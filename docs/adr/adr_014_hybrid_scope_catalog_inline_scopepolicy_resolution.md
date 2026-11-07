---
title: "ADR-014: Hybrid Scope Catalog & Inline ScopePolicy Resolution with Boot-Time Pointer Binding"
status: "Accepted"
date: "2026-11-07"
category: "Architecture Decision Record"
---

# ADR-014: Hybrid Scope Catalog & Inline ScopePolicy Resolution with Boot-Time Pointer Binding

- **Status:** Accepted
- **Context:** While ADR-013 makes scopes pluggable objects, requiring developers to import `{ SingletonScope, ScopedScope }` in every file and pass object references into every `.register()` call creates import fatigue across modular plugins. Conversely, only allowing pre-registered catalog strings (`'singleton'`, `'scoped'`) makes parameterized one-off scopes—like `TtlScope(60_000)` on a single OAuth provider or `PoolScope(16)` on a single parser—awkward because developers would have to register `'ttl60s'` into the global catalog just to use it once. Finally, looking up catalog strings inside `.get()` at runtime would reintroduce string-dictionary overhead.
- **Decision:** Support a Hybrid Scope Registration Model that combines a pre-loaded Scope Catalog (referenced by string literal keys) with Inline ScopePolicy Objects (passed directly for one-off edge cases), unified via Boot-Time Pointer Binding:
  1. **Container Scope Catalog (`new Container({ scopes })` & `.registerScope()`):** A container initializes with a dictionary of named `ScopePolicy` instances (and plugins can extend the catalog via `.registerScope('name', policy)`). Standard `.register()` calls reference catalog scopes by string literal (e.g., `'scoped'`, defaulting to `'singleton'`).
  2. **Inline ScopePolicy Override:** Any `.register()` call may bypass the catalog and pass a `ScopePolicy<Rank>` instance directly (e.g., `TtlScope(60_000)`) as its scope argument.
  3. **Mechanical Sympathy / Boot-Time Normalization:** String lookup against `this.scopeCatalog[scopeName]` occurs strictly once during `.register()`. The resolved `ScopePolicy` memory reference and its integer rank (Smi) are written directly onto `node.scope` and `node.rank` at registration time. During `.get()`, the runtime engine never touches `this.scopeCatalog`.
- **Negative Constraints (Explicitly Forbidden):**
  - NO looking up scope names in `this.scopeCatalog` during `.get()` or graph traversal; all catalog strings MUST be resolved to direct `ScopePolicy` object pointers inside `.register()`.
  - NO polymorphic shape changes on `ProviderNode`: whether a node was registered via a catalog string (`'scoped'`) or an inline policy object (`TtlScope(5000)`), `node.scope` MUST hold a concrete `ScopePolicy` object reference and `node.rank` MUST hold a Smi integer.
- **Consequences:**
  - **Positive:** Zero scope imports needed inside plugins (clean string autocomplete for catalog scopes), effortless one-line ergonomics for parameterized scopes (`TtlScope(60_000)`), and 100% preservation of V8 Monomorphic Hidden Classes and zero-lookup runtime speed.
  - **Negative:** Registering a provider with a catalog string name that does not exist in `this.scopeCatalog` requires both a compile-time TypeScript constraint and a fast runtime fail check in `.register()`.