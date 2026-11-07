---
title: "ADR-013: Scope Inversion & Pluggable Storage Drivers (ScopePolicy)"
status: "Accepted"
supersedes: ["ADR-005", "ADR-006"]
date: "2026-11-07"
category: "Architecture Decision Record"
---

# ADR-013: Scope Inversion & Pluggable Storage Drivers (ScopePolicy)

- **Status:** Accepted (Supersedes the hardcoded enum switch in ADR-005 and decorator workarounds in ADR-006)
- **Context:** Hardcoding SINGLETON, SCOPED, GRAPH, and TRANSIENT inside a central switch (`node.lifetime`) statement inside the container kernel violates the micro-kernel principle. If an application never uses GRAPH scope, the `activeGraphCache` allocation and switch branch remain dead code in the production bundle and add unnecessary CPU branch evaluations during `.get()`. Furthermore, forcing custom lifetimes like TTL or Object Pool to be external factory wrappers (`withTtl`) disguised as TRANSIENT nodes broke the Captive Dependency Rank checker (forcing a SINGLETON to treat a TTL node as Rank 0 TRANSIENT rather than Rank 3) and prevented custom scopes from hooking into `container.onDispose()`. Similarly, `registerUnsafe` required runtime cycle-detection sets (`resolvingNow`) and parallel dynamic edge caches that should not exist in memory if an application only uses safe static registrations.
- **Decision:** Invert scope and resolver ownership out of the container kernel into pluggable, tree-shakeable drivers:
  1. **`ScopePolicy<TRank extends number>` Driver Contract:** The core container knows zero concrete lifetimes. Instead, each `ProviderNode` delegates resolution to `node.scope.resolve(node, callingContainer, callContext)`. A `ScopePolicy` is a fixed-shape strategy object `{ readonly id: string, readonly rank: TRank, resolve(...) }` that controls where a reference is cached (`node.instance`, `callingContainer.scopedStorage`, `callContext.bag`, or nowhere), which container scope resolves its dependencies (`node.owner` vs. `callingContainer`), and how cleanup hooks register with `onDispose()`.
  2. **First-Class Custom Policies (`TtlScope`, `PoolScope`, `GraphScope`):** `GraphScope`, `TtlScope(ms)`, and `PoolScope(size)` are implemented as standalone, opt-in `ScopePolicy` modules with explicit numeric ranks (e.g., `TtlScope` has `rank: 3`, allowing `SingletonScope` to depend on it directly without `asThunk`). If not imported, they are 100% eliminated by the bundler.
  3. **Pluggable Unsafe Resolver Driver:** The dynamic cycle-detection Set (`resolvingNow`) and parallel runtime edge cache (`unsafeEdgeCache`) are moved out of the base `Container` class into the opt-in `registerUnsafe` driver module, attached lazily to `callContext` only when an unsafe node executes.
- **Negative Constraints (Explicitly Forbidden):**
  - NO `switch (node.lifetime)` or if/else branching on specific lifetime types inside the core Container resolution engine.
  - NO hardcoded `activeGraphCache` or `resolvingNow` fields allocated on the base Container instance when `GraphScope` or `registerUnsafe` are not used.
  - NO unrestricted exposure of internal container mutation methods to `ScopePolicy`; policies may only interact with the container via the bounded `ResolutionKernel` interface (`node.instance`, `caller.scopedStorage`, `caller.onDispose`, `ctx.bag`, and `node.instantiate()`).
- **Consequences:**
  - **Positive:** Zero dead code (unused scopes like `GraphScope`, `TtlScope`, or `PoolScope` tree-shake out completely), zero switch branching overhead in `.get()`, and universal Captive Dependency validation across both built-in and custom user-defined scopes via `parentNode.rank <= depNode.rank`.
  - **Negative:** Introduces one monomorphic method dispatch `node.scope.resolve(...)` per uncached node resolution.