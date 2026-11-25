# Dependency Assembler & Presets

A synchronous, statically verified dependency assembler for TypeScript 6+.

- **Zero magic:** No decorators, no `reflect-metadata`, no global registries, no build plugins.
- **Plain TypeScript:** Register classes, functions, values, async initializers, or manual factories directly.
- **Catch lifecycle bugs at boot:** Static lattice verification detects captive scopes, split-state diamonds, purity leaks, and cycles *before a single service is instantiated*.
- **Stay synchronous, stay async-friendly:** Lift any async initializer (or even a synchronous class) into a promisified virtual proxy (`Promisified<T>`) while keeping the container 100% synchronous.
- **Composable hierarchies:** Split apps into isolated child sub-apps, tenant scopes, plugin sandboxes, or per-request containers with zero parent-side memory leaks.
- **Universal runtime support:** Runs on Safari, Chrome, Firefox, Node, Deno, and Bun with plain `dispose()`, zero global mutable state, and zero polyfills.
- **Zero lock-in:** `Assembler` extends the core `Container` directly—same integer tokens, same stores, drop down to raw plumbing or wrap an existing container at any time.

> This guide covers the ergonomic **Assembler & Presets** layer (`@computerwwwizards/dependency-injection/presets`). Documentation for the lower-level core kernel is published separately.

---

## Requirements

- **TypeScript:** `>= 6.0.3` (`strict: true`, `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`, `erasableSyntaxOnly: true`)
- **Runtime:** Standard ES2021+ (`WeakRef`, `FinalizationRegistry`, `Proxy`) — works across Safari, Chrome, Firefox, Node 22+, Bun, and Deno.

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

// 2. Create an assembler
const app = createAssembler();

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

What TypeScript and `assertVerified()` already proved here:
- `Logger`'s constructor expects `(prefix: string)`. Passing a `Token<number>` inside `inject: [...]` is a **compile-time error**.
- Passing too many or too few tokens in `inject: [...]` is a **compile-time error**.
- Forgetting to register `Prefix` or wiring a capture cycle is caught immediately by `app.assertVerified()`.

---

## 2. The Mental Model

Keep three rules in mind—everything else follows directly from them:

1. **Tokens belong to a container hierarchy:** There is no global registry. `app.createToken<T>('Name')` mints an integer token owned by `app`. Child containers inherit ancestor tokens; child-minted tokens are invisible to parents and siblings.
2. **Every dependency edge is either a Capture or a Lazy Firewall:**
   - **Capture (default: bare `Token`):** Resolved eagerly before the dependent is constructed. Tracked statically for lifetime/purity taints and tracked at runtime so evicting a dependency cascades into its capturers.
   - **Lazy Firewall (`viaThunk` / `viaLive` / `viaAsync`):** Resolved on demand. Breaks cycles, stops taint propagation (captive scopes, mutable rebinds, insecure code), and isolates dependents from eviction cascades.
3. **`assertVerified()` proves graph safety without running code:** It inspects every binding's lifetime, purity (`stateless` vs `stateful`), mutability (`rebindable`), and capture graph without invoking a single factory or constructor.

---

## 3. Lifetime Presets

Presets are plain, zero-lock-in option objects. They work identically in `registerClass`, `registerFn`, `asClass`, `asFn`, and raw `bind`.

| Preset | Storage | Owner | Default Purity | Lifetime & Best Use |
|---|---|---|---|---|
| `singleton()` | `solid` | Provider (defining container) | `stateful` | Shared stateful infrastructure (DB pools, clients, queues) |
| `pure()` | `solid` | Provider (defining container) | `stateless` | Functional-core services, formatters, validators, immutable helpers |
| `scoped()` | `solid` | Caller (resolving container) | `stateful` | Per-request / per-job services; bound once on an ancestor, stored per child |
| `transient()` | `none` | Never stored | `stateless` | Fresh instance on every `get()`; lightweight factories & snapshots |
| `ephemeral()` | `ephemeral` | Active `get()` pass | `stateful` | Shared across a diamond inside ONE `get()` call, then disposed before `get()` returns |
| `weak()` | `weak` | Provider | `stateless` | GC-managed cache for stateless objects/functions (primitives rejected at compile time) |
| `memo(tok)` | `weak` | Provider | `stateful` | Escape-hatch preset for intentional stateful weak caches (discharges `volatile-state`) |

Every preset accepts **three call shapes** (no object-spread boilerplate):
- `pure()` — no arguments (returns a frozen zero-allocation default).
- `pure({ inject: [TokA, TokB], onDispose })` — positional injection for `registerClass` / `registerFn`.
- `pure({ captures: [TokA], deps: [TokB], onDispose })` — direct options for manual `bind` / `registerFactory`.

### Pass-Scoped Diamonds (`ephemeral()`)

When a single operation fans out into a diamond and both branches need the **same** short-lived object (like a `UnitOfWork` or correlation buffer) without turning it into a singleton or opening a child scope, use `ephemeral()`:

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

const app = createAssembler();
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

## 4. Child Containers, Sub-Apps & Ownership

You do **not** have to put your entire application into one giant root container. Every `Assembler` can branch into child containers at any depth—sub-apps, micro-frontend islands, tenants, plugins, per-request scopes, or test sandboxes—using `createChild(options)`:

- `parent.createChild({ allowedStores: ['solid', 'weak'] })` — full sub-app, plugin, or tenant container.
- `parent.createChild({ allowedStores: ['solid'] })` — lightweight scoped child (e.g., per-request, per-job, or test sandbox).
- `parent.createChild({ allowedStores: [] })` — zero-retention pass-through override layer (cannot retain its own `solid`/`weak` singletons).

```text
                    Host Shell (DB Pool, Telemetry, Auth Keys)
                   /                                          \
     Billing Sub-App (solid + weak)               Checkout Sub-App (solid + weak)
     • Private tokens invisible to Checkout       • Private tokens invisible to Billing
     • Verified & unloaded independently          • Spawns per-request children
            |                                                |
     Tenant A Scope                                   Request #42 Scope
```

### 4.1 Isolated Feature / Plugin Sub-Apps

Tokens minted on a child container are **strictly private** to that child and its descendants. Sibling sub-apps and the host cannot read, bind, or evict them:

```ts
import {
  POLICIES,
  createAssembler,
  pure,
  singleton,
} from '@computerwwwizards/dependency-injection/presets';

// Minimal shared host shell
const host = createAssembler();
const Telemetry = host.createToken<{ track(evt: string): void }>('Telemetry');
host.bind(Telemetry, pure(), () => ({
  track: (evt) => console.log(`[telemetry] ${evt}`),
}));

// --- Sub-App A: Billing ---
const billing = host.createChild({ allowedStores: ['solid', 'weak'] });
const StripeSecret = billing.createToken<string>('StripeSecret');
const BillingSvc = billing.createToken<{ charge(amount: number): string }>('BillingSvc');

billing.registerValue(StripeSecret, 'sk_billing_only');
billing.registerFn(
  BillingSvc,
  singleton({
    inject: [Telemetry, StripeSecret],
    onDispose: () => console.log('Billing sub-app unloaded'),
  }),
  (telemetry, secret) => ({
    charge: (amount) => {
      telemetry.track(`charge:${amount}`);
      return `charged $${amount} (${secret.slice(0, 10)}...)`;
    },
  })
);

// --- Sub-App B: Search ---
const search = host.createChild({ allowedStores: ['solid'] });
const IndexName = search.createToken<string>('IndexName');
search.registerValue(IndexName, 'products-v2');

// Each sub-app verifies independently against host + its own bindings
billing.assertVerified(POLICIES.strict);
search.assertVerified(POLICIES.strict);

console.log(billing.get(BillingSvc).charge(50));

// Strict isolation: Search and Host cannot access Billing's private tokens
console.log(search.has(StripeSecret)); // false
console.log(host.has(StripeSecret));   // false
// search.get(StripeSecret) -> throws KernelError('token-out-of-scope')

// Unload Billing cleanly without touching Host or Search
billing.dispose();
```

### 4.2 Multi-Level Hierarchies (`Host → Tenant → Request`)

Child containers can spawn their own children. `scoped()` (`target: 'caller'`) is bound once on an ancestor and instantiated inside whichever child calls `.get()`, while `singleton()` (`target: 'provider'`) stays pinned to the container where it was bound:

```ts
const host = createAssembler();
const DbPool = host.createToken<{ query(sql: string): string }>('DbPool');
const TenantId = host.createToken<string>('TenantId');
const ReqId = host.createToken<string>('ReqId');
const AuditLog = host.createToken<{ write(msg: string): string }>('AuditLog');

host.bind(
  DbPool,
  singleton({
    onDecapture: (_pool, remaining) => {
      console.log(`DbPool active capturers: ${remaining}`);
    },
  }),
  () => ({ query: (sql) => `SQL<${sql}>` })
);

// Bound once on host, instantiated per request child
host.registerFn(
  AuditLog,
  scoped({
    inject: [DbPool, TenantId, ReqId],
    onDispose: () => console.log('AuditLog disposed'),
  }),
  (db, tenantId, reqId) => ({
    write: (msg) => `[${tenantId}/${reqId}] ${db.query(msg)}`,
  })
);

// Tier 2: Long-lived Tenant container
const acmeTenant = host.createChild({ allowedStores: ['solid', 'weak'] });
acmeTenant.registerValue(TenantId, 'tenant-acme');

// Tier 3: Short-lived Request container inside Tenant
const req = acmeTenant.createChild({ allowedStores: ['solid'] });
try {
  req.registerValue(ReqId, 'req-99');
  req.assertVerified(POLICIES.strict);
  console.log(req.get(AuditLog).write('INSERT audit'));
} finally {
  req.dispose(); // Disposes only request state; Tenant & Host stay warm
}
// Output:
//   [tenant-acme/req-99] SQL<INSERT audit>
//   AuditLog disposed
//   DbPool active capturers: 0
```

### 4.3 Shadowing & Lexical Scope Isolation

A child container can **override (shadow)** an ancestor token without mutating the parent or affecting siblings.

The container enforces **lexical scope isolation** for `singleton()` / `pure()` (`target: 'provider'`):
- A root singleton always resolves its dependencies in the **root** scope, so a child override can never accidentally poison a shared ancestor singleton.
- `scoped()` (`target: 'caller'`) and `transient()` (`storage: 'none'`) resolve in the **calling child's** scope, so they immediately see the child's shadow binding.

```ts
const root = createAssembler();
const Env = root.createToken<string>('Env');
const RootSingleton = root.createToken<string>('RootSingleton');
const ScopedHandler = root.createToken<string>('ScopedHandler');

root.registerValue(Env, 'prod');
root.registerFn(RootSingleton, pure({ inject: [Env] }), (env) => `root:${env}`);
root.registerFn(ScopedHandler, scoped({ inject: [Env] }), (env) => `handler:${env}`);

const previewChild = root.createChild({ allowedStores: ['solid'] });
previewChild.registerValue(Env, 'preview');

console.log(previewChild.get(RootSingleton)); // "root:prod"       (immune to child shadow)
console.log(previewChild.get(ScopedHandler)); // "handler:preview" (sees child shadow)
console.log(root.get(Env));                   // "prod"            (parent untouched)
```

### 4.4 Lightweight Overrides & Test Sandboxes

Swap dependencies in tests without mutating your production wiring:

- **`app.createChild({ allowedStores: ['solid'] })`**: Allows overriding any token with `registerValue`, `singleton`, `pure`, `scoped`, or `transient`.
- **`app.createChild({ allowedStores: [] })`**: A zero-retention pass-through child for swapping `transient()` or `ephemeral()` fakes while guaranteeing the override layer cannot accidentally retain singletons.

```ts
// Pass-through override scope (`allowedStores: []`) — great for transient overrides
const testOverride = app.createChild({ allowedStores: [] });
testOverride.bind(ClockTok, transient(), () => ({ now: () => 1_700_000_000_000 }));

// Need `registerValue` or `singleton` mocks? Give the test child a `'solid'` store:
const testSandbox = app.createChild({ allowedStores: ['solid'] });
testSandbox.registerValue(ApiUrlTok, 'http://localhost:9999');
try {
  // ... run assertions ...
} finally {
  testSandbox.dispose();
}
```

### 4.5 Ownership, Unloading Sub-Apps & Cross-Boundary Eviction

Understanding **who holds references to whom** is the key to managing child containers and sub-apps cleanly without memory leaks:

```text
  Your App / Router / Framework (Client Code)
        │
        │ owns strong reference
        ▼
  Child Sub-App ───────── parent pointer ─────────▶ Host Root
        │                                               ▲
        │ (ONLY when a live child entry                 │
        │  eagerly captures a host singleton)           │
        └───────── capturedBy back-link ────────────────┘
```

1. **Client code owns child containers—parents never store a `children` list.**
   Calling `host.createChild(...)` returns the child to **your** code (your router, tab manager, plugin registry, or test block) and stores **nothing** on `host`. This is deliberate: if a parent kept a strong list of children, spawning 100,000 request scopes would leak memory forever.
2. **Unloading a sub-app (`subApp.dispose()`):**
   Call `subApp.dispose()` when a route unmounts, a plugin unloads, or a request ends. It:
   - Tears down every retained (`solid` and `weak`) instance owned by `subApp` in exact LIFO instantiation order.
   - Removes `subApp`'s entries from every ancestor singleton's `capturedBy` set and fires `onDecapture` on those ancestor singletons.
   - Marks `subApp.disposed === true` (idempotent; further calls throw `KernelError('container-disposed')`).
   Once your code drops its reference to `subApp`, the runtime collects it immediately.
3. **What if you forget to call `subApp.dispose()`?**
   - If `subApp` never eagerly captured any parent singleton (or only wired parent singletons via `viaThunk` / `viaLive` / `viaAsync`), the runtime still garbage-collects `subApp` as soon as your code drops its reference (its `onDispose` hooks simply won't run).
   - If a retained instance inside `subApp` **did** eagerly capture a parent singleton (like `BillingSvc` capturing `Telemetry` or `AuditLog` capturing `DbPool`), that parent singleton's `capturedBy` set holds a reference to the child's entry—pinning the child in memory until either `subApp.dispose()` is called or the parent singleton is evicted. **Always call `dispose()` on children that capture parent singletons.**
4. **Parent eviction cascades into live children (`host.evict(token)`):**
   Because `capturedBy` tracks live cross-boundary captures, evicting a shared parent singleton (e.g., `host.evict(DbPool)` during credential rotation) automatically cascades into every live child instance that captured `DbPool`, firing their `onDispose` hooks so no sub-app is left holding a stale connection. Unrelated child services and the child container itself remain alive and ready to rebuild cleanly on the next `get()`.
5. **Disposing the host does not automatically dispose children:**
   Because `host` does not maintain a list of child containers, `host.dispose()` tears down `host`'s own stores (cascading into any child entries that captured `host` singletons), but it does **not** mark child containers as disposed or tear down child-only services that never captured anything from `host`. If your application manages a registry of long-lived sub-apps, dispose them bottom-up before disposing `host`:

```ts
// Recommended shutdown order for long-lived sub-apps owned by your app shell
const mountedSubApps = new Map<string, Assembler>();
mountedSubApps.set('billing', billing);
mountedSubApps.set('search', search);

function unloadSubApp(name: string): void {
  const sub = mountedSubApps.get(name);
  if (sub === undefined) return;
  sub.dispose();               // Tears down sub-app in LIFO order + detaches from host
  mountedSubApps.delete(name); // Drops client reference -> eligible for GC
}

function shutdownHost(): void {
  for (const sub of mountedSubApps.values()) {
    sub.dispose();
  }
  mountedSubApps.clear();
  host.dispose();
}
```

> **When to call `dispose()`**
> - **Root container:** You only need `app.dispose()` if you registered `onDispose` shutdown hooks (closing DB pools, sockets, or timers) that you want to run on exit.
> - **Child containers:** Call `child.dispose()` in a `finally` block or unmount hook whenever a sub-app, tenant, or request finishes.

---

## 5. Four Ways to Register Anything

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

## 6. Catching Bugs Before Production (Static Verification)

Traditional DI containers happily boot broken graphs and let them fail at runtime (leaking User A's request session into a singleton, or silently giving two repositories two *different* transactions).

Here is what happens when you wire four classic bugs and call `app.assertVerified(POLICIES.strict)`:

```ts
const app = createAssembler();

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

Compose custom rules with `createTagPolicy`, `createMaskPolicy`, `composePolicies`, `withExceptions`, `onlyDirectCauses`, and `forbidDischarges`.

---

## 7. Virtual Proxies: Hot Swapping & Async Without an Async Container

Using bare tokens in `inject: [A, B]` eagerly captures them. Wrap a token in a `via*` adapter to change how that dependency crosses the boundary:

| Adapter | Injected Type | Kernel Edge | Solves |
|---|---|---|---|
| `Tok` (bare) | `T` | `captures` | Normal eager dependency |
| `viaThunk(Tok)` | `() => T` | `deps` | Explicit lazy call, zero Proxy overhead, breaks cycles & taints |
| `viaLive(Tok)` | `T` | `deps` | Sync Virtual Proxy: hot-swapping `rebindable` deps, `scoped` inside `singleton`, mutual cycles — with zero `() =>` noise |
| `viaAsync(Tok)` | `Promisified<Awaited<T>>` | `deps` | Async Virtual Proxy: lifts **both** `Token<Promise<T>>` **and** synchronous `Token<T>` into uniform async methods |
| `viaSnapshot(Tok)` | `T` | `captures` | Local escape hatch: intentionally freezes a `transient`, discharges `frozen-none` |
| `viaEscape(Tok, mask)` | `T` | `captures` | General local escape hatch: discharges an explicit `TAINT_BITS` mask |

### How `viaAsync` + `viaLive` Work Together

The core container stays **100% synchronous**. Async resources (like a DB connection handshake or lazy `import()`) are registered with `registerAsync`, which stores a single cached `Promise<T>` in the container. Dependents inject `viaAsync(Db)` and call `await this.db.query(...)` directly.

You can also wrap a **purely synchronous** class (like `SyncHasher`) in `viaAsync(Hasher)`—useful when your domain interface is async (for example, keeping the door open for a Web Worker, WASM module, or remote RPC later).

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

const app = createAssembler();
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

> **Manual factories:** The exact same proxies are available standalone as `toLiveProxy(thunk)` and `toAsyncProxy(thunk)` when using raw `app.bind()`.

---

## 8. Local Escape Hatches (Not Global Policy Rot)

When `POLICIES.strict` flags a pattern you **genuinely want**—like snapping a transient `StartupConfig` once at boot (`frozen-none`) or keeping a stateful GC-evictable memo cache (`volatile-state`)—**do not weaken your global policy**. Turning off `frozen-none` globally would hide every *accidental* transient capture in the codebase.

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

const app = createAssembler();
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

// 2. Audit policy: still flags every discharged escape hatch for security reviews!
const audit = app.verify(POLICIES.zeroEscapes);
// audit.ok === false
//   [DENY] Server -> StartupConfig (direct): [] (discharged: [frozen-none])
//   [DENY] ScoreCache (self): [] (discharged: [volatile-state])
```

### Dual-Lattice Diamond Soundness

Local discharges never mask bugs on sibling branches. Active taints join across diamond paths with bitwise **OR** (unsafe if *any* path is tainted), while sanitizations join with bitwise **AND** (safe for an ancestor only if *every* path sanitized that bit):

- If `DiamondParent` captures both `Server` (uses `viaSnapshot(Config)`) and `SloppySibling` (captures raw `Config` without discharging), `DiamondParent` still catches `frozen-none` automatically.

---

## 9. Eviction Policies & Quarantining Legacy Code

### Deterministic Eviction (`evict()`)

When you evict a retained instance (e.g., rotating credentials or resetting between tests), the container applies its `onEvictCaptured` policy (`'cascade'` by default):

- **`'cascade'` (default):** Reverse-topologically evicts every live capturer *before* evicting the dependency—even across intermediate `transient()` bridges and across child container boundaries—eliminating split-brain stale references. Dependencies wired via `viaThunk`, `viaLive`, or `viaAsync` are immune.
- **`'block'`:** Throws a `KernelError` (`code: 'eviction-blocked'`) if anything still captures the token. Calling `dispose()` still succeeds cleanly because retained entries tear down in exact LIFO instantiation order.
- **`'orphan'`:** Severs capture links without evicting capturers.

```ts
app.evict(AuthToken); // Cascades to any retained capturer (even in child scopes), leaves viaLive/viaThunk intact
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

const app = createAssembler();
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

// Clean code places LegacySdk behind `viaThunk` (or `viaLive`) as a taint firewall:
// `insecure` and `state-leak` do NOT cross the boundary.
app.registerFn(Gateway, pure({ inject: [viaThunk(LegacySdk)] }), (getSdk) => ({
  run: () => getSdk().call(),
}));

app.assertVerified(POLICIES.strict); // Passes cleanly!
// Direct capture (`pure({ captures: [LegacySdk] })`) would still be DENIED.
```

---

## 10. Scaling Up: Modules, Descriptors & Custom Extensions

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

## 11. Integrating With External Apps & Frameworks

### Extending an Existing Core Container (`extendContainer`)

If a host application or plugin hands you a raw core `Container`, wrap it with `extendContainer(rawHost)`. It is a lightweight, zero-global-state facade that shares 100% of the underlying container's stores, bindings, and token space—call it once at your module boundary and reuse the returned `Assembler` (so `getLiveProxy` / `getAsyncProxy` stay cached on that facade):

```ts
import { createContainer } from '@computerwwwizards/dependency-injection';
import { extendContainer } from '@computerwwwizards/dependency-injection/presets';

const rawHost = createContainer({ allowedStores: ['solid', 'weak'] });
const ext = extendContainer(rawHost);

const Flag = rawHost.createToken<boolean>('DarkMode');
ext.registerValue(Flag, true);

rawHost.get(Flag); // true — 100% shared state
```

### Exporting Clean Facades to Routes / UI (`getLiveProxy` & `getAsyncProxy`)

Need to pass a service into an HTTP router, React context, or external library that shouldn't know about containers or tokens? Export a proxy memoized on the `Assembler` instance:

```ts
// Works on `Token<Promise<Db>>` or synchronous `Token<Db>`
const dbFacade = app.getAsyncProxy(DbTok);

// Hand `dbFacade` directly to Express/Hono/Fastify handlers:
router.get('/users', async () => dbFacade.query('SELECT * FROM users'));
```

---

## API Quick Reference

| Category | Exports |
|---|---|
| **Containers** | `createAssembler(opts?)`, `extendContainer(container)`, `asm.createChild(opts)`, `asm.kernel` |
| **Registration** | `registerValue`, `registerClass`, `registerFn`, `registerAsync`, `registerFactory`, `register`, `bind`, `bindInsecure`, `use` |
| **Lifetime Presets** | `singleton`, `pure`, `scoped`, `transient`, `ephemeral`, `weak`, `memo` |
| **Injection Adapters** | `viaLive`, `viaAsync`, `viaThunk`, `viaSnapshot`, `viaEscape` |
| **Descriptors** | `asValue`, `asClass`, `asFn`, `asFactory`, `asAsync`, `asInsecure`, `BindingDescriptor<T, Handle>` |
| **Proxies** | `toLiveProxy`, `toAsyncProxy`, `asm.getLiveProxy`, `asm.getAsyncProxy`, `Promisified<T>` |
| **Verification & Policies** | `assertVerified`, `formatVerificationReport`, `VerificationError`, `POLICIES` (`strict`, `balanced`, `paranoid`, `zeroEscapes`), `createTagPolicy`, `createMaskPolicy`, `composePolicies`, `withExceptions`, `onlyDirectCauses`, `forbidDischarges` |
| **Discharge Helpers** | `allowSnapshot`, `allowVolatile`, `allowEscape` |
