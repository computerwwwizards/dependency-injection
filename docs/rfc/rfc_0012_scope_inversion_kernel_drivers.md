---
title: "RFC-0012: Scope Inversion Kernel, Safe Internal Primitives, and Pluggable ScopePolicy Drivers"
feature_name: "scope_inversion_kernel"
status: "Proposed"
start_date: "2026-11-07"
related_adrs: ["ADR-002", "ADR-005", "ADR-006", "ADR-008", "ADR-013"]
category: "Request for Comments"
---

# RFC-0012: Scope Inversion Kernel, Safe Internal Primitives, and Pluggable ScopePolicy Drivers

- **Feature Name:** `scope_inversion_kernel`
- **Start Date:** 2026-11-07
- **Related ADRs:** ADR-002, ADR-005, ADR-006, ADR-008, ADR-013 (Updates RFC-0001 & RFC-0003)

## 1. Summary
Replaces the hardcoded `Lifetime` enum and resolution switch statement in RFC-0001 and RFC-0003 with a scope-agnostic micro-kernel that delegates caching, lifecycle registration, and lexical/dynamic scope selection to pluggable `ScopePolicy<TRank>` drivers via bounded internal kernel primitives.

## 2. Motivation
A true micro-kernel should only manage the Directed Acyclic Graph (`ProviderNode` pointers), the container hierarchy (`parent`), and raw storage slots—not the policy of how or when cached references expire or where they live. By inverting scopes into `ScopePolicy` drivers and moving Unsafe resolution into a parallel resolver driver:
1. Applications that do not use `GraphScope`, `TtlScope`, `PoolScope`, or `registerUnsafe` pay 0 bytes of bundle size and 0 bytes of runtime memory for those features.
2. Custom scopes gain first-class access to the Captive Dependency Rank Law (`parentNode.rank <= depNode.rank`) and container `onDispose` hooks without hacking around TRANSIENT wrappers.

## 3. Guide-Level Explanation
Creating a custom scope (or using built-in ones like `SingletonScope`, `ScopedScope`, `GraphScope`, `TtlScope`) requires implementing a 10-line `ScopePolicy` object that interacts with the container's safe storage primitives:

```typescript
import { ScopePolicy } from '@my-di/core';

// Example: Opt-in GraphScope (Diamond Problem solver) in 9 lines of userland/plugin code!
const GRAPH_BAG_KEY = Symbol('graphCache');

export const GraphScope: ScopePolicy<1> = {
  id: 'graph',
  rank: 1, // Rank 1: Can depend on Scoped (2) & Singleton (3), cannot be captured by them!
  resolve(node, caller, ctx) {
    const cache = ctx.getOrCreateBag<Record<string, unknown>>(GRAPH_BAG_KEY, () => Object.create(null));
    let instance = cache[node.key];
    if (instance === undefined) {
      instance = cache[node.key] = node.instantiate(caller, ctx);
    }
    return instance as any;
  },
};
```

And for a parameterized TTL Scope (`TtlScope`) that automatically cleans up on `container.dispose()`:

```typescript
export const TtlScope = (ttlMs: number): ScopePolicy<3> => ({
  id: `ttl:${ttlMs}`,
  rank: 3, // Rank 3: Safe for Singletons to depend on directly!
  resolve(node, _caller, ctx) {
    let state = node.instance as { value: unknown; expiresAt: number } | undefined;
    const now = Date.now();
    if (state === undefined || now >= state.expiresAt) {
      const value = node.instantiate(node.owner, ctx);
      if (state === undefined) {
        // Hook into the owner container's LIFO disposal queue on first creation!
        node.owner.onDispose(() => { node.instance = undefined; });
      }
      state = node.instance = { value, expiresAt: now + ttlMs };
    }
    return state.value as any;
  },
});
```

## 4. Reference-Level Explanation & Invariants

### 4.1 Updated Monomorphic ProviderNode Layout (Supersedes RFC-0001 §2.2)
Every `ProviderNode` MUST initialize properties in the exact order so V8 assigns a single shared Hidden Class across all nodes regardless of which `ScopePolicy` is attached:

```typescript
export interface ScopePolicy<TRank extends number = number> {
  readonly id: string;
  readonly rank: TRank;
  resolve<T>(
    node: KernelNodeHandle<T>,
    callingContainer: KernelContainerHandle,
    callContext: KernelCallContext
  ): T;
}

interface ProviderNode<T = unknown> {
  readonly key: string;                  // Offset 0: Interned string literal ID
  readonly owner: KernelContainerHandle; // Offset 1: Lexical owner container pointer
  readonly rank: number;                 // Offset 2: Smi integer copied from scope.rank at boot!
  readonly scope: ScopePolicy<number>;   // Offset 3: Direct pointer to ScopePolicy driver!
  flags: NodeFlags;                      // Offset 4: Bitmask Smi (IsAsync, IsUnsafe, IsThunk, IsEager)
  compiledEpoch: number;                 // Offset 5: Smi epoch counter (initialized to -1)
  readonly depKeys: readonly string[];   // Offset 6: Declared string dependencies
  depNodes: ProviderNode[];              // Offset 7: Direct memory pointers to child nodes
  plan: ProviderNode[];                  // Offset 8: Flattened bottom-up topological execution array
  crateProto: object | null;             // Offset 9: Pre-shaped V8 prototype for { dep1, dep2 }
  instance: unknown;                     // Offset 10: Owner-level storage slot (used by Singleton/TTL/Pool)
  readonly factory: Function;            // Offset 11: Paradigm-agnostic provider function
}
```

### 4.2 Bounded Internal Kernel Handles (Safe Exposure Invariant)
To prevent custom `ScopePolicy` authors from corrupting the DAG or violating memory safety, `ScopePolicy.resolve()` MUST NOT receive the raw mutable `Container` class. It MUST only receive three bounded capability handles:
1. `KernelNodeHandle<T>`:
   - `readonly key: string`
   - `readonly owner: KernelContainerHandle` (For lexical-scope policies like `SingletonScope`)
   - `instance: unknown` (Direct monomorphic slot on the node for owner-scoped caching)
   - `instantiate(targetContainer: KernelContainerHandle, ctx: KernelCallContext): T` (Resolves `depNodes` against `targetContainer`, stamps `crateProto`, and invokes `factory`).
2. `KernelContainerHandle`:
   - `readonly scopedStorage: Record<string, unknown>` (Null-prototype dictionary owned by `callingContainer` for caller-scoped policies like `ScopedScope`)
   - `onDispose(cleanupFn: () => void | Promise<void>): void` (Appends a cleanup hook to the container's LIFO disposal queue).
3. `KernelCallContext`:
   - Created lazily or pooled per top-level `.get()` invocation and automatically wiped in a `finally` block when `.get()` exits.
   - `getOrCreateBag<B>(symbolKey: symbol, init: () => B): B`: Allows per-traversal scopes (`GraphScope`) and the `UnsafeResolver` (cycle detection `resolvingNow` + parallel dynamic cache) to attach isolated state to a single `.get()` call without polluting the core Container memory layout.

### 4.3 Universal Captive Dependency Rank Law
During `compile()` (and inside the `UnsafeResolver` driver), the kernel validates every edge `parentNode -> depNode` without knowing anything about concrete scopes:
- **Invariant:** If `(depNode.flags & NodeFlags.IsThunk) === 0` and `parentNode.rank > depNode.rank`, the kernel MUST throw `CaptiveDependencyError(parentNode.key, parentNode.scope.id, parentNode.rank, depNode.key, depNode.scope.id, depNode.rank)`.

## 5. Normative Negative Constraints & Drawbacks
- **MUST NOT (Zero Core Knowledge of Concrete Scopes):** The core resolution method `container.get(key)` MUST NOT contain any switch or if branch checking `scope.id === 'singleton'` or `scope.id === 'graph'`; it MUST unconditionally execute `return node.scope.resolve(node, this, ctx)`.
- **MUST NOT (No Unbounded Retention in KernelCallContext):** Any bag allocated inside `KernelCallContext` (such as `GraphScope`'s cache or `UnsafeResolver`'s `resolvingNow` Set) MUST be severed (`ctx.clear()`) inside the top-level `.get()` `finally` block (and `.finally()` on async promises) immediately upon resolution completion.
- **MUST NOT (No Lexical Violation by Owner-Cached Scopes):** Any `ScopePolicy` that caches its reference on `node.instance` (such as `SingletonScope` or `TtlScope`) MUST pass `node.owner` (and MUST NOT pass `callingContainer`) into `node.instantiate(node.owner, ctx)` so owner-cached instances never capture references from a temporary Child Container.