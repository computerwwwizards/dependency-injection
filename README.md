# Dependency Assembler & Presets

A synchronous, statically verified dependency assembler for TypeScript 6+.

- **Zero magic:** No decorators, no `reflect-metadata`, no global registries, no build plugins.
- **Plain TypeScript:** Register classes, functions, values, async initializers, or manual factories directly.
- **Catch lifecycle bugs at boot:** Static lattice verification detects captive scopes, split-state diamonds, purity leaks, and cycles *before a single service is instantiated*.
- **Stay synchronous, stay async-friendly:** Lift any async initializer (or even a synchronous class) into a promisified virtual proxy (`Promisified<T>`) while keeping the container 100% synchronous.
- **Zero lock-in:** `Assembler` extends the core `Container` directly—same integer tokens, same stores, drop down to raw plumbing or wrap an existing container at any time.

> This guide covers the ergonomic **Assembler & Presets** layer (`@computerwwwizards/dependency-injection/presets`). Documentation for the lower-level core kernel is published separately.

---

## Requirements

- **TypeScript:** `>= 6.0.3` (`strict: true`, `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`, `erasableSyntaxOnly: true`, `lib: ["es2025", "esnext.disposable"]`)
- **Runtime:** Any modern JS engine with `WeakRef`, `FinalizationRegistry`, `Proxy`, and `Symbol.dispose` (Node 22+, Bun, Deno, modern browsers)

```bash
npm install @computerwwwizards/dependency-injection
```

---

## 1. Quick Start (60 Seconds)

Every app follows the same four steps: **create an assembler → mint tokens → register bindings → verify & use**.

```ts
import {
  POLICIES,
  createAssembler,
  pure,
  transient,
} from '@computerwwwizards/dependency-injection/presets';

// 1. Write normal TypeScript — zero decorators or framework imports
class Logger {
  private readonly prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  format(message: string): string {
    return `${this.prefix} ${message}`;
  }
}

class Greeter {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  greet(name: string): string {
    return this.logger.format(`Hello, ${name}!`);
  }
}

// 2. Create an assembler (`using` disposes all retained instances on block exit)
using app = createAssembler();

// 3. Mint typed tokens (plain SMI integers at runtime, scoped to `app` and its children)
const Prefix = app.createToken<string>('Prefix');
const LoggerTok = app.createToken<Logger>('Logger');
const GreeterTok = app.createToken<Greeter>('Greeter');
const Banner = app.createToken<string>('Banner');

// 4. Register values, classes, and functions
app.registerValue(Prefix, '[APP]');
app.registerClass(LoggerTok, Logger, pure({ inject: [Prefix] }));
app.registerClass(GreeterTok, Greeter, pure({ inject: [LoggerTok] }));
app.registerFn(
  Banner,
  transient({ inject: [GreeterTok] }),
  (greeter) => `*** ${greeter.greet('World')} ***`
);

// 5. Verify the entire graph once at boot (pure static analysis — runs 0 factories)
app.assertVerified(POLICIES.strict);

// 6. Resolve synchronously
console.log(app.get(Banner));
// Output: *** [APP] Hello, World! ***
```

Notice what TypeScript checked for you here:
- `Logger`'s constructor expects `(prefix: string)`. Passing a `Token<number>` inside `inject: [...]` is a **compile-time error**.
- Passing too many or too few tokens in `inject: [...]` is a **compile-time error**.
- Passing a token from a sibling scope or forgetting to register `Prefix` is caught immediately by `app.assertVerified()`.

---

## 2. The Mental Model (Everything Fits in Your Head)

Before diving into lifetimes and proxies, keep three rules in mind:

### Rule 1: Tokens belong to a container hierarchy
There is no global token registry. Calling `app.createToken<T>('Name')` mints an integer token owned by `app`.
- Every child scope created from `app` **inherits** `app`'s tokens.
- A token minted inside a child scope is **private** to that child (and its descendants). Parents and sibling scopes cannot read, bind, or evict it.

### Rule 2: Every dependency edge is either a **Capture** or a **Lazy Firewall**

```text
  CAPTURE (default: bare Token)
  ServiceA ──────[eager value]──────▶ ServiceB
  - Resolved before ServiceA is constructed
  - Tracked statically (taints & diamonds)
  - Tracked at runtime (evicting ServiceB cascades into ServiceA)

  LAZY FIREWALL (viaThunk / viaLive / viaAsync)
  ServiceA - - - [lazy lookup] - - -▶ ServiceB
  - Resolved on demand when called
  - Breaks cycles and STOPS taint propagation (captive scopes, rebindable, insecure)
  - Evicting or rebinding ServiceB does NOT evict ServiceA
```

### Rule 3: `assertVerified()` proves graph safety without running your code
Calling `app.assertVerified(POLICIES.strict)` inspects every binding's lifetime, purity (`stateless` vs `stateful`), mutability (`rebindable`), and capture graph **without invoking a single constructor or factory**. If something is structurally broken or violates policy, it fails fast at startup with an exact edge-by-edge report.

---

## 3. Lifetime Presets

Presets are plain, zero-lock-in option objects. They work identically in `registerClass`, `registerFn`, `asClass`, `asFn`, and raw `bind`.

| Preset | Storage | Owner | Default Purity | Lifetime & Best Use |
|---|---|---|---|---|
| `singleton()` | `solid` | Provider (root) | `stateful` | Shared stateful infrastructure (DB pools, clients, queues) |
| `pure()` | `solid` | Provider (root) | `stateless` | Functional-core services, formatters, validators, immutable helpers |
| `scoped()` | `solid` | Caller (child) | `stateful` | Per-request / per-job services; bound once on root, stored per child scope |
| `transient()` | `none` | Never stored | `stateless` | Fresh instance on every `get()`; lightweight factories & snapshots |
| `ephemeral()` | `ephemeral` | Active `get()` pass | `stateful` | Shared across a diamond inside ONE `get()` call, then disposed before `get()` returns |
| `weak()` | `weak` | Provider | `stateless` | GC-managed cache for stateless objects/functions (primitives rejected at compile time) |
| `memo(tok)` | `weak` | Provider | `stateful` | Escape-hatch preset for intentional stateful weak caches (discharges `volatile-state`) |

Every preset accepts **three call shapes** (zero object-spread syntax needed):
- `pure()` — no arguments (returns a frozen zero-allocation default).
- `pure({ inject: [TokA, TokB], onDispose })` — positional injection for `registerClass` / `registerFn`.
- `pure({ captures: [TokA], deps: [TokB], onDispose })` — direct options for manual `bind` / `registerFactory`.

### Per-Request Scopes (`scoped()` + `createRequestScope`)

Bind `scoped()` services **once** on the root assembler. Each child scope gets its own isolated instance and automatically disposes it on block exit via `using`:

```ts
import {
  POLICIES,
  createAssembler,
  scoped,
  singleton,
} from '@computerwwwizards/dependency-injection/presets';

using app = createAssembler();

const DbPool = app.createToken<{ query(sql: string): string }>('DbPool');
const ReqId = app.createToken<string>('RequestId');
const UserRepo = app.createToken<{ findCurrent(): string }>('UserRepo');

// Shared on root; `onDecapture` fires whenever a request scope releases it
app.bind(
  DbPool,
  singleton({
    onDecapture: (_pool, remaining) => {
      console.log(`DbPool active capturers: ${remaining}`);
    },
    onDispose: () => console.log('DbPool closed'),
  }),
  () => ({ query: (sql) => `SQL<${sql}>` })
);

// Bound ONCE on root, instantiated INSIDE each request scope (`target: 'caller'`)
app.registerFn(
  UserRepo,
  scoped({
    inject: [DbPool, ReqId],
    onDispose: () => console.log('UserRepo disposed'),
  }),
  (db, reqId) => ({
    findCurrent: () => `[${reqId}] ${db.query('SELECT * FROM users')}`,
  })
);

// Request #1
{
  using req1 = app.createRequestScope();
  req1.registerValue(ReqId, 'REQ-001');
  req1.assertVerified(POLICIES.strict);

  console.log(req1.get(UserRepo).findCurrent());
}
// Console output when `req1` exits the block:
//   [REQ-001] SQL<SELECT * FROM users>
//   UserRepo disposed
//   DbPool active capturers: 0
//
// DbPool stays warm on `app` for Request #2, and closes only when `app` exits.
```

### Pass-Scoped Diamonds (`ephemeral()`)

When a single operation fans out into a diamond and both branches need the **same** short-lived object (like a `UnitOfWork` or correlation buffer) without turning it into a singleton or creating a child scope, use `ephemeral()`:

```ts
import {
  POLICIES,
  createAssembler,
  ephemeral,
} from '@computerwwwizards/dependency-injection/presets';

class UnitOfWork {
  readonly id: number;
  readonly ops: string[] = [];

  constructor(id: number) {
    this.id = id;
  }
}

using app = createAssembler();
let nextId = 1;

const UoW = app.createToken<UnitOfWork>('UnitOfWork');
const WriteOrder = app.createToken<void>('WriteOrder');
const WriteAudit = app.createToken<void>('WriteAudit');
const Checkout = app.createToken<{ id: number; ops: readonly string[] }>('Checkout');

app.bind(
  UoW,
  ephemeral({
    onDispose: (uow) => console.log(`Flushed UoW#${uow.id}:`, uow.ops),
  }),
  () => new UnitOfWork(nextId++)
);

app.registerFn(WriteOrder, ephemeral({ inject: [UoW] }), (uow) => {
  uow.ops.push('order');
});
app.registerFn(WriteAudit, ephemeral({ inject: [UoW] }), (uow) => {
  uow.ops.push('audit');
});
app.registerFn(
  Checkout,
  ephemeral({ inject: [UoW, WriteOrder, WriteAudit] }),
  (uow) => ({ id: uow.id, ops: [...uow.ops] })
);

app.assertVerified(POLICIES.strict);

const pass1 = app.get(Checkout); // UoW#1 shared by WriteOrder + WriteAudit, then flushed
const pass2 = app.get(Checkout); // Brand new UoW#2, flushed before get() returns
// Output:
//   Flushed UoW#1: [ 'order', 'audit' ]
//   Flushed UoW#2: [ 'order', 'audit' ]
```

---

## 4. Four Ways to Register Anything

Mix and match styles freely in the same container—they all compile down to the exact same kernel binding:

```ts
// 1. Constant immutable value (`solid` + `stateless`)
app.registerValue(Port, 8080);

// 2. Direct TypeScript class (positional `inject` checked against constructor)
app.registerClass(ServerTok, HttpServer, singleton({ inject: [Port, LoggerTok] }));

// 3. Plain function (positional `inject`, zero tuple unpacking)
app.registerFn(UrlTok, pure({ inject: [Port] }), (port) => `http://localhost:${port}`);

// 4. Manual factory via `registerFactory` or raw kernel `bind` (full `(captured, deps)` tuples)
app.bind(
  HealthTok,
  pure({ captures: [UrlTok], deps: [ServerTok] }),
  ([url], [getServer]) => ({
    ping: () => `${url} -> alive=${getServer().isListening}`,
  })
);
```

---

## 5. Catching Bugs Before Production (Static Lattice Verification)

Traditional DI containers happily boot broken graphs and let them explode in production (e.g., leaking User A's request session into a global singleton, or silently giving two repositories two *different* database transactions).

Here is what happens when you wire four classic bugs and call `app.verify(POLICIES.strict)`:

```ts
using app = createAssembler();

const ScopedSession = app.createToken<{ user: string }>('ScopedSession');
const PassCursor = app.createToken<{ step: number }>('PassCursor');
const StatefulTx = app.createToken<{ id: number }>('StatefulTx');
const RepoA = app.createToken<{ tx: { id: number } }>('RepoA');
const RepoB = app.createToken<{ tx: { id: number } }>('RepoB');
const Counter = app.createToken<{ count: number }>('Counter');

const BuggySingleton = app.createToken<unknown>('BuggySingleton');
const BuggyDiamond = app.createToken<unknown>('BuggyDiamond');
const LyingPure = app.createToken<unknown>('LyingPure');

app.bind(ScopedSession, scoped(), () => ({ user: 'alice' }));
app.bind(PassCursor, ephemeral(), () => ({ step: 0 }));
app.bind(StatefulTx, transient({ state: 'stateful' }), () => ({ id: 1 }));
app.bind(Counter, singleton(), () => ({ count: 0 }));

app.bind(RepoA, singleton({ captures: [StatefulTx] }), ([tx]) => ({ tx }));
app.bind(RepoB, singleton({ captures: [StatefulTx] }), ([tx]) => ({ tx }));

// Trap 1 & 2: Singleton capturing a `scoped` service AND an `ephemeral` service
app.bind(
  BuggySingleton,
  singleton({ captures: [ScopedSession, PassCursor] }),
  ([session, cursor]) => ({ session, cursor })
);

// Trap 3: Diamond over a stateful transient (RepoA & RepoB get DIFFERENT instances!)
app.bind(BuggyDiamond, singleton({ captures: [RepoA, RepoB] }), ([a, b]) => ({ a, b }));

// Trap 4: Claims `pure()` (`stateless`), but captures a `stateful` counter
app.bind(LyingPure, pure({ captures: [Counter] }), ([c]) => ({ c }));

app.assertVerified(POLICIES.strict);
```

`assertVerified()` throws a `VerificationError` before any factory runs:

```text
VerificationError: Verification failed:
  [WARN] RepoA -> StatefulTx (direct): [frozen-none]
  [WARN] RepoB -> StatefulTx (direct): [frozen-none]
  [DENY] BuggySingleton -> ScopedSession (direct): [eviction-coupled, captive-caller]
  [DENY] BuggySingleton -> PassCursor (direct): [captive-ephemeral]
  [DENY] BuggyDiamond -> StatefulTx (transitive): [frozen-none, split-state-diamond] [DIAMOND]
  [DENY] LyingPure -> Counter (direct): [eviction-coupled, state-leak]
```

### Built-In Policies

All built-in policies compile down to $O(1)$ bitmask operations:

| Policy | Behavior |
|---|---|
| `POLICIES.strict` | **Recommended default.** Denies lifetime/scope traps (`captive-caller`, `captive-ephemeral`, `escaped-ephemeral`), GC bugs (`weak-pinned`, `volatile-state`), `split-state-diamond`, `pinned-mutable`, `state-leak`, `thunk-cycle`, and `insecure`. Warns on undischarged `frozen-none`. Allows `eviction-coupled` and `shared-diamond`. |
| `POLICIES.balanced` | **Legacy migration.** Denies hard runtime traps; downgrades `state-leak`, `thunk-cycle`, `insecure`, and `frozen-none` to warnings. |
| `POLICIES.paranoid` | **Maximum decoupling.** Denies everything except `shared-diamond` — including `eviction-coupled` (forces lazy thunks/proxies across all retained boundaries). |
| `POLICIES.zeroEscapes` | **Security / architecture audit.** Everything in `strict`, **plus** denies any binding that used a local escape-hatch discharge. |

You can also compose custom rules with `createTagPolicy`, `createMaskPolicy`, `composePolicies`, `withExceptions`, `onlyDirectCauses`, and `forbidDischarges`.

---

## 6. Virtual Proxies: Hot Swapping & Async Without an Async Container

Using bare tokens in `inject: [A, B]` eagerly captures them. When you need lazy indirection, wrap the token in a `via*` adapter:

| Adapter | Injected Type | Kernel Edge | Solves |
|---|---|---|---|
| `Tok` (bare) | `T` | `captures` | Normal eager dependency |
| `viaThunk(Tok)` | `() => T` | `deps` | Explicit lazy call, zero Proxy overhead, breaks cycles & taints |
| `viaLive(Tok)` | `T` | `deps` | Sync Virtual Proxy: hot-swapping `rebindable` deps, `scoped` inside `singleton`, mutual cycles — with zero `() =>` noise |
| `viaAsync(Tok)` | `Promisified<Awaited<T>>` | `deps` | Async Virtual Proxy: lifts **both** `Token<Promise<T>>` **and** synchronous `Token<T>` into uniform async methods |
| `viaSnapshot(Tok)` | `T` | `captures` | Local escape hatch: intentionally freezes a `transient`, discharges `frozen-none` |
| `viaEscape(Tok, mask)` | `T` | `captures` | General local escape hatch: discharges an explicit `TAINT_BITS` mask |

### How `viaAsync` + `viaLive` Work Together

The core container stays **100% synchronous**. Async resources (like a DB connection handshake or a lazy `import()`) are registered with `registerAsync`, which stores a single cached `Promise<T>` in the synchronous container. Dependents inject `viaAsync(Db)` and call `await this.db.query(...)` directly.

Even better: you can wrap a **purely synchronous** class (like `SyncHasher`) in `viaAsync(Hasher)` too—useful when your domain interface is async (e.g., future-proofing for a Web Worker, WASM module, or remote RPC).

```text
  RegistrationService
     │
     ├── viaAsync(Db)     ──▶ Promisified<Database>    ──▶ awaits cached Promise<Database>
     ├── viaAsync(Hasher) ──▶ Promisified<SyncHasher>  ──▶ lifts sync .hash() to Promise<string>
     └── viaLive(Clock)   ──▶ ClockService (Proxy)     ──▶ resolves latest Clock on every .now()
```

```ts
import {
  POLICIES,
  createAssembler,
  pure,
  singleton,
  viaAsync,
  viaLive,
} from '@computerwwwizards/dependency-injection/presets';
import type { Promisified } from '@computerwwwizards/dependency-injection/presets';

interface Clock {
  now(): number;
}
class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}
class FixedClock implements Clock {
  now(): number {
    return 1_700_000_000_000;
  }
}

// 100% synchronous class
class SyncHasher {
  hash(input: string): string {
    return `sha256:${input.length}`;
  }
}

// Async-initialized resource
class Database {
  private readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  query(sql: string): string {
    return `[${this.url}] ${sql}`;
  }
  close(): void {
    console.log('Database closed');
  }
}

class RegistrationService {
  private readonly db: Promisified<Database>;
  private readonly hasher: Promisified<SyncHasher>;
  private readonly clock: Clock;

  constructor(
    db: Promisified<Database>,
    hasher: Promisified<SyncHasher>,
    clock: Clock
  ) {
    this.db = db;
    this.hasher = hasher;
    this.clock = clock;
  }

  async register(user: string): Promise<string> {
    const digest = await this.hasher.hash(user);
    const row = await this.db.query(`INSERT ${user} (${digest})`);
    return `@${this.clock.now()} -> ${row}`;
  }
}

using app = createAssembler();
const ClockTok = app.createToken<Clock>('Clock');
const HasherTok = app.createToken<SyncHasher>('Hasher');
const DbTok = app.createToken<Promise<Database>>('Database');
const RegTok = app.createToken<RegistrationService>('RegistrationService');

// `rebindable: true` returns a typed provider-only rebinder
const rebindClock = app.registerClass(
  ClockTok,
  SystemClock,
  singleton({ rebindable: true })
);

app.registerClass(HasherTok, SyncHasher, pure());

// `onDispose` automatically awaits the cached promise and passes the resolved `Database`
app.registerAsync(DbTok, { onDispose: (db) => db.close() }, async () => {
  await Promise.resolve(); // async connect or dynamic `import()`
  return new Database('postgres://primary');
});

// `viaLive(ClockTok)` prevents `pinned-mutable` while keeping the exact `Clock` interface
app.registerClass(
  RegTok,
  RegistrationService,
  singleton({ inject: [viaAsync(DbTok), viaAsync(HasherTok), viaLive(ClockTok)] })
);

app.assertVerified(POLICIES.strict);

const reg = app.get(RegTok);
console.log(await reg.register('piero'));
// Output: @1764002580123 -> [postgres://primary] INSERT piero (sha256:5)

// Hot-swap Clock in tests — `reg` is NOT evicted and immediately sees FixedClock
rebindClock(FixedClock);
console.log(await reg.register('piero'));
// Output: @1700000000000 -> [postgres://primary] INSERT piero (sha256:5)
```

> **Note for manual factories:** The exact same proxies are available standalone as `toLiveProxy(thunk)` and `toAsyncProxy(thunk)` when using raw `app.bind()`.

---

## 7. Local Escape Hatches (Not Global Policy Rot)

When `POLICIES.strict` warns you about a pattern you **genuinely want**—like snapping a transient `StartupConfig` once at boot (`frozen-none`) or keeping a stateful GC-evictable memo cache (`volatile-state`)—**do not weaken your global policy**. Turning off `frozen-none` globally would hide every *accidental* transient capture in the entire codebase.

Instead, discharge the taint **locally at the exact binding site**:

```ts
import {
  POLICIES,
  createAssembler,
  memo,
  singleton,
  transient,
  viaSnapshot,
  viaThunk,
} from '@computerwwwizards/dependency-injection/presets';

type ScoreCache = Map<string, number>;

class HttpServer {
  readonly port: number;
  constructor(cfg: { readonly port: number }) {
    this.port = cfg.port;
  }
}

using app = createAssembler();
const Config = app.createToken<{ readonly port: number }>('StartupConfig');
const Server = app.createToken<HttpServer>('HttpServer');
const Cache = app.createToken<ScoreCache>('ScoreCache');
const Shell = app.createToken<{ port: number; cache: ScoreCache }>('Shell');

app.bind(Config, transient(), () => ({ port: 8080 }));

// Escape Hatch 1: `viaSnapshot` discharges `frozen-none` on this edge only
app.registerClass(Server, HttpServer, singleton({ inject: [viaSnapshot(Config)] }));

// Escape Hatch 2: `memo(Cache)` discharges `volatile-state` on itself
app.bind(Cache, memo(Cache), () => new Map<string, number>());

// Ancestors stay clean without re-discharging anything
app.registerFn(
  Shell,
  singleton({ inject: [Server, viaThunk(Cache)] }),
  (server, getCache) => ({ port: server.port, cache: getCache() })
);

// 1. Strict policy: 0 warnings, 0 errors!
app.assertVerified(POLICIES.strict);

// 2. Audit policy: still sees every discharged escape hatch for security reviews!
const audit = app.verify(POLICIES.zeroEscapes);
// audit.ok === false
//   [DENY] Server -> StartupConfig (direct): [] (discharged: [frozen-none])
//   [DENY] ScoreCache (self): [] (discharged: [volatile-state])
```

### Dual-Lattice Diamond Soundness

Discharges never accidentally hide bugs on sibling paths. Active taints join with bitwise **OR** (unsafe if *any* path is tainted), while sanitizations join with bitwise **AND** (safe for an ancestor only if *every* path sanitized it):

```text
               DiamondParent
               /           \
         Server             SloppySibling
   (viaSnapshot(Config))   (raw Config — forgot!)
               \           /
               StartupConfig
```

`Server` clears `frozen-none` on its branch, but `SloppySibling` did not—so `DiamondParent` still catches `frozen-none` automatically.

---

## 8. Eviction, Reverse Cascades & Quarantining Legacy Code

### Deterministic Eviction (`evict()`)

When you manually evict a retained instance (e.g., rotating credentials or resetting between tests), the container applies its `onEvictCaptured` policy (`'cascade'` by default):

- **`'cascade'` (default):** Reverse-topologically evicts every live capturer *before* evicting the dependency—even across intermediate `transient()` bridges—eliminating split-brain stale references. Dependencies wired via `viaThunk`, `viaLive`, or `viaAsync` are immune.
- **`'block'`:** Throws a `KernelError` (`code: 'eviction-blocked'`) if anything still captures the token. Calling `dispose()` (or exiting `using`) still succeeds cleanly because retained entries tear down in exact LIFO instantiation order.
- **`'orphan'`:** Severs capture links without evicting capturers.

```ts
app.evict(AuthToken); // Cascades to any singleton capturing AuthToken, leaves viaLive/viaThunk intact
```

### Quarantining Dynamic / Legacy Code (`bindInsecure`)

If you must integrate a legacy service locator or dynamic plugin whose dependencies aren't statically known, use `bindInsecure()`. It stamps the binding with `'insecure'` taint and treats it as `stateful`:

```ts
import { TAINT_BITS } from '@computerwwwizards/dependency-injection';
import {
  POLICIES,
  createAssembler,
  pure,
  viaThunk,
} from '@computerwwwizards/dependency-injection/presets';

using app = createAssembler();
const ApiKey = app.createToken<string>('ApiKey');
const LegacySdk = app.createToken<{ call(): string }>('LegacySdk');
const Gateway = app.createToken<{ run(): string }>('Gateway');

app.registerValue(ApiKey, 'sk-live-123');

// Mark LegacySdk itself as an audited legacy boundary
app.bindInsecure(
  LegacySdk,
  { storage: 'solid', discharges: [[LegacySdk, TAINT_BITS.insecure]] },
  (get) => {
    const key = get(ApiKey);
    return { call: () => `legacy(${key})` };
  }
);

// Clean code puts LegacySdk behind `viaThunk` (or `viaLive`) as a taint firewall:
// `insecure` and `state-leak` do NOT cross the boundary.
app.registerFn(Gateway, pure({ inject: [viaThunk(LegacySdk)] }), (getSdk) => ({
  run: () => getSdk().call(),
}));

app.assertVerified(POLICIES.strict); // Passes cleanly!
// Direct capture (`pure({ captures: [LegacySdk] })`) would still be DENIED.
```

---

## 9. Scaling Up: Modules, Descriptors & Custom Extensions

### Reusable Modules (`use`) & Pure Descriptors (`as*`)

Group registrations into plain functions passed to `app.use(...)`, or declare reusable zero-closure descriptors with `asValue`, `asClass`, `asFn`, `asFactory`, `asAsync`, and `asInsecure`:

```ts
import {
  asClass,
  asFactory,
  asValue,
  pure,
} from '@computerwwwizards/dependency-injection/presets';
import type { Assembler } from '@computerwwwizards/dependency-injection/presets';

const registerCacheModule = (asm: Assembler): void => {
  asm.register(CacheName, asValue('LRU-64'));
  asm.register(CacheEngineTok, asClass(CacheEngine, pure({ inject: [CacheName] })));
  asm.register(
    CacheSummary,
    asFactory(pure({ captures: [CacheEngineTok] }), ([eng]) => eng.describe())
  );
};

app.use(registerCacheModule);
```

### Open Protocol: Write Your Own `BindingDescriptor`

`app.register(token, descriptor)` uses an open 1-method interface (`BindingDescriptor<T, Handle>`), so you can build domain-specific registration helpers (metrics, instrumentation, RPC clients) without modifying the library:

```ts
import type { Container, Token } from '@computerwwwizards/dependency-injection';
import { singleton } from '@computerwwwizards/dependency-injection/presets';
import type { BindingDescriptor } from '@computerwwwizards/dependency-injection/presets';

function asTimedSingleton<T>(
  label: string,
  fn: (this: void) => T
): BindingDescriptor<T, void> {
  return {
    bind(container: Container, token: Token<T>): void {
      container.bind(token, singleton(), () => {
        const t0 = performance.now();
        const instance = fn();
        console.log(`[boot] ${label} ready in ${(performance.now() - t0).toFixed(2)}ms`);
        return instance;
      });
    },
  };
}

app.register(ServiceTok, asTimedSingleton('SearchIndex', () => new SearchIndex()));
```

Descriptors also work directly on a raw kernel container via `desc.bind(rawContainer, token)`.

---

## 10. Integrating With External Apps & Frameworks

### Extending an Existing Core Container (`extendContainer`)

If a host application or plugin gives you a raw core `Container`, call `extendContainer(rawHost)`. It is weakly memoized (`extendContainer(c) === extendContainer(c)`), adds zero hidden state, and shares the exact same stores and token space:

```ts
import { createContainer } from '@computerwwwizards/dependency-injection';
import { extendContainer, pure } from '@computerwwwizards/dependency-injection/presets';

using rawHost = createContainer({ allowedStores: ['solid', 'weak'] });
const ext = extendContainer(rawHost);

const Flag = rawHost.createToken<boolean>('DarkMode');
ext.registerValue(Flag, true);

rawHost.get(Flag); // true — 100% shared state
```

### Exporting Clean Facades to Routes / UI (`getLiveProxy` & `getAsyncProxy`)

Need to pass a service into an HTTP router, React context, or external library that shouldn't know about containers or tokens? Export a memoized proxy:

```ts
// Works on `Token<Promise<Db>>` or synchronous `Token<Db>`
const dbFacade = app.getAsyncProxy(DbTok);

// Hand `dbFacade` directly to Express/Hono/Fastify handlers:
app.get('/users', async () => dbFacade.query('SELECT * FROM users'));
```

---

## API Quick Reference

| Category | Exports |
|---|---|
| **Containers** | `createAssembler(opts?)`, `extendContainer(container)`, `asm.createRequestScope()`, `asm.createOverrideScope()`, `asm.createChild(opts)`, `asm.kernel` |
| **Registration** | `registerValue`, `registerClass`, `registerFn`, `registerAsync`, `registerFactory`, `register`, `bind`, `bindInsecure`, `use` |
| **Lifetime Presets** | `singleton`, `pure`, `scoped`, `transient`, `ephemeral`, `weak`, `memo` |
| **Injection Adapters** | `viaLive`, `viaAsync`, `viaThunk`, `viaSnapshot`, `viaEscape` |
| **Descriptors** | `asValue`, `asClass`, `asFn`, `asFactory`, `asAsync`, `asInsecure`, `BindingDescriptor<T, Handle>` |
| **Proxies** | `toLiveProxy`, `toAsyncProxy`, `asm.getLiveProxy`, `asm.getAsyncProxy`, `Promisified<T>` |
| **Verification & Policies** | `assertVerified`, `formatVerificationReport`, `VerificationError`, `POLICIES` (`strict`, `balanced`, `paranoid`, `zeroEscapes`), `createTagPolicy`, `createMaskPolicy`, `composePolicies`, `withExceptions`, `onlyDirectCauses`, `forbidDischarges` |
| **Discharge Helpers** | `allowSnapshot`, `allowVolatile`, `allowEscape` |
