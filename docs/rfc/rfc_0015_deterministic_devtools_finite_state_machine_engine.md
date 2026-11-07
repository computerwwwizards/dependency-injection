---
title: "RFC-0015: Deterministic DevTools Finite State Machine (FSM) Engine and Telemetry Protocol"
feature_name: "devtools_fsm_engine"
status: "Proposed"
start_date: "2026-11-07"
related_adrs: ["ADR-003", "ADR-010", "ADR-012", "ADR-015", "ADR-016"]
category: "Request for Comments"
---

# RFC-0015: Deterministic DevTools Finite State Machine (FSM) Engine and Telemetry Protocol

- **Feature Name:** `devtools_fsm_engine`
- **Start Date:** 2026-11-07
- **Related ADRs:** ADR-003, ADR-010, ADR-012, ADR-015, ADR-016 (Supersedes RFC-0006 §3)

## 1. Summary
Defines the formal Finite State Machine (FSM) specification for `@my-di/engine-devtools` (`DevToolsStateMachineEngine`), providing deterministic lifecycle state tracking, cycle/captive error forensics, resolution waterfall timings, and live DAG edge visualization (`STATIC_SOLID`, `CONDITIONAL_THUNK`, `DYNAMIC_UNSAFE`) with zero footprint in production builds.

## 2. Motivation
Earlier, RFC-0006 §3 proposed a built-in `container.inspect()` method on the core container. However:
1. Production builds should not carry any inspection serialization or dynamic edge sets in memory.
2. In development, a static graph dump is insufficient when debugging race conditions in `registerAsync`, partial graph rollbacks (RFC-0010), or Child Container Copy-on-Write shadowing (RFC-0007). Developers need an explicit Finite State Machine per node and per resolution call that can emit live events to a DevTools UI or test assertion harness.

## 3. Guide-Level Explanation

```typescript
import { Container } from '@my-di/core';
import { DevToolsStateMachineEngine } from '@my-di/engine-devtools';

const devEngine = new DevToolsStateMachineEngine({
  onTransition(event) {
    // Real-time FSM transition stream:
    // e.g. [Node 'dbPool'] COMPILED -> RESOLVING_ASYNC (at +1.2ms)
    // e.g. [Node 'dbPool'] RESOLVING_ASYNC -> CACHED_HEALTHY (at +14.8ms)
    console.debug(`[DI FSM] ${event.key}: ${event.fromState} -> ${event.toState}`);
  },
});

const app = new Container({ engine: devEngine });
// ... register providers ...
// Inspect the full FSM state, edge classifications, and timing waterfalls via the engine:
const snapshot = devEngine.getSnapshot(app);
```

## 4. Reference-Level Explanation & Invariants

### 4.1 The Node Lifecycle Finite State Machine (FSM)
For every `(Container, ProviderNode)` pair, `DevToolsStateMachineEngine` maintains an external state record inside a `WeakMap<KernelContainerHandle, Map<string, NodeFsmRecord>>` (ensuring evicted Child Containers are automatically garbage-collected even in DevTools mode!).
Each node transitions strictly across the following 9 deterministic FSM states:

```typescript
const enum DevNodeState {
  DeclaredUnfulfilled = 'DECLARED_UNFULFILLED', // Registered via .declare(), awaiting .register()
  RegisteredUnlinked  = 'REGISTERED_UNLINKED',  // Registered, or invalidated by graphEpoch bump
  Linking             = 'LINKING',              // Currently in DFS visiting set during compileNode()
  CompiledReady       = 'COMPILED_READY',       // DAG verified, crateProto & plan built, 0 instances
  ResolvingSync       = 'RESOLVING_SYNC',       // Currently on call stack inside factory()
  ResolvingAsync      = 'RESOLVING_ASYNC',      // In-flight Promise pending (stampede lock active)
  CachedHealthy       = 'CACHED_HEALTHY',       // Live reference stored in Singleton/Scoped/TTL slot
  PoisonedFailed      = 'POISONED_FAILED',      // Factory threw or Promise rejected (cache evicted per RFC-0010)
  DisposedEvicted     = 'DISPOSED_EVICTED',     // Container disposed; reference severed
}
```

### 4.2 Legal FSM State Transition Table (Invariants)
The `DevToolsStateMachineEngine` MUST enforce the following state transition table and emit a `StateTransitionEvent` on every edge:

| Current State (`fromState`) | Triggering Operation | Next State (`toState`) | Guard / Invariant |
| :--- | :--- | :--- | :--- |
| (None) | `.declare<K, V>()` | `DECLARED_UNFULFILLED` | Zero ProviderNode allocated yet. |
| (None) or `DECLARED_UNFULFILLED` | `.register()` / `.registerAsync()` | `REGISTERED_UNLINKED` | Increments `graphEpoch`. |
| `REGISTERED_UNLINKED` | Sibling `.register()` bumps `graphEpoch` | `REGISTERED_UNLINKED` | Invalidates stale topological plans (RFC-0007). |
| `REGISTERED_UNLINKED` | `engine.compileNode()` starts | `LINKING` | Adds key to visiting cycle detector. |
| `LINKING` | Encountered node already in `LINKING` | `POISONED_FAILED` | Throws `CircularDependencyError` with full cycle path. |
| `LINKING` | `parent.rank > dep.rank` (!isThunk) | `POISONED_FAILED` | Throws `CaptiveDependencyError`. |
| `LINKING` | All `depNodes` linked & sorted | `COMPILED_READY` | Stamps `compiledEpoch = container.graphEpoch`. |
| `COMPILED_READY` | `resolver.instantiate()` (Sync) | `RESOLVING_SYNC` | Pushes key to active resolution trace. |
| `COMPILED_READY` | `resolver.instantiate()` (Async) | `RESOLVING_ASYNC` | Stores in-flight Promise stampede lock. |
| `RESOLVING_SYNC` or `RESOLVING_ASYNC` | Factory returns & ScopePolicy caches | `CACHED_HEALTHY` | Records `durationMs` and paradigm kind (OOP/FP). |
| `RESOLVING_SYNC` or `RESOLVING_ASYNC` | Factory returns & TransientScope | `COMPILED_READY` | Ephemeral reference handed to caller; node returns to ready. |
| `RESOLVING_SYNC` or `RESOLVING_ASYNC` | Factory throws or Promise rejects | `POISONED_FAILED` | Evicts in-flight cache slot (RFC-0010); records error stack. |
| `POISONED_FAILED` | Subsequent retry `.get()` call | `RESOLVING_SYNC` / `ASYNC` | Permitted because RFC-0010 forbade cache poisoning! |
| `CACHED_HEALTHY` or `COMPILED_READY` | `container.dispose()` completes | `DISPOSED_EVICTED` | Verifies LIFO disposer ran and `node.instance === undefined`. |

### 4.3 Edge Classification & Shadowing Forensics in DevToolsStateMachineEngine
During `compileNode()` and `UnsafeDynamicResolver.instantiate()`, the DevTools engine populates the visual graph model:
1. **`STATIC_SOLID` (`──►`):** `parentNode` is static (`!IsUnsafe`) and `depNode` is not wrapped in `asThunk`/`asVirtualProxy`.
2. **`CONDITIONAL_THUNK` (`► ┄`):** `parentNode` is static and `depNode` has `NodeFlags.IsThunk`. The DevTools FSM tracks `thunkInvocations: number` so developers can see which branch of an `if/else` (`pgPool()` vs. `sqlitePool()`) was actually taken at runtime!
3. **`DYNAMIC_UNSAFE` (`⚠️ ──►`):** Recorded by `DevToolsStateMachineEngine`'s default unsafe resolver whenever `trackedCtx.get(depKey)` fires inside a `registerUnsafe` closure.
4. **`CHILD_COW_SHADOW` (`🔵 ══►`):** Recorded when a Child Container triggers Copy-on-Write shadowing (RFC-0007), visually linking the Child's cloned `ProviderNode` back to the Parent's original `ProviderNode`.

## 5. Normative Negative Constraints & Drawbacks
- **MUST NOT (No Core Contamination):** `Container` and `ProviderNode` MUST NOT import or store `DevNodeState`, timing metrics, or `GraphEdge` arrays; all FSM data MUST live inside `DevToolsStateMachineEngine`'s external `WeakMap`.
- **MUST NOT (No Memory Leak of Evicted Child Containers in DevTools):** `DevToolsStateMachineEngine` MUST key its per-container state tables by `WeakMap<KernelContainerHandle, ...>` so that when an HTTP request Child Container is evicted and garbage-collected, its DevTools FSM history is also eligible for garbage collection unless explicitly pinned by an active UI snapshot.
- **MUST NOT (No Side Effects During Snapshot):** Calling `devEngine.getSnapshot(container)` MUST be a pure read over the FSM `WeakMap` and MUST NOT trigger `compileNode()` or `instantiate()`.