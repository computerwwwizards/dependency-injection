---
title: "RFC-0013: Hybrid Scope Catalog, Inline ScopePolicy Overrides, and Boot-Time Pointer Binding"
feature_name: "hybrid_scope_catalog_and_inline_policies"
status: "Proposed"
start_date: "2026-11-07"
related_adrs: ["ADR-002", "ADR-004", "ADR-010", "ADR-013", "ADR-014"]
category: "Request for Comments"
---

# RFC-0013: Hybrid Scope Catalog, Inline ScopePolicy Overrides, and Boot-Time Pointer Binding

- **Feature Name:** `hybrid_scope_catalog_and_inline_policies`
- **Start Date:** 2026-11-07
- **Related ADRs:** ADR-002, ADR-004, ADR-010, ADR-013, ADR-014 (Updates RFC-0001 & RFC-0005)

## 1. Summary
Defines the TypeScript type-system state parameter `TScopes` and the runtime boot-time pointer binding algorithm that allows developers to pre-register a catalog of named scopes (`'singleton'`, `'scoped'`, etc.) on the container, extend the catalog via `.registerScope()`, and pass inline `ScopePolicy<TRank>` objects directly into `.register()` for unique edge cases—with zero runtime string-lookup overhead during `.get()`.

## 2. Motivation
Developers need both macro-ergonomics (referencing standard scopes by string name `'singleton'` or `'scoped'` across 50 plugin files without importing scope objects everywhere) and micro-flexibility (passing a one-off `TtlScope(60_000)` or `PoolScope(32)` inline on a single `.register()` call without polluting the global scope catalog). Furthermore, both methods must compile down to the exact same V8 Monomorphic `ProviderNode` pointer structure at registration time so `.get()` executes at peak speed.

## 3. Guide-Level Explanation

```typescript
import { Container, SingletonScope, ScopedScope, TransientScope } from '@my-di/core';
import { TtlScope } from '@my-di/scope-ttl';

// 1. Initialize Container (Default preset includes 'singleton', 'scoped', 'transient',
//    or pass a custom `scopes` catalog so unused scopes tree-shake out!)
const app = new Container({
  scopes: {
    singleton: SingletonScope, // ScopePolicy<3>
    scoped: ScopedScope,       // ScopePolicy<2>
    transient: TransientScope, // ScopePolicy<0>
  },
  defaultScope: 'singleton',
})
  // A. Uses defaultScope ('singleton' -> Rank 3)
  .register('db', [], () => new PostgresPool())

  // B. Uses Catalog Scope by string name ('scoped' -> Rank 2)
  .register('tx', ['db'], ({ db }) => db.beginTx(), 'scoped')

  // C. Uses Inline ScopePolicy object for a unique edge case (Rank 3)
  .register('jwksKeys', ['db'], ({ db }) => fetchKeys(db), TtlScope(300_000))

  // D. Plugins can also register new named scopes into the catalog!
  .registerScope('microCache', TtlScope(5_000))
  .register('hotConfig', ['db'], ({ db }) => db.loadConfig(), 'microCache');
```

## 4. Reference-Level Explanation & Invariants

### 4.1 Type-Level State Machine Extension (`TScopes` & `TDefaultScope`)
RFC-0005 is updated so `Container` tracks `TScopes extends Record<string, ScopePolicy<number>>` and `TDefaultScope extends keyof TScopes`:

```typescript
type ExtractRank<
  TScopes extends Record<string, ScopePolicy<number>>,
  S extends keyof TScopes | ScopePolicy<number>
> = S extends ScopePolicy<infer R>
  ? R
  : S extends keyof TScopes
    ? TScopes[S] extends ScopePolicy<infer R>
      ? R
      : never
    : never;
```

When `.register(key, deps, factory, scopeInput?)` is called:
1. If `scopeInput` is omitted, its effective type is `TDefaultScope` (e.g., `'singleton'`, Rank 3).
2. If `scopeInput` is a string literal `S extends keyof TScopes`, TypeScript resolves its rank via `ExtractRank<TScopes, S>`.
3. If `scopeInput` is an inline `ScopePolicy<R>`, TypeScript resolves its rank directly as `R`.
4. **Compile-Time Captive Dependency Verification Across Both Modes:** TypeScript compares the extracted numeric literal rank `R_Parent` against `TLifetimes[DepKey]` for every key in `deps`. If a `'singleton'` (Rank 3) attempts to depend on a `'scoped'` (Rank 2) provider, TypeScript rejects the registration at compile time; if a `'singleton'` (Rank 3) depends on an inline `TtlScope(60_000)` (Rank 3), `3 <= 3` holds and compilation succeeds!

### 4.2 Boot-Time Normalization Algorithm (Zero Runtime Catalog Lookup)
Inside `container.register(key, deps, factory, scopeOrName = this.defaultScopeName)`:

```typescript
// Executed ONCE during .register() at boot time:
let resolvedPolicy: ScopePolicy<number>;
if (typeof scopeOrName === 'string') {
  resolvedPolicy = this.scopeCatalog[scopeOrName];
  if (resolvedPolicy === undefined) {
    throw new UnknownScopeError(key, scopeOrName);
  }
} else {
  resolvedPolicy = scopeOrName;
}

// Direct pointer and Smi integer rank are bound immediately onto the ProviderNode:
const node: ProviderNode = {
  key,
  owner: this,
  rank: resolvedPolicy.rank | 0, // Forced Smi integer for 1-cycle CPU comparison
  scope: resolvedPolicy,         // Direct heap pointer to the ScopePolicy object
  flags,
  compiledEpoch: -1,
  depKeys: deps,
  depNodes: [],
  plan: [],
  crateProto: null,
  instance: undefined,
  factory,
};
```

- **Child Container Catalog Inheritance:** When `parent.createChild()` is invoked, the child container inherits `this.scopeCatalog = Object.create(parent.scopeCatalog)` via prototype delegation at 0 bytes of copying cost. If a child container calls `child.registerScope('custom', policy)`, it shadows only on the child's `scopeCatalog` without mutating the parent's catalog.

### 4.3 Parallel Cache & Resolver Driver for `registerUnsafe`
To honor ADR-013's separation of the unsafe resolver:
- `registerUnsafe(key, unsafeFactory, scopeOrName?)` wraps `unsafeFactory` using the `UnsafeResolverDriver`.
- The `UnsafeResolverDriver` maintains a per-node Parallel Dynamic Edge Cache (`discoveredNodes: Record<string, ProviderNode>`) initialized via `Object.create(null)`.
- On the first execution of `trackedCtx.get(depKey)` inside an unsafe factory, the driver looks up `depNode`, verifies `node.rank <= depNode.rank` (throwing `CaptiveDependencyError` if violated), records the edge for `container.inspect()`, and caches the direct `depNode` pointer in `discoveredNodes[depKey]` (keyed by `this.graphEpoch`) so subsequent calls to the same dynamic key bypass hierarchy traversal!

## 5. Normative Negative Constraints & Drawbacks
- **MUST NOT (No Runtime Catalog Access):** `container.get()` and `ScopePolicy.resolve()` MUST NOT read `this.scopeCatalog` at runtime; they MUST read `node.scope` and `node.rank` directly from the `ProviderNode`.
- **MUST NOT (No Mutating Registered Scope Ranks):** Calling `.registerScope(existingName, newPolicy)` after providers have already been registered using `existingName` MUST throw a `SealedScopeCatalogError(existingName)` if `newPolicy.rank !== oldPolicy.rank`, preventing retroactive invalidation of Captive Dependency guarantees.
- **MUST NOT (No Unvalidated Inline Scope Objects):** If an inline `ScopePolicy` object is passed with a non-integer or negative rank (`!Number.isInteger(policy.rank) || policy.rank < 0`), `.register()` MUST throw an `InvalidScopePolicyError` immediately at registration time.