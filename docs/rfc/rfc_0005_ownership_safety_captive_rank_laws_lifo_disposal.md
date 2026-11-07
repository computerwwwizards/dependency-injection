---
title: "RFC-0005: Ownership Safety, Captive Rank Laws & LIFO Disposal"
status: Normative Specification
date: 2026-11-06
category: Technical Specification
---

# RFC-0005: Ownership Safety, Captive Rank Laws & LIFO Disposal

- **Feature Name:** `ownership_and_lifecycle_safety`
- **Status:** Normative Specification

## 1. Summary
Establishes the three memory-safety laws that make the container mathematically immune to Captive Dependencies, Disposable Transient OOM Leaks, and Observer/Event-Bus Zombie Leaks.

## 2. Motivation
Production IoC containers routinely leak memory in three ways:
1. **Captive Dependency:** A `SINGLETON` (Rank 3) directly injects a `SCOPED` (Rank 2), `GRAPH` (Rank 1), or `TRANSIENT` (Rank 0) instance, trapping the short-lived reference in RAM forever and causing cross-request state corruption.
2. **Disposable Transient Leak (.NET Runtime Issue #36491):** The container tracks `TRANSIENT` instances in an internal `_disposables` array to clean them up on shutdown, preventing the Garbage Collector from ever freeing any transient object.
3. **Observer Zombie Leak:** A `SCOPED` child service registers a listener on a `SINGLETON` `EventBus`. When the child container is evicted, the `EventBus` still holds the listener closure, keeping the entire child container graph alive in RAM.

## 3. Guide-Level Explanation
1. **The Rank Law:** A longer-lived provider can never directly inject a shorter-lived provider (`SINGLETON (3) > SCOPED (2) > GRAPH (1) > TRANSIENT (0)`). If a `SINGLETON` needs to create fresh `TRANSIENT` or `SCOPED` instances on demand, it must depend on a factory thunk wrapped via `asThunk()` (RFC-0008).
2. **Zero Transient Retention:** The container never tracks `TRANSIENT` or `GRAPH` instances after `.get()` returns.
3. **Arena Disposal (`await child.dispose()`):** When a child container finishes its unit of work, calling `await child.dispose()` runs all registered `onDispose` cleanup callbacks in reverse creation order (LIFO—unsubscribing observers and closing transactions before closing pools) and zeroes out its caches.

## 4. Reference-Level Explanation

### 4.1 Formal Captive Dependency Rank Equation
For any directed edge $u \to v$ in the dependency graph:
$$\text{ValidEdge}(u, v) \iff \left( \text{lifetime}(u) \le \text{lifetime}(v) \right) \lor \left( (\text{flags}(v) \mathbin{\&} \text{NodeFlags.IsThunk}) \neq 0 \right)$$
If $\neg \text{ValidEdge}(u, v)$, the container MUST reject the edge at compile time (RFC-0006) and throw `CaptiveDependencyError` during DAG compilation (RFC-0002) or `trackedCtx.get()` (RFC-0003).

### 4.2 LIFO Arena Teardown (`dispose()` & `Symbol.asyncDispose`)

```typescript
class Container {
  private disposers: Array<() => void | Promise<void>> = [];
  private isDisposed = false;

  onDispose(cleanup: () => void | Promise<void>): this {
    if (this.isDisposed) throw new ContainerDisposedError();
    this.disposers.push(cleanup);
    return this;
  }

  async dispose(): Promise<void> {
    if (this.isDisposed) return;
    this.isDisposed = true;
    // Execute in strict LIFO order (children before parents)
    for (let i = this.disposers.length - 1; i >= 0; i--) {
      await this.disposers[i]();
    }
    this.disposers.length = 0;
    this.scopedCache = Object.create(null);
    for (const key in this.providersByKey) {
      this.providersByKey[key].instance = undefined; // Preserve Monomorphic shape!
    }
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }
}
```

## 5. Normative Invariants & Negative Constraints
- **INV-5.1 (Strict Lifetime Monotonicity):** No cached reference in container $C$ may hold a direct pointer to a non-thunk dependency whose lifetime rank is strictly less than its own.
- **INV-5.2 (LIFO Teardown Ordering):** If resource $A$ is initialized before resource $B$ and both register `onDispose` hooks, $B$'s cleanup hook MUST complete before $A$'s cleanup hook begins.
- **NEG-5.1 (Forbidden Transient/Graph Tracking):** The container MUST NOT store references to `Lifetime.Transient` or `Lifetime.Graph` instances in `this.disposers` or any internal tracking array.
- **NEG-5.2 (Use-After-Dispose Ban):** Calling `.get()`, `.register()`, or `.createChild()` on a container where `isDisposed === true` MUST immediately throw `ContainerDisposedError`.

## 6. Drawbacks
- Requiring explicit `asThunk()` when a `SINGLETON` wants to consume a `TRANSIENT` forces developers to invoke `deps.myTransient()` as a function rather than accessing `deps.myTransient` as a pre-built object. This is an intentional design feature that makes fresh allocation explicit in code.

## 7. Rationale & Alternatives
- *Why not use `WeakRef` / `FinalizationRegistry` for cleanup?* JavaScript `FinalizationRegistry` callbacks run at non-deterministic times (or never), making them unsafe for releasing database transactions, file descriptors, or active event listeners. Explicit Arena `dispose()` (and TypeScript's `await using child = root.createChild()`) guarantees deterministic cleanup.

## 8. Unresolved Questions
- None.