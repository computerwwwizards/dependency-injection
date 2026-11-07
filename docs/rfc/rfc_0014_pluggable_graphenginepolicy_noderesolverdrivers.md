---
title: "RFC-0014: Pluggable GraphEnginePolicy, Per-Node NodeResolverDriver, and the Pure Triad Micro-Kernel"
feature_name: "pluggable_graph_engine_and_node_resolvers"
status: "Proposed"
start_date: "2026-11-07"
related_adrs: ["ADR-002", "ADR-003", "ADR-007", "ADR-009", "ADR-013", "ADR-014", "ADR-015"]
category: "Request for Comments"
---

# RFC-0014: Pluggable GraphEnginePolicy, Per-Node NodeResolverDriver, and the Pure Triad Micro-Kernel

- **Feature Name:** `pluggable_graph_engine_and_node_resolvers`
- **Start Date:** 2026-11-07
- **Related ADRs:** ADR-002, ADR-003, ADR-007, ADR-009, ADR-013, ADR-014, ADR-015 (Updates RFC-0001, RFC-0002, RFC-0004, RFC-0011, RFC-0012)

## 1. Summary
Completes the reduction of the DI container into the "Pure Triad Micro-Kernel":
1. **The Container Arena:** Manages only the `providersByKey` dictionary, parent hierarchy pointer, `scopedStorage` dictionary, and disposers LIFO queue.
2. **The ScopePolicy Driver (RFC-0012):** Controls where references are cached and when they are evicted.
3. **The GraphEnginePolicy & NodeResolverDriver (This RFC):** Controls how dependency edges are linked, validated, sorted, and executed at runtime or via AOT manifests.

## 2. Motivation
By extracting both `ScopePolicy` and `GraphEnginePolicy` out of the container, the core `Container` class is reduced to a pure declarative wiring table and memory arena (~45 lines of code). This enables:
- **Algorithm Swapping:** Switch between `FastTopologicalEngine` (bottom-up flat array), `LazyDfsEngine` (on-demand recursion for massive CLI graphs), `ParallelWaveAsyncEngine` (level-by-level `Promise.all` batching), and `AotPreCompiledEngine` (zero-solver build-time plans).
- **Branchless Synchronous Hot Path:** Instead of checking `if (node.flags & IsUnsafe)` or `if (node.flags & IsAsync)` inside a monolithic resolver, `register()`, `registerAsync()`, and `registerUnsafe()` bind dedicated `NodeResolverDriver` pointers onto `node.resolver` at registration time.

## 3. Guide-Level Explanation

```typescript
import { Container } from '@my-di/core';
import { FastTopologicalEngine } from '@my-di/engine-fast';
import { DevToolsStateMachineEngine } from '@my-di/engine-devtools';
import { ParallelWaveResolver } from '@my-di/resolver-parallel-async';

const engine = process.env.NODE_ENV === 'development'
  ? new DevToolsStateMachineEngine()
  : FastTopologicalEngine;

const app = new Container({ engine })
  // 1. Uses the container's default engine (`FastTopologicalEngine` or `DevToolsStateMachineEngine`)
  .register('config', [], () => loadConfig())

  // 2. Uses a specialized per-node Resolver Driver for heavy parallel async wave batching!
  .registerAsync(
    'searchIndex',
    ['dbShard1', 'dbShard2', 'embeddingsModel'],
    async ({ dbShard1, dbShard2, embeddingsModel }) => buildIndex(dbShard1, dbShard2, embeddingsModel),
    { scope: 'singleton', resolver: ParallelWaveResolver }
  );
```

## 4. Reference-Level Explanation & Invariants

### 4.1 Final Monomorphic ProviderNode Layout (Supersedes RFC-0012 §4.1)
Every `ProviderNode` MUST be allocated with the following fixed 12-property shape:

```typescript
export interface NodeResolverDriver {
  readonly id: string;
  instantiate<T>(
    node: KernelNodeHandle<T>,
    targetContainer: KernelContainerHandle,
    callContext: KernelCallContext
  ): T;
}

export interface GraphEnginePolicy {
  readonly id: string;
  readonly defaultSyncResolver: NodeResolverDriver;
  readonly defaultAsyncResolver?: NodeResolverDriver;
  readonly defaultUnsafeResolver?: NodeResolverDriver;

  /**
   * Links `depNodes`, validates Captive Dependency ranks (`parent.rank <= dep.rank`),
   * detects cycles, and populates `node.plan` and `node.crateProto`.
   */
  compileNode(
    rootNode: ProviderNode,
    container: KernelContainerHandle
  ): void;
}

interface ProviderNode<T = unknown> {
  readonly key: string;                   // Offset 0: Interned string literal ID
  readonly owner: KernelContainerHandle;  // Offset 1: Lexical owner container pointer
  readonly rank: number;                  // Offset 2: Smi integer copied from scope.rank
  readonly scope: ScopePolicy<number>;    // Offset 3: Direct pointer to ScopePolicy driver
  readonly resolver: NodeResolverDriver;  // Offset 4: Direct pointer to NodeResolverDriver!
  flags: NodeFlags;                       // Offset 5: Bitmask Smi
  compiledEpoch: number;                  // Offset 6: Smi epoch counter (initialized to -1)
  readonly depKeys: readonly string[];    // Offset 7: Declared string dependencies
  depNodes: ProviderNode[];               // Offset 8: Direct memory pointers to child nodes
  plan: ProviderNode[];                   // Offset 9: Engine-specific execution plan array
  crateProto: object | null;              // Offset 10: Pre-shaped V8 prototype for { dep1, dep2 }
  instance: unknown;                      // Offset 11: Owner-level storage slot
  readonly factory: Function;             // Offset 12: Paradigm-agnostic provider function
}
```

### 4.2 The Branchless Resolution & Instantiation Handshake
When `container.get(key)` is invoked:
1. **Lookup:** Finds node in `this.providersByKey[key]` (or walks `.parent`).
2. **Epoch Check:** If `node.compiledEpoch !== this.graphEpoch`, invokes `this.engine.compileNode(node, this)` once, which stamps `node.compiledEpoch = this.graphEpoch`.
3. **Scope Delegation:** Calls `return node.scope.resolve(node, this, ctx)`.
4. **Resolver Delegation:** When the `ScopePolicy` experiences a cache miss and calls `node.instantiate(targetContainer, ctx)`, `ProviderNode.instantiate` executes:

```typescript
instantiate(targetContainer: KernelContainerHandle, ctx: KernelCallContext): T {
  return this.resolver.instantiate(this, targetContainer, ctx);
}
```

Notice that zero if/else or switch statements exist in this handshake:
- If node is a standard static node, `this.resolver` points directly to `SyncCrateResolver`, which loops over `this.depNodes`, populates `Object.create(this.crateProto)`, and calls `this.factory(crate)`.
- If node was registered via `registerUnsafe`, `this.resolver` points directly to `UnsafeDynamicResolver`, which initializes `resolvingNow` in `ctx`, passes `trackedCtx` into `this.factory(trackedCtx)`, and caches discovered pointers in its parallel dynamic cache.
- If node was registered via `registerAsync` (or tainted upward during `compileNode`), `this.resolver` points directly to `AsyncWaveResolver`, which coalesces in-flight Promises and awaits async dependencies via `Promise.all` before invoking `this.factory(crate)`.

### 4.3 Standard Pluggable Engine Implementations
1. **FastTopologicalEngine (`@my-di/engine-fast`):** Performs post-order DFS linking during `compileNode`, verifies `parent.rank <= dep.rank`, stamps `node.crateProto`, and populates `node.plan` in bottom-up topological order. Zero telemetry or state tracking.
2. **LazyDfsEngine (`@my-di/engine-lazy-dfs`):** Skips computing full `node.plan` arrays at boot; links and validates `depNodes` on-demand one hop at a time as nodes are touched. Ideal for short-lived CLI binaries with massive dependency trees where only 2% of nodes execute per invocation.
3. **AotPreCompiledEngine (`@my-di/engine-aot`, Updates RFC-0011):** Accepts the build-time `StaticGraphIR` manifest emitted by the AOT compiler. `compileNode()` is a no-op that binds the pre-sorted integer plan directly from the manifest—allowing the bundler to tree-shake the entire cycle-detector and topological sort algorithm out of the client/server build!

## 5. Normative Negative Constraints & Drawbacks
- **MUST NOT (No Resolver Branching in Core):** The core `Container` and `ProviderNode` classes MUST NOT contain conditional branches checking `IsUnsafe` or `IsAsync` during `.get()` or `.instantiate()`; behavior MUST be dispatched polymorphically via `node.resolver.instantiate(...)`.
- **MUST NOT (No Bypassing Captive Rank Validation in Custom Engines):** Every custom `GraphEnginePolicy.compileNode()` implementation MUST enforce the Captive Dependency Rank Law (`parent.rank <= dep.rank` unless `dep.flags & NodeFlags.IsThunk`) before setting `node.compiledEpoch = container.graphEpoch`.