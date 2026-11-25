/**
 * @module @computerwwwizards/di-kernel/types
 *
 * Pure TypeScript 6.0.3+ type specification for a synchronous, capture-tracked,
 * lattice-verified Inversion of Control (IoC) kernel.
 *
 * This file contains ONLY pure types and interfaces (zero runtime code, zero
 * ambient `declare const` / `declare function` value lies, zero `any`, zero
 * classical DI presets). It is safe to re-export via `export type * from './types.js'`
 * from `./index.ts` without conflicting with the runtime `TAINT_BITS` and
 * `createContainer` exports.
 *
 * ============================================================================
 * COMPILER & RUNTIME BASELINE (NORMATIVE)
 * ============================================================================
 * - TypeScript: >= 6.0.3 (aligned for zero-diff migration to TypeScript 7 / tsgo)
 * - Recommended `tsconfig.json`:
 *   ```json
 *   {
 *     "compilerOptions": {
 *       "target": "es2025",
 *       "lib": ["es2025", "esnext.disposable"],
 *       "module": "esnext",
 *       "moduleResolution": "bundler",
 *       "types": [],
 *       "strict": true,
 *       "exactOptionalPropertyTypes": true,
 *       "noUncheckedIndexedAccess": true,
 *       "isolatedDeclarations": true,
 *       "erasableSyntaxOnly": true,
 *       "verbatimModuleSyntax": true
 *     }
 *   }
 *   ```
 *   (`strict`, `target: "es2025"`, `module: "esnext"`, `types: []`,
 *   `noUncheckedSideEffectImports`, and `libReplacement: false` are defaults
 *   in TS 6.0.3, listed explicitly here for contract stability.)
 *
 * ============================================================================
 * CORE KERNEL INVARIANTS
 * ============================================================================
 * 1. **Zero global mutable state:** Tokens are minted per container hierarchy
 *    from a root-owned `TokenSpace` and inherited downward only. Parent and
 *    sibling containers cannot bind, resolve, or evict a descendant's tokens.
 * 2. **100% synchronous resolution:** Eliminates async interleaving hazards on
 *    ephemeral passes, cycle guards, and capture-stack tracking.
 * 3. **Frozen graph topology:** `storage`, `state`, `target`, `captures`,
 *    `deps`, and `discharges` are immutable after `bind()`. Rebinding is
 *    strictly provider-only, so a single `verify()` proof remains valid across
 *    all future factory swaps.
 * 4. **Lexical scope isolation for `'provider'` targets:** A retained
 *    `'provider'`-targeted binding resolves its `captures` and `deps` strictly
 *    in its owning container's scope, making cross-request state leakage into
 *    ancestor singletons structurally impossible.
 * 5. **Dual-lattice local discharges:** Per-origin `discharges` move cleared
 *    bits from `mask` into `dischargedMask` at the declaring binding site.
 *    Across diamond branches, active taints (`mask`) join with bitwise OR (`|`,
 *    may-taint) while inherited sanitizations (`sanitizedMask`) join with
 *    bitwise AND (`&`, must-sanitize) so an unsanitized sibling branch can
 *    never be masked by a sanitized one.
 * 6. **Neutral fact emission:** The kernel computes exact per-token active
 *    masks, discharged masks, capture relations, and diamond flags; policy
 *    enforcement and escape-hatch ergonomics live strictly outside the kernel.
 */

// ============================================================================
// 1. BRANDED SMI INTEGER TOKENS & TUPLE INFERENCE PRIMITIVES
// ============================================================================

declare const TOKEN_BRAND: unique symbol;

/**
 * Opaque, strictly invariant dependency token carrying payload type `T`.
 *
 * **Type-Level Invariance:**
 * - `Token<Admin>` is NOT assignable to `Token<User>`, nor vice versa.
 * - Raw `number` values are rejected at compile time.
 * - `Token<never>`, `Token<unknown>`, and `Token<void>` are all valid and
 *   assignable to {@link AnyToken}.
 *
 * **Runtime & V8 Optimization Contract:**
 * - MUST be a plain V8 SMI integer (`0, 1, 2, ...`) allocated monotonically
 *   from the root container's `TokenSpace` — zero object allocation on
 *   creation, lookup, or storage.
 * - Compatible with `Map<AnyToken, Entry>` today and $O(1)$ dense array
 *   indexing (`store[token]`) later without breaking any public type.
 * - Cold metadata (`owners: ContainerImpl[]`, `names: (string | undefined)[]`)
 *   MUST live in parallel arrays on `TokenSpace` and NEVER be read on the
 *   `get()` fast path unless formatting an error.
 * - Intra-hierarchy scoping (ancestor-only visibility) is enforced at runtime
 *   in $O(1)$ fast-path (`owner === this || owner === this.root`) plus an
 *   $O(\Delta\text{depth})$ ancestor walk. Cross-root isolation between two
 *   independent `createContainer()` trees is maintained by discipline unless
 *   the runtime packs `(rootId, localId)` into the 31-bit SMI.
 */
export type Token<T> = number & {
  readonly [TOKEN_BRAND]: (in_: T) => T;
};

/**
 * Sound, `any`-free top type for every invariant {@link Token}.
 *
 * Function parameters are contravariant (`never` accepts any `T`) and return
 * types are covariant (`unknown` accepts any `T`), so every `Token<T>` is
 * assignable to `AnyToken` while raw numbers remain rejected.
 *
 * **Implementation Note:** Internal resolution helpers (`resolveRoot`,
 * `resolveInternal`) MUST accept `token: AnyToken` and return `unknown` rather
 * than `<T>(token: Token<T>)`, because passing an `AnyToken` to a generic
 * `Token<T>` parameter infers `T = never` from the contravariant position.
 */
export type AnyToken = number & {
  readonly [TOKEN_BRAND]: (in_: never) => unknown;
};

/**
 * Extracts the payload type `T` from a {@link Token}.
 *
 * Intentionally unconstrained on `Tok` so homomorphic tuple mappings
 * (`{ readonly [K in keyof Tokens]: TokenValue<Tokens[K]> }`) compile cleanly
 * without `TS2344` across generic, variadic, and optional tuple parameters.
 *
 * @example
 * ```ts
 * type A = TokenValue<Token<User>>;             // User
 * type B = TokenValue<AnyToken>;                // unknown
 * type C = TokenValue<Token<Foo> | Token<Bar>>; // Foo | Bar
 * type D = TokenValue<Token<never>>;            // never
 * ```
 */
export type TokenValue<Tok> = Tok extends {
  readonly [TOKEN_BRAND]: (in_: never) => infer T;
}
  ? T
  : never;

/**
 * Maps a `captures` token tuple to a readonly tuple of eagerly resolved values.
 *
 * Handles empty, omitted, conditional, variadic, and non-tuple array inputs
 * soundly under `noUncheckedIndexedAccess: true`:
 * - `readonly []`, `undefined`, or `never` -> `readonly []`
 * - `readonly [Token<A>, Token<B>]` -> `readonly [A, B]`
 * - `readonly [Token<A>] | undefined` -> `readonly [A] | readonly []`
 * - `Token<A>[]` -> `readonly A[]` (indexing yields `A | undefined`)
 */
export type ResolvedTuple<Tokens extends readonly AnyToken[] | undefined> = [
  Tokens,
] extends [never]
  ? readonly []
  : Tokens extends readonly AnyToken[]
    ? { readonly [K in keyof Tokens]: TokenValue<Tokens[K]> }
    : readonly [];

/**
 * Maps a `deps` token tuple to a readonly tuple of non-capturing lazy thunks.
 *
 * **V8 Optimization Contract:**
 * - Thunks MUST be cached per `(container, token)` via a top-level minimal
 *   factory capturing only `(container, token)` — never closed over `bind()`
 *   or `resolveInternal()` stack frames.
 * - For `this === binding.owner`, cache the entire thunk tuple directly on
 *   `InternalBinding` so repeated `get()` calls allocate zero arrays/closures.
 * - Invoking a thunk MUST detach from both active capture and ephemeral stacks
 *   using integer watermarks (`capturerBase`, `ephemeralBase`), NEVER
 *   `Array.prototype.splice()`.
 */
export type ThunkTuple<Tokens extends readonly AnyToken[] | undefined> = [
  Tokens,
] extends [never]
  ? readonly []
  : Tokens extends readonly AnyToken[]
    ? { readonly [K in keyof Tokens]: (this: void) => TokenValue<Tokens[K]> }
    : readonly [];

/**
 * Exact return type of `bind()` and `bindInsecure()` across every boolean
 * state of `rebindable?: R`:
 * - `false`, `undefined`, `false | undefined`, `never` -> `void`
 * - `true` -> `Fn` (guaranteed capability handle)
 * - `boolean`, `true | undefined`, `boolean | undefined` -> `Fn | undefined`
 *   (forces callers to narrow when `rebindable` is computed dynamically).
 */
export type BindResult<Fn, R extends boolean | undefined> = [R] extends [
  false | undefined,
]
  ? void
  : [R] extends [true]
    ? Fn
    : Fn | undefined;

// ============================================================================
// 2. STORAGE TIERS, STATE, TARGETING & EVICTION SEMANTICS
// ============================================================================

/**
 * Storage tiers backed by a container-owned store (`Map<AnyToken, StoredEntry>`
 * or future dense array).
 * - `'solid'`: Strongly retained until `evict()`, provider rebind, or `dispose()`.
 * - `'weak'`: Weakly retained via `WeakRef`; subject to V8 GC reclamation.
 */
export type RetainedStorage = 'solid' | 'weak';

/**
 * Complete storage tier set.
 * - `'none'`: Factory-direct; never stored. Pass-through for transitive runtime
 *   capture linking (MUST NOT push onto `capturerStack`, so an ancestor retained
 *   binding links directly to retained dependencies behind a `'none'` bridge).
 * - `'ephemeral'`: Shared across a single outermost `get()` pass; flushed in
 *   LIFO order via a dedicated `ephemeralOrder` stack when `pass.depth === 0`.
 *   Diamond cache hits MUST forward retained entries captured during the
 *   ephemeral's initial construction to any subsequent retained capturer.
 * - `'solid'` / `'weak'`: See {@link RetainedStorage}.
 *
 * **V8 Optimization Contract:**
 * - Encode internally as 2-bit SMI codes (`0=none, 1=ephemeral, 2=solid, 3=weak`)
 *   to index the 16-entry `Uint16Array` capture matrix via `(a << 2) | b`.
 * - Because `erasableSyntaxOnly: true` forbids `enum` / `const enum`, use plain
 *   module-private numeric `const`s internally.
 */
export type StorageKind = RetainedStorage | 'none' | 'ephemeral';

/**
 * Semantic purity declaration of a bound service.
 * - `'stateless'`: Pure / immutable service; capturing a `'stateful'` or
 *   insecure dependency emits `'state-leak'`.
 * - `'stateful'`: Holds mutable internal state; storing in `'weak'` emits
 *   `'volatile-state'`, and diamonds on `'none'` emit `'split-state-diamond'`.
 */
export type StateKind = 'stateless' | 'stateful';

/**
 * Selects which container owns the retained instance for `'solid'` / `'weak'`.
 *
 * - `'provider'` (default):
 *   - Stored on the container where `bind()` was called (`binding.owner`).
 *   - Validated eagerly at `bind()` time against `owner.allowedStores`.
 *   - **Lexical Resolution Rule:** Resolves its `captures` and `deps` strictly
 *     against `binding.owner` (NEVER against a descendant `caller`), structurally
 *     preventing child overrides or request state from polluting ancestor stores.
 *
 * - `'caller'`:
 *   - Stored on the container where `get()` was invoked (`caller`).
 *   - Validated at `get()` time (and statically in `caller.verify()`) against
 *     `caller.allowedStores`; throws {@link KernelError} (`'disallowed-storage'`)
 *     if disallowed.
 *   - Resolves its `captures` and `deps` against `caller`.
 *   - If captured by a `'provider'`-targeted retained binding, `verify()` emits
 *     `'captive-caller'` (catches the classic singleton-capturing-scoped trap).
 */
export type StorageTarget = 'provider' | 'caller';

/**
 * Behavior when an imperative `evict()`, provider rebind, or `dispose()`
 * targets a retained entry with active capturers (`capturedBy.size > 0`).
 *
 * - `'cascade'` (default): Reverse-topologically evicts all live capturers
 *   first (dependents disposed before dependency), eliminating split-brain state.
 * - `'block'`: Throws {@link KernelError} (`'eviction-blocked'`). Note:
 *   `dispose()` MUST evict retained stores in exact LIFO instantiation order
 *   (across both `'solid'` and `'weak'` stores via an intrusive doubly-linked
 *   list) so normal container shutdown succeeds cleanly even under `'block'`.
 * - `'orphan'`: Severs capture links without evicting capturers (explicit opt-in
 *   to detached references).
 */
export type EvictCapturedPolicy = 'cascade' | 'block' | 'orphan';

/** Enforcement decision returned by a {@link PolicyRule} during `verify()`. */
export type PolicyAction = 'allow' | 'warn' | 'deny';

// ============================================================================
// 3. FACTORIES, REBIND CAPABILITIES, DISCHARGES & DISCRIMINATED BIND OPTIONS
// ============================================================================

/**
 * Statically verified factory function.
 *
 * - `this: void`: Prevents accidental `this` reliance (the kernel invokes
 *   factories detached from options/binding objects) and pairs cleanly with
 *   TS 6.0's non-contextually-sensitive `this`-less functions.
 * - `captured`: Eagerly resolved values in positional order of `captures`.
 * - `deps`: Lazy `() => T` thunks in positional order of `deps`.
 */
export type Factory<
  T,
  Caps extends readonly AnyToken[] | undefined,
  Deps extends readonly AnyToken[] | undefined,
> = (
  this: void,
  captured: ResolvedTuple<Caps>,
  deps: ThunkTuple<Deps>
) => T;

/**
 * Object-capability handle returned exclusively by `bind(..., { rebindable: true })`.
 *
 * Replaces ONLY the factory implementation while preserving `storage`, `state`,
 * `target`, `captures`, `deps`, and `discharges` so graph topology and
 * `verify()` proofs remain permanently valid.
 *
 * **Eviction & Atomicity Contract:**
 * - `target === 'provider'` + retained storage: MUST evict the cached instance
 *   on `binding.owner` BEFORE swapping `binding.factory` so an `'eviction-blocked'`
 *   failure leaves the binding unchanged (strong exception safety).
 * - `target === 'caller'`: updates the factory for future resolutions ONLY;
 *   ancestor containers MUST NOT retain strong references to child containers
 *   to cascade rebinds (which would leak ephemeral request scopes).
 * - `'none'` / `'ephemeral'`: updates the factory with no eviction.
 * - Calling after `binding.owner.dispose()` throws `'container-disposed'`.
 */
export type RebindFn<
  T,
  Caps extends readonly AnyToken[] | undefined,
  Deps extends readonly AnyToken[] | undefined,
> = (this: void, fn: Factory<T, Caps, Deps>) => void;

/**
 * Read-only dynamic resolver passed to `bindInsecure()` factories.
 * Prevents insecure code from calling `bind()`, `evict()`, or `dispose()`.
 *
 * **Runtime Tracking Contract:**
 * - Calls executed synchronously *during* factory construction link resolved
 *   retained entries into the insecure node's `capturing`/`capturedBy` sets
 *   (best-effort cascade tracking).
 * - Calls executed *after* construction returns run with an empty capture stack.
 * - Implementation SHOULD cache one `Resolver` per container via a top-level
 *   factory (zero per-`get()` closure allocation).
 */
export type Resolver = <U>(this: void, token: Token<U>) => U;

/** Unverified factory for dynamic/legacy integrations via `bindInsecure()`. */
export type InsecureFactory<T> = (this: void, get: Resolver) => T;

/** Provider-only rebind capability returned by `bindInsecure(..., { rebindable: true })`. */
export type InsecureRebindFn<T> = (
  this: void,
  fn: InsecureFactory<T>
) => void;

/**
 * Per-origin taint discharge entry: `[originToken, bitmaskToDischarge]`.
 *
 * Used by local escape-hatch presets (e.g., startup snapshots, stateful weak
 * memo caches) to sanitize a known taint at the exact binding site instead of
 * weakening a repository-wide policy.
 *
 * - Pass `[selfToken, mask]` to discharge intrinsic `'self'` taints
 *   (e.g., `TAINT_BITS['volatile-state']` on an intentional weak memo cache).
 * - Pass `[originToken, mask]` to discharge a direct or transitive capture
 *   taint (e.g., `TAINT_BITS['frozen-none']` on an intentional snapshot).
 * - Every `origin` token in `discharges` MUST be in scope for the binding's
 *   container (validated in `bind()` / `bindInsecure()`).
 * - Multiple entries for the same `origin` combine via bitwise OR (`|`).
 */
export type TaintDischarge = readonly [origin: AnyToken, mask: TaintMask];

/**
 * Shared option fields for verified `bind()` calls.
 *
 * **Critical Type-Inference Note (`exactOptionalPropertyTypes: true`):**
 * `captures`, `deps`, and `rebindable` intentionally do NOT append `| undefined`
 * to the property annotation itself — instead, `| undefined` lives on the type
 * parameter constraints (`Caps`, `Deps`, `R`). Appending `| undefined` to the
 * property would cause TypeScript to strip `undefined` when matching conditional
 * inputs like `rebindable: flag as true | undefined` or `captures: cond ? [Tok] : undefined`,
 * unsoundly inferring `R = true` or `Caps = readonly [Token<X>]`.
 *
 * **Runtime Disjointness Note:**
 * Duplicate tokens within `captures`/`deps` and `captures ∩ deps` overlap MUST
 * be validated at runtime in `bind()`, NOT via type-level exclusion — distinct
 * tokens commonly share the same payload type (e.g., two `Token<string>` values),
 * which are structurally indistinguishable at the type level.
 */
interface BaseBindOptions<
  Caps extends readonly AnyToken[] | undefined,
  Deps extends readonly AnyToken[] | undefined,
  R extends boolean | undefined,
> {
  readonly state: StateKind;
  /**
   * Eagerly resolved tokens captured by this binding.
   * Pass inline array literals (inferred via `const Caps`) or `as const` arrays
   * to preserve positional tuple types under `noUncheckedIndexedAccess`.
   */
  readonly captures?: Caps;
  /** Non-capturing lazy thunk tokens. Must be disjoint from `captures`. */
  readonly deps?: Deps;
  /**
   * When `true`, `bind()` returns a provider-only {@link RebindFn}.
   * Retained bindings capturing a `rebindable: true` token receive `'pinned-mutable'`.
   * @default false
   */
  readonly rebindable?: R;
  /**
   * Per-origin taint bits explicitly discharged (sanitized) at this binding site.
   * Discharged bits move from `fact.mask` into `fact.dischargedMask` and remain
   * sanitized along this branch in ancestor folds (unless another diamond branch
   * reaches `origin` without discharging those bits).
   */
  readonly discharges?: readonly TaintDischarge[] | undefined;
}

/** Options for `storage: 'none'` (factory-direct; never stored; no disposal hooks). */
export interface NoneBindOptions<
  Caps extends readonly AnyToken[] | undefined = readonly [],
  Deps extends readonly AnyToken[] | undefined = readonly [],
  R extends boolean | undefined = false,
> extends BaseBindOptions<Caps, Deps, R> {
  readonly storage: 'none';
}

/** Options for `storage: 'ephemeral'` (shared within one `get()` pass; LIFO disposal). */
export interface EphemeralBindOptions<
  T,
  Caps extends readonly AnyToken[] | undefined = readonly [],
  Deps extends readonly AnyToken[] | undefined = readonly [],
  R extends boolean | undefined = false,
> extends BaseBindOptions<Caps, Deps, R> {
  readonly storage: 'ephemeral';
  /** Invoked in LIFO order when the outermost `get()` pass completes. */
  readonly onDispose?: ((this: void, instance: T) => void) | undefined;
}

/**
 * Options for `storage: 'solid'`.
 *
 * Because `'solid'` instances are strongly held until explicit eviction,
 * rebind, or `dispose()`, both `onDispose` and `onDecapture` are guaranteed
 * to receive the live `T` (never `undefined` from GC).
 *
 * **Implementation Contract (Nullable `T`):**
 * Cache hits MUST check presence of the `StoredEntry` wrapper in `solidStore`
 * (NOT `entry.value !== undefined`) so `Token<T | undefined>` and `Token<null>`
 * cache soundly without re-invoking the factory.
 */
export interface SolidBindOptions<
  T,
  Caps extends readonly AnyToken[] | undefined = readonly [],
  Deps extends readonly AnyToken[] | undefined = readonly [],
  R extends boolean | undefined = false,
> extends BaseBindOptions<Caps, Deps, R> {
  readonly storage: 'solid';
  /** @default 'provider' */
  readonly target?: StorageTarget | undefined;
  /** Invoked once when removed via `evict()`, provider rebind, or `dispose()`. */
  readonly onDispose?: ((this: void, instance: T) => void) | undefined;
  /**
   * Invoked whenever a retained capturer is disposed while this entry remains alive.
   * `remaining` is the post-decrement live capturer count (`0` = no capturers left).
   */
  readonly onDecapture?:
    | ((this: void, instance: T, remaining: number) => void)
    | undefined;
}

/**
 * Options for `storage: 'weak'`.
 *
 * **Compile-Time Guard (`T extends object`):**
 * Rejects primitives (`string`, `number`, `boolean`, `bigint`, `null`,
 * `undefined`, `void`, `symbol`), `never`, `unknown`, `{}`, and nullable unions
 * (`User | null`). `symbol` is deliberately excluded even though ES2023
 * `WeakKey` permits non-registered symbols, because TypeScript cannot
 * distinguish `Symbol()` from `Symbol.for()` (which throws a `TypeError` in
 * `WeakRef` at runtime).
 *
 * **GC Honesty:**
 * `instance` is `T | undefined` because `FinalizationRegistry` cannot hand back
 * an already-collected object, and a capturer may drop its strong reference
 * before being evicted.
 *
 * **V8 Optimization Contract:**
 * Allocate ONE `FinalizationRegistry` lazily on `root` with a top-level static
 * callback (zero per-container closure allocation).
 */
export interface WeakBindOptions<
  T extends object,
  Caps extends readonly AnyToken[] | undefined = readonly [],
  Deps extends readonly AnyToken[] | undefined = readonly [],
  R extends boolean | undefined = false,
> extends BaseBindOptions<Caps, Deps, R> {
  readonly storage: 'weak';
  /** @default 'provider' */
  readonly target?: StorageTarget | undefined;
  /** `instance` is `undefined` when triggered by V8 GC reclamation. */
  readonly onDispose?:
    | ((this: void, instance: T | undefined) => void)
    | undefined;
  /** `instance` is `undefined` if V8 reclaimed the entry before capturer eviction. */
  readonly onDecapture?:
    | ((this: void, instance: T | undefined, remaining: number) => void)
    | undefined;
}

/**
 * Discriminated union of all legal verified binding options for payload `T`.
 *
 * Uses non-distributive `[T] extends [never]` + `[T] extends [object]` +
 * `Extract<T, object>` so:
 * - Object & function types (`User`, `() => void`, `Foo | Bar`) enable `'weak'`.
 * - Primitives, `never`, `{}`, `unknown`, and nullable unions (`User | null`)
 *   reject `storage: 'weak'` at compile time with zero `TS2344`.
 */
export type BindOptions<
  T,
  Caps extends readonly AnyToken[] | undefined = readonly [],
  Deps extends readonly AnyToken[] | undefined = readonly [],
  R extends boolean | undefined = false,
> =
  | NoneBindOptions<Caps, Deps, R>
  | EphemeralBindOptions<T, Caps, Deps, R>
  | SolidBindOptions<T, Caps, Deps, R>
  | ([T] extends [never]
      ? never
      : [T] extends [object]
        ? WeakBindOptions<Extract<T, object>, Caps, Deps, R>
        : never);

/** Options for `bindInsecure()` with `storage: 'none'`. */
export interface InsecureNoneBindOptions<R extends boolean | undefined = false> {
  readonly storage: 'none';
  readonly rebindable?: R;
  readonly discharges?: readonly TaintDischarge[] | undefined;
}

/** Options for `bindInsecure()` with `storage: 'ephemeral'`. */
export interface InsecureEphemeralBindOptions<
  T,
  R extends boolean | undefined = false,
> {
  readonly storage: 'ephemeral';
  readonly rebindable?: R;
  readonly discharges?: readonly TaintDischarge[] | undefined;
  readonly onDispose?: ((this: void, instance: T) => void) | undefined;
}

/** Options for `bindInsecure()` with `storage: 'solid'`. */
export interface InsecureSolidBindOptions<
  T,
  R extends boolean | undefined = false,
> {
  readonly storage: 'solid';
  /** @default 'provider' */
  readonly target?: StorageTarget | undefined;
  readonly rebindable?: R;
  readonly discharges?: readonly TaintDischarge[] | undefined;
  readonly onDispose?: ((this: void, instance: T) => void) | undefined;
  readonly onDecapture?:
    | ((this: void, instance: T, remaining: number) => void)
    | undefined;
}

/** Options for `bindInsecure()` with `storage: 'weak'` (objects/functions only). */
export interface InsecureWeakBindOptions<
  T extends object,
  R extends boolean | undefined = false,
> {
  readonly storage: 'weak';
  /** @default 'provider' */
  readonly target?: StorageTarget | undefined;
  readonly rebindable?: R;
  readonly discharges?: readonly TaintDischarge[] | undefined;
  readonly onDispose?:
    | ((this: void, instance: T | undefined) => void)
    | undefined;
  readonly onDecapture?:
    | ((this: void, instance: T | undefined, remaining: number) => void)
    | undefined;
}

/**
 * Discriminated options for `bindInsecure()`.
 * Omits `state`, `captures`, and `deps`; statically treated as `state: 'stateful'`
 * with intrinsic `'insecure'` taint. Enforces `[T] extends [object]` (and
 * excludes `never`) for `'weak'`.
 */
export type InsecureBindOptions<
  T,
  R extends boolean | undefined = false,
> =
  | InsecureNoneBindOptions<R>
  | InsecureEphemeralBindOptions<T, R>
  | InsecureSolidBindOptions<T, R>
  | ([T] extends [never]
      ? never
      : [T] extends [object]
        ? InsecureWeakBindOptions<Extract<T, object>, R>
        : never);

/** Container creation options for both root and child containers. */
export interface CreateOptions {
  /**
   * Retained stores owned by this container.
   * Pass `[]` for a pure pass-through / binding-override container.
   * (`'none'` has no store; `'ephemeral'` lives strictly on the `get()` stack.)
   *
   * **V8 Optimization Contract:** Encode internally as a 2-bit SMI bitmask.
   */
  readonly allowedStores: readonly RetainedStorage[];
  /** @default 'cascade' */
  readonly onEvictCaptured?: EvictCapturedPolicy | undefined;
}

// ============================================================================
// 4. LATTICE TAINT MODEL, BITMASK LAYOUT & VERIFICATION CONTRACTS
// ============================================================================

/**
 * Canonical taint facts emitted by the bottom-up token-keyed lattice fold.
 *
 * **Intrinsic (resolution-time) facts:**
 * - `'captive-ephemeral'`: Retained (`solid`/`weak`) captures `ephemeral`.
 * - `'captive-caller'`: Retained `'provider'`-targeted binding captures a
 *   retained `'caller'`-targeted binding (singleton capturing scoped).
 * - `'escaped-ephemeral'`: `none` captures `ephemeral` (local edge only; does
 *   not propagate upward because retained ancestors emit `'captive-ephemeral'`).
 * - `'weak-pinned'`: `solid`, `weak`, or `ephemeral` strongly captures `weak`.
 * - `'frozen-none'`: `solid`, `weak`, or `ephemeral` caches a `none` instance.
 * - `'volatile-state'`: `weak` stores a `stateful` or insecure binding.
 * - `'state-leak'`: `stateless` captures a `stateful` or insecure dependency.
 * - `'split-state-diamond'`: Diamond collision on a `none` + (`stateful` | `insecure`)
 *   token, or two distinct bindings for the same shadowed token where either is stateful.
 * - `'shared-diamond'`: Diamond collision on a shared or stateless token.
 * - `'insecure'`: Bound via `bindInsecure()`, or captures an insecure binding.
 * - `'thunk-cycle'`: Node participates in a lazy cycle involving >= 1 `deps` edge.
 *
 * **Latent (operation-time) facts:**
 * - `'eviction-coupled'`: Dependent captures a `solid` or `weak` dependency
 *   (inert unless `evict()` / `dispose()` is called).
 * - `'pinned-mutable'`: Retained (`solid`/`weak`) captures a `rebindable: true`
 *   token (inert unless the rebind handle is invoked).
 */
export type TaintTag =
  | 'insecure'
  | 'eviction-coupled'
  | 'captive-ephemeral'
  | 'captive-caller'
  | 'weak-pinned'
  | 'frozen-none'
  | 'escaped-ephemeral'
  | 'volatile-state'
  | 'state-leak'
  | 'pinned-mutable'
  | 'split-state-diamond'
  | 'shared-diamond'
  | 'thunk-cycle';

/**
 * Normative 13-bit SMI bitmask layout implemented by the runtime `TAINT_BITS`
 * export in `./index.ts`.
 *
 * **V8 Optimization Contract:**
 * - All lattice merges MUST execute via single-instruction bitwise OR
 *   (`acc.mask |= incomingMask`) and must-sanitize joins via bitwise AND
 *   (`acc.sanitizedMask &= incomingSanitized`).
 * - Direct storage checks MUST index a 16-entry `Uint16Array` lookup table
 *   (`DIRECT_STORAGE_MATRIX[(a << 2) | b]`).
 * - Local-only / dependent-relative bits (`'escaped-ephemeral'`,
 *   `'eviction-coupled'`, `'frozen-none'`, `'weak-pinned'`, `'pinned-mutable'`,
 *   `'captive-caller'`) MUST be masked off during upward propagation and
 *   recomputed against each ancestor's own `(storage, target)` minus the
 *   branch's `sanitizedMask`.
 */
export interface TaintBitsMap {
  readonly insecure: 1;
  readonly 'eviction-coupled': 2;
  readonly 'captive-ephemeral': 4;
  readonly 'captive-caller': 8;
  readonly 'weak-pinned': 16;
  readonly 'frozen-none': 32;
  readonly 'escaped-ephemeral': 64;
  readonly 'volatile-state': 128;
  readonly 'state-leak': 256;
  readonly 'pinned-mutable': 512;
  readonly 'split-state-diamond': 1024;
  readonly 'shared-diamond': 2048;
  readonly 'thunk-cycle': 4096;
}

/** Single power-of-two bit literal from {@link TaintBitsMap}. */
export type TaintBit = TaintBitsMap[TaintTag];

/** Bitwise union (`|`) of zero or more {@link TaintBit} flags (fits in V8 SMI). */
export type TaintMask = number;

/**
 * Topological relationship between `dependent` and `fact.origin`:
 * - `'self'`: `origin === dependent` (intrinsic node taints: `'insecure'`,
 *   `'volatile-state'`, `'thunk-cycle'`).
 * - `'direct'`: `origin` appears directly in `dependent`'s `captures` (dominates
 *   `'transitive'` on lattice merge if reached both directly and transitively).
 * - `'transitive'`: `origin` is reached only through 1+ intermediate captures.
 */
export type CaptureRelation = 'self' | 'direct' | 'transitive';

/**
 * Folded lattice entry for a single originating token within a dependent's
 * captured subgraph.
 *
 * **Optimization Contract:**
 * Implementations SHOULD materialize `taints` and `dischargedTaints` lazily
 * (via getters decoding `mask` and `dischargedMask`, returning a shared empty
 * `ReadonlySet` when the mask is `0`) so `verify()` with bitmask-based policies
 * pays zero `Set` allocation overhead.
 */
export interface FoldedTokenFact {
  readonly origin: AnyToken;
  readonly relation: CaptureRelation;
  /** `true` iff `origin` was reached via 2+ distinct capture paths (diamond). */
  readonly diamond: boolean;
  /** Bitwise OR of all active (undischarged) {@link TaintBitsMap} flags. */
  readonly mask: TaintMask;
  /** Bitwise OR of {@link TaintBitsMap} flags explicitly discharged at this binding site. */
  readonly dischargedMask: TaintMask;
  /** Lazily decoded readonly view matching active `mask`. */
  readonly taints: ReadonlySet<TaintTag>;
  /** Lazily decoded readonly view matching `dischargedMask`. */
  readonly dischargedTaints: ReadonlySet<TaintTag>;
}

/**
 * Policy evaluator invoked by `verify()` for every non-trivial `(dependent, fact)`
 * entry (`fact.mask !== 0 || fact.dischargedMask !== 0 || fact.diamond`).
 *
 * Because `verify()` still invokes `policy` when `fact.mask === 0` and
 * `fact.dischargedMask !== 0`:
 * - Standard policies testing `(fact.mask & denyMask) !== 0` automatically stay
 *   silent on locally discharged escape hatches.
 * - Audit policies testing `(fact.dischargedMask & forbidMask) !== 0` can still
 *   detect and deny escape hatches in security-critical modules.
 *
 * @example
 * ```ts
 * // Standard policy: denies fatal undischarged taints, stays silent on discharges
 * const strict: PolicyRule = (_dep, fact) => {
 *   const fatal =
 *     TAINT_BITS['captive-ephemeral'] |
 *     TAINT_BITS['captive-caller'] |
 *     TAINT_BITS['split-state-diamond'];
 *   return (fact.mask & fatal) !== 0 ? 'deny' : 'allow';
 * };
 *
 * // Audit policy: forbids any escape-hatch discharge on PaymentToken
 * const audit: PolicyRule = (dep, fact) => {
 *   if (dep === PaymentToken && fact.dischargedMask !== 0) return 'deny';
 *   return strict(dep, fact);
 * };
 * ```
 */
export type PolicyRule = (
  this: void,
  dependent: AnyToken,
  fact: FoldedTokenFact
) => PolicyAction;

/** Non-allowed policy finding recorded in {@link VerificationReport.violations}. */
export interface PolicyViolation {
  readonly dependent: AnyToken;
  readonly origin: AnyToken;
  readonly fact: FoldedTokenFact;
  readonly action: Exclude<PolicyAction, 'allow'>;
}

/**
 * Hard structural errors that render the effective dependency graph invalid
 * regardless of policy (always force `VerificationReport.ok === false`).
 */
export type StructuralError =
  | {
      readonly kind: 'disallowed-caller-store';
      readonly token: AnyToken;
      readonly storage: RetainedStorage;
    }
  | {
      readonly kind: 'unbound-dependency';
      readonly dependent: AnyToken;
      readonly missing: AnyToken;
      readonly edge: 'capture' | 'dep';
      /**
       * `'provider'` means `dependent` is `'provider'`-targeted and `missing`
       * is absent from `dependent`'s owning container scope (even if bound on a
       * descendant child). `'caller'` means absent from the verified container.
       */
      readonly resolutionScope: StorageTarget;
    }
  | {
      readonly kind: 'capture-cycle';
      /** Ordered cycle starting and ending at the repeated token: `[A, B, ..., A]`. */
      readonly cycle: readonly [AnyToken, ...AnyToken[]];
    };

/**
 * Deterministic, machine-readable output of `container.verify(policy?)`.
 * Evaluated against the effective graph (inherited ancestor + local bindings)
 * from the calling container's perspective.
 */
export interface VerificationReport {
  /** `true` iff `structuralErrors.length === 0` and no violation has `action === 'deny'`. */
  readonly ok: boolean;
  readonly structuralErrors: readonly StructuralError[];
  /** Outer key: dependent token; inner key: originating token in its captured subgraph. */
  readonly folded: ReadonlyMap<AnyToken, ReadonlyMap<AnyToken, FoldedTokenFact>>;
  readonly violations: readonly PolicyViolation[];
}

// ============================================================================
// 5. TYPED KERNEL RUNTIME ERRORS
// ============================================================================

/** Exhaustive machine-readable runtime error codes thrown by the kernel. */
export type KernelErrorCode =
  | 'container-disposed'
  | 'token-out-of-scope'
  | 'duplicate-binding'
  | 'duplicate-capture'
  | 'duplicate-dep'
  | 'overlapping-capture-and-dep'
  | 'disallowed-storage'
  | 'unbound-token'
  | 'capture-cycle'
  | 'weak-primitive-value'
  | 'eviction-blocked';

/** Structured runtime error thrown by all kernel guard failures. */
export interface KernelError extends Error {
  readonly name: 'KernelError';
  readonly code: KernelErrorCode;
  readonly token?: AnyToken | undefined;
  readonly relatedTokens?: readonly AnyToken[] | undefined;
}

// ============================================================================
// 6. CONTAINER CONTRACT & ROOT FACTORY SIGNATURE
// ============================================================================
 // TODO: consider Implements `Disposable` for native `using` explicit resource management?.

/**
 * Synchronous, capture-tracking DI container.
 *
 *
 * **V8 / Implementation Optimization Contract:**
 * 1. **Monomorphic hidden classes:** Internal structs (`InternalBinding`,
 *    `StoredEntry`, `EphemeralEntry`, `PassContext`, `TokenSpace`) MUST be
 *    concrete classes with fixed field initialization order (never dynamically
 *    add or `delete` properties).
 * 2. **Warm solid fast path:** On outermost lookups (`pass.depth === 0`),
 *    hitting `this.solidStore` returns immediately with a single `Map.get(smi)`
 *    (zero `try/finally`, zero stack ops, zero allocations). Shadowing a token
 *    that already has a cached `caller`-targeted entry on a child container
 *    MUST eagerly evict that entry at `bind()` time so the fast path can never
 *    serve stale instances.
 * 3. **Zero hot-path closures or temporary arrays:** Use indexed `for`/`while`
 *    loops across resolution, validation, eviction cascade, and `verify()`
 *    DFS/fold; hoist recursive verification helpers to module scope so they
 *    capture zero lexical context.
 * 4. **Lazy capture `Set`s & intrusive LIFO list:** `StoredEntry.capturing` and
 *    `capturedBy` SHOULD remain `null` until an edge actually forms. Retained
 *    entries (`solid` + `weak` unified) SHOULD link into an intrusive
 *    doubly-linked list on their owning container for $O(1)$ insertion/removal
 *    and zero-allocation exact LIFO `dispose()`.
 * 5. **Shadow-aware static verification:** `verify()` DFS and memo tables MUST
 *    key on internal binding identity rather than `AnyToken` alone so child
 *    shadowing never corrupts ancestor folds.
 */
export interface Container {
  /** `true` after {@link dispose} has completed. Zero-cost boolean field read. */
  readonly disposed: boolean;

  /**
   * Mints a branded SMI integer token scoped to this container and all its
   * descendants. Parent and sibling containers reject this token at runtime
   * with {@link KernelError} (`'token-out-of-scope'`).
   *
   * Always provide an explicit type argument `<T>`.
   *
   * @param debugName Cold diagnostic label stored outside the token value.
   *
   * @example
   * ```ts
   * const DbToken = app.createToken<Database>('Db');
   * ```
   */
  createToken<T>(debugName?: string | undefined): Token<T>;

  /** Returns the cold diagnostic name for `token`, or a fallback (`Token#<id>`). */
  getTokenName(token: AnyToken): string;

  /**
   * Returns `true` iff `token` is in scope for this container AND has an active
   * binding on this container or an ancestor. Does not trigger instantiation.
   */
  has(token: AnyToken): boolean;

  /**
   * Creates a child container sharing the root's `TokenSpace` and active
   * resolution `PassContext`, with its own `allowedStores`, `onEvictCaptured`,
   * local bindings/overrides, and retained stores.
   *
   * Ancestors MUST NOT retain strong references to created children so request
   * scopes can be garbage-collected freely after `dispose()`.
   *
   * @example
   * ```ts
   * using req = app.createChild({ allowedStores: ['solid'] });
   * req.bind(ReqId, { storage: 'solid', state: 'stateless' }, () => 'req-42');
   * const ctrl = req.get(CtrlToken);
   * // Calls `req.dispose()` automatically on block exit.
   * ```
   */
  createChild(options: CreateOptions): Container;

  /**
   * Executes a registration module against this container and returns its result
   * (e.g., exposing selected {@link RebindFn} handles to a test harness).
   */
  use<R = void>(module: (this: void, container: Container) => R): R;

  /**
   * Binds a statically verified factory to `token`.
   *
   * **Inference Contract (TS 6.0.3+ `const` + `NoInfer`):**
   * - Never pass explicit type arguments to `bind()`.
   * - `T` is inferred solely from `token`; `options` hooks and `fn` return type
   *   are strictly checked against `NoInfer<T>`.
   * - `Caps`, `Deps`, and `R` are inferred solely from `options`; `fn` parameter
   *   tuples and the returned {@link BindResult} are derived from them.
   * - Because TS 6.0 treats `this`-less method syntax as non-contextually-sensitive,
   *   `onDispose(inst) { ... }` and `onDecapture(inst, n) { ... }` infer cleanly
   *   in both arrow and method syntax.
   *
   * @example
   * ```ts
   * // 1. Rebindable solid singleton -> returns typed RebindFn
   * const rebindAuth = app.bind(
   *   AuthToken,
   *   { storage: 'solid', state: 'stateful', rebindable: true },
   *   () => new AuthService()
   * );
   *
   * // 2. Captures Db eagerly, reads Auth lazily via thunk, discharges frozen-none on Config
   * app.bind(
   *   CtrlToken,
   *   {
   *     storage: 'solid',
   *     state: 'stateless',
   *     captures: [DbToken, ConfigToken],
   *     deps: [AuthToken],
   *     discharges: [[ConfigToken, TAINT_BITS['frozen-none']]],
   *     onDispose(ctrl) { ctrl.shutdown(); },
   *   },
   *   ([db, cfg], [getAuth]) => new Controller(db, cfg, getAuth)
   * );
   *
   * // 3. Caller-targeted binding (per-request scope without hardcoded presets)
   * app.bind(
   *   RepoToken,
   *   { storage: 'solid', target: 'caller', state: 'stateful', captures: [DbToken, ReqId] },
   *   ([db, reqId]) => new UserRepo(db, reqId)
   * );
   * ```
   */
  bind<
    T,
    const Caps extends readonly AnyToken[] | undefined = readonly [],
    const Deps extends readonly AnyToken[] | undefined = readonly [],
    const R extends boolean | undefined = false,
  >(
    token: Token<T>,
    options: BindOptions<NoInfer<T>, Caps, Deps, R>,
    fn: Factory<NoInfer<T>, NoInfer<Caps>, NoInfer<Deps>>
  ): BindResult<RebindFn<NoInfer<T>, NoInfer<Caps>, NoInfer<Deps>>, R>;

  /**
   * Binds an unverified dynamic factory (`unsafe` escape hatch).
   *
   * Stamps the binding with `'insecure'` taint and treats it as `state: 'stateful'`
   * in the lattice fold. Dependents placing `token` in `deps` (thunk) instead of
   * `captures` act as a taint firewall and do NOT inherit `'insecure'`.
   *
   * @example
   * ```ts
   * app.bindInsecure(LegacyToken, { storage: 'solid' }, (get) => {
   *   return new LegacyClient(get(ConfigToken));
   * });
   * ```
   */
  bindInsecure<T, const R extends boolean | undefined = false>(
    token: Token<T>,
    options: InsecureBindOptions<NoInfer<T>, R>,
    fn: InsecureFactory<NoInfer<T>>
  ): BindResult<InsecureRebindFn<NoInfer<T>>, R>;

  /**
   * Synchronously resolves `token` from this container's effective binding table.
   * Flushes all `'ephemeral'` entries in LIFO order when the outermost call exits.
   * Throws {@link KernelError} on `'container-disposed'`, `'token-out-of-scope'`,
   * `'unbound-token'`, `'disallowed-storage'`, `'capture-cycle'`, or
   * `'weak-primitive-value'`.
   */
  get<T>(token: Token<T>): T;

  /**
   * Imperatively evicts a retained (`'solid'` or `'weak'`) instance while keeping
   * its binding recipe intact. Applies the owning store's `onEvictCaptured`
   * policy (`'cascade'`, `'block'`, or `'orphan'`) and fires `onDecapture` /
   * `onDispose`. No-op for `'none'`, `'ephemeral'`, or uninstantiated tokens.
   */
  evict(token: AnyToken): void;

  /**
   * Runs structural validation, detects thunk cycles, executes the bottom-up
   * token-keyed dual-lattice bitmask fold, and evaluates `policy` across all
   * effective bindings visible from this container. Pure read-only pass (zero
   * instantiation).
   */
  verify(policy?: PolicyRule | undefined): VerificationReport;

  /**
   * Disposes all retained instances owned by this container in exact LIFO order,
   * cascades decaptures to ancestor dependencies, clears cached thunks, and
   * marks this container permanently disposed. Idempotent.
   */
  dispose(): void;

  /** Explicit Resource Management alias for {@link dispose} (`using` blocks). */
  [Symbol.dispose](): void;
}

/** Signature of the root container factory implemented in `./index.ts`. */
export type CreateContainerFn = (
  this: void,
  options: CreateOptions
) => Container;
