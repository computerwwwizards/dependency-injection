---
title: "RFC-0002: Static DAG Compilation & Flat Topological Execution"
status: Normative Specification
date: 2026-11-06
category: Technical Specification
---

# RFC-0002: Static DAG Compilation & Flat Topological Execution

- **Feature Name:** `static_dag_execution`
- **Status:** Normative Specification

## 1. Summary
Specifies how static provider declarations (`register(key, deps, factory)`) are linked into a Directed Acyclic Graph (DAG), validated against circular dependencies, and flattened into a non-recursive topological execution array (`node.plan`).

## 2. Motivation
When dependencies are resolved via mutual recursion (`get('A') -> factoryA -> get('B') -> factoryB`), every hop pushes frames onto the V8 call stack and performs redundant dictionary lookups. Because our default registration API requires pre-declaring `deps: readonly string[]`, the container knows the complete static graph ahead of time and can flatten resolution into a linear, non-recursive loop.

## 3. Guide-Level Explanation
When you register services using the default `register()` method:

```typescript
container
  .register('tax', [], () => 0.15)
  .register('calc', ['tax'], ({ tax }) => (amt: number) => amt * (1 + tax));
```

Nothing is instantiated during `.register()`. On the first call to `container.get('calc')` (or explicitly via `container.compile()` / `container.prewarm()`), the container verifies that `'tax'` exists, confirms there are no cycles, links `'calc'` directly to `'tax'`'s `ProviderNode` pointer, and builds a flat array `plan = [Node(tax), Node(calc)]`.

## 4. Reference-Level Explanation

### 4.1 Post-Order DAG Compilation Algorithm
Given a target `rootNode`:
1. Initialize `visiting = new Set<string>()` and `visited = new Set<string>()`.
2. Perform a post-order traversal starting at `rootNode`:
   - Add `curr.key` to `visiting`.
   - For each `depKey` in `curr.depKeys`:
     1. If `visiting.has(depKey)`, immediately throw `CircularDependencyError([...visiting, depKey])`.
     2. Locate `depNode` by walking container and its `.parent` chain. If not found, throw `MissingProviderError(curr.key, depKey)`.
     3. Validate the Captive Dependency Rank Law between `curr` and `depNode` (per RFC-0005).
     4. Push `depNode` into `curr.depNodes`.
     5. If `(depNode.flags & NodeFlags.IsAsync) !== 0`, propagate the async bitmask upward: `curr.flags |= NodeFlags.IsAsync`.
     6. If `!visited.has(depKey)` and `(depNode.flags & NodeFlags.IsUnsafe) === 0`, recursively traverse `depNode`.
   - Remove `curr.key` from `visiting`, add `curr.key` to `visited`, and append `curr` to `rootNode.plan`.
3. Set `rootNode.flags |= NodeFlags.IsCompiled`.

### 4.2 Non-Recursive Flat Execution Loop
When resolving `rootNode` in a purely static synchronous subgraph:
1. If `rootNode.lifetime === Lifetime.Singleton && rootNode.instance !== undefined`, return `rootNode.instance` immediately.
2. Iterate `for (let i = 0; i < rootNode.plan.length; i++)`:
   - Let `step = rootNode.plan[i]`.
   - If `step` is already cached in its target lifetime cache (`step.instance`, `scopedCache[step.key]`, or `activeGraphCache[step.key]`), skip factory execution.
   - Otherwise, assemble `depsObj = Object.create(null)` by reading each `depNode` in `step.depNodes` from its already-populated cache or ephemeral slot, invoke `step.factory(depsObj)`, and store the result in `step`'s target cache.

### 4.3 Explicit Pre-Warming (`prewarm()`)
Registrations are 100% lazy by default. Calling `container.prewarm()` iterates over all nodes owned by container where `(node.flags & NodeFlags.IsEager) !== 0 && node.lifetime === Lifetime.Singleton`, compiling and resolving them upfront before traffic is served.

## 5. Normative Invariants & Negative Constraints
- **INV-2.1 (Lazy Registration Invariant):** Calling `register()` MUST NOT invoke `factory()` under any circumstance.
- **INV-2.2 (Topological Ordering Invariant):** For every node `N` at index `i` in `rootNode.plan`, all static dependencies of `N` MUST appear at indices `< i` in `rootNode.plan`.
- **NEG-2.1 (No Container Reference in Safe Factories):** Safe factories registered via `register()` MUST NOT be passed a reference to the Container or any `.get()` function; they MUST only receive the plain `depsObj` containing the keys declared in `depKeys`.

## 6. Drawbacks
- First resolution (or `compile()`) incurs a one-time $O(V + E)$ graph traversal to populate `depNodes` and `plan`.

## 7. Rationale & Alternatives
- *Why post-order DFS compilation instead of Kahn's in-degree algorithm?* Post-order DFS starting from the requested `rootNode` only compiles the reachable subgraph needed by `rootNode`, rather than sorting unconnected branches of the container, and naturally produces the exact cycle path `[...visiting, depKey]` upon encountering a back-edge.

## 8. Unresolved Questions
- None.