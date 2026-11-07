---
title: "ADR-004: Direct ProviderNode Pointer Graph & String Literal Keys"
status: Accepted
date: 2026-03-07
category: Architecture
---

# ADR-004: Direct ProviderNode Pointer Graph & String Literal Keys

- **Status:** Accepted
- **Context:** External token objects (`const DB = createToken()`) and `const enum` tokens force developers to export and import token references across files, break clean `{ db, tax }` object destructuring in factories, and (`const enum`) break single-file transpilers (esbuild, swc, native Node type-stripping). Meanwhile, translating strings to integer slot IDs (`'db' -> 0 -> array[0]`) at runtime adds an unnecessary double lookup on entry, while repeated `cache[dynamicKey]` string lookups inside a loop trigger V8 Megamorphic Keyed Loads.
- **Decision:**
  1. **External API:** Use plain String Literals (`'db'`) as keys (which V8 automatically interns in its compile-time string table at zero extra heap cost).
  2. **Internal Graph Representation:** Store a single fixed-shape `ProviderNode` per key `({ key, lifetime, depNodes, instance, factory })`. At registration/compilation time, translate the `deps: string[]` array into `depNodes: ProviderNode[]`—an array of direct memory pointers to the child `ProviderNode` structs.
  3. **Internal Flags:** Use internal `const enum` bitmasks/integers strictly inside the container engine file for Lifetime ranks so switch statements compile to fast CPU jump tables.
- **Negative Constraints (Explicitly Forbidden):**
  - NO mandatory external `createToken()` or `Symbol()` imports required in userland code.
  - NO user-facing `const enum` token registries.
  - NO string-to-integer dictionary translation during runtime graph traversal; internal graph edges traverse direct `ProviderNode` object references (`depNode.instance`).
- **Consequences:**
  - *Positive:* Zero token imports across files, clean (`{ db, tax }`) destructuring, only one string lookup at the top-level `.get('root')` entry point, and $O(1)$ V8 Monomorphic property offset reads (`depNode.instance`) for the entire dependency tree.
  - *Negative:* Requires a lightweight linking pass (either eagerly during bottom-up registration or once on first resolution for forward-declared `.declare()` nodes) to bind `depNodes` pointers.