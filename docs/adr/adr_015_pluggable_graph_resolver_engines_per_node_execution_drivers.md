---
title: "ADR-015: Pluggable Graph Resolver Engines (GraphEnginePolicy) & Per-Node Execution Drivers"
status: "Accepted"
supersedes: ["ADR-007"]
date: "2026-11-07"
category: "Architecture Decision Record"
---

# ADR-015: Pluggable Graph Resolver Engines (GraphEnginePolicy) & Per-Node Execution Drivers

- **Status:** Accepted (Supersedes hardcoded graph compilation in ADR-007 and mixes with ADR-013)
- **Context:** Hardcoding a single graph-linking and dependency-resolution algorithm inside the container kernel forces every environment and workload into a suboptimal trade-off:
  1. Production Servers need a stripped, zero-telemetry topological array runner (`FastTopologicalEngine`).
  2. Development & Debugging need an observable state-machine engine (`DevToolsStateMachineEngine`) that tracks node transitions, timing waterfalls, and cycle paths.
  3. Serverless / CLI Cold Starts that only invoke 1 out of 500 registered nodes benefit from lazy Depth-First Search (`LazyDfsEngine`) without paying boot-time topological sort overhead for untouched branches.
  4. Future Ahead-of-Time (AOT) Builds (using Reason/OCaml or SWC compilers) need a zero-solver runtime (`AotPreCompiledEngine`) that executes pre-computed plans without shipping any graph-sorting code in the JavaScript bundle.
  5. Node-Specific Mechanics (`registerUnsafe` dynamic lookups vs. `registerAsync` parallel `Promise.all` waves vs. standard synchronous nodes) previously required `if (isUnsafe) ... else if (isAsync)` branching inside the hot resolution loop.
- **Decision:** Invert the graph planner and dependency walker out of the core container into a pluggable Two-Level Resolver Architecture:
  1. **Container-Level `GraphEnginePolicy`:** Set on `new Container({ engine })` (defaulting to `FastTopologicalEngine`). Controls how `compile()` links `depNodes`, validates Captive Dependency ranks, and orders execution plans across the container.
  2. **Per-Node `NodeResolverDriver` Binding:** At registration time (`register`, `registerAsync`, `registerUnsafe`), each `ProviderNode` binds a direct pointer `node.resolver` to the exact execution driver for its mechanics (or an explicit custom resolver passed in `options.resolver`). Calling `node.instantiate(targetContainer, ctx)` delegates directly to `node.resolver.instantiate(node, targetContainer, ctx)` with zero if/else flag branching on the hot path.
- **Negative Constraints (Explicitly Forbidden):**
  - NO hardcoded topological sort, DFS loop, or cycle-detection Set inside the base `Container` class.
  - NO runtime `if (node.flags & IsUnsafe)` or `if (node.flags & IsAsync)` branching inside the synchronous `FastTopologicalEngine` execution loop; unsafe and async mechanics MUST be isolated inside their respective `NodeResolverDriver` implementations.
  - NO shipping of DevTools state-machine tracking or telemetry hooks inside the production `FastTopologicalEngine`.
- **Consequences:**
  - **Positive:** Complete algorithmic freedom (swap in Tarjan’s SCC, Kahn’s parallel waves, lazy DFS, or AOT pre-baked plans without touching the container), zero DevTools overhead in production, and zero flag-branching in synchronous hot loops.
  - **Negative:** Adds one direct monomorphic pointer field (`resolver: NodeResolverDriver`) to `ProviderNode`.