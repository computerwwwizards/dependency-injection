---
title: "ADR-003: Safe-by-Default Static DAG (register) vs. Explicit Escape Hatch (registerUnsafe)"
status: Accepted
date: 2026-03-07
category: Architecture
---

# ADR-003: Safe-by-Default Static DAG (register) vs. Explicit Escape Hatch (registerUnsafe)

- **Status:** Accepted
- **Context:** If a container defaults to opaque resolution `(ctx) => ctx.get('b')`, the dependency graph is hidden inside an uninspectable closure until runtime execution. This prevents ahead-of-time cycle detection, requires recursive call-stack traversal, and breaks DevTools visualization. However, 1% of real-world cases (such as dynamic plugin names determined at runtime) genuinely require dynamic lookups.
- **Decision:** Borrow Rust’s safety philosophy by inverting the default:
  1. **Default Safe Path (`register(key, ['dep1', 'dep2'], ({ dep1, dep2 }) => ...)`):** Forces the developer to pre-declare dependency edges as a static array. The container builds and validates the Directed Acyclic Graph (DAG) upfront before instantiation.
  2. **Explicit Escape Hatch (`registerUnsafe(key, (trackedCtx) => trackedCtx.get(dynamicKey))`):** Quarantines opaque runtime resolution behind an explicit unsafe API that records edges dynamically (`addDynamicEdge`) into DevTools the moment `trackedCtx.get()` executes at runtime.
- **Negative Constraints (Explicitly Forbidden):**
  - NO `ctx` or `.get()` reference is ever passed into safe `register()` factories; safe factories can only access the exact destructured properties declared in their `deps` array.
  - NO silent fallback to opaque resolution without using the `registerUnsafe` signature.
- **Consequences:**
  - *Positive:* 99% of the graph is statically verifiable at boot, immune to hidden dependencies, and visible in DevTools before executing a single line of business logic. `registerUnsafe` calls are immediately visible in code reviews and lintable.
  - *Negative:* Developers must explicitly list dependency keys in the `deps` array (`['b', 'b1']`) unless using a future compiler macro.