---
title: "RFC-0001: Memory Representation & V8 Monomorphic Graph Kernel"
status: Normative Specification
date: 2026-11-06
category: Technical Specification
---

# RFC-0001: Memory Representation & V8 Monomorphic Graph Kernel

- **Feature Name:** `monomorphic_graph_kernel`
- **Status:** Normative Specification

## 1. Summary
Defines the low-level memory layout of the DI Container and its internal `ProviderNode` structs. By enforcing identical property initialization orders, null-prototype lookup dictionaries, and inlined `const enum` integer bitmasks, the engine guarantees V8 Monomorphic Hidden Classes (Maps) and single-instruction offset reads with zero runtime reflection or ES6 Proxy overhead.

## 2. Motivation
JavaScript/TypeScript DI containers traditionally suffer from two severe runtime penalties:
1. **Decorator Reflection (`reflect-metadata`):** Requires compiler flags (`emitDecoratorMetadata`) incompatible with fast single-file transpilers and bloats bundle metadata.
2. **ES6 `new Proxy()` Cradles & Duck-Typed Maps:** Intercepting property lookups via `new Proxy()` bypasses V8's fast property paths, while mutating or deleting object keys dynamically degrades V8 Inline Caches (ICs) from Monomorphic (1 shape $\rightarrow$ direct C++ memory offset jump) to Megamorphic (hash-table dictionary lookup).

We need a representation that treats OOP object instances and FP closures identically in memory while keeping V8 Hidden Classes 100% stable.

## 3. Guide-Level Explanation
To the developer, tokens are plain string literals (`'db'`, `'calcOrder'`), and providers are plain factory functions returning either an OOP class instance, a higher-order function closure, or a primitive value. Internally, the container stores every registration inside a strictly shaped `ProviderNode` object and links parent-to-child dependencies as direct memory pointers (`depNodes: ProviderNode[]`) rather than resolving strings repeatedly.

## 4. Reference-Level Explanation

### 4.1 Internal Bitmasks and Lifetime Constants (`const enum`)
All internal lifetime ranks and node state flags MUST be declared using `const enum` internal to the engine module so TypeScript erases the enum object and inlines raw V8 Small Integers (Smi—stored directly inside the tagged pointer with 0 bytes of heap allocation):

```typescript
const enum Lifetime {
  Transient = 0, // Rank 0: Uncached ephemeral allocation
  Graph     = 1, // Rank 1: Cached in temporary per-resolution map
  Scoped    = 2, // Rank 2: Cached in calling child container map
  Singleton = 3, // Rank 3: Cached directly on owner ProviderNode.instance
}

const enum NodeFlags {
  None       = 0,
  IsAsync    = 1 << 0, // 1: Factory or transitive child returns a Promise
  IsUnsafe   = 1 << 1, // 2: Registered via registerUnsafe (uses trackedCtx)
  IsThunk    = 1 << 2, // 4: Wrapped via asThunk/asVirtualProxy (safe across ranks)
  IsEager    = 1 << 3, // 8: Must be instantiated during container.prewarm()
  IsCompiled = 1 << 4, // 16: Direct depNodes pointers & topological plan built
  InFlight   = 1 << 5, // 32: Async singleton/scoped Promise currently pending
}
```

### 4.2 The Monomorphic ProviderNode Struct
Every node MUST be allocated via a single factory function `createProviderNode()` that initializes all 8 fields in the exact same sequence:

```typescript
interface ProviderNode {
  readonly key: string;                // Field 0: Interned string literal identifier
  readonly lifetime: Lifetime;         // Field 1: Smi 0..3
  flags: NodeFlags;                    // Field 2: Bitmask Smi
  readonly depKeys: readonly string[]; // Field 3: Static dependency names
  depNodes: ProviderNode[];            // Field 4: Direct memory pointers to child nodes
  plan: ProviderNode[];                // Field 5: Flattened post-order execution array
  instance: unknown;                   // Field 6: Direct SINGLETON cache slot (init: undefined)
  readonly factory: Function;          // Field 7: Paradigm-agnostic factory closure
}
```

### 4.3 Null-Prototype Storage Maps
Every container instance MUST allocate its key-indexed dictionaries using `Object.create(null)`:
- `providersByKey: Record<string, ProviderNode> = Object.create(null)`
- `scopedCache: Record<string, unknown> = Object.create(null)`

## 5. Normative Invariants & Negative Constraints
- **INV-1.1 (Monomorphic Shape Preservation):** Once a `ProviderNode` is allocated, the engine MUST NOT add new properties or execute `delete node.instance`. Evicting a cached singleton MUST assign `node.instance = undefined`.
- **NEG-1.1 (Zero Reflection):** The engine MUST NOT import or call `Reflect`, `reflect-metadata`, or inspect `Function.prototype.toString()` to parse parameter names at runtime.
- **NEG-1.2 (Zero ES6 Proxy):** The engine MUST NOT instantiate `new Proxy()` in the container core, dependency arguments, or resolution pipeline.
- **NEG-1.3 (Zero Runtime Codegen):** The engine MUST NOT call `new Function()` or `eval()`.
- **NEG-1.4 (Zero External Token Boilerplate):** The engine MUST NOT require users to instantiate or import `Symbol()` or `createToken()` references or user-facing `const enum` registries; string literals MUST be used directly.

## 6. Drawbacks
- Using string literals as external keys means two independent plugins could theoretically register the same string `'config'`; this is mitigated via plugin naming conventions and compile-time type tracking (RFC-0006).

## 7. Rationale & Alternatives
- *Why not convert string literals into integer slot IDs (`'db' -> 0 -> array[0]`) at runtime?* Looking up `'db'` in a string-to-integer map and then indexing into an array performs two lookups on entry. Storing instance directly on `ProviderNode` and linking `depNodes: ProviderNode[]` as direct object pointers requires only one lookup at the top-level `.get(key)` entry point, after which all child reads (`depNode.instance`) are direct V8 Hidden-Class field offsets.

## 8. Unresolved Questions
- None.