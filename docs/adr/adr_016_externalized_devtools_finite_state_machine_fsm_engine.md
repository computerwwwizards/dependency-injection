---
title: "ADR-016: Externalized DevTools Finite State Machine (FSM) Engine vs. Zero-Telemetry Production"
status: "Accepted"
supersedes: ["ADR-012"]
date: "2026-11-07"
category: "Architecture Decision Record"
---

# ADR-016: Externalized DevTools Finite State Machine (FSM) Engine vs. Zero-Telemetry Production

- **Status:** Accepted (Supersedes the built-in `container.inspect()` method in ADR-012)
- **Context:** In ADR-012 and RFC-0006, the container exposed a built-in `container.inspect()` method and tracked dynamic unsafe edges directly inside the core. In production, maintaining introspection arrays, edge classifications (`STATIC_SOLID`, `CONDITIONAL_THUNK`, `DYNAMIC_UNSAFE`), and resolution state transitions wastes memory and CPU cycles. Conversely, during development, a static snapshot is not enough—developers want a deterministic Finite State Machine (FSM) that tracks every node's real-time lifecycle (`UNLINKED -> LINKING -> COMPILED -> RESOLVING -> CACHED | POISONED | DISPOSED`), detects exact cycle traces, and measures instantiation latency.
- **Decision:** Remove all introspection and edge-recording code from the core Container kernel and encapsulate it inside an opt-in `DevToolsStateMachineEngine` (`GraphEnginePolicy` implementation):
  1. **In Production (`FastTopologicalEngine`):** Zero state machine transitions, zero timing hooks, and zero edge classification objects exist in memory.
  2. **In Development (`DevToolsStateMachineEngine`):** Wraps the linking and instantiation lifecycle in an explicit Finite State Machine per node, recording transition timestamps, active resolution stacks, discovered `registerUnsafe` edges, and memory cache states into an external DevTools store.
- **Negative Constraints (Explicitly Forbidden):**
  - NO `container.inspect()` method or DevTools snapshot serialization code inside the bare-minimum `Container` class.
  - NO dynamic edge recording arrays allocated when running with `FastTopologicalEngine`.
- **Consequences:**
  - **Positive:** Production bundles are 100% free of observability dead code, while development builds get a vastly superior, time-travel-capable Finite State Machine inspector.
  - **Negative:** Inspecting the graph requires initializing the container with `DevToolsStateMachineEngine` (or attaching it via a dev plugin).