/**
 * @module @computerwwwizards/di-kernel/presets
 *
 * Mechanically sympathetic presets, O(1) bitmask policies, zero-allocation
 * virtual proxies, extensible `BindingDescriptor` protocol, and `Assembler`
 * container extension built directly on `./index.js` and `./types.js`.
 *
 * Compiles cleanly under TypeScript 6.0.3+ with:
 * `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
 * `isolatedDeclarations`, `erasableSyntaxOnly`, and `verbatimModuleSyntax`.
 */

import { TAINT_BITS, createContainer } from '.';
import type {
  AnyToken,
  BindOptions,
  BindResult,
  Container,
  CreateOptions,
  EphemeralBindOptions,
  EvictCapturedPolicy,
  Factory,
  FoldedTokenFact,
  InsecureBindOptions,
  InsecureFactory,
  InsecureRebindFn,
  NoneBindOptions,
  PolicyAction,
  PolicyRule,
  RebindFn,
  RetainedStorage,
  SolidBindOptions,
  StateKind,
  StorageKind,
  StorageTarget,
  StructuralError,
  TaintDischarge,
  TaintMask,
  TaintTag,
  Token,
  TokenValue,
  VerificationReport,
  WeakBindOptions,
} from './types';

// ============================================================================
// 1. STANDALONE VIRTUAL PROXIES (`toLiveProxy` & `toAsyncProxy`)
// ============================================================================

/**
 * Lifts every method on an object/class (or a callable function) into an async
 * Promise-returning signature, flattening nested Promises via `Awaited<R>`.
 */
export type Promisified<T> = T extends (...args: infer Args) => infer R
  ? (this: void, ...args: Args) => Promise<Awaited<R>>
  : T extends object
    ? {
        readonly [K in keyof T as T[K] extends (...args: never[]) => unknown
          ? K
          : never]: T[K] extends (...args: infer Args) => infer R
          ? (this: void, ...args: Args) => Promise<Awaited<R>>
          : never;
      }
    : never;

type CallableProxyTarget = (...args: unknown[]) => unknown;

/** Single shared, non-mutated arrow target (no `delete` dictionary-mode deopt). */
const SHARED_PROXY_TARGET: CallableProxyTarget = () => undefined;

function createLiveMethodTrampoline(
  thunk: (this: void) => object,
  prop: PropertyKey
): (this: void, ...args: unknown[]) => unknown {
  return function liveProxyMethod(this: void): unknown {
    const target = thunk();
    const member: unknown = Reflect.get(target, prop, target);
    if (typeof member !== 'function') {
      throw new TypeError(
        `Property "${String(prop)}" is not callable on live proxy target.`
      );
    }
    const fn = member as (this: unknown, ...a: unknown[]) => unknown;
    switch (arguments.length) {
      case 0:
        return fn.call(target);
      case 1:
        return fn.call(target, arguments[0]);
      case 2:
        return fn.call(target, arguments[0], arguments[1]);
      case 3:
        return fn.call(target, arguments[0], arguments[1], arguments[2]);
      case 4:
        return fn.call(
          target,
          arguments[0],
          arguments[1],
          arguments[2],
          arguments[3]
        );
      default:
        return fn.apply(target, arguments as unknown as unknown[]);
    }
  };
}

class LiveProxyHandler implements ProxyHandler<CallableProxyTarget> {
  private readonly thunk: (this: void) => object;
  private methodCache: Map<
    PropertyKey,
    (this: void, ...args: unknown[]) => unknown
  > | null = null;

  constructor(thunk: (this: void) => object) {
    this.thunk = thunk;
  }

  get(_t: CallableProxyTarget, prop: PropertyKey): unknown {
    const cache = this.methodCache;
    if (cache !== null) {
      const cached = cache.get(prop);
      if (cached !== undefined) return cached;
    }
    const target = this.thunk();
    const value: unknown = Reflect.get(target, prop, target);
    if (typeof value === 'function') {
      const trampoline = createLiveMethodTrampoline(this.thunk, prop);
      if (cache === null) {
        const next = new Map<
          PropertyKey,
          (this: void, ...args: unknown[]) => unknown
        >();
        next.set(prop, trampoline);
        this.methodCache = next;
      } else {
        cache.set(prop, trampoline);
      }
      return trampoline;
    }
    return value;
  }

  set(_t: CallableProxyTarget, prop: PropertyKey, value: unknown): boolean {
    const target = this.thunk();
    return Reflect.set(target, prop, value, target);
  }

  has(_t: CallableProxyTarget, prop: PropertyKey): boolean {
    return Reflect.has(this.thunk(), prop);
  }

  deleteProperty(_t: CallableProxyTarget, prop: PropertyKey): boolean {
    return Reflect.deleteProperty(this.thunk(), prop);
  }

  ownKeys(): (string | symbol)[] {
    return Reflect.ownKeys(this.thunk());
  }

  getOwnPropertyDescriptor(
    _t: CallableProxyTarget,
    prop: PropertyKey
  ): PropertyDescriptor | undefined {
    const desc = Reflect.getOwnPropertyDescriptor(this.thunk(), prop);
    if (desc === undefined) return undefined;
    return desc.configurable ? desc : { ...desc, configurable: true };
  }

  getPrototypeOf(): object | null {
    return Reflect.getPrototypeOf(this.thunk());
  }

  apply(
    _t: CallableProxyTarget,
    thisArg: unknown,
    argArray: unknown[]
  ): unknown {
    const target = this.thunk();
    return Reflect.apply(
      target as unknown as (...args: unknown[]) => unknown,
      thisArg,
      argArray
    );
  }
}

/**
 * Synchronous Virtual Proxy over any `() => T` thunk (including kernel `deps`).
 * Monomorphic handler + lazy zero-rest-array method trampolines.
 */
export function toLiveProxy<T extends object>(thunk: (this: void) => T): T {
  return new Proxy(
    SHARED_PROXY_TARGET,
    new LiveProxyHandler(thunk)
  ) as unknown as T;
}

async function invokeDeferredCallable(
  thunk: (this: void) => unknown,
  args: unknown[]
): Promise<unknown> {
  const target = await thunk();
  if (typeof target !== 'function') {
    throw new TypeError(
      'Async virtual proxy target resolved to a non-callable value.'
    );
  }
  return await Reflect.apply(
    target as (...a: unknown[]) => unknown,
    undefined,
    args
  );
}

function createAsyncMethodTrampoline(
  thunk: (this: void) => unknown,
  prop: PropertyKey
): (this: void, ...args: unknown[]) => Promise<unknown> {
  return async function asyncProxyMethod(this: void): Promise<unknown> {
    const target = await thunk();
    if (
      target === null ||
      (typeof target !== 'object' && typeof target !== 'function')
    ) {
      throw new TypeError(
        `Cannot invoke "${String(prop)}" on non-object async proxy target.`
      );
    }
    const member: unknown = Reflect.get(target, prop, target);
    if (typeof member !== 'function') {
      throw new TypeError(
        `Property "${String(prop)}" is not callable on async proxy target.`
      );
    }
    const fn = member as (this: unknown, ...a: unknown[]) => unknown;
    switch (arguments.length) {
      case 0:
        return await fn.call(target);
      case 1:
        return await fn.call(target, arguments[0]);
      case 2:
        return await fn.call(target, arguments[0], arguments[1]);
      case 3:
        return await fn.call(target, arguments[0], arguments[1], arguments[2]);
      case 4:
        return await fn.call(
          target,
          arguments[0],
          arguments[1],
          arguments[2],
          arguments[3]
        );
      default:
        return await fn.apply(target, arguments as unknown as unknown[]);
    }
  };
}

class AsyncProxyHandler implements ProxyHandler<CallableProxyTarget> {
  private readonly thunk: (this: void) => unknown;
  private methodCache: Map<
    PropertyKey,
    (this: void, ...args: unknown[]) => Promise<unknown>
  > | null = null;

  constructor(thunk: (this: void) => unknown) {
    this.thunk = thunk;
  }

  get(_t: CallableProxyTarget, prop: PropertyKey): unknown {
    if (
      prop === 'then' ||
      prop === 'catch' ||
      prop === 'finally' ||
      typeof prop === 'symbol'
    ) {
      return prop === Symbol.toStringTag ? 'AsyncProxy' : undefined;
    }
    let cache = this.methodCache;
    if (cache === null) {
      cache = new Map<
        PropertyKey,
        (this: void, ...args: unknown[]) => Promise<unknown>
      >();
      this.methodCache = cache;
    }
    let fn = cache.get(prop);
    if (fn === undefined) {
      fn = createAsyncMethodTrampoline(this.thunk, prop);
      cache.set(prop, fn);
    }
    return fn;
  }

  apply(
    _t: CallableProxyTarget,
    _thisArg: unknown,
    argArray: unknown[]
  ): Promise<unknown> {
    return invokeDeferredCallable(this.thunk, argArray);
  }
}

/**
 * Promisified Virtual Proxy over any sync or async thunk (`() => T | Promise<T>`).
 * Lifts BOTH async-initialized services AND sync classes/functions into async methods.
 */
export function toAsyncProxy<T extends object | PromiseLike<object>>(
  thunk: (this: void) => T
): Promisified<Awaited<T>> {
  return new Proxy(
    SHARED_PROXY_TARGET,
    new AsyncProxyHandler(thunk)
  ) as unknown as Promisified<Awaited<T>>;
}

// ============================================================================
// 2. INJECTION ADAPTERS (`via*`) & HOMOMORPHIC `InjectTuple`
// ============================================================================

declare const INJECT_ADAPTER_BRAND: unique symbol;

export type InjectMode = 'capture' | 'thunk' | 'live' | 'async';

const MODE_CAPTURE = 0;
const MODE_THUNK = 1;
const MODE_LIVE = 2;
const MODE_ASYNC = 3;
type ModeCode = 0 | 1 | 2 | 3;

export interface InjectAdapter<Tok extends AnyToken, Out> {
  readonly [INJECT_ADAPTER_BRAND]: () => readonly [Tok, Out];
  readonly token: Tok;
  readonly mode: InjectMode;
  readonly dischargeMask: TaintMask;
}

export type AnyInjectAdapter = {
  readonly [INJECT_ADAPTER_BRAND]: () => readonly [AnyToken, unknown];
  readonly token: AnyToken;
  readonly mode: InjectMode;
  readonly dischargeMask: TaintMask;
};

export type InjectSpec = AnyToken | AnyInjectAdapter;

export type InjectOut<S> = S extends {
  readonly [INJECT_ADAPTER_BRAND]: () => readonly [AnyToken, infer Out];
}
  ? Out
  : TokenValue<S>;

/**
 * Homomorphic tuple mapper over bare `Specs` with per-element `NoInfer`.
 * Preserves exact tuple structure for `...args:` rest parameters while
 * blocking reverse inference from class constructors / function parameters.
 */
type MapInjectTuple<Specs extends readonly InjectSpec[]> = {
  readonly [K in keyof Specs]: NoInfer<InjectOut<Specs[K]>>;
};

export type InjectTuple<Specs extends readonly InjectSpec[] | undefined> = [
  Specs,
] extends [never]
  ? readonly []
  : Specs extends readonly InjectSpec[]
    ? MapInjectTuple<Specs>
    : readonly [];

class InjectAdapterImpl<Tok extends AnyToken, Out>
  implements InjectAdapter<Tok, Out>
{
  declare readonly [INJECT_ADAPTER_BRAND]: () => readonly [Tok, Out];
  readonly token: Tok;
  readonly mode: InjectMode;
  readonly modeCode: ModeCode;
  readonly dischargeMask: TaintMask;

  constructor(
    token: Tok,
    mode: InjectMode,
    modeCode: ModeCode,
    dischargeMask: TaintMask
  ) {
    this.token = token;
    this.mode = mode;
    this.modeCode = modeCode;
    this.dischargeMask = dischargeMask;
  }
}

/** Inject as a non-capturing lazy thunk `() => T` (routes via kernel `deps`). */
export function viaThunk<T>(
  token: Token<T>
): InjectAdapter<Token<T>, (this: void) => T> {
  return new InjectAdapterImpl(token, 'thunk', MODE_THUNK, 0);
}

/** Inject as a synchronous virtual proxy `T` (routes via kernel `deps` + `toLiveProxy`). */
export function viaLive<T extends object>(
  token: Token<T>
): InjectAdapter<Token<T>, T> {
  return new InjectAdapterImpl(token, 'live', MODE_LIVE, 0);
}

/** Inject as a promisified virtual proxy `Promisified<Awaited<T>>` (works on sync OR async tokens). */
export function viaAsync<T extends object | PromiseLike<object>>(
  token: Token<T>
): InjectAdapter<Token<T>, Promisified<Awaited<T>>> {
  return new InjectAdapterImpl(token, 'async', MODE_ASYNC, 0);
}

/** Eagerly capture a transient (`none`) token and locally discharge `frozen-none`. */
export function viaSnapshot<T>(token: Token<T>): InjectAdapter<Token<T>, T> {
  return new InjectAdapterImpl(
    token,
    'capture',
    MODE_CAPTURE,
    TAINT_BITS['frozen-none']
  );
}

/** Eagerly capture `token` and locally discharge `mask` of {@link TAINT_BITS}. */
export function viaEscape<T>(
  token: Token<T>,
  mask: TaintMask
): InjectAdapter<Token<T>, T> {
  return new InjectAdapterImpl(token, 'capture', MODE_CAPTURE, mask);
}

// ============================================================================
// 3. PLAIN KERNEL & INJECT OPTION PRESETS (ZERO SPREADS, ZERO LOCK-IN)
// ============================================================================

/** Discharges `frozen-none` on an intentional transient snapshot edge. */
export function allowSnapshot(token: AnyToken): TaintDischarge {
  return [token, TAINT_BITS['frozen-none']];
}

/** Discharges `volatile-state` on an intentional stateful weak cache. */
export function allowVolatile(token: AnyToken): TaintDischarge {
  return [token, TAINT_BITS['volatile-state']];
}

/** Discharges an explicit bitmask of {@link TAINT_BITS} on `token`. */
export function allowEscape(
  token: AnyToken,
  mask: TaintMask
): TaintDischarge {
  return [token, mask];
}

// Zero-arg preset default shapes (assignable to BOTH BindOptions<T> and InjectRegisterOptions<T>)

export interface SolidPresetDefaults<
  Target extends StorageTarget = StorageTarget,
  State extends StateKind = StateKind,
> {
  readonly storage: 'solid';
  readonly target: Target;
  readonly state: State;
}

export interface TransientPresetDefaults {
  readonly storage: 'none';
  readonly state: 'stateless';
}

export interface EphemeralPresetDefaults {
  readonly storage: 'ephemeral';
  readonly state: 'stateful';
}

export interface WeakPresetDefaults {
  readonly storage: 'weak';
  readonly target: 'provider';
  readonly state: 'stateless';
}

export interface WeakMemoDefaults {
  readonly storage: 'weak';
  readonly target: 'provider';
  readonly state: 'stateful';
  readonly discharges: readonly TaintDischarge[];
}

const DEFAULT_SINGLETON: SolidPresetDefaults<'provider', 'stateful'> =
  Object.freeze({
    storage: 'solid',
    target: 'provider',
    state: 'stateful',
  });

const DEFAULT_PURE: SolidPresetDefaults<'provider', 'stateless'> =
  Object.freeze({
    storage: 'solid',
    target: 'provider',
    state: 'stateless',
  });

const DEFAULT_SCOPED: SolidPresetDefaults<'caller', 'stateful'> =
  Object.freeze({
    storage: 'solid',
    target: 'caller',
    state: 'stateful',
  });

const DEFAULT_TRANSIENT: TransientPresetDefaults = Object.freeze({
  storage: 'none',
  state: 'stateless',
});

const DEFAULT_EPHEMERAL: EphemeralPresetDefaults = Object.freeze({
  storage: 'ephemeral',
  state: 'stateful',
});

const DEFAULT_WEAK: WeakPresetDefaults = Object.freeze({
  storage: 'weak',
  target: 'provider',
  state: 'stateless',
});

// Kernel-style preset inputs (`captures` / `deps`)

export interface SolidPresetOptions<
  T,
  Caps extends readonly AnyToken[] | undefined = readonly [],
  Deps extends readonly AnyToken[] | undefined = readonly [],
  R extends boolean | undefined = false,
> {
  readonly state?: StateKind | undefined;
  readonly captures?: Caps;
  readonly deps?: Deps;
  readonly rebindable?: R;
  readonly discharges?: readonly TaintDischarge[] | undefined;
  readonly onDispose?: ((this: void, instance: T) => void) | undefined;
  readonly onDecapture?:
    | ((this: void, instance: T, remaining: number) => void)
    | undefined;
}

export interface PurePresetOptions<
  T,
  Caps extends readonly AnyToken[] | undefined = readonly [],
  Deps extends readonly AnyToken[] | undefined = readonly [],
  R extends boolean | undefined = false,
> {
  readonly captures?: Caps;
  readonly deps?: Deps;
  readonly rebindable?: R;
  readonly discharges?: readonly TaintDischarge[] | undefined;
  readonly onDispose?: ((this: void, instance: T) => void) | undefined;
  readonly onDecapture?:
    | ((this: void, instance: T, remaining: number) => void)
    | undefined;
}

export interface TransientPresetOptions<
  Caps extends readonly AnyToken[] | undefined = readonly [],
  Deps extends readonly AnyToken[] | undefined = readonly [],
  R extends boolean | undefined = false,
> {
  readonly state?: StateKind | undefined;
  readonly captures?: Caps;
  readonly deps?: Deps;
  readonly rebindable?: R;
  readonly discharges?: readonly TaintDischarge[] | undefined;
}

export interface EphemeralPresetOptions<
  T,
  Caps extends readonly AnyToken[] | undefined = readonly [],
  Deps extends readonly AnyToken[] | undefined = readonly [],
  R extends boolean | undefined = false,
> {
  readonly state?: StateKind | undefined;
  readonly captures?: Caps;
  readonly deps?: Deps;
  readonly rebindable?: R;
  readonly discharges?: readonly TaintDischarge[] | undefined;
  readonly onDispose?: ((this: void, instance: T) => void) | undefined;
}

export interface WeakPresetOptions<
  T extends object,
  Caps extends readonly AnyToken[] | undefined = readonly [],
  Deps extends readonly AnyToken[] | undefined = readonly [],
  R extends boolean | undefined = false,
> {
  readonly state?: StateKind | undefined;
  readonly target?: StorageTarget | undefined;
  readonly captures?: Caps;
  readonly deps?: Deps;
  readonly rebindable?: R;
  readonly discharges?: readonly TaintDischarge[] | undefined;
  readonly onDispose?:
    | ((this: void, instance: T | undefined) => void)
    | undefined;
  readonly onDecapture?:
    | ((this: void, instance: T | undefined, remaining: number) => void)
    | undefined;
}

// Inject-style preset inputs & outputs (for `registerClass`, `registerFn`, `asClass`, `asFn`)

export interface SolidInjectPresetInput<
  T,
  Specs extends readonly InjectSpec[],
  R extends boolean | undefined = false,
> {
  readonly inject: Specs;
  readonly state?: StateKind | undefined;
  readonly rebindable?: R;
  readonly discharges?: readonly TaintDischarge[] | undefined;
  readonly onDispose?: ((this: void, instance: T) => void) | undefined;
  readonly onDecapture?:
    | ((this: void, instance: T, remaining: number) => void)
    | undefined;
}

export interface PureInjectPresetInput<
  T,
  Specs extends readonly InjectSpec[],
  R extends boolean | undefined = false,
> {
  readonly inject: Specs;
  readonly rebindable?: R;
  readonly discharges?: readonly TaintDischarge[] | undefined;
  readonly onDispose?: ((this: void, instance: T) => void) | undefined;
  readonly onDecapture?:
    | ((this: void, instance: T, remaining: number) => void)
    | undefined;
}

export interface TransientInjectPresetInput<
  Specs extends readonly InjectSpec[],
  R extends boolean | undefined = false,
> {
  readonly inject: Specs;
  readonly state?: StateKind | undefined;
  readonly rebindable?: R;
  readonly discharges?: readonly TaintDischarge[] | undefined;
}

export interface EphemeralInjectPresetInput<
  T,
  Specs extends readonly InjectSpec[],
  R extends boolean | undefined = false,
> {
  readonly inject: Specs;
  readonly state?: StateKind | undefined;
  readonly rebindable?: R;
  readonly discharges?: readonly TaintDischarge[] | undefined;
  readonly onDispose?: ((this: void, instance: T) => void) | undefined;
}

export interface WeakInjectPresetInput<
  T extends object,
  Specs extends readonly InjectSpec[],
  R extends boolean | undefined = false,
> {
  readonly inject: Specs;
  readonly state?: StateKind | undefined;
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

export interface SolidInjectOptions<
  T,
  Specs extends readonly InjectSpec[] | undefined = undefined,
  R extends boolean | undefined = false,
> {
  readonly storage?: 'solid' | undefined;
  readonly target?: StorageTarget | undefined;
  readonly state?: StateKind | undefined;
  readonly inject?: Specs;
  readonly rebindable?: R;
  readonly discharges?: readonly TaintDischarge[] | undefined;
  readonly onDispose?: ((this: void, instance: T) => void) | undefined;
  readonly onDecapture?:
    | ((this: void, instance: T, remaining: number) => void)
    | undefined;
}

export interface NoneInjectOptions<
  Specs extends readonly InjectSpec[] | undefined = undefined,
  R extends boolean | undefined = false,
> {
  readonly storage: 'none';
  readonly state?: StateKind | undefined;
  readonly inject?: Specs;
  readonly rebindable?: R;
  readonly discharges?: readonly TaintDischarge[] | undefined;
}

export interface EphemeralInjectOptions<
  T,
  Specs extends readonly InjectSpec[] | undefined = undefined,
  R extends boolean | undefined = false,
> {
  readonly storage: 'ephemeral';
  readonly state?: StateKind | undefined;
  readonly inject?: Specs;
  readonly rebindable?: R;
  readonly discharges?: readonly TaintDischarge[] | undefined;
  readonly onDispose?: ((this: void, instance: T) => void) | undefined;
}

export interface WeakInjectOptions<
  T extends object,
  Specs extends readonly InjectSpec[] | undefined = undefined,
  R extends boolean | undefined = false,
> {
  readonly storage: 'weak';
  readonly target?: StorageTarget | undefined;
  readonly state?: StateKind | undefined;
  readonly inject?: Specs;
  readonly rebindable?: R;
  readonly discharges?: readonly TaintDischarge[] | undefined;
  readonly onDispose?:
    | ((this: void, instance: T | undefined) => void)
    | undefined;
  readonly onDecapture?:
    | ((this: void, instance: T | undefined, remaining: number) => void)
    | undefined;
}

export type InjectRegisterOptions<
  T,
  Specs extends readonly InjectSpec[] | undefined = undefined,
  R extends boolean | undefined = false,
> =
  | SolidInjectOptions<T, Specs, R>
  | NoneInjectOptions<Specs, R>
  | EphemeralInjectOptions<T, Specs, R>
  | ([T] extends [never]
      ? never
      : [T] extends [object]
        ? WeakInjectOptions<Extract<T, object>, Specs, R>
        : never);

interface RawPresetInput {
  readonly state?: StateKind | undefined;
  readonly target?: StorageTarget | undefined;
  readonly discharges?: readonly TaintDischarge[] | undefined;
}

/** Provider-retained singleton (`storage: 'solid', target: 'provider', state: 'stateful'`). */
export function singleton(): SolidPresetDefaults<'provider', 'stateful'>;
export function singleton<
  T = unknown,
  const Specs extends readonly InjectSpec[] = readonly [],
  const R extends boolean | undefined = false,
>(opts: SolidInjectPresetInput<T, Specs, R>): SolidInjectOptions<T, Specs, R>;
export function singleton<
  T = unknown,
  const Caps extends readonly AnyToken[] | undefined = readonly [],
  const Deps extends readonly AnyToken[] | undefined = readonly [],
  const R extends boolean | undefined = false,
>(opts: SolidPresetOptions<T, Caps, Deps, R>): SolidBindOptions<T, Caps, Deps, R>;
export function singleton(opts?: RawPresetInput): any {
  if (opts === undefined) return DEFAULT_SINGLETON;
  return {
    ...opts,
    storage: 'solid',
    target: 'provider',
    state: opts.state ?? 'stateful',
  };
}

/** Functional-core singleton (`storage: 'solid', target: 'provider', state: 'stateless'`). */
export function pure(): SolidPresetDefaults<'provider', 'stateless'>;
export function pure<
  T = unknown,
  const Specs extends readonly InjectSpec[] = readonly [],
  const R extends boolean | undefined = false,
>(opts: PureInjectPresetInput<T, Specs, R>): SolidInjectOptions<T, Specs, R>;
export function pure<
  T = unknown,
  const Caps extends readonly AnyToken[] | undefined = readonly [],
  const Deps extends readonly AnyToken[] | undefined = readonly [],
  const R extends boolean | undefined = false,
>(opts: PurePresetOptions<T, Caps, Deps, R>): SolidBindOptions<T, Caps, Deps, R>;
export function pure(opts?: RawPresetInput): any {
  if (opts === undefined) return DEFAULT_PURE;
  return {
    ...opts,
    storage: 'solid',
    target: 'provider',
    state: 'stateless',
  };
}

/** Per-scope / per-request service (`storage: 'solid', target: 'caller', state: 'stateful'`). */
export function scoped(): SolidPresetDefaults<'caller', 'stateful'>;
export function scoped<
  T = unknown,
  const Specs extends readonly InjectSpec[] = readonly [],
  const R extends boolean | undefined = false,
>(opts: SolidInjectPresetInput<T, Specs, R>): SolidInjectOptions<T, Specs, R>;
export function scoped<
  T = unknown,
  const Caps extends readonly AnyToken[] | undefined = readonly [],
  const Deps extends readonly AnyToken[] | undefined = readonly [],
  const R extends boolean | undefined = false,
>(opts: SolidPresetOptions<T, Caps, Deps, R>): SolidBindOptions<T, Caps, Deps, R>;
export function scoped(opts?: RawPresetInput): any {
  if (opts === undefined) return DEFAULT_SCOPED;
  return {
    ...opts,
    storage: 'solid',
    target: 'caller',
    state: opts.state ?? 'stateful',
  };
}

/** Factory-direct transient (`storage: 'none', state: 'stateless'`). */
export function transient(): TransientPresetDefaults;
export function transient<
  const Specs extends readonly InjectSpec[] = readonly [],
  const R extends boolean | undefined = false,
>(opts: TransientInjectPresetInput<Specs, R>): NoneInjectOptions<Specs, R>;
export function transient<
  const Caps extends readonly AnyToken[] | undefined = readonly [],
  const Deps extends readonly AnyToken[] | undefined = readonly [],
  const R extends boolean | undefined = false,
>(opts: TransientPresetOptions<Caps, Deps, R>): NoneBindOptions<Caps, Deps, R>;
export function transient(opts?: RawPresetInput): any {
  if (opts === undefined) return DEFAULT_TRANSIENT;
  return {
    ...opts,
    storage: 'none',
    state: opts.state ?? 'stateless',
  };
}

/** Single-resolution-pass ephemeral (`storage: 'ephemeral', state: 'stateful'`). */
export function ephemeral(): EphemeralPresetDefaults;
export function ephemeral<
  T = unknown,
  const Specs extends readonly InjectSpec[] = readonly [],
  const R extends boolean | undefined = false,
>(
  opts: EphemeralInjectPresetInput<T, Specs, R>
): EphemeralInjectOptions<T, Specs, R>;
export function ephemeral<
  T = unknown,
  const Caps extends readonly AnyToken[] | undefined = readonly [],
  const Deps extends readonly AnyToken[] | undefined = readonly [],
  const R extends boolean | undefined = false,
>(
  opts: EphemeralPresetOptions<T, Caps, Deps, R>
): EphemeralBindOptions<T, Caps, Deps, R>;
export function ephemeral(opts?: RawPresetInput): any {
  if (opts === undefined) return DEFAULT_EPHEMERAL;
  return {
    ...opts,
    storage: 'ephemeral',
    state: opts.state ?? 'stateful',
  };
}

/** GC-managed weak cache (`storage: 'weak', state: 'stateless'`, objects only). */
export function weak(): WeakPresetDefaults;
export function weak<
  T extends object = object,
  const Specs extends readonly InjectSpec[] = readonly [],
  const R extends boolean | undefined = false,
>(opts: WeakInjectPresetInput<T, Specs, R>): WeakInjectOptions<T, Specs, R>;
export function weak<
  T extends object = object,
  const Caps extends readonly AnyToken[] | undefined = readonly [],
  const Deps extends readonly AnyToken[] | undefined = readonly [],
  const R extends boolean | undefined = false,
>(opts: WeakPresetOptions<T, Caps, Deps, R>): WeakBindOptions<T, Caps, Deps, R>;
export function weak(opts?: RawPresetInput): any {
  if (opts === undefined) return DEFAULT_WEAK;
  return {
    ...opts,
    storage: 'weak',
    target: opts.target ?? 'provider',
    state: opts.state ?? 'stateless',
  };
}

/**
 * Intentional stateful weak memo cache: sets `storage: 'weak'`, `state: 'stateful'`,
 * and locally discharges `volatile-state` on `selfToken` (silent under
 * `POLICIES.strict`, auditable under `POLICIES.zeroEscapes`).
 */
export function memo<T extends object>(selfToken: Token<T>): WeakMemoDefaults;
export function memo<
  T extends object,
  const Specs extends readonly InjectSpec[] = readonly [],
  const R extends boolean | undefined = false,
>(
  selfToken: Token<T>,
  opts: WeakInjectPresetInput<T, Specs, R>
): WeakInjectOptions<T, Specs, R>;
export function memo<
  T extends object,
  const Caps extends readonly AnyToken[] | undefined = readonly [],
  const Deps extends readonly AnyToken[] | undefined = readonly [],
  const R extends boolean | undefined = false,
>(
  selfToken: Token<T>,
  opts: WeakPresetOptions<T, Caps, Deps, R>
): WeakBindOptions<T, Caps, Deps, R>;
export function memo(selfToken: AnyToken, opts?: RawPresetInput): any {
  const selfDischarge = allowVolatile(selfToken);
  if (opts === undefined) {
    return {
      storage: 'weak',
      target: 'provider',
      state: 'stateful',
      discharges: [selfDischarge],
    };
  }
  return {
    ...opts,
    storage: 'weak',
    target: opts.target ?? 'provider',
    state: 'stateful',
    discharges:
      opts.discharges !== undefined
        ? [selfDischarge, ...opts.discharges]
        : [selfDischarge],
  };
}

// ============================================================================
// 4. O(1) BITMASK POLICIES & DIAGNOSTICS
// ============================================================================

const TAINT_TAG_LIST: readonly TaintTag[] = Object.freeze([
  'insecure',
  'eviction-coupled',
  'captive-ephemeral',
  'captive-caller',
  'weak-pinned',
  'frozen-none',
  'escaped-ephemeral',
  'volatile-state',
  'state-leak',
  'pinned-mutable',
  'split-state-diamond',
  'shared-diamond',
  'thunk-cycle',
]);

const ALLOW_ALL_POLICY: PolicyRule = function allowAllPolicy(
  this: void
): PolicyAction {
  return 'allow';
};

export function createMaskPolicy(
  denyMask: TaintMask,
  warnMask: TaintMask = 0,
  forbidDischargeMask: TaintMask = 0
): PolicyRule {
  if (forbidDischargeMask === 0) {
    return function maskPolicy(
      this: void,
      _dependent: AnyToken,
      fact: FoldedTokenFact
    ): PolicyAction {
      if ((fact.mask & denyMask) !== 0) return 'deny';
      if ((fact.mask & warnMask) !== 0) return 'warn';
      return 'allow';
    };
  }
  return function auditMaskPolicy(
    this: void,
    _dependent: AnyToken,
    fact: FoldedTokenFact
  ): PolicyAction {
    if (
      (fact.mask & denyMask) !== 0 ||
      (fact.dischargedMask & forbidDischargeMask) !== 0
    ) {
      return 'deny';
    }
    if ((fact.mask & warnMask) !== 0) return 'warn';
    return 'allow';
  };
}

export function createTagPolicy(
  table: Readonly<Record<TaintTag, PolicyAction>>
): PolicyRule {
  let denyMask = 0;
  let warnMask = 0;
  for (let i = 0; i < TAINT_TAG_LIST.length; i++) {
    const tag = TAINT_TAG_LIST[i];
    if (tag === undefined) continue;
    const action = table[tag];
    const bit = TAINT_BITS[tag];
    if (action === 'deny') denyMask |= bit;
    else if (action === 'warn') warnMask |= bit;
  }
  return createMaskPolicy(denyMask, warnMask);
}

function composeTwoPolicies(a: PolicyRule, b: PolicyRule): PolicyRule {
  return function composedTwoPolicy(
    this: void,
    dependent: AnyToken,
    fact: FoldedTokenFact
  ): PolicyAction {
    const first = a(dependent, fact);
    if (first === 'deny') return 'deny';
    const second = b(dependent, fact);
    if (second === 'deny') return 'deny';
    return first === 'warn' || second === 'warn' ? 'warn' : 'allow';
  };
}

export function composePolicies(...policies: readonly PolicyRule[]): PolicyRule {
  const len = policies.length;
  if (len === 0) return ALLOW_ALL_POLICY;
  const p0 = policies[0];
  if (len === 1 && p0 !== undefined) return p0;
  const p1 = policies[1];
  if (len === 2 && p0 !== undefined && p1 !== undefined) {
    return composeTwoPolicies(p0, p1);
  }
  return function composedPolicy(
    this: void,
    dependent: AnyToken,
    fact: FoldedTokenFact
  ): PolicyAction {
    let worst: PolicyAction = 'allow';
    for (let i = 0; i < policies.length; i++) {
      const rule = policies[i];
      if (rule === undefined) continue;
      const action = rule(dependent, fact);
      if (action === 'deny') return 'deny';
      if (action === 'warn') worst = 'warn';
    }
    return worst;
  };
}

export function withExceptions(
  base: PolicyRule,
  override: (
    this: void,
    dependent: AnyToken,
    fact: FoldedTokenFact
  ) => PolicyAction | undefined
): PolicyRule {
  return function exceptionPolicy(
    this: void,
    dependent: AnyToken,
    fact: FoldedTokenFact
  ): PolicyAction {
    const decision = override(dependent, fact);
    return decision !== undefined ? decision : base(dependent, fact);
  };
}

export function onlyDirectCauses(base: PolicyRule): PolicyRule {
  return function directOnlyPolicy(
    this: void,
    dependent: AnyToken,
    fact: FoldedTokenFact
  ): PolicyAction {
    if (fact.relation === 'transitive' && !fact.diamond) return 'allow';
    return base(dependent, fact);
  };
}

/** Denies any binding whose `dischargedMask` intersects `forbidMask`. */
export function forbidDischarges(forbidMask: TaintMask = 0xffff): PolicyRule {
  return createMaskPolicy(0, 0, forbidMask);
}

export interface PolicyPresets {
  readonly strict: PolicyRule;
  readonly balanced: PolicyRule;
  readonly paranoid: PolicyRule;
  readonly zeroEscapes: PolicyRule;
}

const STRICT_DENY_MASK: TaintMask =
  TAINT_BITS['captive-ephemeral'] |
  TAINT_BITS['captive-caller'] |
  TAINT_BITS['weak-pinned'] |
  TAINT_BITS['escaped-ephemeral'] |
  TAINT_BITS['volatile-state'] |
  TAINT_BITS['split-state-diamond'] |
  TAINT_BITS['pinned-mutable'] |
  TAINT_BITS['state-leak'] |
  TAINT_BITS['thunk-cycle'] |
  TAINT_BITS.insecure;

const BALANCED_DENY_MASK: TaintMask =
  TAINT_BITS['captive-ephemeral'] |
  TAINT_BITS['captive-caller'] |
  TAINT_BITS['weak-pinned'] |
  TAINT_BITS['escaped-ephemeral'] |
  TAINT_BITS['volatile-state'] |
  TAINT_BITS['split-state-diamond'] |
  TAINT_BITS['pinned-mutable'];

const BALANCED_WARN_MASK: TaintMask =
  TAINT_BITS['state-leak'] |
  TAINT_BITS['thunk-cycle'] |
  TAINT_BITS.insecure |
  TAINT_BITS['frozen-none'];

const PARANOID_DENY_MASK: TaintMask =
  STRICT_DENY_MASK | TAINT_BITS['frozen-none'] | TAINT_BITS['eviction-coupled'];

export const POLICIES: PolicyPresets = Object.freeze({
  strict: createMaskPolicy(STRICT_DENY_MASK, TAINT_BITS['frozen-none']),
  balanced: createMaskPolicy(BALANCED_DENY_MASK, BALANCED_WARN_MASK),
  paranoid: createMaskPolicy(PARANOID_DENY_MASK, 0),
  zeroEscapes: createMaskPolicy(
    STRICT_DENY_MASK,
    TAINT_BITS['frozen-none'],
    0xffff
  ),
});

export class VerificationError extends Error {
  override readonly name: 'VerificationError' = 'VerificationError';
  readonly report: VerificationReport;

  constructor(message: string, report: VerificationReport) {
    super(message);
    this.report = report;
  }
}

function formatStructuralError(
  container: Container,
  err: StructuralError
): string {
  if (err.kind === 'disallowed-caller-store') {
    return (
      `  [STRUCTURAL] "${container.getTokenName(err.token)}" targets "caller" ` +
      `with storage "${err.storage}", which is disallowed on this container.`
    );
  }
  if (err.kind === 'unbound-dependency') {
    return (
      `  [STRUCTURAL] "${container.getTokenName(err.dependent)}" ${err.edge}s ` +
      `unbound token "${container.getTokenName(err.missing)}" ` +
      `(scope: ${err.resolutionScope}).`
    );
  }
  let chain = '';
  for (let i = 0; i < err.cycle.length; i++) {
    const tok = err.cycle[i];
    if (tok !== undefined) {
      chain += (chain.length > 0 ? ' -> ' : '') + container.getTokenName(tok);
    }
  }
  return `  [STRUCTURAL] Capture cycle detected: ${chain}`;
}

function joinTaintSet(tags: ReadonlySet<TaintTag>): string {
  let out = '';
  for (const tag of tags) {
    out += (out.length > 0 ? ', ' : '') + tag;
  }
  return out;
}

export function formatVerificationReport(
  container: Container,
  report: VerificationReport
): string {
  const lines: string[] = [];
  for (let i = 0; i < report.structuralErrors.length; i++) {
    const err = report.structuralErrors[i];
    if (err !== undefined) lines.push(formatStructuralError(container, err));
  }
  for (let i = 0; i < report.violations.length; i++) {
    const v = report.violations[i];
    if (v === undefined) continue;
    const activeStr = joinTaintSet(v.fact.taints);
    const disStr = joinTaintSet(v.fact.dischargedTaints);
    const label = v.action === 'deny' ? 'DENY' : 'WARN';
    const depName = container.getTokenName(v.dependent);
    const origName = container.getTokenName(v.origin);
    const edge =
      v.fact.relation === 'self'
        ? `${depName} (self)`
        : `${depName} -> ${origName} (${v.fact.relation})`;
    const diamond = v.fact.diamond ? ' [DIAMOND]' : '';
    const disPart = disStr.length > 0 ? ` (discharged: [${disStr}])` : '';
    lines.push(`  [${label}] ${edge}: [${activeStr}]${disPart}${diamond}`);
  }
  if (lines.length === 0) return 'Verification passed with zero findings.';
  const header = report.ok
    ? 'Verification passed with warnings:'
    : 'Verification failed:';
  return `${header}\n${lines.join('\n')}`;
}

export type WarnHandler = (
  this: void,
  report: VerificationReport,
  formatted: string
) => void;

export function assertVerified(
  container: Container,
  policy: PolicyRule = POLICIES.strict,
  onWarn?: WarnHandler | undefined
): VerificationReport {
  const report = container.verify(policy);
  if (!report.ok) {
    throw new VerificationError(
      formatVerificationReport(container, report),
      report
    );
  }
  if (onWarn !== undefined) {
    for (let i = 0; i < report.violations.length; i++) {
      const v = report.violations[i];
      if (v !== undefined && v.action === 'warn') {
        onWarn(report, formatVerificationReport(container, report));
        break;
      }
    }
  }
  return report;
}

// ============================================================================
// 5. REBIND HANDLES, ASYNC OPTIONS & EXTENSIBLE `BindingDescriptor` PROTOCOL
// ============================================================================

export type ClassRebindFn<
  T,
  Specs extends readonly InjectSpec[] | undefined,
> = (this: void, ctor: new (...args: InjectTuple<Specs>) => T) => void;

export type FnRebindFn<T, Specs extends readonly InjectSpec[] | undefined> = (
  this: void,
  fn: (this: void, ...args: InjectTuple<Specs>) => T
) => void;

export type AsyncRebindFn<
  T,
  Specs extends readonly InjectSpec[] | undefined,
> = (
  this: void,
  fn: (this: void, ...args: InjectTuple<Specs>) => Promise<T>
) => void;

export interface AsyncRegisterOptions<
  T,
  Specs extends readonly InjectSpec[] | undefined = undefined,
  R extends boolean | undefined = false,
> {
  readonly state?: StateKind | undefined;
  readonly inject?: Specs;
  readonly rebindable?: R;
  readonly discharges?: readonly TaintDischarge[] | undefined;
  /** @default 'provider' */
  readonly target?: StorageTarget | undefined;
  /** Invoked once the cached promise resolves and the entry is evicted/disposed. */
  readonly onDispose?: ((this: void, instance: T) => void) | undefined;
  readonly onDecapture?:
    | ((this: void, promise: Promise<T>, remaining: number) => void)
    | undefined;
}

/**
 * Open, zero-lock-in binding descriptor protocol.
 * Built-in `as*` descriptors are monomorphic data classes whose `bind` lives
 * on the prototype (zero per-descriptor closures). Works via
 * `assembler.register(token, desc)` AND directly via `desc.bind(container, token)`.
 */
export interface BindingDescriptor<T, Handle = void> {
  bind(container: Container, token: Token<T>): Handle;
}

// ============================================================================
// 6. ARITY-SPECIALIZED, ZERO-CONTEXT-LEAK INJECTION COMPILER
// ============================================================================

const APP_STORES: readonly RetainedStorage[] = Object.freeze(['solid', 'weak']);
const REQUEST_STORES: readonly RetainedStorage[] = Object.freeze(['solid']);
const OVERRIDE_STORES: readonly RetainedStorage[] = Object.freeze([]);
const EMPTY_TOKENS: readonly AnyToken[] = Object.freeze([]);
const EMPTY_SLOT_MODES = new Uint8Array(0);
const EMPTY_SLOT_INDICES = new Uint32Array(0);

interface CompiledInjectPlan {
  readonly captures: readonly AnyToken[];
  readonly deps: readonly AnyToken[];
  readonly discharges: readonly TaintDischarge[] | undefined;
  readonly len: number;
  readonly slotModes: Uint8Array;
  readonly slotIndices: Uint32Array;
  readonly allCaptures: boolean;
  readonly allLazy: boolean;
}

interface RawInjectOptions {
  readonly storage?: StorageKind | undefined;
  readonly state?: StateKind | undefined;
  readonly target?: StorageTarget | undefined;
  readonly inject?: readonly InjectSpec[] | undefined;
  readonly rebindable?: boolean | undefined;
  readonly discharges?: readonly TaintDischarge[] | undefined;
  readonly onDispose?: ((this: void, instance: any) => void) | undefined;
  readonly onDecapture?:
    | ((this: void, instance: any, remaining: number) => void)
    | undefined;
}

function encodeInjectMode(spec: AnyInjectAdapter): ModeCode {
  if (spec instanceof InjectAdapterImpl) return spec.modeCode;
  if (spec.mode === 'thunk') return MODE_THUNK;
  if (spec.mode === 'live') return MODE_LIVE;
  if (spec.mode === 'async') return MODE_ASYNC;
  return MODE_CAPTURE;
}

function compileInjectPlan(
  container: Container,
  ownerToken: AnyToken,
  specs: readonly InjectSpec[] | undefined,
  extraDischarges: readonly TaintDischarge[] | undefined
): CompiledInjectPlan {
  const len = specs !== undefined ? specs.length : 0;
  if (len === 0) {
    return {
      captures: EMPTY_TOKENS,
      deps: EMPTY_TOKENS,
      discharges: extraDischarges,
      len: 0,
      slotModes: EMPTY_SLOT_MODES,
      slotIndices: EMPTY_SLOT_INDICES,
      allCaptures: true,
      allLazy: true,
    };
  }

  const capTokens: AnyToken[] = [];
  const depTokens: AnyToken[] = [];
  const slotModes = new Uint8Array(len);
  const slotIndices = new Uint32Array(len);
  let dischargeTokens: AnyToken[] | null = null;
  let dischargeMasks: TaintMask[] | null = null;
  let allCaptures = true;
  let allLazy = true;

  if (extraDischarges !== undefined && extraDischarges.length > 0) {
    dischargeTokens = [];
    dischargeMasks = [];
    for (let i = 0; i < extraDischarges.length; i++) {
      const d = extraDischarges[i];
      if (d === undefined) continue;
      const existing = dischargeTokens.indexOf(d[0]);
      if (existing === -1) {
        dischargeTokens.push(d[0]);
        dischargeMasks.push(d[1]);
      } else {
        dischargeMasks[existing] = (dischargeMasks[existing] ?? 0) | d[1];
      }
    }
  }

  const useMaps = len > 8;
  const capMap = useMaps ? new Map<AnyToken, number>() : null;
  const depMap = useMaps ? new Map<AnyToken, number>() : null;

  for (let i = 0; i < len; i++) {
    const spec = specs?.[i];
    if (spec === undefined) continue;

    const isAdapter = typeof spec === 'object' && spec !== null;
    const tok = isAdapter ? spec.token : spec;
    const modeCode: ModeCode = isAdapter
      ? encodeInjectMode(spec)
      : MODE_CAPTURE;

    if (modeCode === MODE_CAPTURE) {
      allLazy = false;
      const inDeps =
        depMap !== null ? depMap.has(tok) : depTokens.indexOf(tok) !== -1;
      if (inDeps) {
        throw new Error(
          `Token "${container.getTokenName(tok)}" cannot be both captured and lazy-adapted in "${container.getTokenName(ownerToken)}".`
        );
      }
      let idx = capMap !== null ? capMap.get(tok) : capTokens.indexOf(tok);
      if (idx === undefined || idx === -1) {
        idx = capTokens.length;
        capTokens.push(tok);
        if (capMap !== null) capMap.set(tok, idx);
      }
      if (isAdapter && spec.dischargeMask !== 0) {
        if (dischargeTokens === null || dischargeMasks === null) {
          dischargeTokens = [tok];
          dischargeMasks = [spec.dischargeMask];
        } else {
          const existing = dischargeTokens.indexOf(tok);
          if (existing === -1) {
            dischargeTokens.push(tok);
            dischargeMasks.push(spec.dischargeMask);
          } else {
            dischargeMasks[existing] =
              (dischargeMasks[existing] ?? 0) | spec.dischargeMask;
          }
        }
      }
      slotModes[i] = MODE_CAPTURE;
      slotIndices[i] = idx;
    } else {
      allCaptures = false;
      const inCaps =
        capMap !== null ? capMap.has(tok) : capTokens.indexOf(tok) !== -1;
      if (inCaps) {
        throw new Error(
          `Token "${container.getTokenName(tok)}" cannot be both captured and lazy-adapted in "${container.getTokenName(ownerToken)}".`
        );
      }
      let idx = depMap !== null ? depMap.get(tok) : depTokens.indexOf(tok);
      if (idx === undefined || idx === -1) {
        idx = depTokens.length;
        depTokens.push(tok);
        if (depMap !== null) depMap.set(tok, idx);
      }
      slotModes[i] = modeCode;
      slotIndices[i] = idx;
    }
  }

  let discharges: TaintDischarge[] | undefined;
  if (
    dischargeTokens !== null &&
    dischargeMasks !== null &&
    dischargeTokens.length > 0
  ) {
    discharges = new Array<TaintDischarge>(dischargeTokens.length);
    for (let i = 0; i < dischargeTokens.length; i++) {
      const t = dischargeTokens[i];
      const m = dischargeMasks[i];
      if (t !== undefined && m !== undefined) discharges[i] = [t, m];
    }
  }

  return {
    captures: capTokens.length > 0 ? capTokens : EMPTY_TOKENS,
    deps: depTokens.length > 0 ? depTokens : EMPTY_TOKENS,
    discharges,
    len,
    slotModes,
    slotIndices,
    allCaptures,
    allLazy,
  };
}

type AnyCtor = new (...args: unknown[]) => unknown;
type AnyFn = (this: void, ...args: unknown[]) => unknown;
type KernelFactory = Factory<unknown, readonly AnyToken[], readonly AnyToken[]>;

function makeClass0(Ctor: AnyCtor): KernelFactory {
  return function class0(this: void): unknown {
    return new Ctor();
  };
}
function makeClassCap1(Ctor: AnyCtor): KernelFactory {
  return function classCap1(this: void, c: readonly unknown[]): unknown {
    return new Ctor(c[0]);
  };
}
function makeClassCap2(Ctor: AnyCtor): KernelFactory {
  return function classCap2(this: void, c: readonly unknown[]): unknown {
    return new Ctor(c[0], c[1]);
  };
}
function makeClassCap3(Ctor: AnyCtor): KernelFactory {
  return function classCap3(this: void, c: readonly unknown[]): unknown {
    return new Ctor(c[0], c[1], c[2]);
  };
}
function makeClassCap4(Ctor: AnyCtor): KernelFactory {
  return function classCap4(this: void, c: readonly unknown[]): unknown {
    return new Ctor(c[0], c[1], c[2], c[3]);
  };
}
function makeClassCapN(Ctor: AnyCtor): KernelFactory {
  return function classCapN(this: void, c: readonly unknown[]): unknown {
    return new Ctor(...c);
  };
}

function makeFn0(fn: AnyFn): KernelFactory {
  return function fn0(this: void): unknown {
    return fn();
  };
}
function makeFnCap1(fn: AnyFn): KernelFactory {
  return function fnCap1(this: void, c: readonly unknown[]): unknown {
    return fn(c[0]);
  };
}
function makeFnCap2(fn: AnyFn): KernelFactory {
  return function fnCap2(this: void, c: readonly unknown[]): unknown {
    return fn(c[0], c[1]);
  };
}
function makeFnCap3(fn: AnyFn): KernelFactory {
  return function fnCap3(this: void, c: readonly unknown[]): unknown {
    return fn(c[0], c[1], c[2]);
  };
}
function makeFnCap4(fn: AnyFn): KernelFactory {
  return function fnCap4(this: void, c: readonly unknown[]): unknown {
    return fn(c[0], c[1], c[2], c[3]);
  };
}
function makeFnCapN(fn: AnyFn): KernelFactory {
  return function fnCapN(this: void, c: readonly unknown[]): unknown {
    return fn(...c);
  };
}

function materializeProxySlots(
  len: number,
  slotModes: Uint8Array,
  slotIndices: Uint32Array,
  deps: readonly ((this: void) => unknown)[]
): unknown[] {
  const out = new Array<unknown>(len);
  for (let i = 0; i < len; i++) {
    const mode = slotModes[i];
    if (mode === MODE_CAPTURE) continue;
    const idx = slotIndices[i];
    if (idx === undefined) continue;
    const thunk = deps[idx];
    if (thunk === undefined) continue;
    if (mode === MODE_THUNK) {
      out[i] = thunk;
    } else if (mode === MODE_LIVE) {
      out[i] = toLiveProxy(thunk as (this: void) => object);
    } else {
      out[i] = toAsyncProxy(
        thunk as (this: void) => object | PromiseLike<object>
      );
    }
  }
  return out;
}

function makeLazyOnlyFactory(
  plan: CompiledInjectPlan,
  isClass: boolean,
  target: unknown
): KernelFactory {
  const len = plan.len;
  const slotModes = plan.slotModes;
  const slotIndices = plan.slotIndices;
  let cachedDepsRef: readonly ((this: void) => unknown)[] | null = null;
  let cachedArgs: unknown[] | null = null;

  if (isClass) {
    const Ctor = target as AnyCtor;
    if (len === 1) {
      return function lazyClass1(
        this: void,
        _c: readonly unknown[],
        deps: readonly ((this: void) => unknown)[]
      ): unknown {
        if (cachedDepsRef !== deps || cachedArgs === null) {
          cachedArgs = materializeProxySlots(1, slotModes, slotIndices, deps);
          cachedDepsRef = deps;
        }
        return new Ctor(cachedArgs[0]);
      };
    }
    if (len === 2) {
      return function lazyClass2(
        this: void,
        _c: readonly unknown[],
        deps: readonly ((this: void) => unknown)[]
      ): unknown {
        if (cachedDepsRef !== deps || cachedArgs === null) {
          cachedArgs = materializeProxySlots(2, slotModes, slotIndices, deps);
          cachedDepsRef = deps;
        }
        return new Ctor(cachedArgs[0], cachedArgs[1]);
      };
    }
    if (len === 3) {
      return function lazyClass3(
        this: void,
        _c: readonly unknown[],
        deps: readonly ((this: void) => unknown)[]
      ): unknown {
        if (cachedDepsRef !== deps || cachedArgs === null) {
          cachedArgs = materializeProxySlots(3, slotModes, slotIndices, deps);
          cachedDepsRef = deps;
        }
        return new Ctor(cachedArgs[0], cachedArgs[1], cachedArgs[2]);
      };
    }
    if (len === 4) {
      return function lazyClass4(
        this: void,
        _c: readonly unknown[],
        deps: readonly ((this: void) => unknown)[]
      ): unknown {
        if (cachedDepsRef !== deps || cachedArgs === null) {
          cachedArgs = materializeProxySlots(4, slotModes, slotIndices, deps);
          cachedDepsRef = deps;
        }
        return new Ctor(
          cachedArgs[0],
          cachedArgs[1],
          cachedArgs[2],
          cachedArgs[3]
        );
      };
    }
    return function lazyClassN(
      this: void,
      _c: readonly unknown[],
      deps: readonly ((this: void) => unknown)[]
    ): unknown {
      if (cachedDepsRef !== deps || cachedArgs === null) {
        cachedArgs = materializeProxySlots(len, slotModes, slotIndices, deps);
        cachedDepsRef = deps;
      }
      return new Ctor(...cachedArgs);
    };
  }

  const fn = target as AnyFn;
  if (len === 1) {
    return function lazyFn1(
      this: void,
      _c: readonly unknown[],
      deps: readonly ((this: void) => unknown)[]
    ): unknown {
      if (cachedDepsRef !== deps || cachedArgs === null) {
        cachedArgs = materializeProxySlots(1, slotModes, slotIndices, deps);
        cachedDepsRef = deps;
      }
      return fn(cachedArgs[0]);
    };
  }
  if (len === 2) {
    return function lazyFn2(
      this: void,
      _c: readonly unknown[],
      deps: readonly ((this: void) => unknown)[]
    ): unknown {
      if (cachedDepsRef !== deps || cachedArgs === null) {
        cachedArgs = materializeProxySlots(2, slotModes, slotIndices, deps);
        cachedDepsRef = deps;
      }
      return fn(cachedArgs[0], cachedArgs[1]);
    };
  }
  if (len === 3) {
    return function lazyFn3(
      this: void,
      _c: readonly unknown[],
      deps: readonly ((this: void) => unknown)[]
    ): unknown {
      if (cachedDepsRef !== deps || cachedArgs === null) {
        cachedArgs = materializeProxySlots(3, slotModes, slotIndices, deps);
        cachedDepsRef = deps;
      }
      return fn(cachedArgs[0], cachedArgs[1], cachedArgs[2]);
    };
  }
  if (len === 4) {
    return function lazyFn4(
      this: void,
      _c: readonly unknown[],
      deps: readonly ((this: void) => unknown)[]
    ): unknown {
      if (cachedDepsRef !== deps || cachedArgs === null) {
        cachedArgs = materializeProxySlots(4, slotModes, slotIndices, deps);
        cachedDepsRef = deps;
      }
      return fn(cachedArgs[0], cachedArgs[1], cachedArgs[2], cachedArgs[3]);
    };
  }
  return function lazyFnN(
    this: void,
    _c: readonly unknown[],
    deps: readonly ((this: void) => unknown)[]
  ): unknown {
    if (cachedDepsRef !== deps || cachedArgs === null) {
      cachedArgs = materializeProxySlots(len, slotModes, slotIndices, deps);
      cachedDepsRef = deps;
    }
    return fn(...cachedArgs);
  };
}

function makeMixedFactory(
  plan: CompiledInjectPlan,
  isClass: boolean,
  target: unknown
): KernelFactory {
  const len = plan.len;
  const slotModes = plan.slotModes;
  const slotIndices = plan.slotIndices;
  let cachedDepsRef: readonly ((this: void) => unknown)[] | null = null;
  let cachedProxies: unknown[] | null = null;

  if (len === 2) {
    const m0 = slotModes[0] ?? 0;
    const i0 = slotIndices[0] ?? 0;
    const m1 = slotModes[1] ?? 0;
    const i1 = slotIndices[1] ?? 0;
    if (isClass) {
      const Ctor = target as AnyCtor;
      return function mixedClass2(
        this: void,
        c: readonly unknown[],
        deps: readonly ((this: void) => unknown)[]
      ): unknown {
        if (cachedDepsRef !== deps || cachedProxies === null) {
          cachedProxies = materializeProxySlots(2, slotModes, slotIndices, deps);
          cachedDepsRef = deps;
        }
        return new Ctor(
          m0 === MODE_CAPTURE ? c[i0] : cachedProxies[0],
          m1 === MODE_CAPTURE ? c[i1] : cachedProxies[1]
        );
      };
    }
    const fn = target as AnyFn;
    return function mixedFn2(
      this: void,
      c: readonly unknown[],
      deps: readonly ((this: void) => unknown)[]
    ): unknown {
      if (cachedDepsRef !== deps || cachedProxies === null) {
        cachedProxies = materializeProxySlots(2, slotModes, slotIndices, deps);
        cachedDepsRef = deps;
      }
      return fn(
        m0 === MODE_CAPTURE ? c[i0] : cachedProxies[0],
        m1 === MODE_CAPTURE ? c[i1] : cachedProxies[1]
      );
    };
  }

  if (len === 3) {
    const m0 = slotModes[0] ?? 0;
    const i0 = slotIndices[0] ?? 0;
    const m1 = slotModes[1] ?? 0;
    const i1 = slotIndices[1] ?? 0;
    const m2 = slotModes[2] ?? 0;
    const i2 = slotIndices[2] ?? 0;
    if (isClass) {
      const Ctor = target as AnyCtor;
      return function mixedClass3(
        this: void,
        c: readonly unknown[],
        deps: readonly ((this: void) => unknown)[]
      ): unknown {
        if (cachedDepsRef !== deps || cachedProxies === null) {
          cachedProxies = materializeProxySlots(3, slotModes, slotIndices, deps);
          cachedDepsRef = deps;
        }
        return new Ctor(
          m0 === MODE_CAPTURE ? c[i0] : cachedProxies[0],
          m1 === MODE_CAPTURE ? c[i1] : cachedProxies[1],
          m2 === MODE_CAPTURE ? c[i2] : cachedProxies[2]
        );
      };
    }
    const fn = target as AnyFn;
    return function mixedFn3(
      this: void,
      c: readonly unknown[],
      deps: readonly ((this: void) => unknown)[]
    ): unknown {
      if (cachedDepsRef !== deps || cachedProxies === null) {
        cachedProxies = materializeProxySlots(3, slotModes, slotIndices, deps);
        cachedDepsRef = deps;
      }
      return fn(
        m0 === MODE_CAPTURE ? c[i0] : cachedProxies[0],
        m1 === MODE_CAPTURE ? c[i1] : cachedProxies[1],
        m2 === MODE_CAPTURE ? c[i2] : cachedProxies[2]
      );
    };
  }

  if (len === 4) {
    const m0 = slotModes[0] ?? 0;
    const i0 = slotIndices[0] ?? 0;
    const m1 = slotModes[1] ?? 0;
    const i1 = slotIndices[1] ?? 0;
    const m2 = slotModes[2] ?? 0;
    const i2 = slotIndices[2] ?? 0;
    const m3 = slotModes[3] ?? 0;
    const i3 = slotIndices[3] ?? 0;
    if (isClass) {
      const Ctor = target as AnyCtor;
      return function mixedClass4(
        this: void,
        c: readonly unknown[],
        deps: readonly ((this: void) => unknown)[]
      ): unknown {
        if (cachedDepsRef !== deps || cachedProxies === null) {
          cachedProxies = materializeProxySlots(4, slotModes, slotIndices, deps);
          cachedDepsRef = deps;
        }
        return new Ctor(
          m0 === MODE_CAPTURE ? c[i0] : cachedProxies[0],
          m1 === MODE_CAPTURE ? c[i1] : cachedProxies[1],
          m2 === MODE_CAPTURE ? c[i2] : cachedProxies[2],
          m3 === MODE_CAPTURE ? c[i3] : cachedProxies[3]
        );
      };
    }
    const fn = target as AnyFn;
    return function mixedFn4(
      this: void,
      c: readonly unknown[],
      deps: readonly ((this: void) => unknown)[]
    ): unknown {
      if (cachedDepsRef !== deps || cachedProxies === null) {
        cachedProxies = materializeProxySlots(4, slotModes, slotIndices, deps);
        cachedDepsRef = deps;
      }
      return fn(
        m0 === MODE_CAPTURE ? c[i0] : cachedProxies[0],
        m1 === MODE_CAPTURE ? c[i1] : cachedProxies[1],
        m2 === MODE_CAPTURE ? c[i2] : cachedProxies[2],
        m3 === MODE_CAPTURE ? c[i3] : cachedProxies[3]
      );
    };
  }

  if (isClass) {
    const Ctor = target as AnyCtor;
    return function mixedClassN(
      this: void,
      c: readonly unknown[],
      deps: readonly ((this: void) => unknown)[]
    ): unknown {
      if (cachedDepsRef !== deps || cachedProxies === null) {
        cachedProxies = materializeProxySlots(len, slotModes, slotIndices, deps);
        cachedDepsRef = deps;
      }
      const args = new Array<unknown>(len);
      for (let i = 0; i < len; i++) {
        const idx = slotIndices[i] ?? 0;
        args[i] = slotModes[i] === MODE_CAPTURE ? c[idx] : cachedProxies[i];
      }
      return new Ctor(...args);
    };
  }

  const fn = target as AnyFn;
  return function mixedFnN(
    this: void,
    c: readonly unknown[],
    deps: readonly ((this: void) => unknown)[]
  ): unknown {
    if (cachedDepsRef !== deps || cachedProxies === null) {
      cachedProxies = materializeProxySlots(len, slotModes, slotIndices, deps);
      cachedDepsRef = deps;
    }
    const args = new Array<unknown>(len);
    for (let i = 0; i < len; i++) {
      const idx = slotIndices[i] ?? 0;
      args[i] = slotModes[i] === MODE_CAPTURE ? c[idx] : cachedProxies[i];
    }
    return fn(...args);
  };
}

function buildInjectFactory(
  plan: CompiledInjectPlan,
  isClass: boolean,
  target: unknown
): KernelFactory {
  const len = plan.len;
  if (len === 0) {
    return isClass ? makeClass0(target as AnyCtor) : makeFn0(target as AnyFn);
  }
  if (plan.allCaptures && plan.captures.length === len) {
    if (isClass) {
      const Ctor = target as AnyCtor;
      if (len === 1) return makeClassCap1(Ctor);
      if (len === 2) return makeClassCap2(Ctor);
      if (len === 3) return makeClassCap3(Ctor);
      if (len === 4) return makeClassCap4(Ctor);
      return makeClassCapN(Ctor);
    }
    const fn = target as AnyFn;
    if (len === 1) return makeFnCap1(fn);
    if (len === 2) return makeFnCap2(fn);
    if (len === 3) return makeFnCap3(fn);
    if (len === 4) return makeFnCap4(fn);
    return makeFnCapN(fn);
  }
  if (plan.allLazy) {
    return makeLazyOnlyFactory(plan, isClass, target);
  }
  return makeMixedFactory(plan, isClass, target);
}

function wrapAsyncDispose(
  onDispose: ((this: void, instance: unknown) => void) | undefined
): ((this: void, promise: unknown) => void) | undefined {
  if (onDispose === undefined) return undefined;
  return function disposeResolvedPromise(this: void, promise: unknown): void {
    void Promise.resolve(promise).then(
      (resolved) => {
        onDispose(resolved);
      },
      () => undefined
    );
  };
}

function makeConstantFactory<T>(value: T): Factory<T, readonly [], readonly []> {
  return function constantValue(this: void): T {
    return value;
  };
}

function createInjectRebinder(
  plan: CompiledInjectPlan,
  isClass: boolean,
  kernelRebind: RebindFn<unknown, readonly AnyToken[], readonly AnyToken[]>
): (this: void, nextTarget: unknown) => void {
  return function rebindInjectTarget(this: void, nextTarget: unknown): void {
    kernelRebind(buildInjectFactory(plan, isClass, nextTarget));
  };
}

function bindInjected(
  container: Container,
  token: AnyToken,
  isClass: boolean,
  target: unknown,
  opts: RawInjectOptions | undefined,
  isAsync: boolean
): unknown {
  const plan = compileInjectPlan(
    container,
    token,
    opts?.inject,
    opts?.discharges
  );
  const factory = buildInjectFactory(plan, isClass, target);
  const storage: StorageKind = isAsync ? 'solid' : (opts?.storage ?? 'solid');
  const state: StateKind =
    opts?.state ??
    (storage === 'none' || storage === 'weak' ? 'stateless' : 'stateful');
  const rebindable = opts?.rebindable === true;
  const onDispose = isAsync
    ? wrapAsyncDispose(opts?.onDispose)
    : opts?.onDispose;

  let kernelRebind:
    | RebindFn<unknown, readonly AnyToken[], readonly AnyToken[]>
    | undefined;

  if (storage === 'weak') {
    const weakOpts: WeakBindOptions<
      object,
      readonly AnyToken[],
      readonly AnyToken[],
      boolean
    > = {
      storage: 'weak',
      state,
      target: opts?.target,
      captures: plan.captures,
      deps: plan.deps,
      rebindable,
      discharges: plan.discharges,
      onDispose,
      onDecapture: opts?.onDecapture,
    };
    kernelRebind = container.bind(
      token as Token<object>,
      weakOpts,
      factory as Factory<object, readonly AnyToken[], readonly AnyToken[]>
    ) as RebindFn<unknown, readonly AnyToken[], readonly AnyToken[]> | undefined;
  } else if (storage === 'none') {
    kernelRebind = container.bind(
      token as Token<unknown>,
      {
        storage: 'none',
        state,
        captures: plan.captures,
        deps: plan.deps,
        rebindable,
        discharges: plan.discharges,
      },
      factory
    );
  } else if (storage === 'ephemeral') {
    kernelRebind = container.bind(
      token as Token<unknown>,
      {
        storage: 'ephemeral',
        state,
        captures: plan.captures,
        deps: plan.deps,
        rebindable,
        discharges: plan.discharges,
        onDispose,
      },
      factory
    );
  } else {
    kernelRebind = container.bind(
      token as Token<unknown>,
      {
        storage: 'solid',
        state,
        target: opts?.target,
        captures: plan.captures,
        deps: plan.deps,
        rebindable,
        discharges: plan.discharges,
        onDispose,
        onDecapture: opts?.onDecapture,
      },
      factory
    );
  }

  return kernelRebind !== undefined
    ? createInjectRebinder(plan, isClass, kernelRebind)
    : undefined;
}

// ============================================================================
// 7. ZERO-CLOSURE MONOMORPHIC DESCRIPTOR CLASSES (`as*`)
// ============================================================================

class ValueDescriptorImpl<T> implements BindingDescriptor<T, void> {
  private readonly value: T;

  constructor(value: T) {
    this.value = value;
  }

  bind(container: Container, token: Token<T>): void {
    container.bind(token, DEFAULT_PURE, makeConstantFactory(this.value));
  }
}

class FactoryDescriptorImpl<
  T,
  Caps extends readonly AnyToken[] | undefined,
  Deps extends readonly AnyToken[] | undefined,
  R extends boolean | undefined,
> implements BindingDescriptor<T, BindResult<RebindFn<T, Caps, Deps>, R>>
{
  private readonly options: BindOptions<T, Caps, Deps, R>;
  private readonly factory: Factory<T, Caps, Deps>;

  constructor(
    options: BindOptions<T, Caps, Deps, R>,
    factory: Factory<T, Caps, Deps>
  ) {
    this.options = options;
    this.factory = factory;
  }

  bind(
    container: Container,
    token: Token<T>
  ): BindResult<RebindFn<T, Caps, Deps>, R> {
    return container.bind(token, this.options, this.factory);
  }
}

class InjectDescriptorImpl<T, Handle> implements BindingDescriptor<T, Handle> {
  private readonly isClass: boolean;
  private readonly isAsync: boolean;
  private readonly target: unknown;
  private readonly options: RawInjectOptions | undefined;

  constructor(
    isClass: boolean,
    isAsync: boolean,
    target: unknown,
    options: RawInjectOptions | undefined
  ) {
    this.isClass = isClass;
    this.isAsync = isAsync;
    this.target = target;
    this.options = options;
  }

  bind(container: Container, token: Token<T>): Handle {
    return bindInjected(
      container,
      token,
      this.isClass,
      this.target,
      this.options,
      this.isAsync
    ) as Handle;
  }
}

class InsecureDescriptorImpl<T, R extends boolean | undefined>
  implements BindingDescriptor<T, BindResult<InsecureRebindFn<T>, R>>
{
  private readonly options: InsecureBindOptions<T, R>;
  private readonly factory: InsecureFactory<T>;

  constructor(
    options: InsecureBindOptions<T, R>,
    factory: InsecureFactory<T>
  ) {
    this.options = options;
    this.factory = factory;
  }

  bind(
    container: Container,
    token: Token<T>
  ): BindResult<InsecureRebindFn<T>, R> {
    return container.bindInsecure(token, this.options, this.factory);
  }
}

export function asValue<T>(value: T): BindingDescriptor<T, void> {
  return new ValueDescriptorImpl(value);
}

export function asFactory<
  T,
  const Caps extends readonly AnyToken[] | undefined = readonly [],
  const Deps extends readonly AnyToken[] | undefined = readonly [],
  const R extends boolean | undefined = false,
>(
  options: BindOptions<NoInfer<T>, Caps, Deps, R>,
  factory: Factory<T, NoInfer<Caps>, NoInfer<Deps>>
): BindingDescriptor<
  T,
  BindResult<RebindFn<T, NoInfer<Caps>, NoInfer<Deps>>, R>
> {
  return new FactoryDescriptorImpl<T, Caps, Deps, R>(options, factory);
}

export function asClass<
  T extends object,
  const Specs extends readonly InjectSpec[] | undefined = undefined,
  const R extends boolean | undefined = false,
>(
  ctor: new (...args: InjectTuple<Specs>) => T,
  options?: InjectRegisterOptions<NoInfer<T>, Specs, R>
): BindingDescriptor<T, BindResult<ClassRebindFn<T, Specs>, R>> {
  return new InjectDescriptorImpl<T, BindResult<ClassRebindFn<T, Specs>, R>>(
    true,
    false,
    ctor,
    options as RawInjectOptions | undefined
  );
}

export function asFn<T>(fn: (this: void) => T): BindingDescriptor<T, void>;
export function asFn<
  T,
  const Specs extends readonly InjectSpec[] | undefined = undefined,
  const R extends boolean | undefined = false,
>(
  options: InjectRegisterOptions<NoInfer<T>, Specs, R>,
  fn: (this: void, ...args: InjectTuple<Specs>) => T
): BindingDescriptor<T, BindResult<FnRebindFn<T, Specs>, R>>;
export function asFn(
  optsOrFn: unknown,
  maybeFn?: unknown
): BindingDescriptor<any, any> {
  return typeof optsOrFn === 'function'
    ? new InjectDescriptorImpl(false, false, optsOrFn, undefined)
    : new InjectDescriptorImpl(
        false,
        false,
        maybeFn,
        optsOrFn as RawInjectOptions
      );
}

export function asAsync<T>(
  fn: (this: void) => Promise<T>
): BindingDescriptor<Promise<T>, void>;
export function asAsync<
  T,
  const Specs extends readonly InjectSpec[] | undefined = undefined,
  const R extends boolean | undefined = false,
>(
  options: AsyncRegisterOptions<NoInfer<T>, Specs, R>,
  fn: (this: void, ...args: InjectTuple<Specs>) => Promise<T>
): BindingDescriptor<Promise<T>, BindResult<AsyncRebindFn<T, Specs>, R>>;
export function asAsync(
  optsOrFn: unknown,
  maybeFn?: unknown
): BindingDescriptor<any, any> {
  return typeof optsOrFn === 'function'
    ? new InjectDescriptorImpl(false, true, optsOrFn, undefined)
    : new InjectDescriptorImpl(
        false,
        true,
        maybeFn,
        optsOrFn as RawInjectOptions
      );
}

export function asInsecure<T, const R extends boolean | undefined = false>(
  options: InsecureBindOptions<NoInfer<T>, R>,
  factory: InsecureFactory<T>
): BindingDescriptor<T, BindResult<InsecureRebindFn<T>, R>> {
  return new InsecureDescriptorImpl<T, R>(options, factory);
}

// ============================================================================
// 8. ASSEMBLER CONTRACT & IMPLEMENTATION (DIRECT EXTENSION OF `Container`)
// ============================================================================

export interface Assembler extends Container {
  /** Direct reference to the underlying kernel {@link Container}. */
  readonly kernel: Container;

  createChild(options: CreateOptions): Assembler;
  createRequestScope(
    onEvictCaptured?: EvictCapturedPolicy | undefined
  ): Assembler;
  createOverrideScope(): Assembler;

  use<R = void>(module: (this: void, assembler: Assembler) => R): R;

  /**
   * Registers any {@link BindingDescriptor} (`asValue`, `asClass`, `asFn`,
   * `asFactory`, `asAsync`, `asInsecure`, or custom). Accepts any covariant
   * subtype `U extends T` (e.g., binding a concrete class to an interface token).
   */
  register<T, U extends NoInfer<T>, Handle>(
    token: Token<T>,
    descriptor: BindingDescriptor<U, Handle>
  ): Handle;

  registerValue<T>(token: Token<T>, value: NoInfer<T>): void;

  registerFactory<
    T,
    const Caps extends readonly AnyToken[] | undefined = readonly [],
    const Deps extends readonly AnyToken[] | undefined = readonly [],
    const R extends boolean | undefined = false,
  >(
    token: Token<T>,
    options: BindOptions<NoInfer<T>, Caps, Deps, R>,
    fn: Factory<NoInfer<T>, NoInfer<Caps>, NoInfer<Deps>>
  ): BindResult<RebindFn<NoInfer<T>, NoInfer<Caps>, NoInfer<Deps>>, R>;

  registerClass<
    T extends object,
    const Specs extends readonly InjectSpec[] | undefined = undefined,
    const R extends boolean | undefined = false,
  >(
    token: Token<T>,
    ctor: new (...args: InjectTuple<Specs>) => NoInfer<T>,
    options?: InjectRegisterOptions<NoInfer<T>, Specs, R>
  ): BindResult<ClassRebindFn<NoInfer<T>, Specs>, R>;

  registerFn<T>(token: Token<T>, fn: (this: void) => NoInfer<T>): void;
  registerFn<
    T,
    const Specs extends readonly InjectSpec[] | undefined = undefined,
    const R extends boolean | undefined = false,
  >(
    token: Token<T>,
    options: InjectRegisterOptions<NoInfer<T>, Specs, R>,
    fn: (this: void, ...args: InjectTuple<Specs>) => NoInfer<T>
  ): BindResult<FnRebindFn<NoInfer<T>, Specs>, R>;

  registerAsync<T>(
    token: Token<Promise<T>>,
    fn: (this: void) => Promise<NoInfer<T>>
  ): void;
  registerAsync<
    T,
    const Specs extends readonly InjectSpec[] | undefined = undefined,
    const R extends boolean | undefined = false,
  >(
    token: Token<Promise<T>>,
    options: AsyncRegisterOptions<NoInfer<T>, Specs, R>,
    fn: (this: void, ...args: InjectTuple<Specs>) => Promise<NoInfer<T>>
  ): BindResult<AsyncRebindFn<NoInfer<T>, Specs>, R>;

  /** Memoized synchronous live virtual proxy for `token`. */
  getLiveProxy<T extends object>(token: Token<T>): T;

  /** Memoized promisified virtual proxy for any sync or async `token`. */
  getAsyncProxy<T extends object | PromiseLike<object>>(
    token: Token<T>
  ): Promisified<Awaited<T>>;

  assertVerified(
    policy?: PolicyRule | undefined,
    onWarn?: WarnHandler | undefined
  ): VerificationReport;
}

function createExternalTokenThunk(
  container: Container,
  token: AnyToken
): (this: void) => unknown {
  return function externalTokenThunk(this: void): unknown {
    return container.get(token as Token<unknown>);
  };
}

class AssemblerImpl implements Assembler {
  readonly kernel: Container;
  private externalThunks: Map<AnyToken, (this: void) => unknown> | null = null;
  private liveProxies: Map<AnyToken, object> | null = null;
  private asyncProxies: Map<AnyToken, object> | null = null;

  constructor(kernel: Container) {
    this.kernel = kernel;
  }

  get disposed(): boolean {
    return this.kernel.disposed;
  }

  createToken<T>(debugName?: string | undefined): Token<T> {
    return this.kernel.createToken<T>(debugName);
  }

  getTokenName(token: AnyToken): string {
    return this.kernel.getTokenName(token);
  }

  has(token: AnyToken): boolean {
    return this.kernel.has(token);
  }

  createChild(options: CreateOptions): Assembler {
    return new AssemblerImpl(this.kernel.createChild(options));
  }

  createRequestScope(
    onEvictCaptured: EvictCapturedPolicy = 'cascade'
  ): Assembler {
    return new AssemblerImpl(
      this.kernel.createChild({
        allowedStores: REQUEST_STORES,
        onEvictCaptured,
      })
    );
  }

  createOverrideScope(): Assembler {
    return new AssemblerImpl(
      this.kernel.createChild({
        allowedStores: OVERRIDE_STORES,
        onEvictCaptured: 'cascade',
      })
    );
  }

  use<R = void>(module: (this: void, assembler: Assembler) => R): R {
    return module(this);
  }

  bind<
    T,
    const Caps extends readonly AnyToken[] | undefined = readonly [],
    const Deps extends readonly AnyToken[] | undefined = readonly [],
    const R extends boolean | undefined = false,
  >(
    token: Token<T>,
    options: BindOptions<NoInfer<T>, Caps, Deps, R>,
    fn: Factory<NoInfer<T>, NoInfer<Caps>, NoInfer<Deps>>
  ): BindResult<RebindFn<NoInfer<T>, NoInfer<Caps>, NoInfer<Deps>>, R> {
    return this.kernel.bind(token, options, fn);
  }

  bindInsecure<T, const R extends boolean | undefined = false>(
    token: Token<T>,
    options: InsecureBindOptions<NoInfer<T>, R>,
    fn: InsecureFactory<NoInfer<T>>
  ): BindResult<InsecureRebindFn<NoInfer<T>>, R> {
    return this.kernel.bindInsecure(token, options, fn);
  }

  get<T>(token: Token<T>): T {
    return this.kernel.get(token);
  }

  evict(token: AnyToken): void {
    this.kernel.evict(token);
  }

  verify(policy?: PolicyRule | undefined): VerificationReport {
    return this.kernel.verify(policy);
  }

  dispose(): void {
    this.externalThunks = null;
    this.liveProxies = null;
    this.asyncProxies = null;
    this.kernel.dispose();
  }


  register<T, U extends NoInfer<T>, Handle>(
    token: Token<T>,
    descriptor: BindingDescriptor<U, Handle>
  ): Handle {
    return descriptor.bind(this.kernel, token as unknown as Token<U>);
  }

  registerValue<T>(token: Token<T>, value: NoInfer<T>): void {
    this.kernel.bind(token, DEFAULT_PURE, makeConstantFactory(value));
  }

  registerFactory<
    T,
    const Caps extends readonly AnyToken[] | undefined = readonly [],
    const Deps extends readonly AnyToken[] | undefined = readonly [],
    const R extends boolean | undefined = false,
  >(
    token: Token<T>,
    options: BindOptions<NoInfer<T>, Caps, Deps, R>,
    fn: Factory<NoInfer<T>, NoInfer<Caps>, NoInfer<Deps>>
  ): BindResult<RebindFn<NoInfer<T>, NoInfer<Caps>, NoInfer<Deps>>, R> {
    return this.kernel.bind(token, options, fn);
  }

  registerClass<
    T extends object,
    const Specs extends readonly InjectSpec[] | undefined = undefined,
    const R extends boolean | undefined = false,
  >(
    token: Token<T>,
    ctor: new (...args: InjectTuple<Specs>) => NoInfer<T>,
    options?: InjectRegisterOptions<NoInfer<T>, Specs, R>
  ): BindResult<ClassRebindFn<NoInfer<T>, Specs>, R> {
    return bindInjected(
      this.kernel,
      token,
      true,
      ctor,
      options as RawInjectOptions | undefined,
      false
    ) as BindResult<ClassRebindFn<NoInfer<T>, Specs>, R>;
  }

  registerFn<T>(token: Token<T>, fn: (this: void) => NoInfer<T>): void;
  registerFn<
    T,
    const Specs extends readonly InjectSpec[] | undefined = undefined,
    const R extends boolean | undefined = false,
  >(
    token: Token<T>,
    options: InjectRegisterOptions<NoInfer<T>, Specs, R>,
    fn: (this: void, ...args: InjectTuple<Specs>) => NoInfer<T>
  ): BindResult<FnRebindFn<NoInfer<T>, Specs>, R>;
  registerFn(token: AnyToken, optsOrFn: unknown, maybeFn?: unknown): any {
    return typeof optsOrFn === 'function'
      ? bindInjected(this.kernel, token, false, optsOrFn, undefined, false)
      : bindInjected(
          this.kernel,
          token,
          false,
          maybeFn,
          optsOrFn as RawInjectOptions,
          false
        );
  }

  registerAsync<T>(
    token: Token<Promise<T>>,
    fn: (this: void) => Promise<NoInfer<T>>
  ): void;
  registerAsync<
    T,
    const Specs extends readonly InjectSpec[] | undefined = undefined,
    const R extends boolean | undefined = false,
  >(
    token: Token<Promise<T>>,
    options: AsyncRegisterOptions<NoInfer<T>, Specs, R>,
    fn: (this: void, ...args: InjectTuple<Specs>) => Promise<NoInfer<T>>
  ): BindResult<AsyncRebindFn<NoInfer<T>, Specs>, R>;
  registerAsync(token: AnyToken, optsOrFn: unknown, maybeFn?: unknown): any {
    return typeof optsOrFn === 'function'
      ? bindInjected(this.kernel, token, false, optsOrFn, undefined, true)
      : bindInjected(
          this.kernel,
          token,
          false,
          maybeFn,
          optsOrFn as RawInjectOptions,
          true
        );
  }

  getLiveProxy<T extends object>(token: Token<T>): T {
    let cache = this.liveProxies;
    if (cache !== null) {
      const hit = cache.get(token);
      if (hit !== undefined) return hit as T;
    } else {
      cache = new Map<AnyToken, object>();
      this.liveProxies = cache;
    }
    const proxy = toLiveProxy(
      this.getExternalThunk(token) as (this: void) => T
    );
    cache.set(token, proxy);
    return proxy;
  }

  getAsyncProxy<T extends object | PromiseLike<object>>(
    token: Token<T>
  ): Promisified<Awaited<T>> {
    let cache = this.asyncProxies;
    if (cache !== null) {
      const hit = cache.get(token);
      if (hit !== undefined) return hit as Promisified<Awaited<T>>;
    } else {
      cache = new Map<AnyToken, object>();
      this.asyncProxies = cache;
    }
    const proxy = toAsyncProxy(
      this.getExternalThunk(token) as (this: void) => T
    );
    cache.set(token, proxy as unknown as object);
    return proxy;
  }

  assertVerified(
    policy?: PolicyRule | undefined,
    onWarn?: WarnHandler | undefined
  ): VerificationReport {
    return assertVerified(this.kernel, policy, onWarn);
  }

  private getExternalThunk(token: AnyToken): (this: void) => unknown {
    let cache = this.externalThunks;
    if (cache === null) {
      cache = new Map<AnyToken, (this: void) => unknown>();
      this.externalThunks = cache;
    }
    let fn = cache.get(token);
    if (fn === undefined) {
      fn = createExternalTokenThunk(this.kernel, token);
      cache.set(token, fn);
    }
    return fn;
  }
}


const extendedContainerCache = new WeakMap<Container, AssemblerImpl>();

export function createAssembler(
  options?: CreateOptions | undefined
): Assembler {
  const container = createContainer(
    options ?? { allowedStores: APP_STORES, onEvictCaptured: 'cascade' }
  );
  const asm = new AssemblerImpl(container);
  extendedContainerCache.set(container, asm);
  return asm;
}

/**
 * Extends any existing kernel {@link Container} with {@link Assembler}
 * ergonomics. Weakly memoized per container (`extendContainer(c) === extendContainer(c)`)
 * with zero memory leaks and 100% shared stores and `TokenSpace`.
 */
export function extendContainer(container: Container): Assembler {
  if (container instanceof AssemblerImpl) return container;
  let asm = extendedContainerCache.get(container);
  if (asm === undefined) {
    asm = new AssemblerImpl(container);
    extendedContainerCache.set(container, asm);
  }
  return asm;
}
