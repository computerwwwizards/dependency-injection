---
title: "ADR-001: Multi-Paradigm Provider Agnosticism (OOP Objects + FP Functions)"
status: Accepted
date: 2026-03-07
category: Architecture
---

# ADR-001: Multi-Paradigm Provider Agnosticism (OOP Objects + FP Functions)

- **Status:** Accepted
- **Context:** Traditional DI containers force everything into OOP classes with interfaces (`@Injectable()`), while strict FP architectures reject containers in favor of monadic `ReaderT`/`Layer` stacks or claim DI makes pure functions impure. In multi-paradigm runtimes (TypeScript/JavaScript, C++), applications require stateful OOP shells (connection pools, controllers, observers) and stateless/pure or higher-order FP functions to share the exact same dependency graph.
- **Decision:** The container treats every dependency as a Provider Factory `(resolvedDeps) => Reference`. The returned Reference is paradigm-agnostic: it can be a heap-allocated OOP class instance, a curried/higher-order function closure, a flat stateless function, or a primitive configuration value.
- **Negative Constraints (Explicitly Forbidden):**
  - NO requirement that providers be classes or implement interfaces.
  - NO segregation between "object containers" and "function environments."
- **Consequences:**
  - *Positive:* Seamless interoperability—an OOP class can inject a pure/curried FP function, and an FP factory can inject an OOP service handle.
  - *Negative:* To avoid excessive V8 heap Context allocations from nested FP closures, high-frequency functional providers should prefer flat signatures `(deps, arg) => result` or single-level factories where memory density matters.