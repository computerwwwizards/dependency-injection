---
title: "ADR-011: Hierarchical Child Container Semantics & Lexical vs. Dynamic Scoping"
status: Accepted
date: 2026-03-07
category: Architecture
---

# ADR-011: Hierarchical Child Container Semantics & Lexical vs. Dynamic Scoping

- **Status:** Accepted
- **Context:** When a Parent Container (Root) spawns a Child Container (Request), edge cases arise when a provider registered in Root is resolved via `child.get()`. Specifically, if a `TRANSIENT`, `GRAPH`, or `SCOPED` provider registered in Root depends on a provider registered (or overridden) only inside Child, how are those dependencies resolved without violating lexical ownership or causing Captive Dependencies?
- **Decision:**
  1. **SINGLETON Resolution (Lexical Owner Scope):** A `SINGLETON` is always resolved and cached inside the Owner Container where it was registered. Therefore, a Root `SINGLETON` can never resolve dependencies from a Child Container.
  2. **SCOPED, GRAPH, and TRANSIENT Resolution (Caller Scope Delegation):** When `child.get('orderController')` is invoked on a provider registered in Root with `SCOPED`, `GRAPH`, or `TRANSIENT` lifetime, its dependencies are resolved against `child` (the Calling Container) first, walking up the `.parent` chain only if `child` does not override the key.
- **Negative Constraints (Explicitly Forbidden):**
  - NO resolution of Child-registered providers inside a Parent-owned `SINGLETON`.
  - NO mutation of a Parent Container's `providersByKey` or `cache` from a Child Container.
- **Consequences:**
  - *Positive:* Allows registering an entire application blueprint in Root (using `.declare()` for request-specific values like `'currentUser'`), then spawning lightweight `child = root.createChild().register('currentUser', ...)` instances per request that seamlessly inject `'currentUser'` into Root-defined `SCOPED` and `TRANSIENT` services.
  - *Negative:* `child` must re-link or resolve `SCOPED`/`TRANSIENT` dependency keys dynamically against its own override map when overrides exist.