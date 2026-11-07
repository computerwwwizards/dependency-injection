---
title: "ADR-008: Memory Safety & Lifecycle Invariants (Preventing the 3 Classic DI Leaks)"
status: Accepted
date: 2026-03-07
category: Architecture
---

# ADR-008: Memory Safety & Lifecycle Invariants (Preventing the 3 Classic DI Leaks)

- **Status:** Accepted
- **Context:** IoC containers are notorious for three catastrophic memory leaks:
  1. *Captive Dependencies:* A longer-lived service (`SINGLETON`) directly captures a shorter-lived service (`SCOPED`, `GRAPH`, or `TRANSIENT`), preventing garbage collection and causing cross-request state corruption.
  2. *Disposable Transient Leaks (The .NET Bug):* The container stores references to `TRANSIENT` instances in an internal array to dispose of them later, preventing the GC from ever freeing transient objects.
  3. *Observer / Event-Bus Zombies:* A `SCOPED` child service subscribes to a `SINGLETON` `EventBus` and never unsubscribes when the child container is evicted, trapping the entire child closure in RAM forever.
- **Decision:** Enforce three strict memory invariants in the bare-minimum core:
  1. **Strict Lifetime Rank Rule:** Every node checks `parentNode.lifetime <= depNode.lifetime` (`SINGLETON [3] > SCOPED [2] > GRAPH [1] > TRANSIENT [0]`). A higher-rank node cannot depend on a lower-rank node unless the dependency is wrapped as a factory thunk (`asThunk`).
  2. **Zero Retention of Non-Cached Lifetimes:** The container never stores a pointer to a `TRANSIENT` or `GRAPH` instance in any long-lived list or disposal array once `.get()` returns.
  3. **Arena Eviction & LIFO `dispose()`:** Child containers act as Arena Allocators. Calling `await container.dispose()` (or `Symbol.asyncDispose` / `Symbol.dispose`) executes registered `onDispose(fn)` cleanup hooks in reverse creation order (LIFO) and severs all cache references (`this.cache = Object.create(null)`).
- **Negative Constraints (Explicitly Forbidden):**
  - NO tracking or registering `onDispose` hooks for `TRANSIENT` or `GRAPH` instances inside the container.
  - NO direct injection of `SCOPED`, `GRAPH`, or `TRANSIENT` instances into a `SINGLETON` (must throw a `CaptiveDependencyError` at graph validation/registration or fail at compile time).
  - NO caching of Child Container instances inside a Parent Container.
- **Consequences:**
  - *Positive:* Mathematically immune to Captive Dependencies, Disposable Transient OOM crashes, and Observer memory leaks with only ~10 lines of core lifecycle code.
  - *Negative:* Developers must explicitly wrap shorter-lived dependencies in `asThunk` when consuming them inside a `SINGLETON`, and must call `child.dispose()` when evicting a child scope.