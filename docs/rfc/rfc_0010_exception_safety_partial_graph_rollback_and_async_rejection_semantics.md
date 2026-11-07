---
title: "RFC-0010: Exception Safety, Partial Graph Rollback, and Async Rejection Semantics"
status: Normative Specification
date: 2026-11-06
category: Technical Specification
---

# RFC-0010: Exception Safety, Partial Graph Rollback, and Async Rejection Semantics

- **Feature Name:** `exception_safety_and_partial_rollback`
- **Status:** Normative Specification

## 1. Summary
Defines deterministic cleanup and cache-poisoning prevention when a synchronous factory throws an exception or an asynchronous `registerAsync` Promise rejects partway through resolving a dependency graph.

## 2. Motivation
Suppose resolving $A$ requires building $B$ (which opens a `SCOPED` database transaction and registers an `onDispose` rollback hook) and $C$ (which throws an exception or rejects its `import()` Promise during construction).
Without a formal exception-safety specification:
1. **Cache Poisoning:** If $C$ was an `IsAsync` `SINGLETON`, and its rejected Promise remains cached in `node.instance`, the server is permanently bricked—every future request awaits the forever-rejected Promise!
2. **Half-Initialized Leaks:** $B$ was already constructed and registered an `onDispose` hook, or `activeGraphCache` and `resolvingNow` were left dirty on the container!

## 3. Guide-Level Explanation
- If any provider throws synchronously or rejects asynchronously during `container.get('a')`:
  1. Failed Promises are immediately evicted from `SINGLETON` and `SCOPED` caches so retries can succeed.
  2. Temporary resolution state (`activeGraphCache` and `resolvingNow` cycle sets) is guaranteed to unwind cleanly.
  3. Any `GRAPH`-scoped resources allocated during the failed `.get('a')` call are immediately abandoned to GC.

## 4. Reference-Level Explanation & Invariants
1. **Unwinding `activeGraphCache` and `resolvingNow`:**
   - All manipulation of `this.resolvingNow` and `this.activeGraphCache` MUST be wrapped in `try / finally` blocks (for synchronous paths) and `.finally()` handlers (for `IsAsync` paths).
2. **Async Cache Eviction on Rejection (Anti-Poisoning Invariant):**
   - In RFC-0004, while an `IsAsync` `SINGLETON` or `SCOPED` node is pending, its in-flight Promise is stored to prevent stampedes.
   - If that Promise rejects, the `.catch()` handler MUST immediately reset the cache slot (`node.instance = undefined` or `scopedCache[key] = undefined`) before re-throwing the rejection to the caller.
3. **Transactional Child Scope Rollback:**
   - If a caller invokes `child.get(key)` and an exception occurs mid-graph, any `onDispose` hooks registered by `SCOPED` dependencies that did succeed prior to the throw remain safely queued in `child.disposers`, and MUST be cleaned up when the caller's `try / finally` block calls `await child.dispose()`.

## 5. Normative Negative Constraints & Drawbacks
- **MUST NOT (No Poisoned Singletons):** A rejected Promise or thrown error inside a `SINGLETON` or `SCOPED` factory MUST NOT remain cached in `node.instance` or `scopedCache[key]`.
- **MUST NOT (No Partial Singleton Commit):** A node's cache slot MUST NOT be populated with an object reference if its constructor/factory throws prior to returning.