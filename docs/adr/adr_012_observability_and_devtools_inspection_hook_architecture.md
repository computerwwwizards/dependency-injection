---
title: "ADR-012: Observability & DevTools Inspection Hook Architecture"
status: Accepted
date: 2026-03-07
category: Architecture
---

# ADR-012: Observability & DevTools Inspection Hook Architecture

- **Status:** Accepted
- **Context:** Because the core container supports both pre-declared static edges (`register`) and quarantined dynamic edges (`registerUnsafe`), plus userland factory decorators (`asThunk`, `withTtl`), developers need a way to inspect the live dependency graph, visualize solid vs. conditional vs. dynamic edges, and audit active memory caches without bloating the production core.
- **Decision:** Expose a lightweight, read-only introspection snapshot (`container.inspect()`) and plugin hooks that report:
  - **Static Edges (`──►`):** Pre-declared via `register(key, deps, ...)`.
  - **Conditional / Thunk Edges (`►`):** Pre-declared edges pointing to providers wrapped with `asThunk` metadata (`factory.__isThunk = true`).
  - **Dynamic Runtime Edges (`⚠️ ──►`):** Recorded on the fly whenever `registerUnsafe`'s `trackedCtx.get(depKey)` executes at runtime.
  - **Unfulfilled Declarations (`🟡`):** Keys registered via `.declare('key')` that have not yet been provided in the current container tier.
- **Negative Constraints (Explicitly Forbidden):**
  - NO heavy visualization UI or serialization logic embedded inside the core `Container` class (all formatting and UI rendering must live in an external `devToolsPlugin`).
- **Consequences:**
  - *Positive:* Full runtime and boot-time visibility into the dependency graph, making debugging circular dependencies, captive lifetimes, and `registerUnsafe` hops effortless.
  - *Negative:* Requires attaching a tiny symbol/boolean property (`__isThunk = true`) on decorator utilities so DevTools and the Captive Dependency validator can distinguish a raw `TRANSIENT` from a safe `asThunk(TRANSIENT)`.