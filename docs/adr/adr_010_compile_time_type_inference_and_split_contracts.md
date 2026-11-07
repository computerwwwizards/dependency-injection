---
title: "ADR-010: Compile-Time Type Inference, .use(plugin), and Split .declare<K, V>() Contracts"
status: Accepted
date: 2026-03-07
category: Architecture
---

# ADR-010: Compile-Time Type Inference, .use(plugin), and Split .declare<K, V>() Contracts

- **Status:** Accepted
- **Context:** Writing manual `get<ServiceA>('a')` generics or maintaining a giant central interface `AppDeps` is error-prone boilerplate. Furthermore, creating separate containers and calling `.merge()` wastes memory by allocating duplicate container structures. However, modular plugins need a way to declare external or out-of-order dependencies (like `'db'` or child-scoped `'currentUser'`) before those dependencies are registered, without losing compile-time verification that every declared dependency was eventually provided.
- **Decision:**
  1. **Fluent Type Accumulation:** `Container<TProvided, TDeclared, TAsync>` infers and accumulates return types automatically from each `.register()` call, typing both `({ dep1, dep2 })` inside factories and `container.get('key')` automatically.
  2. **Zero-Allocation Plugins (`.use(pluginFn)`):** `.use(fn)` passes the exact same `this` reference into `fn(this)` and adopts the returned container's accumulated type generics—allocating zero extra containers or maps in memory.
  3. **Split TDeclared vs. TProvided Generics (`.declare<K, V>()`):** `.declare<'db', Db>()` is a zero-runtime-cost phantom method that adds `'db': Db` to `TDeclared` so plugins and out-of-order factories can depend on `['db']` immediately. Calling `.register('db', ...)` adds `'db'` to `TProvided`.
  4. **Compile-Time Unfulfilled Declaration Lock:** `container.get()` computes `Missing = Exclude<keyof TDeclared, keyof TProvided>`. If `Missing` is not `never`, TypeScript blocks `container.get()` at compile time with a descriptive type error listing the unfulfilled keys!
  5. **Automatic Async Taint Propagation:** If any key in a provider's `deps` array belongs to `TAsync`, the provider's own key is automatically added to `TAsync`, switching `container.get(key)` from `TProvided[K]` to `Promise<TProvided[K]>`.
- **Negative Constraints (Explicitly Forbidden):**
  - NO `.merge(otherContainer)` method that allocates intermediate container instances.
  - NO permitting `container.get()` to compile if any `.declare<K, V>()` contract remains unfulfilled by a `.register()` call in that container hierarchy.
  - NO partial generic type argument traps on `.register()`.
- **Consequences:**
  - *Positive:* 100% end-to-end type inference with zero manual interfaces, zero-cost modular plugins, compile-time enforcement of Child Container prerequisites, and automatic Promise return-type inference for async graphs.
  - *Negative:* Complex conditional TypeScript types inside the `Container` class definition (hidden from the user, who only sees clean autocomplete and readable error strings).