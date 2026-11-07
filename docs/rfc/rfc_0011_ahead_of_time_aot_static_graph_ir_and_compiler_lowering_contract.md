---
title: "RFC-0011: Ahead-of-Time (AOT) Static Graph IR and Compiler Lowering Contract"
status: Normative Specification
date: 2026-11-06
category: Technical Specification
---

# RFC-0011: Ahead-of-Time (AOT) Static Graph IR and Compiler Lowering Contract

- **Feature Name:** `aot_compiler_ir_contract`
- **Status:** Normative Specification

## 1. Summary
Defines the portable Intermediate Representation (IR) JSON/AST schema emitted by the container's static DAG analyzer so future Ahead-of-Time (AOT) build compilers (written in ReasonML/OCaml, Rust/SWC, or TypeScript AST transformers) can lower static `register()` graphs into zero-overhead, unrolled static code at build time—without ever using runtime `new Function()`.

## 2. Motivation
In our discussion, we explicitly banned runtime `new Function()` (ADR-002), while noting that knowing the static graph (`register('a', ['b', 'b1'])`) ahead of time allows a future compiler (such as a Reason/OCaml or SWC build step) to eliminate the container overhead entirely for static paths. To make the runtime container 100% forward-compatible with a future AOT compiler, we must standardize the Static Graph Intermediate Representation (IR).

## 3. Guide-Level Explanation
At build time (or via `container.exportIR()`), the container outputs a deterministic, language-agnostic DAG schema that an AOT compiler can lower directly into flat static wiring functions:

```typescript
// Exported by `container.exportIR()` for AOT build tools / Reason compiler:
// Lowered by AOT Compiler at build-time into a flat, zero-lookup module:
export function __aot_resolve_orderController(rootSingletons, childScopedCache) {
  const s0 = (rootSingletons.dbPool ??= createDbPool());
  const g1 = createUnitOfWork({ dbPool: s0 }); // GRAPH Diamond C in local stack register!
  const b0 = createBilling({ uow: g1 });
  const b1 = createShipping({ uow: g1 });
  return new OrderController({ billing: b0, shipping: b1 });
}
```

## 4. Reference-Level Explanation & Invariants
1. **Deterministic Static IR Schema (`StaticGraphIR`):**
   - `container.exportIR()` MUST output a strictly ordered, serializable structure containing:
     - `nodes`: Array of `{ id: number, key: string, lifetime: 0|1|2|3, flags: number, deps: number[], topologicalOrder: number[] }`.
     - `boundaries`: Array of `IsUnsafe` node keys where AOT unrolling MUST pause and hand control back to `trackedCtx.get()`.
     - `declarations`: Array of unfulfilled `.declare()` contracts required by Child Containers as input parameters to the generated AOT function.
2. **Semantic Equivalence Invariant:**
   - Code lowered by an AOT compiler from `StaticGraphIR` MUST preserve identical instantiation ordering (`topologicalOrder`), Diamond `GRAPH` local-variable sharing (`const g1`), and Captive Dependency errors as the runtime RFC-0002 interpreter.

## 5. Normative Negative Constraints & Drawbacks
- **MUST NOT:** The runtime library MUST NOT depend on the AOT compiler to function; the AOT compiler is strictly an optional build-time optimization pass over the exact same `register()` syntax.
- **MUST NOT:** The AOT lowering pass MUST NOT inline across `registerUnsafe` boundaries.