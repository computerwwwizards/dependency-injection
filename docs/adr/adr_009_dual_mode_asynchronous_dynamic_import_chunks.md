---
title: "ADR-009: Dual-Mode Asynchronous Dynamic import() Chunks"
status: Accepted
date: 2026-03-07
category: Architecture
---

# ADR-009: Dual-Mode Asynchronous Dynamic import() Chunks

- **Status:** Accepted
- **Context:** In JavaScript, lazy-loading code chunks via `import('./chunk.js')` returns a Promise. Because of the "Function Coloring Problem," a synchronous method cannot block the single JS thread to await a network/disk chunk and still return synchronously. Unlike React UI components, backend/domain DI services cannot always rely on a `<Suspense>` fallback UI or idempotent function restarts via throw promise.
- **Decision:** Support two explicit strategies for dynamic `import()` chunks:
  1. **Strategy 1 — Graph-Level Async (`registerAsync`):** The provider factory is `async () => { const m = await import(...); return new m.Service(); }`. Any node in the DAG that depends (directly or transitively) on an async provider becomes Async-Tainted, transforming `container.get('a')` to return `Promise<A>`. All async chunks in 'a''s DAG are fetched in parallel (`Promise.all`) before synchronously constructing the dependent classes, so all methods on 'a' and 'b' remain 100% synchronous after resolution!
  2. **Strategy 2 — Method-Level Async Virtual Proxy (`asAsyncVirtualProxy` Util):** Constructed via a userland helper that takes explicit method names `['generatePdf']` and an `import()` loader. It synchronously returns a monomorphic wrapper object whose methods return Promises (`async generatePdf(...args)`), keeping `container.get('a')` 100% synchronous and delaying the `import()` network fetch until `.generatePdf()` is actually called.
- **Negative Constraints (Explicitly Forbidden):**
  - NO calling synchronous execution paths on an Async-Tainted graph node without awaiting the resulting Promise.
  - NO forced conversion of synchronous domain methods into async methods when using Strategy 1 (`registerAsync`).
- **Consequences:**
  - *Positive:* Supports both upfront parallel chunk pre-loading (preserving sync domain methods) and on-demand method-level chunk loading (preserving sync container resolution).
  - *Negative:* Strategy 1 propagates `Promise<T>` upward to `container.get()`, while Strategy 2 requires the consumer to await calls on the proxied dependency's methods.