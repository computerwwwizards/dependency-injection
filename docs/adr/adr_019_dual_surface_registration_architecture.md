---
title: "ADR-019: Dual-Surface Registration Architecture (Idiomatic Methods + Composable TargetDescriptor Utilities)"
status: "Accepted"
unifies: ["ADR-003", "ADR-006", "ADR-009", "ADR-017", "ADR-018"]
date: "2026-11-07"
category: "Architecture Decision Record"
---

# ADR-019: Dual-Surface Registration Architecture (Idiomatic Methods + Composable TargetDescriptor Utilities)

- **Status:** Accepted (Unifies ADR-003, ADR-006, ADR-009, ADR-017, and ADR-018)
- **Context:** Different engineering teams, paradigms, and AI coding agents have distinct ergonomic expectations when wiring a dependency graph:
  1. OOP & Verb-Oriented Agents/Developers expect idiomatic, self-documenting methods directly on the container (`container.registerClass(...)`, `container.registerFn(...)`, `container.registerValue(...)`, `container.registerAsync(...)`, `container.registerUnsafe(...)`, `container.registerWith(...)`) so IDE autocomplete immediately reveals every supported capability without hunting for external imports.
  2. Functional & Composition-Oriented Agents/Developers prefer a minimal single-verb surface (`container.register(key, deps, descriptor, scope?)`) where behavior is composed via external Higher-Order Function (HOF) descriptor utilities (`asClass(Ctor)`, `asFn(fn)`, `asValue(val)`, `asAsync(fn)`, `asUnsafe(fn)`, `asFunctor(fn)`) that can be piped, wrapped in `asThunk()` or `asVirtualProxy()`, and tree-shaken when unused.
  3. If these two surfaces implemented separate internal mechanics, the container would suffer from duplicated validation logic, divergent TypeScript inference rules, and inconsistent V8 Hidden Classes.
- **Decision:** Support both idiomatic container methods and composable `TargetDescriptor` HOF utilities as first-class citizens via Canonical Descriptor Lowering:
  1. **The Canonical `TargetDescriptor` Protocol:** Every HOF utility (`asClass`, `asFn`, `asValue`, `asAsync`, `asUnsafe`, `asThunk`, `asVirtualProxy`, `asFunctor`, `asMonad`) returns a standardized, lightweight `TargetDescriptor<TTarget, TDeps, TOut, TFlags>` struct pointing to a shared static `NodeResolverDriver` singleton.
  2. **Unified `.register()` Entry Point:** `container.register(key, deps, targetOrDescriptor, scope?)` inspects whether the 3rd argument is a `TargetDescriptor` or a standard Crate Factory `(crate) => R`, and populates the 13-field monomorphic `ProviderNode` accordingly.
  3. **Idiomatic Sugar Methods (`registerClass`, `registerFn`, `registerValue`, `registerAsync`, `registerUnsafe`, `registerWith`):** Remain on the Container class for idiomatic ergonomics and IDE discoverability, implemented as 1-line inline delegates that forward directly to the same internal descriptor-binding pipeline using the shared static `NodeResolverDriver` singletons.
  4. **Composable Descriptor Stacking (`pipeDescriptors` / Wrapping):** Because `TargetDescriptor` utilities are pure functions returning `{ __isDescriptor: true, target, resolver, flags }`, utilities can wrap other descriptors (e.g., `asThunk(asClass(HeavyPdfEngine))` or `asVirtualProxy(PdfProto, asClass(HeavyPdfEngine))`) without allocating intermediate userland closures!
- **Negative Constraints (Explicitly Forbidden):**
  - NO divergence in runtime `ProviderNode` memory shape between `.registerClass('a', ['b'], Cls)` and `.register('a', ['b'], asClass(Cls))`—both MUST produce byte-for-byte identical `ProviderNode` structs in V8 memory.
  - NO per-call closure allocation inside `asClass`, `asFn`, or `asValue`—each utility MUST bind the global static `NodeResolverDriver` reference (`ClassPositionalResolver`, `FnPositionalResolver`, `ValueResolver`).
  - NO allocating a `{ dep1, dep2 }` Crate (`crateProto`) when a `TargetDescriptor` wraps a positional `asClass` or `asFn` target inside `asThunk` or `asVirtualProxy`.
- **Consequences:**
  - **Positive:** 100% ergonomic adaptability for both OOP/method-chained styles and FP/utility-composed styles; enables zero-closure composition like `asThunk(asClass(Service))`; keeps the core engine unified around a single `ProviderNode` allocation pipeline.
  - **Negative:** Requires maintaining parallel TypeScript method overloads on Container (`registerClass` vs. `register(..., asClass())`), mitigated by sharing the underlying TypeScript generic helper types (`MapDepsTuple`, `ValidateCaptiveRanks`).