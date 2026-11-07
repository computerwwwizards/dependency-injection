---
title: "RFC-0009: Closure-Free Functional Injection and V8 Monomorphic Dependency Crates"
status: Normative Specification
date: 2026-11-06
category: Technical Specification
---

# RFC-0009: Closure-Free Functional Injection and V8 Monomorphic Dependency Crates

- **Feature Name:** `closure_free_fp_and_monomorphic_crates`
- **Status:** Normative Specification

## 1. Summary
Defines two low-level V8 memory optimizations: (1) constructing fixed-shape dependency argument objects ("Crates") to prevent V8 Megamorphic dictionary transitions when passing `{ dep1, dep2 }` into factories, and (2) supporting closure-free functional injection (`registerFn`) so functional programming workflows do not allocate heap Context closures on every `TRANSIENT` or `SCOPED` resolution.

## 2. Motivation
1. **The Dynamic `{ [key]: val }` Megamorphic Trap:** In RFC-0002, before calling `node.factory(depsObj)`, the container assembles `depsObj` containing `{ b, b1 }`. If the engine builds `depsObj` using a dynamic loop `const obj = {}; for (const d of depNodes) obj[d.key] = val;`, V8 sees dynamic property additions inside a loop and converts `obj` into Slow Dictionary Mode (Hash Table)! Every destructuring read `({ b, b1 }) => ...` inside the user's factory then suffers a dictionary lookup instead of a 1-instruction Hidden Class offset!
2. **The FP Curried Closure Allocation Tax:** In Functional Programming, writing `register('calc', ['tax'], ({ tax }) => (amount: number) => amount * tax)` allocates a brand-new JSFunction + heap Context every time `'calc'` is resolved in a `SCOPED`, `GRAPH`, or `TRANSIENT` lifetime.

## 3. Guide-Level Explanation
1. **Automatic Prototype Crate Stamping (Invisible to User):** Developers write normal `({ db, tax }) => ...` factories, while the engine pre-allocates a prototype template object per `ProviderNode` so V8 keeps `{ db, tax }` 100% Monomorphic.
2. **Closure-Free Functional Binding (`registerFn`):** For high-throughput functional pipelines, developers can register a static, non-curried pure function `(deps, arg1, arg2) => result` that executes without allocating a new inner closure on every resolution:

```typescript
// Defined ONCE in static memory — zero nested closure `() => () =>`!
const computeTotal = (deps: { tax: number }, amount: number) => amount * (1 + deps.tax);

container.registerFn('computeTotal', ['tax'], computeTotal, { lifetime: 'SCOPED' });
```

## 4. Reference-Level Explanation & Invariants
1. **V8 Monomorphic Crate Prototype per ProviderNode:**
   - During `compile()` (once per node), for a node with `depKeys = ['db', 'tax']`, the engine constructs a single frozen Crate Prototype object with `undefined` placeholders initialized in deterministic order.
   - When resolving the node at runtime, instead of `const depsObj = {}` with dynamic key insertion, the engine clones the exact Hidden Class shape via `Object.create(node.cratePrototype)` or uses a pre-sized positional tuple for 1–4 dependencies, ensuring V8's Inline Cache inside `node.factory({ db, tax })` remains 100% Monomorphic.
2. **Callable Struct Wrapper for `registerFn`:**
   - Instead of allocating a dynamic closure `(arg) => fn(deps, arg)` (which allocates a V8 Context slot on the heap), `registerFn` binds the static function reference and the resolved deps crate using a single shared monomorphic callable dispatcher or static `.call(depsCrate, arg)` invocation path.

## 5. Normative Negative Constraints & Drawbacks
- **MUST NOT:** The resolution loop MUST NOT mutate the key order of a node's dependency crate across calls.
- **MUST NOT:** `registerFn` MUST NOT mutate the passed deps crate within the functional execution path.