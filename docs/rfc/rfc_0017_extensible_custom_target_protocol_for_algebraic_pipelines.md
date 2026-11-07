---
title: "RFC-0017: Extensible Custom Target Protocol (registerWith) for Functors, Monads, and Algebraic Pipelines"
feature_name: "extensible_custom_target_protocol"
status: "Proposed"
start_date: "2026-11-07"
related_adrs: ["ADR-001", "ADR-013", "ADR-015", "ADR-018"]
category: "Request for Comments"
---

# RFC-0017: Extensible Custom Target Protocol (registerWith) for Functors, Monads, and Algebraic Pipelines

- **Feature Name:** `extensible_custom_target_protocol`
- **Start Date:** 2026-11-07
- **Related ADRs:** ADR-001, ADR-013, ADR-015, ADR-018 (Extends RFC-0014 & RFC-0016)

## 1. Summary
Defines the low-level `container.registerWith(key, deps, target, resolverDriver, scope?)` primitive and the `CustomTargetDescriptor<TTarget, TDepsTuple, TOut>` type contract, enabling zero-wrapper registration of Functors, Reader/Effect Monads, Reactive Streams, and future algebraic structures via external plugins.

## 2. Motivation
As functional and multi-paradigm patterns evolve in an application, developers often work with domain types that have their own composition protocol:
- **Functors (`Functor<A>`):** Transform an upstream dependency `'rawUser'` using a pure mapping function `toDto` via `rawUserFunctor.map(toDto)`.
- **Reader / Effect Monads (`Reader<Env, A>`):** Inject a resolved environment crate or tuple into an immutable Reader computation via `reader.run(env)` or `Effect.provideService(...)`.
- **Kleisli / Monad Chains (`flatMap` / `chain`):** Bind an upstream monadic dependency `'authResult'` into a downstream monadic function `loadProfileMonad`.
With `registerWith`, libraries can provide first-class, zero-closure resolvers for these algebraic structures without adding a single byte of code to `@my-di/core`.

## 3. Guide-Level Explanation

```typescript
import { NodeResolverDriver } from '@my-di/core';

// --- 1. Define a reusable Functor Map Resolver Driver (Once in a FP plugin) ---
export interface Functor<A> {
  map<B>(fn: (a: A) => B): Functor<B>;
}

export const FunctorMapResolver: NodeResolverDriver = {
  id: 'fp-functor-map',
  instantiate(node, caller, ctx) {
    // `node.depNodes[0]` is the upstream Functor<A>
    // `node.target` is the pure mapping function `(a: A) => B` (Zero wrapper closure!)
    const upstreamFunctor = node.depNodes[0].scope.resolve(node.depNodes[0], caller, ctx) as Functor<unknown>;
    const mapFn = node.target as (a: unknown) => unknown;
    return upstreamFunctor.map(mapFn) as any;
  },
};

// --- 2. Use `registerWith` (or a plugin method `.registerFunctor()`) ---
// Pure static function — zero DI wrapper closure needed!
const toUpperName = (user: { name: string }) => user.name.toUpperCase();

app
  .registerValue('userBox', Box.of({ name: 'alice' })) // Functor<{ name: string }>
  .registerWith(
    'upperNameBox',
    ['userBox'],
    toUpperName,          // <-- Stored directly in `node.target`!
    FunctorMapResolver,   // <-- Stored directly in `node.resolver`!
    'scoped'
  );
```

And for a Reader Monad (`Reader<Deps, R>`):

```typescript
export interface Reader<Env, R> {
  run(env: Env): R;
}

export const ReaderMonadResolver: NodeResolverDriver = {
  id: 'fp-reader-monad',
  instantiate(node, caller, ctx) {
    const reader = node.target as Reader<Record<string, unknown>, unknown>;
    const crate = node.buildCrate(caller, ctx); // Uses the pre-shaped Monomorphic Crate!
    return reader.run(crate) as any;
  },
};
```

## 4. Reference-Level Explanation & Invariants

### 4.1 Typed `NodeResolverDriver<TTarget, TDeps, TOut>` Contract
To allow `container.registerWith()` to infer the output type `TOut` and validate `TTarget` against `Deps` automatically at compile time, `NodeResolverDriver` carries optional phantom type parameters:

```typescript
export interface NodeResolverDriver<
  TTarget = unknown,
  TExpectedDeps = any,
  TOut = unknown
> {
  readonly id: string;
  /**
   * Optional flag: if true, `compileNode()` will pre-allocate `node.crateProto`
   * so `node.buildCrate(caller, ctx)` can be called by the custom resolver (e.g., for Reader Monads).
   * Defaults to `false` (zero Crate allocation).
   */
  readonly usesCrate?: boolean;

  instantiate<T = TOut>(
    node: KernelNodeHandle<T>,
    targetContainer: KernelContainerHandle,
    callContext: KernelCallContext
  ): T;

  // Phantom brand for compile-time type inference in `registerWith`
  readonly __types?: {
    target: TTarget;
    deps: TExpectedDeps;
    out: TOut;
  };
}
```

### 4.2 `container.registerWith()` Specification

```typescript
registerWith<
  K extends string,
  const Deps extends readonly (keyof (TProvided & TDeclared))[],
  TTarget,
  TOut,
  S extends keyof TScopes | ScopePolicy<number> = TDefaultScope
>(
  key: K,
  deps: ValidateCaptiveRanks<K, Deps, S, TLifetimes, TScopes, TDefaultScope>,
  target: TTarget,
  resolver: NodeResolverDriver<TTarget, MapDepsTuple<TProvided & TDeclared, Deps>, TOut>,
  scope?: S
): Container<TProvided & Record<K, TOut>, ...>
```

1. **At Registration Time:**
   - Resolves scope via the Hybrid Scope Catalog (RFC-0013).
   - Sets `node.target = target` and `node.resolver = resolver`.
   - If `resolver.usesCrate === true`, sets `node.flags |= NodeFlags.UsesCrate` so `compileNode()` builds `node.crateProto`. Otherwise, `node.crateProto` remains `null`.
2. **At Compilation & Runtime:**
   - Participates in the exact same DAG cycle detection, Captive Dependency rank check (`parent.rank <= dep.rank`), and topological sorting (`node.plan`) as built-in registrations.
   - When resolved via `node.scope.resolve(node, this, ctx)`, cache misses invoke `node.resolver.instantiate(node, targetContainer, ctx)`.

## 5. Normative Negative Constraints & Drawbacks
- **MUST NOT (No Special-Casing Custom Resolvers in Core):** The core `Container` and `FastTopologicalEngine` MUST NOT contain any logic specific to Functors, Monads, Classes, or Functions; they MUST only inspect `node.flags & NodeFlags.UsesCrate` (to decide whether to build `crateProto`) and delegate instantiation to `node.resolver.instantiate(...)`.
- **MUST NOT (No Mutating node.target at Runtime):** Custom `NodeResolverDriver` implementations MUST treat `node.target` as strictly read-only (`readonly target: unknown`) so `TransientScope` and `ScopedScope` resolutions across concurrent child containers remain 100% stateless and race-free.