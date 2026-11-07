---
title: "ADR-017: Zero-Wrapper Target Registration & V8 Lexical Context Leak Prevention"
status: "Accepted"
extends: ["ADR-001", "ADR-002"]
updates: ["RFC-0009"]
date: "2026-11-07"
category: "Architecture Decision Record"
---

# ADR-017: Zero-Wrapper Target Registration & V8 Lexical Context Leak Prevention

- **Status:** Accepted (Extends ADR-001 & ADR-002; Updates RFC-0009)
- **Context:** Forcing every registration through an anonymous wrapper closure `register('order', ['db', 'tax'], ({ db, tax }) => new OrderService(db, tax))` introduces three severe runtime and memory penalties in V8:
  1. **Boot-Time Closure Allocation Tax:** Every registration allocates an unnecessary wrapper `JSFunction` and heap `Context` just to forward arguments to a class constructor or function.
  2. **Runtime Crate Object Allocation Tax:** On every cache miss (especially in `TransientScope` or `ScopedScope`), the resolver must allocate and populate an intermediate `{ db, tax }` Crate object just so the wrapper closure can immediately destructure it into positional arguments.
  3. **V8 Shared Lexical Context Memory Leaks:** In V8, all closures declared inside the same lexical scope (such as a `main.ts` setup function or a `.use(plugin)` body) share a single heap-allocated `Context` structure if any closure captures a local variable. Writing inline `(deps) => new Service(deps)` closures can unintentionally retain large initialization buffers, raw config ASTs, or temporary setup objects alive in RAM for the lifetime of the container.
- **Decision:** Replace `readonly factory: Function` on `ProviderNode` with a generalized `readonly target: unknown` slot, and provide dedicated Zero-Wrapper Registration Paths backed by specialized `NodeResolverDriver` implementations:
  1. **`registerValue(key, rawValue)`:** Pre-populates `node.instance = rawValue` at registration time with zero closures and zero runtime instantiation calls.
  2. **`registerClass(key, ['dep1', 'dep2'], ClassCtor, scope?)`:** Stores the raw `ClassCtor` constructor reference in `node.target` and binds `ClassPositionalResolver`. At runtime, dependencies are resolved positionally and passed directly into `new ClassCtor(d0, d1, ...)` via V8’s fast Construct Stub Inline Cache—allocating zero wrapper closures at boot and zero `{ dep1, dep2 }` Crate objects at runtime.
  3. **`registerFn(key, ['dep1', 'dep2'], staticFn, scope?)`:** Stores a top-level static function `(dep1, dep2, ...callArgs) => R` in `node.target` and binds `FnPartialResolver`, partially applying the injected dependencies positionally without requiring nested curried closures `(deps) => (arg) => ...` in userland code.
- **Negative Constraints (Explicitly Forbidden):**
  - NO allocating a `{ dep1, dep2 }` Crate object (`crateProto`) for nodes registered via `registerClass`, `registerFn`, or `registerValue` (`node.crateProto` MUST remain null).
  - NO wrapping `ClassCtor`, `staticFn`, or `rawValue` inside an internal anonymous closure `() => ...` during `.registerClass()`, `.registerFn()`, or `.registerValue()`.
  - NO using `Function.prototype.bind()` inside `FnPartialResolver` on the hot path if a monomorphic callable struct or arity-switched dispatcher avoids V8 bound-function exotic object overhead.
- **Consequences:**
  - **Positive:** Eliminates 100% of wrapper closures and intermediate `{ dep1, dep2 }` Crate allocations for standard class, function, and value registrations; makes accidental V8 shared-lexical-context memory leaks impossible for static classes and top-level functions.
  - **Negative:** `registerClass` and `registerFn` require the deps array order `['db', 'tax']` to match the exact positional parameter order of the constructor or function (enforced at compile time by TypeScript tuple mapping).