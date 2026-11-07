---
title: "ADR-007: Non-Recursive Topological Execution Plan with Hybrid Fallback"
status: Accepted
date: 2026-03-07
category: Architecture
---

# ADR-007: Non-Recursive Topological Execution Plan with Hybrid Fallback

- **Status:** Accepted
- **Context:** Traditional containers resolve dependencies via mutual recursion (`get('A') -> factoryA -> get('B') -> factoryB`), growing the CPU call stack proportionally to graph depth. Because `register()` pre-declares dependencies statically, the container knows the DAG ahead of time.
- **Decision:**
  1. **Static DAG Nodes (`register`):** Pre-compile a flat Topological Execution Order (`ProviderNode[]` sorted bottom-up from leaves to root) per target node. At runtime, `.get('A')` iterates a flat `for` loop from `0` to `plan.length - 1`, populating leaf instances before parents with zero call-stack recursion (stack depth = 1).
  2. **Unsafe Dynamic Nodes (`registerUnsafe`):** Fall back to Depth-First Search (DFS) recursion equipped with an active `resolvingNow: Set<string>` to catch circular dependency loops ($A \rightarrow B \rightarrow A$) at runtime, while passing the shared `activeGraphCache` across the static/unsafe boundary.
- **Negative Constraints (Explicitly Forbidden):**
  - NO unbounded recursive `.get()` traversal for purely static DAG sub-trees.
  - NO silent infinite loops on circular dependencies (caught statically during topological sort for safe nodes, and via `resolvingNow` Set for unsafe nodes).
- **Consequences:**
  - *Positive:* Flat, predictable CPU execution loop for static graphs; guaranteed cycle detection in both static and dynamic modes.
  - *Negative:* Slight boot/first-access cost to compute the topological array for each root entry point.