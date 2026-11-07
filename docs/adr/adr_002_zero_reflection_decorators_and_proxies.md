---
title: "ADR-002: Zero Runtime Reflection, Zero Decorators, and Zero ES6 Proxy"
status: Accepted
date: 2026-03-07
category: Architecture
---

# ADR-002: Zero Runtime Reflection, Zero Decorators, and Zero ES6 Proxy

- **Status:** Accepted
- **Context:** Decorator-based reflection (`reflect-metadata`, `@Inject`) relies on unstable compiler hacks because TypeScript types vanish at runtime. Conversely, cradle-based autowiring containers (like Awilix) rely on JavaScript's new `Proxy()` trap to intercept property access dynamically, which bypasses V8 Hidden Classes (Maps) and degrades Inline Caches (IC) into slow dictionary lookups. Additionally, runtime code generation (`new Function()` / `eval()`) violates Content Security Policies (CSP) and complicates debugging.
- **Decision:** The container operates with 100% static, monomorphic data structures. All dependency wiring uses explicit provider declarations and fixed-shape V8 objects.
- **Negative Constraints (Explicitly Forbidden):**
  - NO `reflect-metadata`, TypeScript `experimentalDecorators`, or runtime type introspection.
  - NO JavaScript `new Proxy()` traps anywhere in the core resolution loop or dependency cradle.
  - NO dynamic runtime code generation via `new Function()` or `eval()` (leaving AOT code generation strictly to future build-time compilers like Reason/SWC).
  - NO uncontrolled duck-typing or dynamic property mutation on container internal nodes after initialization, preserving V8 Monomorphic Inline Caches.
- **Consequences:**
  - *Positive:* Maximum V8 JIT optimization (stable Hidden Classes), zero bundler/transpiler friction (`isolatedModules` compatible), and strict CSP compliance.
  - *Negative:* Cannot magically autowire undeclared constructor parameters via runtime parameter-name regex parsing or reflection metadata.