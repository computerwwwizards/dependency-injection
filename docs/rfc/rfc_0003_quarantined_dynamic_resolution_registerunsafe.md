---
title: "RFC-0003: Quarantined Dynamic Resolution (registerUnsafe)"
status: Normative Specification
date: 2026-11-06
category: Technical Specification
---

# RFC-0003: Quarantined Dynamic Resolution (registerUnsafe)

- **Feature Name:** `quarantined_unsafe_resolution`
- **Status:** Normative Specification

## 1. Summary
Introduces an explicit, Rust-inspired escape hatch (`registerUnsafe`) for the rare cases where dependency keys cannot be known until runtime execution, while preventing unsafe nodes from de-optimizing the rest of the static DAG or bypassing cycle and lifetime safety checks.

## 2. Motivation
Sometimes a provider must resolve a dependency dynamically at runtime (e.g., `ctx.get(\`plugin_\${env.DRIVER}\`)`). If we ban dynamic lookups completely, the container cannot handle dynamic plugin loading. However, if we allow `ctx.get()` everywhere by default, developers skip static dependency arrays and ruin static DAG analysis. Quarantining `ctx.get()` inside `registerUnsafe` makes dynamic lookups explicit, lintable, and self-documenting.

## 3. Guide-Level Explanation
When you cannot pre-declare dependencies in an array, you explicitly opt out of static DAG compilation using `registerUnsafe`:

```typescript
container.registerUnsafe('driver', (trackedCtx) => {
  const target = process.env.STORAGE_DRIVER === 's3' ? 's3Driver' : 'localDriver';
  return trackedCtx.get(target);
}, { lifetime: Lifetime.Singleton });
```

In code reviews and DevTools, `'driver'` is flagged with `NodeFlags.IsUnsafe`. Whenever `trackedCtx.get(target)` runs at runtime, the container still checks for circular dependencies, still enforces the Captive Dependency Rank Law, and automatically records the discovered edge `'driver' -> target` into the DevTools graph!

## 4. Reference-Level Explanation

### 4.1 The `TrackedContext` Interface
`registerUnsafe` passes a restricted `trackedCtx` object (NOT the full Container instance) into the factory:

```typescript
interface TrackedContext<TProvided> {
  get<K extends keyof TProvided>(key: K): TProvided[K];
  getLazy<K extends keyof TProvided>(key: K): () => TProvided[K];
}
```

### 4.2 Runtime Guards & Edge Recording Inside `trackedCtx.get(depKey)`
When `callerNode` (marked `NodeFlags.IsUnsafe`) invokes `trackedCtx.get(depKey)`:
1. **Runtime Cycle Guard:** The container checks `this.resolvingNow: Set<string>`. If `this.resolvingNow.has(depKey)`, it MUST throw `CircularDependencyError([...this.resolvingNow, depKey])`.
2. **Runtime Captive Rank Guard:** The container locates `depNode` and verifies `callerNode.lifetime <= depNode.lifetime || (depNode.flags & NodeFlags.IsThunk) !== 0`. If violated, it MUST throw `CaptiveDependencyError`.
3. **Self-Learning Edge Recording:** The container appends `{ from: callerNode.key, to: depKey, kind: 'DYNAMIC_UNSAFE' }` to its internal `dynamicEdges` set for `container.inspect()` (RFC-0009).
4. **Boundary Handoff:** The container resolves `depNode` using the current `callingContainer` and `activeGraphCache`. If `depNode` is a safe static node (`(depNode.flags & NodeFlags.IsUnsafe) === 0`), resolution immediately resumes using `depNode`'s pre-compiled static plan (RFC-0002).

## 5. Normative Invariants & Negative Constraints
- **INV-3.1 (Quarantine Contagion Boundary):** Depending on an `IsUnsafe` node MUST NOT force parent or child safe nodes to abandon their static `depNodes` pointers; when an `IsUnsafe` node requests a safe child via `trackedCtx.get()`, the safe child MUST execute its pre-compiled topological plan.
- **INV-3.2 (Shared Graph Cache Continuity):** `trackedCtx.get()` MUST forward the active `activeGraphCache` so `Lifetime.Graph` diamond dependencies are shared seamlessly across `register` and `registerUnsafe` boundaries.
- **NEG-3.1 (No Mutation from trackedCtx):** `trackedCtx` MUST NOT expose `.register()`, `.declare()`, `.use()`, or `.dispose()`; an unsafe factory MUST NOT mutate container registrations during resolution.

## 6. Drawbacks
- Errors inside `registerUnsafe` factories (such as missing keys or captive dependencies) are caught when the factory executes at runtime rather than during boot-time `compile()`.

## 7. Rationale & Alternatives
- *Why not call it `registerDynamic`?* Naming it `registerUnsafe` (mirroring Rust's `unsafe`) signals to developers and static linters that compile-time/boot-time graph verification is bypassed for this node, encouraging them to use static `register` with `asThunk` (RFC-0008) for normal if/else branching.

## 8. Unresolved Questions
- None.