---
title: "RFC-0018: Composable TargetDescriptor Utilities (asClass, asFn, asValue, asAsync, asUnsafe) and Descriptor Stacking Protocol"
feature_name: "composable_target_descriptors_and_idiomatic_methods"
status: "Proposed"
start_date: "2026-11-07"
related_adrs: ["ADR-001", "ADR-002", "ADR-003", "ADR-006", "ADR-009", "ADR-015", "ADR-017", "ADR-018", "ADR-019"]
category: "Request for Comments"
---

# RFC-0018: Composable TargetDescriptor Utilities (asClass, asFn, asValue, asAsync, asUnsafe) and Descriptor Stacking Protocol

- **Feature Name:** `composable_target_descriptors_and_idiomatic_methods`
- **Start Date:** 2026-11-07
- **Related ADRs:** ADR-001, ADR-002, ADR-003, ADR-006, ADR-009, ADR-015, ADR-017, ADR-018, ADR-019 (Unifies RFC-0006, RFC-0016, RFC-0017)

## 1. Summary
Defines the formal specification for authoring, composing, and lowering `TargetDescriptor` utilities (`asClass`, `asFn`, `asValue`, `asAsync`, `asUnsafe`, `asThunk`, `asVirtualProxy`, `asFunctor`, `asMonad`) alongside idiomatic Container registration methods (`registerClass`, `registerFn`, `registerValue`, `registerAsync`, `registerUnsafe`, `registerWith`).

## 2. Motivation
In RFC-0006, decorators like `asThunk` and `asVirtualProxy` were designed to wrap Crate Factories `(deps) => R`. Later, in RFC-0016 and RFC-0017, we introduced zero-wrapper positional targets (`OrderService` class, `calcTotal` function, Functor map) to eliminate wrapper closures and `{ dep1, dep2 }` Crate objects.
What happens if a developer wants a Lazy Thunk of a Positional Class (`asThunk(asClass(HeavyService))`) or an Idiomatic Method call (`container.registerClass(...)`)?
By standardizing the `TargetDescriptor` Protocol, we achieve two major goals:
1. **Ergonomic Equivalence:** Both `container.registerClass('s', ['db'], Svc)` and `container.register('s', ['db'], asClass(Svc))` execute the exact same code path.
2. **Zero-Closure Descriptor Composition:** Higher-order utilities (`asThunk`, `asVirtualProxy`) can wrap positional descriptors (`asClass`, `asFn`, `asFunctor`) directly by composing their `NodeResolverDriver`s—without ever falling back to a `{ dep1, dep2 }` Crate or an inline arrow closure!

## 3. Guide-Level Explanation

```typescript
import {
  Container,
  asClass,
  asFn,
  asValue,
  asAsync,
  asUnsafe,
  asThunk,
  asVirtualProxy,
} from '@my-di/core';

const app = new Container()
  // =========================================================================
  // STYLE A: Idiomatic Container Methods (Great for OOP & Method-Discovery)
  // =========================================================================
  .registerValue('taxRate', 0.15)
  .registerClass('db', [], PostgresPool, 'singleton')
  .registerFn('calcTax', ['taxRate'], (rate: number, amt: number) => amt * rate, 'scoped')

  // =========================================================================
  // STYLE B: Unified `.register()` + Descriptor Utils (Great for FP & Piping)
  // =========================================================================
  .register('port', [], asValue(8080))
  .register('userRepo', ['db'], asClass(UserRepository), 'scoped')
  .register('formatPrice', ['taxRate'], asFn(formatWithTax), 'scoped')
  .register('searchChunk', ['db'], asAsync(async ({ db }) => (await import('./search.js')).init(db)))
  .register('dynamicPlugin', [], asUnsafe((ctx) => ctx.get(process.env.PLUGIN_KEY!)))

  // =========================================================================
  // STYLE C: Composable Descriptor Stacking (Zero-Closure Wrapping!)
  // =========================================================================
  // Wraps `asClass(HeavyPdfEngine)` inside `asThunk` — zero arrow closure written,
  // zero `{ db, taxRate }` Crate allocated, and safe for a Singleton to inject!
  .register('lazyPdf', ['db', 'taxRate'], asThunk(asClass(HeavyPdfEngine)), 'transient')
  .register('pdfProxy', ['db', 'taxRate'], asVirtualProxy(HeavyPdfEngine.prototype, asClass(HeavyPdfEngine)), 'singleton');
```

## 4. Reference-Level Explanation & Invariants

### 4.1 The Canonical TargetDescriptor Interface
Every descriptor utility MUST return a frozen or monomorphic object matching the `TargetDescriptor` shape:

```typescript
export const DESCRIPTOR_SYMBOL = Symbol.for('@my-di/TargetDescriptor');

export interface TargetDescriptor<
  TTarget = unknown,
  TExpectedDeps = any, // Either `'CRATE'` (named object) or a Positional Tuple `[Dep0, Dep1, ...]`
  TOut = unknown,
  TFlags extends number = 0
> {
  readonly [DESCRIPTOR_SYMBOL]: true;
  readonly target: TTarget;
  readonly resolver: NodeResolverDriver<TTarget, TExpectedDeps, TOut>;
  readonly flags: NodeFlags;
  /**
   * Compile-time phantom property carrying the binding mode ('CRATE' vs 'POSITIONAL' vs 'UNSAFE')
   * and bitmask flags (IsAsync, IsThunk, IsUnsafe) for TypeScript's `.register()` overload!
   */
  readonly __meta?: {
    depsMode: TExpectedDeps;
    out: TOut;
    flags: TFlags;
  };
}
```

### 4.2 Reference Implementation of Core Descriptor Utilities
All built-in descriptor utilities MUST reuse static `NodeResolverDriver` singletons so zero closures are allocated per call:

```typescript
// 1. `asValue(val)` — Pre-cached constant (Zero closures, zero Crate)
export function asValue<V>(value: V): TargetDescriptor<V, readonly [], V, 0> {
  return {
    [DESCRIPTOR_SYMBOL]: true,
    target: value,
    resolver: ValueResolver, // Static singleton
    flags: NodeFlags.None,
  };
}

// 2. `asClass(Ctor)` — Positional constructor injection (Zero closures, zero Crate)
export function asClass<Args extends readonly unknown[], R>(
  ctor: new (...args: Args) => R
): TargetDescriptor<typeof ctor, Args, R, 0> {
  return {
    [DESCRIPTOR_SYMBOL]: true,
    target: ctor,
    resolver: ClassPositionalResolver, // Static singleton from RFC-0016 §4.2
    flags: NodeFlags.None,
  };
}

// 3. `asFn(fn)` — Positional prefix partial application (Zero closures, zero Crate)
export function asFn<Args extends readonly unknown[], R>(
  fn: (...args: Args) => R
): TargetDescriptor<typeof fn, 'FN_PREFIX', typeof fn, 0> {
  return {
    [DESCRIPTOR_SYMBOL]: true,
    target: fn,
    resolver: FnPositionalResolver, // Static singleton from RFC-0016 §4.3
    flags: NodeFlags.None,
  };
}

// 4. `asAsync(asyncFactoryOrDescriptor)` — Graph-level Async (Sets NodeFlags.IsAsync)
export function asAsync<D, R>(
  factory: (deps: D) => Promise<R>
): TargetDescriptor<typeof factory, 'CRATE', R, NodeFlags.IsAsync> {
  return {
    [DESCRIPTOR_SYMBOL]: true,
    target: factory,
    resolver: AsyncCrateResolver, // Static singleton from RFC-0004 / RFC-0014
    flags: NodeFlags.IsAsync | NodeFlags.UsesCrate,
  };
}

// 5. `asUnsafe(unsafeFactory)` — Dynamic Escape Hatch (Sets NodeFlags.IsUnsafe)
export function asUnsafe<R>(
  factory: (ctx: TrackedContext) => R
): TargetDescriptor<typeof factory, readonly [], R, NodeFlags.IsUnsafe> {
  return {
    [DESCRIPTOR_SYMBOL]: true,
    target: factory,
    resolver: UnsafeDynamicResolver, // Static singleton from RFC-0013 §4.3
    flags: NodeFlags.IsUnsafe,
  };
}

// 6. `asCustom(target, resolverDriver)` — For Functors, Monads, Streams (RFC-0017)
export function asCustom<TTarget, TDeps, TOut>(
  target: TTarget,
  resolver: NodeResolverDriver<TTarget, TDeps, TOut>
): TargetDescriptor<TTarget, TDeps, TOut, 0> {
  return {
    [DESCRIPTOR_SYMBOL]: true,
    target,
    resolver,
    flags: resolver.usesCrate ? NodeFlags.UsesCrate : NodeFlags.None,
  };
}
```

### 4.3 Higher-Order Descriptor Composition (`asThunk` & `asVirtualProxy`)
Unlike naive HOFs that only accept functions, `asThunk` and `asVirtualProxy` accept either a raw Crate Factory `(deps) => R` or any `TargetDescriptor` (such as `asClass(HeavyPdf)` or `asFn(heavyCalc)`):

```typescript
// Static higher-order resolver that wraps ANY inner NodeResolverDriver in a lazy thunk `() => T`!
const ThunkDescriptorResolver: NodeResolverDriver = {
  id: 'thunk-wrapper',
  instantiate<T>(node: KernelNodeHandle<T>, caller: KernelContainerHandle, ctx: KernelCallContext): T {
    const inner = node.target as TargetDescriptor;
    // Returns a thunk that invokes the inner descriptor's exact positional/crate resolver on demand!
    return (() => inner.resolver.instantiate(
      { ...node, target: inner.target, resolver: inner.resolver },
      caller,
      ctx
    )) as unknown as T;
  },
};

export function asThunk<TTarget, TDeps, TOut, TFlags extends number>(
  input: TargetDescriptor<TTarget, TDeps, TOut, TFlags> | ((deps: any) => TOut)
): TargetDescriptor<any, TDeps, () => TOut, TFlags | NodeFlags.IsThunk> {
  const innerDesc: TargetDescriptor =
    typeof input === 'function'
      ? { [DESCRIPTOR_SYMBOL]: true, target: input, resolver: SyncCrateResolver, flags: NodeFlags.UsesCrate }
      : input;

  return {
    [DESCRIPTOR_SYMBOL]: true,
    target: innerDesc,
    resolver: ThunkDescriptorResolver,
    // Preserves inner UsesCrate flag (0 for asClass!) and adds NodeFlags.IsThunk!
    flags: (innerDesc.flags & NodeFlags.UsesCrate) | NodeFlags.IsThunk,
  };
}
```

- **Why This Is Huge:** When you write `asThunk(asClass(HeavyPdfEngine))`, `innerDesc.flags` does not have `NodeFlags.UsesCrate`! So even when wrapped in `asThunk` or `asVirtualProxy`, `HeavyPdfEngine` is still instantiated positionally via `ClassPositionalResolver` (`new HeavyPdfEngine(d0, d1)`) with zero `{ dep1, dep2 }` Crate allocated and zero userland wrapper closures!

### 4.4 Canonical Lowering of Idiomatic Container Methods
Inside Container, all idiomatic registration methods MUST be implemented as 1-line delegates to the unified internal `_bindNode(key, deps, target, resolver, flags, scope)` method:

```typescript
// All idiomatic methods and `.register(..., asX())` converge on the exact same internal binder:
registerClass(key, deps, ctor, scope) {
  return this._bindNode(key, deps, ctor, ClassPositionalResolver, NodeFlags.None, scope);
}
registerFn(key, deps, fn, scope) {
  return this._bindNode(key, deps, fn, FnPositionalResolver, NodeFlags.None, scope);
}
registerValue(key, value) {
  return this._bindValueNode(key, value);
}
registerAsync(key, deps, asyncFn, scope) {
  return this._bindNode(key, deps, asyncFn, AsyncCrateResolver, NodeFlags.IsAsync | NodeFlags.UsesCrate, scope);
}
registerUnsafe(key, unsafeFn, scope) {
  return this._bindNode(key, [], unsafeFn, UnsafeDynamicResolver, NodeFlags.IsUnsafe, scope);
}
registerWith(key, deps, target, resolver, scope) {
  const flags = resolver.usesCrate ? NodeFlags.UsesCrate : NodeFlags.None;
  return this._bindNode(key, deps, target, resolver, flags, scope);
}
```

## 5. Normative Negative Constraints & Drawbacks
- **MUST NOT (No Second-Class Citizens):** Neither the idiomatic methods (`registerClass`, etc.) nor the descriptor utilities (`asClass`, etc.) may have capabilities that cannot be expressed in the other; every idiomatic method corresponds 1:1 to a `TargetDescriptor` constructor.
- **MUST NOT (No Double-Wrapping `asUnsafe`):** `asUnsafe` nodes MUST always declare `deps = []`. Wrapping `asUnsafe` inside `asAsync` or vice versa MUST preserve `NodeFlags.IsUnsafe` so DevTools and runtime cycle checks (`resolvingNow`) remain active.
- **MUST NOT (No Persistent Descriptor Allocation in ProviderNode):** When `container.register(key, deps, descriptor, scope)` executes for a non-nested descriptor (like `asClass(Ctor)`), `_bindNode` MUST unpack `descriptor.target` (`Ctor`) and `descriptor.resolver` (`ClassPositionalResolver`) directly into `node.target` and `node.resolver` so the temporary descriptor object is immediately collected in V8’s nursery generation and requires 0 pointer indirection during `.get()`.