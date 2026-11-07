---
title: "RFC-0006: Type-Level State Machine, .declare() Contracts & .use() Plugins"
status: Normative Specification
date: 2026-11-06
category: Technical Specification
---

# RFC-0006: Type-Level State Machine, .declare() Contracts & .use() Plugins

- **Feature Name:** `type_level_state_machine`
- **Status:** Normative Specification

## 1. Summary
Defines the compile-time TypeScript generic state machine on `Container<TProvided, TDeclared, TAsync, TLifetimes>` that delivers 100% automatic type inference, zero-memory `.use(plugin)` composition, compile-time Captive Dependency errors, and compile-time blocking of unfulfilled `.declare()` contracts.

## 2. Motivation
Developers shouldn't have to maintain a central interface `AppDeps` by hand or pass manual generics like `container.get<OrderService>('order')`. At the same time, modular plugins need to declare external dependencies (`.declare<'db', Db>()`) before they are registered, and the compiler must guarantee that every declared dependency is actually registered before `.get()` is called.

## 3. Guide-Level Explanation
1. **Automatic Inference:** Every `.register(key, deps, factory)` call infers the parameter types of `factory` from `deps` and adds the return type of `factory` to the container's type map.
2. **Modular Plugins (`.use`):** A plugin is just a function `(ctx) => ctx.declare<'db', Db>().register(...)`. Calling `container.use(myPlugin)` passes `this` directly into `myPlugin` (0 extra memory allocated!) and merges all declared and provided types into the container chain.
3. **Compile-Time Locks:**
   - If a plugin calls `.declare<'currentUser', User>()`, and you try to call `root.get('orderController')` before registering `'currentUser'`, TypeScript blocks `.get()` at compile time with `"UNFULFILLED_DECLARATION_ERROR: currentUser"`.
   - If you try to register a `SINGLETON` that lists a `SCOPED` or `TRANSIENT` dependency in `deps`, TypeScript underlines the `deps` array in red at compile time with `"CAPTIVE_DEPENDENCY_ERROR"`.

## 4. Reference-Level Explanation
*(Normative generic architecture specifications and conditional type mappings defined in engine type definitions)*
- Evaluates `Missing = Exclude<keyof TDeclared, keyof TProvided>`.
- Evaluates rank compatibility per dependency edge at compile time using conditional tuple type checking.

## 5. Normative Invariants & Negative Constraints
- **INV-6.1 (Zero-Allocation Plugin Typing):** `.use(fn)` MUST NOT allocate any new container instances or proxy objects at runtime.
- **NEG-6.1 (No Unfulfilled Declarations at Entry):** `container.get()` MUST fail compilation if `Exclude<keyof TDeclared, keyof TProvided>` is not `never`.

## 6. Drawbacks
- Complex conditional type signatures can occasionally produce dense TypeScript compiler error messages when developers violate lifetime rules.

## 7. Rationale & Alternatives
- *Why not require a central interface?* Central interfaces defeat modular plugin architecture because plugins cannot modify an external global type without cumbersome declaration merging.

## 8. Unresolved Questions
- None.