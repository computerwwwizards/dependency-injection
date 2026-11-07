---
title: "RFC-0016: Zero-Wrapper Positional Registration (registerValue, registerClass, registerFn) and V8 Arity Dispatch"
feature_name: "zero_wrapper_positional_registration"
status: "Proposed"
start_date: "2026-11-07"
related_adrs: ["ADR-001", "ADR-002", "ADR-004", "ADR-010", "ADR-015", "ADR-017"]
category: "Request for Comments"
---

# RFC-0016: Zero-Wrapper Positional Registration (registerValue, registerClass, registerFn) and V8 Arity Dispatch

- **Feature Name:** `zero_wrapper_positional_registration`
- **Start Date:** 2026-11-07
- **Related ADRs:** ADR-001, ADR-002, ADR-004, ADR-010, ADR-015, ADR-017 (Updates RFC-0001, RFC-0005, RFC-0009, RFC-0014)

## 1. Summary
Specifies the runtime `NodeResolverDriver` implementations and compile-time TypeScript tuple-validation signatures for `registerValue`, `registerClass`, and `registerFn`, eliminating registration wrapper closures, runtime `{ dep1, dep2 }` Crate allocations, and V8 lexical scope retention leaks.

## 2. Motivation
In RFC-0009, we optimized `{ dep1, dep2 }` Crate creation using `Object.create(node.crateProto)`. However, for a class `class OrderService { constructor(db: Db, tax: number) {} }` or a top-level function `function calc(db: Db, tax: number, amount: number)`, allocating a Crate object at runtime AND requiring the developer to write an inline arrow function `({ db, tax }) => new OrderService(db, tax)` at registration time is completely unnecessary work. Passing `OrderService` or `calc` directly with positional `['db', 'tax']` keys allows the engine to pass resolved dependencies straight into V8's stack frames.

## 3. Guide-Level Explanation

```typescript
// 1. ZERO-CLOSURE VALUE: Pre-cached in `node.instance` at registration!
app.registerValue('taxRate', 0.15);

// 2. ZERO-CLOSURE CLASS: Passes `PostgresPool` and `OrderService` class constructors directly!
//    TypeScript verifies at compile-time that `['db', 'taxRate']` matches `OrderService` constructor params!
class OrderService {
  constructor(private db: PostgresPool, private taxRate: number) {}
  checkout(amount: number) { return this.db.save(amount * (1 + this.taxRate)); }
}

app.registerClass('db', [], PostgresPool, 'singleton');
app.registerClass('orderService', ['db', 'taxRate'], OrderService, 'scoped');

// 3. ZERO-CLOSURE STATIC FUNCTION: Injects the first N parameters (`db`, `taxRate`),
//    and returns a callable function accepting the remaining parameters (`amount: number`)!
function calculateTotal(db: PostgresPool, taxRate: number, amount: number): Promise<string> {
  return db.save(amount * (1 + taxRate));
}

app.registerFn('calcTotal', ['db', 'taxRate'], calculateTotal, 'scoped');

// Inferred type of `calc`: `(amount: number) => Promise<string>`!
const calc = app.get('calcTotal');
await calc(100);
```

## 4. Reference-Level Explanation & Invariants

### 4.1 Updated ProviderNode Target Slot (Updates RFC-0014 §4.1)
Offset 12 of `ProviderNode` is renamed from `factory: Function` to `readonly target: unknown`.
- For `register()` (Crate Factory): `node.target` holds the `(crate) => R` function, and `node.crateProto` is initialized during `compileNode()`.
- For `registerValue()`: `node.target` is `undefined`, `node.instance` is set to `rawValue` immediately inside `registerValue()`, `node.compiledEpoch` is set to `MAX_SMI` (never needs compilation), and `node.crateProto` is `null`.
- For `registerClass()` and `registerFn()`: `node.target` holds the raw `ClassCtor` or `staticFn` pointer, and `node.crateProto` MUST remain `null` (saving memory and compilation time).

### 4.2 ClassPositionalResolver & V8 Arity Switch Dispatch
To avoid allocating intermediate arrays (`deps.map(...)`) and spread arguments (`new Ctor(...args)`) on the hot path for common constructor sizes (0 to 5 dependencies), `ClassPositionalResolver` MUST dispatch via an inline arity switch:

```typescript
export const ClassPositionalResolver: NodeResolverDriver = {
  id: 'class-positional',
  instantiate<T>(node: KernelNodeHandle<T>, caller: KernelContainerHandle, ctx: KernelCallContext): T {
    const Ctor = node.target as new (...args: unknown[]) => T;
    const d = node.depNodes;
    switch (d.length) {
      case 0: return new Ctor();
      case 1: return new Ctor(
        d[0].scope.resolve(d[0], caller, ctx)
      );
      case 2: return new Ctor(
        d[0].scope.resolve(d[0], caller, ctx),
        d[1].scope.resolve(d[1], caller, ctx)
      );
      case 3: return new Ctor(
        d[0].scope.resolve(d[0], caller, ctx),
        d[1].scope.resolve(d[1], caller, ctx),
        d[2].scope.resolve(d[2], caller, ctx)
      );
      case 4: return new Ctor(
        d[0].scope.resolve(d[0], caller, ctx),
        d[1].scope.resolve(d[1], caller, ctx),
        d[2].scope.resolve(d[2], caller, ctx),
        d[3].scope.resolve(d[3], caller, ctx)
      );
      default: {
        const args = new Array(d.length);
        for (let i = 0; i < d.length; i++) {
          args[i] = d[i].scope.resolve(d[i], caller, ctx);
        }
        return new Ctor(...args);
      }
    }
  },
};
```

### 4.3 FnPositionalResolver (Zero-Crate Partial Application)
When `registerFn(key, deps, staticFn, scope?)` is resolved, `FnPositionalResolver` resolves the injected prefix arguments `d[0]..d[k-1]` directly from `node.depNodes` without allocating a Crate object, and returns a lightweight arity-specialized invoker for the remaining domain arguments:

```typescript
export const FnPositionalResolver: NodeResolverDriver = {
  id: 'fn-positional',
  instantiate<T>(node: KernelNodeHandle<T>, caller: KernelContainerHandle, ctx: KernelCallContext): T {
    const fn = node.target as Function;
    const d = node.depNodes;
    switch (d.length) {
      case 0: return fn as unknown as T; // 0 deps: returns the raw static function pointer with ZERO allocation!
      case 1: {
        const d0 = d[0].scope.resolve(d[0], caller, ctx);
        return ((...args: unknown[]) => fn(d0, ...args)) as unknown as T;
      }
      case 2: {
        const d0 = d[0].scope.resolve(d[0], caller, ctx);
        const d1 = d[1].scope.resolve(d[1], caller, ctx);
        return ((...args: unknown[]) => fn(d0, d1, ...args)) as unknown as T;
      }
      // ... cases 3..4 and default array fallback
    }
  },
};
```

- **Crucial Optimization when `d.length === 0`:** If a pure function has 0 dependencies (`registerFn('add', [], addFn)`), `FnPositionalResolver` returns the exact static `addFn` pointer with 0 heap allocations!

### 4.4 Compile-Time Positional Tuple Validation (RFC-0005 Extension)
Unlike `register()` (where `['db', 'tax']` can be listed in any order because they are destructured by name `{ db, tax }`), `registerClass` and `registerFn` are positional. Therefore, the TypeScript signature MUST validate that the tuple of types mapped from `Deps` is assignable to the constructor parameters or function prefix parameters:

```typescript
// Maps ['db', 'taxRate'] -> [PostgresPool, number]
type MapDepsTuple<
  TMap extends Record<string, any>,
  Deps extends readonly (keyof TMap)[]
> = {
  [I in keyof Deps]: TMap[Deps[I]];
};

// 1. Compile-Time Positional Check on `registerClass`:
registerClass<
  K extends string,
  const Deps extends readonly (keyof (TProvided & TDeclared))[],
  Ctor extends new (...args: MapDepsTuple<TProvided & TDeclared, Deps>) => any,
  S extends keyof TScopes | ScopePolicy<number> = TDefaultScope
>(
  key: K,
  deps: ValidateCaptiveRanks<K, Deps, S, TLifetimes, TScopes, TDefaultScope>,
  ctor: Ctor,
  scope?: S
): Container<TProvided & Record<K, InstanceType<Ctor>>, ...>;

// 2. Compile-Time Positional Prefix Slicing on `registerFn`:
// Strips the injected prefix `MapDepsTuple<..., Deps>` and infers the remaining `(...rest: RestArgs) => R`!
registerFn<
  K extends string,
  const Deps extends readonly (keyof (TProvided & TDeclared))[],
  RestArgs extends unknown[],
  R,
  S extends keyof TScopes | ScopePolicy<number> = TDefaultScope
>(
  key: K,
  deps: ValidateCaptiveRanks<K, Deps, S, TLifetimes, TScopes, TDefaultScope>,
  fn: (...args: [...MapDepsTuple<TProvided & TDeclared, Deps>, ...RestArgs]) => R,
  scope?: S
): Container<TProvided & Record<K, (...args: RestArgs) => R>, ...>;
```

## 5. Normative Negative Constraints & Drawbacks
- **MUST NOT (No Crate Allocation on Positional Nodes):** `compileNode()` MUST skip `crateProto` creation whenever `node.resolver !== defaultSyncResolver && node.resolver !== defaultAsyncResolver` (or when `node.flags & NodeFlags.UsesCrate` is not set).
- **MUST NOT (No Disposing registerValue Constants Unless Requested):** `registerValue(key, val)` stores an externally provided constant/reference; `container.dispose()` resets `node.instance = undefined` so the container drops its pointer, but MUST NOT automatically invoke methods on `val` unless an explicit `onDispose` hook was registered.