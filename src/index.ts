/**
 * @module @computerwwwizards/di-kernel
 *
 * Mechanically sympathetic TypeScript 6.0.3+ implementation of `./types.ts`.
 */

import type {
  AnyToken,
  BindOptions,
  BindResult,
  CaptureRelation,
  Container,
  CreateOptions,
  EvictCapturedPolicy,
  Factory,
  FoldedTokenFact,
  InsecureBindOptions,
  InsecureFactory,
  InsecureRebindFn,
  KernelError,
  KernelErrorCode,
  PolicyAction,
  PolicyRule,
  PolicyViolation,
  RebindFn,
  Resolver,
  RetainedStorage,
  StateKind,
  StorageKind,
  StorageTarget,
  StructuralError,
  TaintBitsMap,
  TaintDischarge,
  TaintMask,
  TaintTag,
  Token,
  VerificationReport,
} from './types';

export type * from './types';

// ============================================================================
// 1. IMMUTABLE SMI BITMASK CONSTANTS & 16-ENTRY CAPTURE MATRIX
// ============================================================================

const STORAGE_NONE = 0;
const STORAGE_EPHEMERAL = 1;
const STORAGE_SOLID = 2;
const STORAGE_WEAK = 3;
type StorageCode = 0 | 1 | 2 | 3;

const STATE_STATELESS = 0;
const STATE_STATEFUL = 1;
type StateCode = 0 | 1;

const TARGET_PROVIDER = 0;
const TARGET_CALLER = 1;
type TargetCode = 0 | 1;

const EVICT_CASCADE = 0;
const EVICT_BLOCK = 1;
const EVICT_ORPHAN = 2;
type EvictCode = 0 | 1 | 2;

const ALLOWED_SOLID_BIT = 1 << 0;
const ALLOWED_WEAK_BIT = 1 << 1;

export const TAINT_BITS: TaintBitsMap = Object.freeze({
  insecure: 1,
  'eviction-coupled': 2,
  'captive-ephemeral': 4,
  'captive-caller': 8,
  'weak-pinned': 16,
  'frozen-none': 32,
  'escaped-ephemeral': 64,
  'volatile-state': 128,
  'state-leak': 256,
  'pinned-mutable': 512,
  'split-state-diamond': 1024,
  'shared-diamond': 2048,
  'thunk-cycle': 4096,
} as const);

const TAINT_TAG_BY_BIT: readonly TaintTag[] = Object.freeze([
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

const PROPAGATING_MASK = ~(
  TAINT_BITS['escaped-ephemeral'] |
  TAINT_BITS['eviction-coupled'] |
  TAINT_BITS['frozen-none'] |
  TAINT_BITS['weak-pinned'] |
  TAINT_BITS['pinned-mutable'] |
  TAINT_BITS['captive-caller']
);

const DIRECT_STORAGE_MATRIX = new Uint16Array([
  // dependent = none
  0,
  TAINT_BITS['escaped-ephemeral'],
  0,
  0,
  // dependent = ephemeral
  TAINT_BITS['frozen-none'],
  0,
  TAINT_BITS['eviction-coupled'],
  TAINT_BITS['weak-pinned'],
  // dependent = solid
  TAINT_BITS['frozen-none'],
  TAINT_BITS['captive-ephemeral'],
  TAINT_BITS['eviction-coupled'],
  TAINT_BITS['weak-pinned'] | TAINT_BITS['eviction-coupled'],
  // dependent = weak
  TAINT_BITS['frozen-none'],
  TAINT_BITS['captive-ephemeral'],
  TAINT_BITS['eviction-coupled'],
  TAINT_BITS['weak-pinned'] | TAINT_BITS['eviction-coupled'],
]);

const EMPTY_ARRAY: readonly never[] = Object.freeze([]);
const EMPTY_THUNKS: readonly ((this: void) => unknown)[] = Object.freeze([]);
const EMPTY_DISCHARGES: readonly TaintDischarge[] = Object.freeze([]);
const EMPTY_TAINT_SET: ReadonlySet<TaintTag> = new Set<TaintTag>();

function encodeStorage(storage: StorageKind): StorageCode {
  if (storage === 'solid') return STORAGE_SOLID;
  if (storage === 'weak') return STORAGE_WEAK;
  if (storage === 'ephemeral') return STORAGE_EPHEMERAL;
  return STORAGE_NONE;
}

function storageName(code: StorageCode): StorageKind {
  if (code === STORAGE_SOLID) return 'solid';
  if (code === STORAGE_WEAK) return 'weak';
  if (code === STORAGE_EPHEMERAL) return 'ephemeral';
  return 'none';
}

function encodeEvictPolicy(policy: EvictCapturedPolicy | undefined): EvictCode {
  if (policy === 'block') return EVICT_BLOCK;
  if (policy === 'orphan') return EVICT_ORPHAN;
  return EVICT_CASCADE;
}

function encodeAllowedStores(stores: readonly RetainedStorage[]): number {
  let mask = 0;
  for (let i = 0; i < stores.length; i++) {
    const s = stores[i];
    if (s === 'solid') mask |= ALLOWED_SOLID_BIT;
    else if (s === 'weak') mask |= ALLOWED_WEAK_BIT;
  }
  return mask;
}

function decodeTaintMask(mask: TaintMask): ReadonlySet<TaintTag> {
  if (mask === 0) return EMPTY_TAINT_SET;
  const out = new Set<TaintTag>();
  for (let m = mask, bit = 0; m !== 0; m >>>= 1, bit++) {
    if ((m & 1) !== 0) {
      const tag = TAINT_TAG_BY_BIT[bit];
      if (tag !== undefined) out.add(tag);
    }
  }
  return out;
}

// ============================================================================
// 2. MONOMORPHIC INTERNAL STRUCTS (FIXED V8 HIDDEN CLASSES)
// ============================================================================

interface RawBindOptions {
  readonly storage: StorageKind;
  readonly state?: StateKind;
  readonly target?: StorageTarget | undefined;
  readonly captures?: readonly AnyToken[] | undefined;
  readonly deps?: readonly AnyToken[] | undefined;
  readonly rebindable?: boolean | undefined;
  readonly discharges?: readonly TaintDischarge[] | undefined;
  readonly onDispose?: ((this: void, instance: any) => void) | undefined;
  readonly onDecapture?:
    | ((this: void, instance: any, remaining: number) => void)
    | undefined;
}

class KernelErrorImpl extends Error implements KernelError {
  override readonly name = 'KernelError' as const;
  readonly code: KernelErrorCode;
  readonly token: AnyToken | undefined;
  readonly relatedTokens: readonly AnyToken[] | undefined;

  constructor(
    code: KernelErrorCode,
    message: string,
    token?: AnyToken | undefined,
    relatedTokens?: readonly AnyToken[] | undefined
  ) {
    super(message);
    this.code = code;
    this.token = token;
    this.relatedTokens = relatedTokens;
  }
}

class TokenSpace {
  nextId = 0;
  readonly owners: ContainerImpl[] = [];
  readonly names: (string | undefined)[] = [];
}

class PassContext {
  depth = 0;
  capturerBase = 0;
  ephemeralBase = 0;
  readonly resolving: AnyToken[] = [];
  readonly ephemeral = new Map<AnyToken, EphemeralEntry>();
  readonly ephemeralOrder: EphemeralEntry[] = [];
  readonly capturerStack: StoredEntry[] = [];
  readonly ephemeralCollectorStack: EphemeralEntry[] = [];
}

class EphemeralEntry {
  value: unknown = undefined;
  readonly onDispose: ((this: void, instance: any) => void) | undefined;
  capturedEntries: StoredEntry[] | null = null;

  constructor(onDispose: ((this: void, instance: any) => void) | undefined) {
    this.onDispose = onDispose;
  }
}

class InternalBinding {
  readonly token: AnyToken;
  readonly owner: ContainerImpl;
  readonly storage: StorageCode;
  readonly state: StateCode;
  readonly target: TargetCode;
  readonly captures: readonly AnyToken[];
  readonly deps: readonly AnyToken[];
  readonly discharges: readonly TaintDischarge[];
  readonly rebindable: boolean;
  readonly insecure: boolean;
  readonly onDispose: ((this: void, instance: any) => void) | undefined;
  readonly onDecapture:
    | ((this: void, instance: any, remaining: number) => void)
    | undefined;
  factory: (this: void, ...args: any[]) => any;
  ownerDepThunks: readonly ((this: void) => unknown)[] | null = null;

  constructor(
    token: AnyToken,
    owner: ContainerImpl,
    storage: StorageCode,
    state: StateCode,
    target: TargetCode,
    captures: readonly AnyToken[],
    deps: readonly AnyToken[],
    discharges: readonly TaintDischarge[],
    rebindable: boolean,
    insecure: boolean,
    onDispose: ((this: void, instance: any) => void) | undefined,
    onDecapture:
      | ((this: void, instance: any, remaining: number) => void)
      | undefined,
    factory: (this: void, ...args: any[]) => any
  ) {
    this.token = token;
    this.owner = owner;
    this.storage = storage;
    this.state = state;
    this.target = target;
    this.captures = captures;
    this.deps = deps;
    this.discharges = discharges;
    this.rebindable = rebindable;
    this.insecure = insecure;
    this.onDispose = onDispose;
    this.onDecapture = onDecapture;
    this.factory = factory;
  }
}

class StoredEntry {
  readonly container: ContainerImpl;
  readonly binding: InternalBinding;
  readonly storage: typeof STORAGE_SOLID | typeof STORAGE_WEAK;
  value: unknown = undefined;
  weakRef: WeakRef<object> | null = null;
  gcToken: object | null = null;
  capturing: Set<StoredEntry> | null = null;
  capturedBy: Set<StoredEntry> | null = null;
  prevInContainer: StoredEntry | null = null;
  nextInContainer: StoredEntry | null = null;
  inContainerList = false;
  disposed = false;

  constructor(
    container: ContainerImpl,
    binding: InternalBinding,
    storage: typeof STORAGE_SOLID | typeof STORAGE_WEAK
  ) {
    this.container = container;
    this.binding = binding;
    this.storage = storage;
  }
}

class MutableFoldFact {
  readonly origin: AnyToken;
  readonly originBinding: InternalBinding;
  direct: boolean;
  diamond: boolean;
  mask: number;
  dischargedMask: number;
  sanitizedMask: number;

  constructor(
    origin: AnyToken,
    originBinding: InternalBinding,
    direct: boolean,
    diamond: boolean,
    mask: number,
    dischargedMask: number,
    sanitizedMask: number
  ) {
    this.origin = origin;
    this.originBinding = originBinding;
    this.direct = direct;
    this.diamond = diamond;
    this.mask = mask;
    this.dischargedMask = dischargedMask;
    this.sanitizedMask = sanitizedMask;
  }
}

class FoldedTokenFactImpl implements FoldedTokenFact {
  readonly origin: AnyToken;
  readonly relation: CaptureRelation;
  readonly diamond: boolean;
  readonly mask: TaintMask;
  readonly dischargedMask: TaintMask;
  private _taints: ReadonlySet<TaintTag> | null = null;
  private _dischargedTaints: ReadonlySet<TaintTag> | null = null;

  constructor(
    origin: AnyToken,
    relation: CaptureRelation,
    diamond: boolean,
    mask: TaintMask,
    dischargedMask: TaintMask
  ) {
    this.origin = origin;
    this.relation = relation;
    this.diamond = diamond;
    this.mask = mask;
    this.dischargedMask = dischargedMask;
  }

  get taints(): ReadonlySet<TaintTag> {
    let set = this._taints;
    if (set === null) {
      set = decodeTaintMask(this.mask);
      this._taints = set;
    }
    return set;
  }

  get dischargedTaints(): ReadonlySet<TaintTag> {
    let set = this._dischargedTaints;
    if (set === null) {
      set = decodeTaintMask(this.dischargedMask);
      this._dischargedTaints = set;
    }
    return set;
  }
}

class ThunkStackFrame {
  readonly binding: InternalBinding;
  readonly viaThunk: boolean;

  constructor(binding: InternalBinding, viaThunk: boolean) {
    this.binding = binding;
    this.viaThunk = viaThunk;
  }
}

// ============================================================================
// 3. TOP-LEVEL MINIMAL-CONTEXT CALLBACKS & CLOSURE FACTORIES
// ============================================================================

function finalizeWeakEntry(entry: StoredEntry): void {
  if (!entry.disposed) {
    entry.container.finalizeDeadWeak(entry);
  }
}

function createDetachedThunk(
  container: ContainerImpl,
  token: AnyToken
): (this: void) => unknown {
  return function diThunk(this: void): unknown {
    return container.resolveDetached(token);
  };
}

function createDynamicResolver(container: ContainerImpl): Resolver {
  return function diDynamicGet<U>(this: void, token: Token<U>): U {
    return container.get(token);
  };
}

function createProviderRebinder<
  T,
  Caps extends readonly AnyToken[] | undefined,
  Deps extends readonly AnyToken[] | undefined,
>(
  owner: ContainerImpl,
  binding: InternalBinding
): RebindFn<T, Caps, Deps> {
  return function diRebind(this: void, newFn: Factory<T, Caps, Deps>): void {
    owner.applyRebind(binding, newFn as (this: void, ...args: any[]) => any);
  };
}

function createInsecureRebinder<T>(
  owner: ContainerImpl,
  binding: InternalBinding
): InsecureRebindFn<T> {
  return function diRebindInsecure(
    this: void,
    newFn: InsecureFactory<T>
  ): void {
    owner.applyRebind(binding, newFn as (this: void, ...args: any[]) => any);
  };
}

// ============================================================================
// 4. HOISTED STATIC LATTICE VERIFICATION ENGINE (DUAL-LATTICE DISCHARGES)
// ============================================================================

function isProviderRetained(b: InternalBinding): boolean {
  return (
    (b.storage === STORAGE_SOLID || b.storage === STORAGE_WEAK) &&
    b.target === TARGET_PROVIDER
  );
}

function resolveStaticEdge(
  dependent: InternalBinding,
  depTok: AnyToken,
  callerEffective: Map<AnyToken, InternalBinding>
): InternalBinding | undefined {
  if (isProviderRetained(dependent)) {
    return dependent.owner.findBindingInternal(depTok);
  }
  return callerEffective.get(depTok);
}

function getDischargeMask(binding: InternalBinding, origin: AnyToken): number {
  const list = binding.discharges;
  const len = list.length;
  if (len === 0) return 0;
  let mask = 0;
  for (let i = 0; i < len; i++) {
    const entry = list[i];
    if (entry !== undefined && entry[0] === origin) {
      mask |= entry[1];
    }
  }
  return mask;
}

function computeSelfMask(b: InternalBinding): number {
  let mask = 0;
  if (b.insecure) mask |= TAINT_BITS.insecure;
  if (b.storage === STORAGE_WEAK && (b.insecure || b.state === STATE_STATEFUL)) {
    mask |= TAINT_BITS['volatile-state'];
  }
  return mask;
}

function computeDirectMask(
  dependent: InternalBinding,
  dependency: InternalBinding
): number {
  let mask =
    DIRECT_STORAGE_MATRIX[(dependent.storage << 2) | dependency.storage] ?? 0;

  if (
    isProviderRetained(dependent) &&
    (dependency.storage === STORAGE_SOLID ||
      dependency.storage === STORAGE_WEAK) &&
    dependency.target === TARGET_CALLER
  ) {
    mask |= TAINT_BITS['captive-caller'];
  }
  if (dependency.insecure) {
    mask |= TAINT_BITS.insecure;
  }
  if (
    !dependent.insecure &&
    dependent.state === STATE_STATELESS &&
    (dependency.insecure || dependency.state === STATE_STATEFUL)
  ) {
    mask |= TAINT_BITS['state-leak'];
  }
  if (
    (dependent.storage === STORAGE_SOLID ||
      dependent.storage === STORAGE_WEAK) &&
    dependency.rebindable
  ) {
    mask |= TAINT_BITS['pinned-mutable'];
  }

  return mask;
}

function dfsCaptureCycles(
  binding: InternalBinding,
  effective: Map<AnyToken, InternalBinding>,
  color: Map<InternalBinding, 0 | 1 | 2>,
  stack: InternalBinding[],
  cycleBindings: Set<InternalBinding>,
  errors: StructuralError[]
): void {
  color.set(binding, 1);
  stack.push(binding);

  const caps = binding.captures;
  for (let i = 0; i < caps.length; i++) {
    const depTok = caps[i];
    if (depTok === undefined) continue;
    const depB = resolveStaticEdge(binding, depTok, effective);
    if (depB === undefined) continue;

    const c = color.get(depB) ?? 0;
    if (c === 1) {
      const idx = stack.indexOf(depB);
      if (idx !== -1) {
        const cycle: [AnyToken, ...AnyToken[]] = [depB.token];
        cycleBindings.add(depB);
        for (let j = idx + 1; j < stack.length; j++) {
          const item = stack[j];
          if (item !== undefined) {
            cycleBindings.add(item);
            cycle.push(item.token);
          }
        }
        cycle.push(depB.token);
        errors.push({ kind: 'capture-cycle', cycle });
      }
    } else if (c === 0) {
      dfsCaptureCycles(depB, effective, color, stack, cycleBindings, errors);
    }
  }

  stack.pop();
  color.set(binding, 2);
}

function visitThunkEdge(
  depB: InternalBinding,
  isThunk: boolean,
  effective: Map<AnyToken, InternalBinding>,
  color: Map<InternalBinding, 0 | 1 | 2>,
  stack: ThunkStackFrame[],
  thunkCycleBindings: Set<InternalBinding>
): void {
  const c = color.get(depB) ?? 0;
  if (c === 1) {
    let idx = -1;
    for (let i = 0; i < stack.length; i++) {
      const frame = stack[i];
      if (frame !== undefined && frame.binding === depB) {
        idx = i;
        break;
      }
    }
    if (idx !== -1) {
      let hasThunk = isThunk;
      if (!hasThunk) {
        for (let i = idx + 1; i < stack.length; i++) {
          const frame = stack[i];
          if (frame !== undefined && frame.viaThunk) {
            hasThunk = true;
            break;
          }
        }
      }
      if (hasThunk) {
        for (let i = idx; i < stack.length; i++) {
          const frame = stack[i];
          if (frame !== undefined) thunkCycleBindings.add(frame.binding);
        }
      }
    }
  } else if (c === 0) {
    dfsThunkCycles(depB, isThunk, effective, color, stack, thunkCycleBindings);
  }
}

function dfsThunkCycles(
  binding: InternalBinding,
  viaThunk: boolean,
  effective: Map<AnyToken, InternalBinding>,
  color: Map<InternalBinding, 0 | 1 | 2>,
  stack: ThunkStackFrame[],
  thunkCycleBindings: Set<InternalBinding>
): void {
  color.set(binding, 1);
  stack.push(new ThunkStackFrame(binding, viaThunk));

  const caps = binding.captures;
  for (let i = 0; i < caps.length; i++) {
    const depTok = caps[i];
    if (depTok === undefined) continue;
    const depB = resolveStaticEdge(binding, depTok, effective);
    if (depB !== undefined) {
      visitThunkEdge(depB, false, effective, color, stack, thunkCycleBindings);
    }
  }

  const deps = binding.deps;
  for (let i = 0; i < deps.length; i++) {
    const depTok = deps[i];
    if (depTok === undefined) continue;
    const depB = resolveStaticEdge(binding, depTok, effective);
    if (depB !== undefined) {
      visitThunkEdge(depB, true, effective, color, stack, thunkCycleBindings);
    }
  }

  stack.pop();
  color.set(binding, 2);
}

function mergeFoldEntry(
  acc: Map<AnyToken, MutableFoldFact>,
  origin: AnyToken,
  originBinding: InternalBinding,
  incomingMask: number,
  incomingSanitized: number,
  incomingDirect: boolean,
  alreadyDiamond: boolean
): void {
  const existing = acc.get(origin);
  if (existing !== undefined) {
    existing.diamond = true;
    if (incomingDirect) existing.direct = true;
    // May-taint joins with OR; must-sanitize joins with AND across diamond branches.
    existing.mask |= incomingMask;
    existing.sanitizedMask &= incomingSanitized;

    const isSplit =
      (originBinding.storage === STORAGE_NONE &&
        (originBinding.insecure || originBinding.state === STATE_STATEFUL)) ||
      (existing.originBinding !== originBinding &&
        (originBinding.insecure ||
          originBinding.state === STATE_STATEFUL ||
          existing.originBinding.insecure ||
          existing.originBinding.state === STATE_STATEFUL));

    existing.mask |= isSplit
      ? TAINT_BITS['split-state-diamond']
      : TAINT_BITS['shared-diamond'];
  } else {
    acc.set(
      origin,
      new MutableFoldFact(
        origin,
        originBinding,
        incomingDirect,
        alreadyDiamond,
        incomingMask,
        0,
        incomingSanitized
      )
    );
  }
}

function foldNodeCaptures(
  binding: InternalBinding,
  effective: Map<AnyToken, InternalBinding>,
  cycleBindings: Set<InternalBinding>,
  memo: Map<InternalBinding, Map<AnyToken, MutableFoldFact>>
): Map<AnyToken, MutableFoldFact> {
  const cached = memo.get(binding);
  if (cached !== undefined) return cached;

  const acc = new Map<AnyToken, MutableFoldFact>();
  if (cycleBindings.has(binding)) {
    memo.set(binding, acc);
    return acc;
  }

  const caps = binding.captures;
  for (let i = 0; i < caps.length; i++) {
    const depTok = caps[i];
    if (depTok === undefined) continue;
    const depB = resolveStaticEdge(binding, depTok, effective);
    if (depB === undefined) continue;

    // Respect depB's self-discharges (e.g. memo discharging volatile-state)
    const depRawSelf = computeSelfMask(depB);
    const depSelfReq = getDischargeMask(depB, depTok);
    const depSelfSanitized = depRawSelf & depSelfReq;
    const depSelfEffective = depRawSelf & ~depSelfSanitized;

    const directMask =
      (computeDirectMask(binding, depB) & ~depSelfSanitized) | depSelfEffective;
    mergeFoldEntry(acc, depTok, depB, directMask, depSelfSanitized, true, false);

    const subFold = foldNodeCaptures(depB, effective, cycleBindings, memo);
    for (const [originTok, subFact] of subFold) {
      const originB = subFact.originBinding;
      const combinedMask =
        (computeDirectMask(binding, originB) & ~subFact.sanitizedMask) |
        (subFact.mask & PROPAGATING_MASK);
      mergeFoldEntry(
        acc,
        originTok,
        originB,
        combinedMask,
        subFact.sanitizedMask,
        false,
        subFact.diamond
      );
    }
  }

  // Apply this binding's local per-origin discharges after merging all branches
  if (binding.discharges.length > 0) {
    for (const fact of acc.values()) {
      const req = getDischargeMask(binding, fact.origin);
      if (req !== 0) {
        const discharged = fact.mask & req;
        fact.dischargedMask = discharged;
        fact.mask &= ~discharged;
        fact.sanitizedMask |= discharged;
      }
    }
  }

  memo.set(binding, acc);
  return acc;
}

// ============================================================================
// 5. CONTAINER IMPLEMENTATION
// ============================================================================

class ContainerImpl implements Container {
  readonly root: ContainerImpl;
  readonly parent: ContainerImpl | null;
  readonly depth: number;
  private readonly tokens: TokenSpace;
  private readonly pass: PassContext;
  private readonly allowedMask: number;
  private readonly onEvictCaptured: EvictCode;

  private readonly bindings = new Map<AnyToken, InternalBinding>();
  private readonly solidStore = new Map<AnyToken, StoredEntry>();
  private readonly weakStore = new Map<AnyToken, StoredEntry>();
  private readonly thunkCache = new Map<AnyToken, (this: void) => unknown>();
  private weakRegistry: FinalizationRegistry<StoredEntry> | null = null;
  private cachedResolver: Resolver | null = null;

  private headEntry: StoredEntry | null = null;
  private tailEntry: StoredEntry | null = null;

  private _disposed = false;
  private _disposing = false;

  constructor(options: CreateOptions, parent: ContainerImpl | null) {
    this.parent = parent;
    if (parent === null) {
      this.root = this;
      this.depth = 0;
      this.tokens = new TokenSpace();
      this.pass = new PassContext();
    } else {
      this.root = parent.root;
      this.depth = parent.depth + 1;
      this.tokens = parent.tokens;
      this.pass = parent.pass;
    }
    this.allowedMask = encodeAllowedStores(options.allowedStores);
    this.onEvictCaptured = encodeEvictPolicy(options.onEvictCaptured);
  }

  get disposed(): boolean {
    return this._disposed;
  }

  createToken<T>(debugName?: string | undefined): Token<T> {
    this.assertAlive();
    const id = this.tokens.nextId++;
    this.tokens.owners.push(this);
    this.tokens.names.push(debugName);
    return id as Token<T>;
  }

  getTokenName(token: AnyToken): string {
    return this.tokens.names[token] ?? `Token#${token}`;
  }

  has(token: AnyToken): boolean {
    if (this._disposed) return false;
    return (
      this.isTokenInScope(token) &&
      this.findBindingInternal(token) !== undefined
    );
  }

  createChild(options: CreateOptions): Container {
    this.assertAlive();
    return new ContainerImpl(options, this);
  }

  use<R = void>(module: (this: void, container: Container) => R): R {
    this.assertAlive();
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
    this.assertAlive();
    this.assertTokenInScope(token);
    if (this.bindings.has(token)) {
      throw new KernelErrorImpl(
        'duplicate-binding',
        `Token "${this.getTokenName(token)}" is already bound in this container.`,
        token
      );
    }

    const opts = options as RawBindOptions;
    const captures: readonly AnyToken[] =
      opts.captures !== undefined && opts.captures.length > 0
        ? opts.captures
        : EMPTY_ARRAY;
    const deps: readonly AnyToken[] =
      opts.deps !== undefined && opts.deps.length > 0 ? opts.deps : EMPTY_ARRAY;
    const discharges: readonly TaintDischarge[] =
      opts.discharges !== undefined && opts.discharges.length > 0
        ? opts.discharges
        : EMPTY_DISCHARGES;

    this.validateEdges(token, captures, deps, discharges);

    const storageCode = encodeStorage(opts.storage);
    const targetCode =
      (storageCode === STORAGE_SOLID || storageCode === STORAGE_WEAK) &&
      opts.target === 'caller'
        ? TARGET_CALLER
        : TARGET_PROVIDER;

    if (
      (storageCode === STORAGE_SOLID || storageCode === STORAGE_WEAK) &&
      targetCode === TARGET_PROVIDER &&
      !this.allowsStorage(storageCode)
    ) {
      throw new KernelErrorImpl(
        'disallowed-storage',
        `Cannot bind "${this.getTokenName(token)}" with storage "${opts.storage}" (target: "provider"): container does not allow "${opts.storage}".`,
        token
      );
    }

    if (this.solidStore.has(token) || this.weakStore.has(token)) {
      this.evictFromContainer(this, token);
    }

    const binding = new InternalBinding(
      token,
      this,
      storageCode,
      opts.state === 'stateful' ? STATE_STATEFUL : STATE_STATELESS,
      targetCode,
      captures,
      deps,
      discharges,
      opts.rebindable === true,
      false,
      opts.onDispose,
      opts.onDecapture,
      fn as (this: void, ...args: any[]) => any
    );

    this.bindings.set(token, binding);

    if (opts.rebindable === true) {
      return createProviderRebinder<NoInfer<T>, NoInfer<Caps>, NoInfer<Deps>>(
        this,
        binding
      ) as BindResult<RebindFn<NoInfer<T>, NoInfer<Caps>, NoInfer<Deps>>, R>;
    }

    return undefined as BindResult<
      RebindFn<NoInfer<T>, NoInfer<Caps>, NoInfer<Deps>>,
      R
    >;
  }

  bindInsecure<T, const R extends boolean | undefined = false>(
    token: Token<T>,
    options: InsecureBindOptions<NoInfer<T>, R>,
    fn: InsecureFactory<NoInfer<T>>
  ): BindResult<InsecureRebindFn<NoInfer<T>>, R> {
    this.assertAlive();
    this.assertTokenInScope(token);
    if (this.bindings.has(token)) {
      throw new KernelErrorImpl(
        'duplicate-binding',
        `Token "${this.getTokenName(token)}" is already bound in this container.`,
        token
      );
    }

    const opts = options as RawBindOptions;
    const discharges: readonly TaintDischarge[] =
      opts.discharges !== undefined && opts.discharges.length > 0
        ? opts.discharges
        : EMPTY_DISCHARGES;
    for (let i = 0; i < discharges.length; i++) {
      const d = discharges[i];
      if (d !== undefined) this.assertTokenInScope(d[0]);
    }

    const storageCode = encodeStorage(opts.storage);
    const targetCode =
      (storageCode === STORAGE_SOLID || storageCode === STORAGE_WEAK) &&
      opts.target === 'caller'
        ? TARGET_CALLER
        : TARGET_PROVIDER;

    if (
      (storageCode === STORAGE_SOLID || storageCode === STORAGE_WEAK) &&
      targetCode === TARGET_PROVIDER &&
      !this.allowsStorage(storageCode)
    ) {
      throw new KernelErrorImpl(
        'disallowed-storage',
        `Cannot bindInsecure "${this.getTokenName(token)}" with storage "${opts.storage}": container does not allow "${opts.storage}".`,
        token
      );
    }

    if (this.solidStore.has(token) || this.weakStore.has(token)) {
      this.evictFromContainer(this, token);
    }

    const binding = new InternalBinding(
      token,
      this,
      storageCode,
      STATE_STATEFUL,
      targetCode,
      EMPTY_ARRAY,
      EMPTY_ARRAY,
      discharges,
      opts.rebindable === true,
      true,
      opts.onDispose,
      opts.onDecapture,
      fn as (this: void, ...args: any[]) => any
    );

    this.bindings.set(token, binding);

    if (opts.rebindable === true) {
      return createInsecureRebinder<NoInfer<T>>(this, binding) as BindResult<
        InsecureRebindFn<NoInfer<T>>,
        R
      >;
    }

    return undefined as BindResult<InsecureRebindFn<NoInfer<T>>, R>;
  }

  /** @internal */
  applyRebind(
    binding: InternalBinding,
    newFn: (this: void, ...args: any[]) => any
  ): void {
    this.assertAlive();
    if (
      (binding.storage === STORAGE_SOLID || binding.storage === STORAGE_WEAK) &&
      binding.target === TARGET_PROVIDER
    ) {
      this.evictFromContainer(this, binding.token);
    }
    binding.factory = newFn;
  }

  get<T>(token: Token<T>): T {
    return this.resolveRoot(token) as T;
  }

  /** @internal */
  resolveDetached(token: AnyToken): unknown {
    const pass = this.pass;
    const prevCapBase = pass.capturerBase;
    const prevEphBase = pass.ephemeralBase;
    pass.capturerBase = pass.capturerStack.length;
    pass.ephemeralBase = pass.ephemeralCollectorStack.length;
    try {
      return this.resolveRoot(token);
    } finally {
      pass.capturerBase = prevCapBase;
      pass.ephemeralBase = prevEphBase;
    }
  }

  evict(token: AnyToken): void {
    this.assertAlive();
    this.assertTokenInScope(token);
    const binding = this.findBindingInternal(token);
    if (binding === undefined) return;
    if (binding.storage !== STORAGE_SOLID && binding.storage !== STORAGE_WEAK) {
      return;
    }
    const storeOwner = binding.target === TARGET_CALLER ? this : binding.owner;
    this.evictFromContainer(storeOwner, token);
  }

  dispose(): void {
    if (this._disposed || this._disposing) return;
    this._disposing = true;
    try {
      while (this.tailEntry !== null) {
        this.evictEntry(this.tailEntry);
      }
      this.bindings.clear();
      this.thunkCache.clear();
      this.cachedResolver = null;
      this._disposed = true;
    } finally {
      this._disposing = false;
    }
  }

  declare [Symbol.dispose]: () => void;


  // --------------------------------------------------------------------------
  // Resolution & Runtime Capture Wiring
  // --------------------------------------------------------------------------

  private resolveRoot(token: AnyToken): unknown {
    this.assertAlive();
    const pass = this.pass;

    if (pass.depth === 0 && this.solidStore.size !== 0) {
      const fast = this.solidStore.get(token);
      if (fast !== undefined) {
        return fast.value;
      }
    }

    pass.depth++;
    try {
      return this.resolveInternal(token, this);
    } finally {
      pass.depth--;
      if (pass.depth === 0) {
        this.flushEphemerals();
      }
    }
  }

  private resolveInternal(token: AnyToken, caller: ContainerImpl): unknown {
    if (!caller.isTokenInScope(token)) {
      throw new KernelErrorImpl(
        'token-out-of-scope',
        `Token "${this.getTokenName(token)}" is out of scope for this container.`,
        token
      );
    }

    const binding = caller.findBindingInternal(token);
    if (binding === undefined) {
      throw new KernelErrorImpl(
        'unbound-token',
        `No binding found for token "${this.getTokenName(token)}".`,
        token
      );
    }

    const storage = binding.storage;
    const pass = this.pass;

    if (storage === STORAGE_EPHEMERAL) {
      const hit = pass.ephemeral.get(token);
      if (hit !== undefined) {
        const transitive = hit.capturedEntries;
        if (transitive !== null) {
          for (let i = 0; i < transitive.length; i++) {
            const target = transitive[i];
            if (target !== undefined && !target.disposed) {
              this.linkActiveCapturer(target);
            }
          }
        }
        return hit.value;
      }
    } else if (storage === STORAGE_SOLID || storage === STORAGE_WEAK) {
      const storeOwner = this.resolveStoreOwner(binding, caller);
      const store =
        storage === STORAGE_SOLID
          ? storeOwner.solidStore
          : storeOwner.weakStore;
      const existing = store.get(token);

      if (existing !== undefined && !existing.disposed) {
        if (storage === STORAGE_SOLID) {
          this.linkActiveCapturer(existing);
          return existing.value;
        }
        const deref =
          existing.weakRef !== null ? existing.weakRef.deref() : undefined;
        if (deref !== undefined) {
          this.linkActiveCapturer(existing);
          return deref;
        }
        this.finalizeDeadWeak(existing);
      }
    }

    const resolving = pass.resolving;
    for (let i = 0; i < resolving.length; i++) {
      if (resolving[i] === token) {
        const cycle: AnyToken[] = [];
        let chain = '';
        for (let j = i; j < resolving.length; j++) {
          const item = resolving[j];
          if (item !== undefined) {
            cycle.push(item);
            chain += (chain.length > 0 ? ' -> ' : '') + this.getTokenName(item);
          }
        }
        cycle.push(token);
        chain += ' -> ' + this.getTokenName(token);
        throw new KernelErrorImpl(
          'capture-cycle',
          `Circular capture dependency detected: ${chain}`,
          token,
          cycle
        );
      }
    }

    const resScope = isProviderRetained(binding) ? binding.owner : caller;

    resolving.push(token);
    let createdEntry: StoredEntry | null = null;
    let ephemeralEntry: EphemeralEntry | null = null;
    let pushedCapturer = false;
    let pushedEphemeral = false;

    try {
      if (storage === STORAGE_SOLID || storage === STORAGE_WEAK) {
        const storeOwner = this.resolveStoreOwner(binding, caller);
        createdEntry = new StoredEntry(storeOwner, binding, storage);
        pass.capturerStack.push(createdEntry);
        pushedCapturer = true;
      } else if (storage === STORAGE_EPHEMERAL) {
        ephemeralEntry = new EphemeralEntry(binding.onDispose);
        pass.ephemeralCollectorStack.push(ephemeralEntry);
        pushedEphemeral = true;
      }

      let instance: unknown;
      const factory = binding.factory;

      if (binding.insecure) {
        instance = factory(resScope.getDynamicResolver());
      } else {
        const caps = binding.captures;
        const capLen = caps.length;
        let capturedValues: readonly unknown[];

        if (capLen === 0) {
          capturedValues = EMPTY_ARRAY;
        } else {
          const arr = new Array<unknown>(capLen);
          for (let i = 0; i < capLen; i++) {
            const capTok = caps[i];
            if (capTok !== undefined) {
              arr[i] = this.resolveInternal(capTok, resScope);
            }
          }
          capturedValues = arr;
        }

        if (pushedCapturer) {
          pass.capturerStack.pop();
          pushedCapturer = false;
        }
        if (pushedEphemeral) {
          pass.ephemeralCollectorStack.pop();
          pushedEphemeral = false;
        }

        const depThunks = resScope.getDepThunks(binding);
        instance = factory(capturedValues, depThunks);
      }

      if (pushedCapturer) {
        pass.capturerStack.pop();
        pushedCapturer = false;
      }
      if (pushedEphemeral) {
        pass.ephemeralCollectorStack.pop();
        pushedEphemeral = false;
      }

      if (ephemeralEntry !== null) {
        ephemeralEntry.value = instance;
        pass.ephemeral.set(token, ephemeralEntry);
        pass.ephemeralOrder.push(ephemeralEntry);
      } else if (createdEntry !== null) {
        if (storage === STORAGE_WEAK) {
          if (
            (typeof instance !== 'object' || instance === null) &&
            typeof instance !== 'function'
          ) {
            throw new KernelErrorImpl(
              'weak-primitive-value',
              `Token "${this.getTokenName(token)}" uses "weak" storage but factory returned a non-object value.`,
              token
            );
          }
          const gcToken = {};
          createdEntry.weakRef = new WeakRef(instance as object);
          createdEntry.gcToken = gcToken;
          createdEntry.container.weakStore.set(token, createdEntry);
          createdEntry.container.appendEntry(createdEntry);
          this.getWeakRegistry().register(
            instance as object,
            createdEntry,
            gcToken
          );
        } else {
          createdEntry.value = instance;
          createdEntry.container.solidStore.set(token, createdEntry);
          createdEntry.container.appendEntry(createdEntry);
        }
        this.linkActiveCapturer(createdEntry);
      }

      return instance;
    } catch (err) {
      if (pushedCapturer) pass.capturerStack.pop();
      if (pushedEphemeral) pass.ephemeralCollectorStack.pop();
      if (createdEntry !== null) {
        this.detachCapturingLinksSilent(createdEntry);
        createdEntry.disposed = true;
      }
      throw err;
    } finally {
      resolving.pop();
    }
  }

  private getDepThunks(
    binding: InternalBinding
  ): readonly ((this: void) => unknown)[] {
    const deps = binding.deps;
    const len = deps.length;
    if (len === 0) return EMPTY_THUNKS;

    if (this === binding.owner && binding.ownerDepThunks !== null) {
      return binding.ownerDepThunks;
    }

    const thunks = new Array<(this: void) => unknown>(len);
    for (let i = 0; i < len; i++) {
      const depTok = deps[i];
      if (depTok !== undefined) {
        thunks[i] = this.getCachedThunk(depTok);
      }
    }

    if (this === binding.owner) {
      binding.ownerDepThunks = thunks;
    }
    return thunks;
  }

  private getCachedThunk(token: AnyToken): (this: void) => unknown {
    let fn = this.thunkCache.get(token);
    if (fn === undefined) {
      fn = createDetachedThunk(this, token);
      this.thunkCache.set(token, fn);
    }
    return fn;
  }

  private getDynamicResolver(): Resolver {
    let r = this.cachedResolver;
    if (r === null) {
      r = createDynamicResolver(this);
      this.cachedResolver = r;
    }
    return r;
  }

  private getWeakRegistry(): FinalizationRegistry<StoredEntry> {
    let reg = this.root.weakRegistry;
    if (reg === null) {
      reg = new FinalizationRegistry<StoredEntry>(finalizeWeakEntry);
      this.root.weakRegistry = reg;
    }
    return reg;
  }

  private linkActiveCapturer(target: StoredEntry): void {
    const pass = this.pass;

    const capLen = pass.capturerStack.length;
    if (capLen > pass.capturerBase) {
      const capturer = pass.capturerStack[capLen - 1];
      if (capturer !== undefined && capturer !== target) {
        let capSet = capturer.capturing;
        if (capSet === null) {
          capSet = new Set<StoredEntry>();
          capturer.capturing = capSet;
        }
        capSet.add(target);

        let bySet = target.capturedBy;
        if (bySet === null) {
          bySet = new Set<StoredEntry>();
          target.capturedBy = bySet;
        }
        bySet.add(capturer);
      }
    }

    const ephLen = pass.ephemeralCollectorStack.length;
    if (ephLen > pass.ephemeralBase) {
      for (let i = pass.ephemeralBase; i < ephLen; i++) {
        const eph = pass.ephemeralCollectorStack[i];
        if (eph !== undefined) {
          let list = eph.capturedEntries;
          if (list === null) {
            list = [target];
            eph.capturedEntries = list;
          } else if (list.indexOf(target) === -1) {
            list.push(target);
          }
        }
      }
    }
  }

  private resolveStoreOwner(
    binding: InternalBinding,
    caller: ContainerImpl
  ): ContainerImpl {
    const owner = binding.target === TARGET_CALLER ? caller : binding.owner;
    if (!owner.allowsStorage(binding.storage)) {
      throw new KernelErrorImpl(
        'disallowed-storage',
        `Token "${this.getTokenName(binding.token)}" targets "${
          binding.target === TARGET_CALLER ? 'caller' : 'provider'
        }" with storage "${storageName(binding.storage)}", which is disallowed on that container.`,
        binding.token
      );
    }
    return owner;
  }

  private flushEphemerals(): void {
    const order = this.pass.ephemeralOrder;
    if (order.length === 0) return;
    this.pass.ephemeral.clear();
    while (order.length > 0) {
      const entry = order.pop();
      if (entry !== undefined) {
        entry.capturedEntries = null;
        const onDispose = entry.onDispose;
        if (onDispose !== undefined) {
          onDispose(entry.value);
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // Intrusive Doubly-Linked List Operations (O(1) LIFO Lifecycle)
  // --------------------------------------------------------------------------

  private appendEntry(entry: StoredEntry): void {
    const tail = this.tailEntry;
    if (tail === null) {
      this.headEntry = entry;
      this.tailEntry = entry;
    } else {
      tail.nextInContainer = entry;
      entry.prevInContainer = tail;
      this.tailEntry = entry;
    }
    entry.inContainerList = true;
  }

  private unlinkEntry(entry: StoredEntry): void {
    if (!entry.inContainerList) return;
    const prev = entry.prevInContainer;
    const next = entry.nextInContainer;

    if (prev !== null) prev.nextInContainer = next;
    else this.headEntry = next;

    if (next !== null) next.prevInContainer = prev;
    else this.tailEntry = prev;

    entry.prevInContainer = null;
    entry.nextInContainer = null;
    entry.inContainerList = false;
  }

  // --------------------------------------------------------------------------
  // Eviction, Reverse Cascade & Weak GC Reclamation
  // --------------------------------------------------------------------------

  private evictFromContainer(storeOwner: ContainerImpl, token: AnyToken): void {
    const entry =
      storeOwner.solidStore.get(token) ?? storeOwner.weakStore.get(token);
    if (entry !== undefined && !entry.disposed) {
      this.evictEntry(entry);
    }
  }

  private evictEntry(entry: StoredEntry): void {
    if (entry.disposed) return;

    const storeOwner = entry.container;
    const token = entry.binding.token;
    const capturedBy = entry.capturedBy;

    if (capturedBy !== null && capturedBy.size > 0) {
      const policy = storeOwner.onEvictCaptured;
      if (policy === EVICT_BLOCK) {
        const related: AnyToken[] = [];
        let names = '';
        for (const c of capturedBy) {
          related.push(c.binding.token);
          names +=
            (names.length > 0 ? ', ' : '') + this.getTokenName(c.binding.token);
        }
        throw new KernelErrorImpl(
          'eviction-blocked',
          `Blocked eviction of "${this.getTokenName(token)}": still captured by [${names}].`,
          token,
          related
        );
      }
      if (policy === EVICT_CASCADE) {
        for (const capturer of capturedBy) {
          if (!capturer.disposed) {
            this.evictEntry(capturer);
          }
          capturedBy.delete(capturer);
        }
      } else {
        for (const capturer of capturedBy) {
          if (capturer.capturing !== null) {
            capturer.capturing.delete(entry);
          }
        }
        capturedBy.clear();
      }
    }

    if (entry.disposed) return;
    entry.disposed = true;
    storeOwner.unlinkEntry(entry);

    let instance: unknown;
    if (entry.storage === STORAGE_SOLID) {
      instance = entry.value;
      entry.value = undefined;
      storeOwner.solidStore.delete(token);
    } else {
      instance = entry.weakRef !== null ? entry.weakRef.deref() : undefined;
      entry.weakRef = null;
      if (entry.gcToken !== null && this.root.weakRegistry !== null) {
        this.root.weakRegistry.unregister(entry.gcToken);
      }
      entry.gcToken = null;
      storeOwner.weakStore.delete(token);
    }

    this.detachCapturingAndNotify(entry);

    const onDispose = entry.binding.onDispose;
    if (onDispose !== undefined) {
      onDispose(instance);
    }
  }

  /** @internal */
  finalizeDeadWeak(entry: StoredEntry): void {
    if (entry.disposed) return;
    entry.disposed = true;
    entry.container.unlinkEntry(entry);

    const current = entry.container.weakStore.get(entry.binding.token);
    if (current === entry) {
      entry.container.weakStore.delete(entry.binding.token);
    }
    if (entry.gcToken !== null && this.root.weakRegistry !== null) {
      this.root.weakRegistry.unregister(entry.gcToken);
    }
    entry.gcToken = null;
    entry.weakRef = null;

    this.detachCapturingAndNotify(entry);

    const onDispose = entry.binding.onDispose;
    if (onDispose !== undefined) {
      onDispose(undefined);
    }
  }

  private detachCapturingLinksSilent(entry: StoredEntry): void {
    const capturing = entry.capturing;
    if (capturing === null || capturing.size === 0) return;
    for (const target of capturing) {
      if (target.capturedBy !== null) {
        target.capturedBy.delete(entry);
      }
    }
    capturing.clear();
  }

  private detachCapturingAndNotify(entry: StoredEntry): void {
    const capturing = entry.capturing;
    if (capturing === null || capturing.size === 0) return;
    try {
      for (const target of capturing) {
        capturing.delete(target);
        const bySet = target.capturedBy;
        if (bySet !== null && bySet.delete(entry) && !target.disposed) {
          const onDecapture = target.binding.onDecapture;
          if (onDecapture !== undefined) {
            const targetInst =
              target.storage === STORAGE_SOLID
                ? target.value
                : target.weakRef !== null
                  ? target.weakRef.deref()
                  : undefined;
            onDecapture(targetInst, bySet.size);
          }
        }
      }
    } finally {
      if (capturing.size > 0) {
        this.detachCapturingLinksSilent(entry);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Static Verification (`verify`)
  // --------------------------------------------------------------------------

  verify(policy?: PolicyRule | undefined): VerificationReport {
    this.assertAlive();
    const effective = this.collectEffectiveBindings();
    const structuralErrors: StructuralError[] = [];

    for (const [token, b] of effective) {
      if (
        (b.storage === STORAGE_SOLID || b.storage === STORAGE_WEAK) &&
        b.target === TARGET_CALLER &&
        !this.allowsStorage(b.storage)
      ) {
        structuralErrors.push({
          kind: 'disallowed-caller-store',
          token,
          storage: b.storage === STORAGE_SOLID ? 'solid' : 'weak',
        });
      }

      const resScope: StorageTarget = isProviderRetained(b)
        ? 'provider'
        : 'caller';

      const caps = b.captures;
      for (let i = 0; i < caps.length; i++) {
        const depTok = caps[i];
        if (
          depTok !== undefined &&
          resolveStaticEdge(b, depTok, effective) === undefined
        ) {
          structuralErrors.push({
            kind: 'unbound-dependency',
            dependent: token,
            missing: depTok,
            edge: 'capture',
            resolutionScope: resScope,
          });
        }
      }

      const deps = b.deps;
      for (let i = 0; i < deps.length; i++) {
        const depTok = deps[i];
        if (
          depTok !== undefined &&
          resolveStaticEdge(b, depTok, effective) === undefined
        ) {
          structuralErrors.push({
            kind: 'unbound-dependency',
            dependent: token,
            missing: depTok,
            edge: 'dep',
            resolutionScope: resScope,
          });
        }
      }
    }

    const capColor = new Map<InternalBinding, 0 | 1 | 2>();
    const capStack: InternalBinding[] = [];
    const cycleBindings = new Set<InternalBinding>();

    for (const b of effective.values()) {
      if ((capColor.get(b) ?? 0) === 0) {
        dfsCaptureCycles(
          b,
          effective,
          capColor,
          capStack,
          cycleBindings,
          structuralErrors
        );
      }
    }

    const thunkCycleBindings = new Set<InternalBinding>();
    const allColor = new Map<InternalBinding, 0 | 1 | 2>();
    const allStack: ThunkStackFrame[] = [];

    for (const b of effective.values()) {
      if ((allColor.get(b) ?? 0) === 0) {
        dfsThunkCycles(
          b,
          false,
          effective,
          allColor,
          allStack,
          thunkCycleBindings
        );
      }
    }

    const captureMemo = new Map<
      InternalBinding,
      Map<AnyToken, MutableFoldFact>
    >();
    const folded = new Map<AnyToken, Map<AnyToken, FoldedTokenFact>>();
    const violations: PolicyViolation[] = [];
    let hasDeny = false;

    for (const [tok, b] of effective) {
      const nodeFacts = new Map<AnyToken, FoldedTokenFact>();

      let rawSelf = computeSelfMask(b);
      if (thunkCycleBindings.has(b)) rawSelf |= TAINT_BITS['thunk-cycle'];
      const selfReq = getDischargeMask(b, tok);
      const selfDischarged = rawSelf & selfReq;
      const selfActive = rawSelf & ~selfDischarged;

      if (selfActive !== 0 || selfDischarged !== 0) {
        nodeFacts.set(
          tok,
          new FoldedTokenFactImpl(tok, 'self', false, selfActive, selfDischarged)
        );
      }

      const sub = foldNodeCaptures(b, effective, cycleBindings, captureMemo);
      for (const [originTok, mutFact] of sub) {
        nodeFacts.set(
          originTok,
          new FoldedTokenFactImpl(
            mutFact.origin,
            mutFact.direct ? 'direct' : 'transitive',
            mutFact.diamond,
            mutFact.mask,
            mutFact.dischargedMask
          )
        );
      }

      folded.set(tok, nodeFacts);

      if (policy !== undefined) {
        for (const [originTok, fact] of nodeFacts) {
          if (fact.mask === 0 && fact.dischargedMask === 0 && !fact.diamond) {
            continue;
          }
          const action: PolicyAction = policy(tok, fact);
          if (action === 'deny') {
            hasDeny = true;
            violations.push({ dependent: tok, origin: originTok, fact, action });
          } else if (action === 'warn') {
            violations.push({ dependent: tok, origin: originTok, fact, action });
          }
        }
      }
    }

    return {
      ok: structuralErrors.length === 0 && !hasDeny,
      structuralErrors,
      folded,
      violations,
    };
  }

  // --------------------------------------------------------------------------
  // Validation, Hierarchy & Scoping Helpers
  // --------------------------------------------------------------------------

  private validateEdges(
    ownerToken: AnyToken,
    captures: readonly AnyToken[],
    deps: readonly AnyToken[],
    discharges: readonly TaintDischarge[]
  ): void {
    for (let i = 0; i < discharges.length; i++) {
      const d = discharges[i];
      if (d !== undefined) this.assertTokenInScope(d[0]);
    }

    const capLen = captures.length;
    const depLen = deps.length;
    if (capLen === 0 && depLen === 0) return;

    if (capLen <= 4 && depLen <= 4) {
      for (let i = 0; i < capLen; i++) {
        const c = captures[i];
        if (c === undefined) continue;
        this.assertTokenInScope(c);
        for (let j = 0; j < i; j++) {
          if (captures[j] === c) {
            throw new KernelErrorImpl(
              'duplicate-capture',
              `Duplicate token "${this.getTokenName(c)}" in captures of "${this.getTokenName(ownerToken)}".`,
              ownerToken,
              [c]
            );
          }
        }
      }
      for (let i = 0; i < depLen; i++) {
        const d = deps[i];
        if (d === undefined) continue;
        this.assertTokenInScope(d);
        for (let j = 0; j < capLen; j++) {
          if (captures[j] === d) {
            throw new KernelErrorImpl(
              'overlapping-capture-and-dep',
              `Token "${this.getTokenName(d)}" cannot appear in both captures and deps of "${this.getTokenName(ownerToken)}".`,
              ownerToken,
              [d]
            );
          }
        }
        for (let j = 0; j < i; j++) {
          if (deps[j] === d) {
            throw new KernelErrorImpl(
              'duplicate-dep',
              `Duplicate token "${this.getTokenName(d)}" in deps of "${this.getTokenName(ownerToken)}".`,
              ownerToken,
              [d]
            );
          }
        }
      }
      return;
    }

    const capSet = new Set<AnyToken>();
    for (let i = 0; i < capLen; i++) {
      const c = captures[i];
      if (c === undefined) continue;
      this.assertTokenInScope(c);
      if (capSet.has(c)) {
        throw new KernelErrorImpl(
          'duplicate-capture',
          `Duplicate token "${this.getTokenName(c)}" in captures of "${this.getTokenName(ownerToken)}".`,
          ownerToken,
          [c]
        );
      }
      capSet.add(c);
    }

    const depSet = new Set<AnyToken>();
    for (let i = 0; i < depLen; i++) {
      const d = deps[i];
      if (d === undefined) continue;
      this.assertTokenInScope(d);
      if (capSet.has(d)) {
        throw new KernelErrorImpl(
          'overlapping-capture-and-dep',
          `Token "${this.getTokenName(d)}" cannot appear in both captures and deps of "${this.getTokenName(ownerToken)}".`,
          ownerToken,
          [d]
        );
      }
      if (depSet.has(d)) {
        throw new KernelErrorImpl(
          'duplicate-dep',
          `Duplicate token "${this.getTokenName(d)}" in deps of "${this.getTokenName(ownerToken)}".`,
          ownerToken,
          [d]
        );
      }
      depSet.add(d);
    }
  }

  private isTokenInScope(token: AnyToken): boolean {
    const owner = this.tokens.owners[token];
    if (owner === undefined) return false;
    if (owner === this || owner === this.root) return true;
    if (owner.depth >= this.depth) return false;
    let cur: ContainerImpl | null = this.parent;
    while (cur !== null && cur.depth > owner.depth) {
      cur = cur.parent;
    }
    return cur === owner;
  }

  private assertTokenInScope(token: AnyToken): void {
    if (!this.isTokenInScope(token)) {
      throw new KernelErrorImpl(
        'token-out-of-scope',
        `Token "${this.getTokenName(token)}" does not belong to this container or its ancestors.`,
        token
      );
    }
  }

  private allowsStorage(code: StorageCode): boolean {
    if (code === STORAGE_SOLID) {
      return (this.allowedMask & ALLOWED_SOLID_BIT) !== 0;
    }
    if (code === STORAGE_WEAK) {
      return (this.allowedMask & ALLOWED_WEAK_BIT) !== 0;
    }
    return true;
  }

  private collectEffectiveBindings(): Map<AnyToken, InternalBinding> {
    const chain: ContainerImpl[] = [];
    let cur: ContainerImpl | null = this;
    while (cur !== null) {
      chain.push(cur);
      cur = cur.parent;
    }
    const merged = new Map<AnyToken, InternalBinding>();
    for (let i = chain.length - 1; i >= 0; i--) {
      const container = chain[i];
      if (container !== undefined) {
        for (const [tok, b] of container.bindings) {
          merged.set(tok, b);
        }
      }
    }
    return merged;
  }

  /** @internal */
  findBindingInternal(token: AnyToken): InternalBinding | undefined {
    let cur: ContainerImpl | null = this;
    while (cur !== null) {
      const found = cur.bindings.get(token);
      if (found !== undefined) return found;
      cur = cur.parent;
    }
    return undefined;
  }

  private assertAlive(): void {
    if (this._disposed || this._disposing) {
      throw new KernelErrorImpl(
        'container-disposed',
        'Container has been disposed.'
      );
    }
  }
}

const DISPOSE_SYMBOL: symbol =
  typeof Symbol.dispose === 'symbol'
    ? Symbol.dispose
    : Symbol.for('Symbol.dispose');

Object.defineProperty(ContainerImpl.prototype, DISPOSE_SYMBOL, {
  value: ContainerImpl.prototype.dispose,
  configurable: true,
  writable: true,
});

export function createContainer(options: CreateOptions): Container {
  return new ContainerImpl(options, null);
}

