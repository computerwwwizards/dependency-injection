---
title: "RFC-0007: Dynamic Runtime Registration, Topological Cache Invalidation, and Child Override Re-Linking"
status: Normative Specification
date: 2026-11-06
category: Technical Specification
---

# RFC-0007: Dynamic Runtime Registration, Topological Cache Invalidation, and Child Override Re-Linking

- **Feature Name:** `dynamic_graph_invalidation`
- **Status:** Normative Specification

## 1. Summary
Defines the exact mechanics for registering new providers at runtime (after initial graph compilation) and overriding parent providers inside a Child Container without corrupting pre-compiled `depNodes` pointers or flat `plan` arrays.

## 2. Motivation
In RFC-0001 and RFC-0002, `node.depNodes` holds direct memory pointers to child `ProviderNode` structs, and `node.plan` holds a pre-sorted topological execution array. However, two real-world scenarios break naive static pointer linking:
1. **Runtime Plugin Loading:** Halfway through execution, a dynamic module loads and calls `container.register('newPlugin', ...)`.
2. **Child Container Shadowing (Overrides):** Root registers `'orderService'` (Rank 2: SCOPED) depending on `'db'` (Rank 2: SCOPED). Later, a test or tenant Child Container calls `child.register('db', [], () => mockDb, { lifetime: 'SCOPED' })`. If `'orderService'` in Root already bound its `depNodes` pointer directly to Root's `'db'` node, calling `child.get('orderService')` would blindly follow the pointer to Root's `'db'` and ignore child's override!

## 3. Guide-Level Explanation
Developers can register providers inside a Child Container to fulfill `.declare()` contracts or override non-singleton parent providers, and can dynamically register new providers at runtime:

```typescript
const child = root
  .createChild()
  // Overrides 'taxStrategy' for this child branch only:
  .register('taxStrategy', [], () => euTaxFn, { lifetime: 'SCOPED' });

// Automatically re-links SCOPED/GRAPH/TRANSIENT parents to use child's 'taxStrategy'!
const calc = child.get('invoiceCalculator');
```

## 4. Reference-Level Explanation & Invariants
1. **Generation Epoch Counter (`graphEpoch: number`):**
   - Every Container maintains a monotonically increasing integer `this.graphEpoch = 0` (Smi).
   - Every compiled `ProviderNode` stores `compiledEpoch: number` (Offset 8 on `ProviderNode`, initialized to `-1`).
   - Whenever `.register()` or `.registerAsync()` is called on a container, `this.graphEpoch++` is incremented.
2. **Lazy Epoch Re-Verification:**
   - On `container.get(key)`, the engine checks if `(node.compiledEpoch !== this.graphEpoch)`. If mismatched, it re-runs the post-order pointer linker (RFC-0002) for `node` and updates `node.compiledEpoch = this.graphEpoch`.
3. **Child Container Shadowing & Copy-on-Write (`cloneNodeForChild`):**
   - When `child.get(key)` resolves a `SCOPED`, `GRAPH`, or `TRANSIENT` node owned by parent, if child (or an intermediate ancestor between child and parent) has registered any providers (`child.hasLocalRegistrations === true`), child MUST check if any node in `parentNode.plan` is shadowed in `child.providersByKey`.
   - If shadowed, child performs a Shallow Copy-on-Write of the affected `ProviderNode` into `child.providersByKey[key]`, re-linking `depNodes` and `plan` against child's lexical hierarchy so parent's `ProviderNode` is never mutated.

## 5. Normative Negative Constraints & Drawbacks
- **MUST NOT (Immutability of Sealed Singletons):** Calling `.register(existingKey, ...)` on the same container after `existingKey` has already been instantiated as a `SINGLETON` (`node.instance !== undefined`) MUST throw a `SealedProviderOverrideError(existingKey)`. Replacing an already-captured singleton would leave older services holding a stale pointer while newer services get a new pointer (Split-Brain Singleton bug).
- **MUST NOT (Parent Mutation):** A Child Container MUST NOT mutate `depNodes`, `plan`, or `compiledEpoch` on a `ProviderNode` owned by a Parent Container.
- **Drawback:** Copy-on-Write node cloning in child containers that shadow parent keys adds a small one-time allocation per shadowed root node per child container.

## 6. Rationale, Alternatives, and Prior Art
- *Alternative Considered:* Always looking up `depKey` strings dynamically in `callingContainer.providersByKey` on every step instead of linking `depNodes` pointers. Rejected because it destroys V8 Monomorphic pointer traversal for the 99% case where child containers only fulfill leaf `.declare()` contracts or don't shadow mid-tree nodes.