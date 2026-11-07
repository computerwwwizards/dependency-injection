---
title: "ADR-006: Micro-Kernel Reduction (Commodities Moved to Userland Factory Decorators)"
status: Accepted
date: 2026-03-07
category: Architecture
---

# ADR-006: Micro-Kernel Reduction (Commodities Moved to Userland Factory Decorators)

- **Status:** Accepted
- **Context:** Features like TTL expiration (`Drifter`), Object Pooling (`Pooled`), Lazy Thunks (`() => T`), and Synchronous OOP Virtual Proxies do not require internal container state. Building them into the core engine bloats the container, increases bug surface area, and hurts tree-shaking.
- **Decision:** Strip the core container down to the bare-minimum structural kernel and implement all advanced caching/lazy behaviors as composable Higher-Order Factory Utils (Add-Ons) that wrap a provider's factory function:
  - `withTtl(ms, factory)`: Registered as `TRANSIENT`; holds `{ cached, expiresAt }` inside the decorator’s own closure.
  - `withPool(size, resetFn, factory)`: Registered as `TRANSIENT`; manages an internal ring-buffer/array of reusable instances.
  - `asThunk(factory)`: Transforms a provider `(deps) => T` into `(deps) => () => T`. This also solves conditional factory branching (`optimizeLazy`) without a special core method: if `pgPool` and `sqlitePool` are wrapped in `asThunk`, a conditional `db` factory declares `['config', 'pgPool', 'sqlitePool']` (keeping 100% static DAG visibility for DevTools) and only invokes `pgPool()` or `sqlitePool()` in the branch it takes!
  - `asVirtualProxy(ClassProto, factory)`: Inspects `Object.getOwnPropertyNames(ClassProto)` once at registration to construct a V8-monomorphic wrapper class implementing the exact same contract that lazily instantiates and caches `this._real` on first method call (without `new Proxy()`).
- **Negative Constraints (Explicitly Forbidden):**
  - NO TTL timers, object pool arrays, or virtual proxy generators inside the core `Container` class.
- **Consequences:**
  - *Positive:* The core engine remains ~60 lines of ultra-fast, auditable code; all add-ons are 100% tree-shakeable and composable.
  - *Negative:* When a `SINGLETON` depends on a `TRANSIENT` wrapped in `asThunk`, the dependency must be marked or typed as a factory thunk so the Captive Dependency checker knows it is safe.