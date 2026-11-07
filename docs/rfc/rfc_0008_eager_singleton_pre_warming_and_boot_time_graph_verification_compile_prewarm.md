---
title: "RFC-0008: Eager Singleton Pre-Warming and Boot-Time Graph Verification (compile & prewarm)"
status: Normative Specification
date: 2026-11-06
category: Technical Specification
---

# RFC-0008: Eager Singleton Pre-Warming and Boot-Time Graph Verification (compile & prewarm)

- **Feature Name:** `boot_verification_and_prewarm`
- **Status:** Normative Specification

## 1. Summary
Specifies the explicit boot-time lifecycle phases—`container.compile()` (static verification without instantiation) and `container.prewarm()` (eager instantiation of flagged singletons)—separating registration from startup execution.

## 2. Motivation
During registration (`register()`), zero instances are created and nodes may be registered out-of-order via `.declare()`. In production servers, waiting until the first user HTTP request arrives to discover a circular dependency, a Captive Dependency, or a dead database connection causes runtime outages and high tail-latency on the first request.

## 3. Guide-Level Explanation

```typescript
const app = new Container()
  .register('config', [], () => loadEnv(), { lifetime: 'SINGLETON', eager: true })
  .registerAsync('dbPool', ['config'], async ({ config }) => connectDb(config), {
    lifetime: 'SINGLETON',
    eager: true,
  })
  .register('orderHandler', ['dbPool'], ({ dbPool }) => makeHandler(dbPool), {
    lifetime: 'SCOPED',
  });

// Phase 1: Verify entire DAG, cycles, and captive ranks (Zero instances created)
app.compile();

// Phase 2: Instantiate only `{ eager: true }` SINGLETON nodes in topological order!
await app.prewarm();
```

## 4. Reference-Level Explanation & Invariants
1. **`container.compile()` (Pure Static Verification Pass):**
   - Iterates all keys in `this.providersByKey`.
   - Executes the DAG pointer linker, topological sort (`node.plan`), and Captive Dependency Rank validation (`parent.lifetime <= dep.lifetime`) across every registered node.
   - Checks if any `.declare()` key demanded by a `SINGLETON` node is missing in the current container. (Note: `.declare()` keys demanded only by `SCOPED`, `GRAPH`, or `TRANSIENT` nodes are permitted to remain unfulfilled in a Root Container during `.compile()`, as they are fulfilled by Child Containers at request time).
   - *Invariant:* `compile()` MUST execute in 0 instance allocations—no provider factory is invoked.
2. **`container.prewarm()`: Promise<void> (Eager Singleton Initialization Pass):**
   - Automatically invokes `this.compile()` if not already compiled for the current `graphEpoch`.
   - Filters all nodes owned by `this` where `node.lifetime === Lifetime.Singleton` and `(node.flags & NodeFlags.IsEager) !== 0`.
   - Executes their topological plans in bottom-up dependency order, awaiting any `NodeFlags.IsAsync` singletons in parallel waves by topological depth, populating `node.instance`.

## 5. Normative Negative Constraints & Drawbacks
- **MUST NOT:** `register()` MUST NOT auto-trigger `compile()` or `prewarm()`, as plugins and `.declare()` fulfillments may still be pending on subsequent lines.
- **MUST NOT:** `{ eager: true }` MUST NOT be permitted on `SCOPED`, `GRAPH`, or `TRANSIENT` registrations; passing `{ lifetime: 'TRANSIENT', eager: true }` MUST fail both TypeScript type-checking and runtime registration with an `InvalidEagerLifetimeError`.