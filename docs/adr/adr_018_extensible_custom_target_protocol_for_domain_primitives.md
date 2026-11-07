---
title: "ADR-018: Extensible Custom Target Protocol (registerWith) for Functors, Monads, and Domain Primitives"
status: "Accepted"
extends: ["ADR-001", "ADR-015"]
date: "2026-11-07"
category: "Architecture Decision Record"
---

# ADR-018: Extensible Custom Target Protocol (registerWith) for Functors, Monads, and Domain Primitives

- **Status:** Accepted (Extends ADR-001 & ADR-015)
- **Context:** Beyond standard OOP classes, pure functions, and factory closures, multi-paradigm applications frequently wire higher-kinded or specialized algebraic structures—such as Functors (`Box.map(fn)`), Reader / Effect Monads (`Effect.provide(env)`), Reactive Streams / Observables (`combineLatest([s1, s2]).pipe(mapFn)`), or State Machines / Actors. Hardcoding `.registerFunctor()` or `.registerMonad()` directly into the bare-minimum Container class would violate our micro-kernel philosophy (ADR-013, ADR-015), yet forcing users to wrap every Functor or Monad in an anonymous `register()` factory closure reintroduces closure and Crate allocation overhead.
- **Decision:** Expose a single, zero-overhead kernel extension primitive `container.registerWith(key, deps, target, resolverDriver, scope?)`:
  1. **Kernel Mechanism:** `registerWith` stores the arbitrary domain structure (Functor, Monad, Observable, ActorBlueprint) directly in `node.target` and binds the caller-supplied `resolverDriver: NodeResolverDriver` to `node.resolver`.
  2. **Plugin Ergonomics:** Domain libraries and `.use(plugin)` extensions can define domain-specific hot registration helpers (e.g., `registerFunctor`, `registerReaderMonad`, `registerStream`) that delegate to `registerWith` using a shared static `NodeResolverDriver` singleton—achieving zero wrapper closures, zero Crate allocations, and 100% preservation of the monomorphic `ProviderNode` layout.
- **Negative Constraints (Explicitly Forbidden):**
  - NO hardcoding Functor, Monad, RxJS Observable, or Actor logic inside the core `@my-di/core` package.
  - NO mutating the 13-field monomorphic `ProviderNode` shape when registering custom targets via `registerWith`.
- **Consequences:**
  - **Positive:** Infinite extensibility for functional, reactive, and algebraic paradigms with zero core bloat and zero closure wrapper tax.
  - **Negative:** Custom `NodeResolverDriver` authors must provide a TypeScript helper signature if they want automatic compile-time type inference between `deps`, `target`, and the resolved output type `R`.