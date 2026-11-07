---
title: "RFC-0004: Reference Lifetimes, Diamond Graph Scope & Arena Hierarchy"
status: Normative Specification
date: 2026-11-06
category: Technical Specification
---

# RFC-0004: Reference Lifetimes, Diamond Graph Scope & Arena Hierarchy

- **Feature Name:** `structural_lifetimes_and_arenas`
- **Status:** Normative Specification

## 1. Summary
Formalizes the exact caching and lookup mechanics for the four irreducible structural lifetimes (`SINGLETON`, `SCOPED`, `GRAPH`, `TRANSIENT`) across multi-tier container hierarchies (`Root -> Tenant -> Request`).

## 2. Motivation
Existing IoC containers suffer from broken hierarchical caching (such as Awilix Issue #131, where registering a `.singleton()` inside a child container leaks the instance into the global root cache) and ambiguous scope names (`inRequestScope` vs. `Scoped`). Furthermore, the Diamond Dependency Problem ($A \rightarrow B, B_1 \rightarrow C$) requires a dedicated resolution-tree lifetime (`GRAPH`) so $B$ and $B_1$ can share a single instance of $C$ during one `.get('A')` call without keeping $C$ alive in the container afterward.

## 3. Guide-Level Explanation
Every provider has one of 4 structural lifetimes based on where its reference is cached:
1. **SINGLETON (Owner-Cached):** Cached on the `ProviderNode` in the exact container where it was registered. If registered in Root, it lives for the whole app. If registered in a Tenant child container, it is shared by all Request grandchildren under Tenant and dies when Tenant is disposed.
2. **SCOPED (Caller-Cached):** Registered once in Root, but cached inside whichever child container calls `.get()`. Each Request child container gets its own isolated instance.
3. **GRAPH (Resolution-Cached):** Solves the Diamond Problem. When resolving $A \rightarrow (B, B_1) \rightarrow C$, if $C$ is `GRAPH`, $B$ and $B_1$ receive the exact same $C$ instance. The microsecond `.get('A')` returns $A$, the temporary graph cache is wiped.
4. **TRANSIENT (Uncached):** Never cached; $B$ and $B_1$ receive two separate instances ($C_1$ and $C_2$).

## 4. Reference-Level Explanation

### 4.1 Multi-Tier Hierarchy & Lexical vs. Dynamic Scope Resolution
A Child Container is created via `const child = parent.createChild()`, storing a read-only pointer `this.parent = parent`.
When `callingContainer.get(key)` resolves a node located in `ownerContainer`:

| `node.lifetime` | Cache Storage Location | Against Which Container Are `node.depNodes` Resolved? |
| :--- | :--- | :--- |
| **Singleton (3)** | `ownerContainer`'s `node.instance` | `ownerContainer` (Lexical Scope). A Root Singleton can NEVER see or resolve child overrides. |
| **Scoped (2)** | `callingContainer.scopedCache[key]` | `callingContainer` (Dynamic Caller Scope). Resolves child overrides/registrations first, falling back up `.parent`. |
| **Graph (1)** | `callingContainer.activeGraphCache[key]` | `callingContainer` (Dynamic Caller Scope) with the active `activeGraphCache`. |
| **Transient (0)** | None (`null`) | `callingContainer` (Dynamic Caller Scope) with the active `activeGraphCache`. |

### 4.2 The GRAPH Diamond Resolution Lifecycle

```typescript
// Inside Container.prototype.get(key):
const isTopLevel = this.activeGraphCache === null;
if (isTopLevel) {
  this.activeGraphCache = Object.create(null);
}
try {
  return this.resolveNode(key, this, this.activeGraphCache!);
} finally {
  if (isTopLevel) {
    this.activeGraphCache = null; // Immediate eviction upon returning top-level root!
  }
}
```

## 5. Normative Invariants & Negative Constraints
- **INV-4.1 (Child Singleton Isolation):** Registering a `Lifetime.Singleton` provider inside a Child Container MUST cache the instance on that Child Container's `ProviderNode`, and MUST NOT write to any ancestor container's cache.
- **INV-4.2 (Diamond Graph Ephemerality):** All references stored in `activeGraphCache` MUST become unreachable from the container the moment the top-level `.get()` call unwinds its `finally` block.
- **NEG-4.1 (Ban on AsyncLocalStorage in Core):** The container MUST NOT use `AsyncLocalStorage` (`node:async_hooks`) to track request scopes; per-request or per-job state MUST be isolated via explicit `.createChild()` arenas whose closures naturally persist across Promise continuations.
- **NEG-4.2 (No Parent Cache Contamination):** A Parent Container MUST NOT store or cache any instance created using a Child Container as the `callingContainer`.

## 6. Drawbacks
- Because `SCOPED`, `GRAPH`, and `TRANSIENT` providers registered in Root resolve their dependencies against `callingContainer`, if a Child Container overrides a key (or fulfills a `.declare()` key), the engine must check `callingContainer.providersByKey[depKey]` before falling back to the pre-linked Root `depNode`.

## 7. Rationale & Alternatives
- *Why reject `AsyncLocalStorage` (`ASYNC_SCOPED`)?* In V8, `AsyncLocalStorage` attaches context frames to every Promise creation, adding runtime hook overhead. Passing a Child Container (or a lazy thunk bound to a Child Container) across async calls uses standard V8 lexical closures at zero async-hook cost.

## 8. Unresolved Questions
- None.