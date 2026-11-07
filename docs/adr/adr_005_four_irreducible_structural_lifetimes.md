---
title: "ADR-005: The Four Irreducible Structural Lifetimes (SINGLETON, SCOPED, GRAPH, TRANSIENT)"
status: Accepted
date: 2026-03-07
category: Architecture
---

# ADR-005: The Four Irreducible Structural Lifetimes (SINGLETON, SCOPED, GRAPH, TRANSIENT)

- **Status:** Accepted
- **Context:** IoC frameworks confuse developers with dozens of overlapping scope names (`inRequestScope`, `PerThread`, `Pooled`, `Drifter`). By analyzing memory ownership and the Diamond Dependency Problem ($A \rightarrow B, B_1 \rightarrow C$), structural reference lifetimes reduce to exactly four fundamental states based on which actor caches the pointer.
- **Decision:** The core container implements only four structural lifetimes, ranked strictly by lifespan longevity:
  1. **SINGLETON (Rank 3 — Owner-Cached):** Cached directly on `ownerNode.instance` inside the container where the provider was registered. Lives until that owner container is disposed. (Lazy by default on first `.get()`, with an optional `prewarm()` method to eagerly instantiate flagged singletons at boot).
  2. **SCOPED (Rank 2 — Caller-Cached):** Registered in a parent/root container, but cached inside `callingChildContainer.scopedCache[key]`. Allows registering request/tenant services once at startup while isolating instances per child container (and avoiding the Awilix bug where `.singleton()` in a child leaks into the root cache).
  3. **GRAPH (Rank 1 — Resolution-Cached):** Cached inside a temporary `activeGraphCache` created at the start of a top-level `.get('A')` call and wiped immediately in a `finally` block when `.get('A')` returns. Solves the Diamond Dependency Problem so $B$ and $B_1$ share the exact same $C$ during a single resolution of $A$, while subsequent calls to `.get('A')` get a fresh $C$.
  4. **TRANSIENT (Rank 0 — Uncached / Ephemeral):** Never cached anywhere. Every edge requesting $C$ executes `node.factory()` and receives a fresh memory reference.
- **Negative Constraints (Explicitly Forbidden):**
  - NO creation of instances during `.register()` (all lifetimes are lazy until `.get()` or `prewarm()`).
  - NO routing of Child Container `SINGLETON` registrations into the Root Container’s cache (every container owns its own `SINGLETON` registrations).
  - NO `AsyncLocalStorage` (`ASYNC_SCOPED`) inside the core container engine; async request isolation is handled explicitly by resolving from a Child Container whose closures naturally survive across `await` / `Promise` continuations with zero V8 async-hook overhead.
- **Consequences:**
  - *Positive:* Complete mathematical coverage of all structural reference lifetimes (Owner, Caller, Resolution Tree, None) in ~25 lines of branching logic.
  - *Negative:* Developers wanting a Root Singleton to access per-request state cannot rely on hidden `AsyncLocalStorage` globals; they must either scope the consumer or pass request context/thunks explicitly.