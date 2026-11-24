/**
 * @module @computerwwwizards/di-kernel/tutorial
 *
 * Interactive 10-lesson guide to the synchronous DI kernel (`./index.js`)
 * and its zero-lock-in Assembler & Presets extension (`./presets.js`).
 */

import { TAINT_BITS, createContainer } from '.';
import type { Container, KernelError, Token } from '.';
import {
  POLICIES,
  VerificationError,
  allowSnapshot,
  asClass,
  asFactory,
  asValue,
  createAssembler,
  ephemeral,
  extendContainer,
  formatVerificationReport,
  memo,
  pure,
  scoped,
  singleton,
  toAsyncProxy,
  toLiveProxy,
  transient,
  viaAsync,
  viaLive,
  viaSnapshot,
  viaThunk,
} from './presets';
import type {
  Assembler,
  BindingDescriptor,
  Promisified,
} from './presets';

function banner(num: number, title: string): void {
  console.log(`\n============================================================`);
  console.log(`LESSON ${num}: ${title}`);
  console.log(`============================================================`);
}

function isKernelError(err: unknown): err is KernelError {
  return err instanceof Error && err.name === 'KernelError' && 'code' in err;
}

// ============================================================================
// LESSON 1: Core Mental Model — Lifetimes, `using` Scopes & Lifecycle Hooks
// ============================================================================

function lesson1LifetimesAndScopes(): void {
  banner(1, 'Core Mental Model — Lifetimes, Scopes & `using` Teardown');

  interface DbPool {
    query(sql: string): string;
  }
  interface Formatter {
    format(text: string): string;
  }

  using app = createAssembler();

  const Db = app.createToken<DbPool>('DbPool');
  const ReqId = app.createToken<string>('RequestId');
  const UserRepo = app.createToken<{ loadProfile(): string }>('UserRepo');
  const Fmt = app.createToken<Formatter>('Formatter');

  app.bind(
    Db,
    singleton({
      onDecapture: (_pool, remaining) => {
        console.log(`  [hook] DbPool decaptured -> remaining capturers: ${remaining}`);
      },
      onDispose: () => {
        console.log(`  [hook] DbPool closed on root shutdown`);
      },
    }),
    () => ({ query: (sql) => `SQL<${sql}>` })
  );

  app.bind(
    UserRepo,
    scoped({
      captures: [Db, ReqId],
      onDispose: () => {
        console.log(`  [hook] UserRepo disposed when request scope exited`);
      },
    }),
    ([db, reqId]) => ({
      loadProfile: () => `${reqId} -> ${db.query('SELECT * FROM users')}`,
    })
  );

  app.bind(Fmt, transient(), () => ({
    format: (s) => `[${s.toUpperCase()}]`,
  }));

  {
    using req1 = app.createRequestScope();
    req1.registerValue(ReqId, 'REQ-001');
    req1.assertVerified(POLICIES.strict);

    const repo = req1.get(UserRepo);
    const fmt = req1.get(Fmt);
    console.log('  Result:', fmt.format(repo.loadProfile()));
  }
}

// ============================================================================
// LESSON 2: Classes, Functions & Manual Factories Side-by-Side (Zero Lock-In)
// ============================================================================

function lesson2ClassesFunctionsAndManualFactories(): void {
  banner(2, 'Classes, Functions & Manual Factories Side-by-Side');

  class PrefixLogger {
    private readonly prefix: string;

    constructor(prefix: string) {
      this.prefix = prefix;
    }

    log(msg: string): string {
      return `${this.prefix} ${msg}`;
    }
  }

  class Greeter {
    private readonly logger: PrefixLogger;

    constructor(logger: PrefixLogger) {
      this.logger = logger;
    }

    greet(name: string): string {
      return this.logger.log(`Hello, ${name}!`);
    }
  }

  using app = createAssembler();
  const Prefix = app.createToken<string>('Prefix');
  const Logger = app.createToken<PrefixLogger>('PrefixLogger');
  const GreeterTok = app.createToken<Greeter>('Greeter');
  const BannerFn = app.createToken<string>('Banner');
  const ManualTok = app.createToken<string>('ManualReport');

  app.registerValue(Prefix, '[APP]');

  // Clean preset calls — zero spread operators
  app.registerClass(Logger, PrefixLogger, pure({ inject: [Prefix] }));
  app.registerClass(GreeterTok, Greeter, pure({ inject: [Logger] }));

  app.registerFn(
    BannerFn,
    transient({ inject: [GreeterTok] }),
    (greeter) => `*** ${greeter.greet('Piero')} ***`
  );

  // Raw manual kernel factory right alongside class/fn registrations
  app.bind(
    ManualTok,
    pure({ captures: [Logger], deps: [BannerFn] }),
    ([logger], [getBanner]) => logger.log(`Manual saw: ${getBanner()}`)
  );

  app.assertVerified(POLICIES.strict);
  console.log('  Greeter:', app.get(GreeterTok).greet('World'));
  console.log('  Banner: ', app.get(BannerFn));
  console.log('  Manual: ', app.get(ManualTok));
}

// ============================================================================
// LESSON 3: Static Lattice Verification — Catching Classic IoC Bugs at Boot
// ============================================================================

function lesson3CatchingTrapsAtBoot(): void {
  banner(3, 'Static Verification — Catching 4 Classic IoC Traps at Boot');

  using app = createAssembler();

  const ScopedSession = app.createToken<{ user: string }>('ScopedSession');
  const PassCursor = app.createToken<{ step: number }>('PassCursor');
  const StatefulTx = app.createToken<{ id: number }>('StatefulTx');
  const RepoA = app.createToken<{ tx: { id: number } }>('RepoA');
  const RepoB = app.createToken<{ tx: { id: number } }>('RepoB');
  const StatefulCounter = app.createToken<{ count: number }>('StatefulCounter');

  const BuggySingleton = app.createToken<unknown>('BuggySingleton');
  const BuggyDiamond = app.createToken<unknown>('BuggyDiamond');
  const LyingPureService = app.createToken<unknown>('LyingPureService');

  let txSeq = 1;
  app.bind(ScopedSession, scoped(), () => ({ user: 'alice' }));
  app.bind(PassCursor, ephemeral(), () => ({ step: 0 }));
  app.bind(StatefulTx, transient({ state: 'stateful' }), () => ({ id: txSeq++ }));
  app.bind(StatefulCounter, singleton(), () => ({ count: 0 }));

  app.bind(RepoA, singleton({ captures: [StatefulTx] }), ([tx]) => ({ tx }));
  app.bind(RepoB, singleton({ captures: [StatefulTx] }), ([tx]) => ({ tx }));

  app.bind(
    BuggySingleton,
    singleton({ captures: [ScopedSession, PassCursor] }),
    ([session, cursor]) => ({ session, cursor })
  );

  app.bind(
    BuggyDiamond,
    singleton({ captures: [RepoA, RepoB] }),
    ([a, b]) => ({ a, b })
  );

  app.bind(
    LyingPureService,
    pure({ captures: [StatefulCounter] }),
    ([counter]) => ({ counter })
  );

  const report = app.verify(POLICIES.strict);
  console.log('  Verification OK?', report.ok);
  console.log(formatVerificationReport(app, report));
}

// ============================================================================
// LESSON 4: Ephemeral Passes — Solving Diamonds Without Singletons
// ============================================================================

function lesson4EphemeralPassDiamonds(): void {
  banner(4, 'Ephemeral Passes — Solving Diamonds Without Singletons');

  class UnitOfWork {
    readonly id: number;
    readonly ops: string[] = [];

    constructor(id: number) {
      this.id = id;
    }

    record(op: string): void {
      this.ops.push(op);
    }
  }

  using app = createAssembler();
  let uowSeq = 1;

  const UoW = app.createToken<UnitOfWork>('UnitOfWork');
  const OrdersStep = app.createToken<string>('OrdersStep');
  const AuditStep = app.createToken<string>('AuditStep');
  const CheckoutOp = app.createToken<{ uowId: number; ops: readonly string[] }>(
    'CheckoutOp'
  );

  app.bind(
    UoW,
    ephemeral({
      onDispose: (uow) => {
        console.log(`  [ephemeral flush] UoW#${uow.id} committed:`, uow.ops);
      },
    }),
    () => new UnitOfWork(uowSeq++)
  );

  app.registerFn(OrdersStep, ephemeral({ inject: [UoW] }), (uow) => {
    uow.record('insert-order');
    return `order@${uow.id}`;
  });

  app.registerFn(AuditStep, ephemeral({ inject: [UoW] }), (uow) => {
    uow.record('write-audit');
    return `audit@${uow.id}`;
  });

  app.registerFn(
    CheckoutOp,
    ephemeral({ inject: [UoW, OrdersStep, AuditStep] }),
    (uow) => ({ uowId: uow.id, ops: [...uow.ops] })
  );

  app.assertVerified(POLICIES.strict);

  const pass1 = app.get(CheckoutOp);
  const pass2 = app.get(CheckoutOp);
  console.log('  Pass 1 UoW ID:', pass1.uowId, 'Pass 2 UoW ID:', pass2.uowId);
}

// ============================================================================
// LESSON 5: Local Escape-Hatch Presets & Dual-Lattice Discharges
// ============================================================================

function lesson5EscapeHatchesAndDischarges(): void {
  banner(5, 'Local Escape-Hatch Presets & Dual-Lattice Discharges');

  type ScoreCache = Map<string, number>;

  class HttpServer {
    readonly port: number;

    constructor(cfg: { readonly port: number }) {
      this.port = cfg.port;
    }
  }

  using app = createAssembler();
  const StartupConfig = app.createToken<{ readonly port: number }>('StartupConfig');
  const Server = app.createToken<HttpServer>('HttpServer');
  const ScratchMemo = app.createToken<ScoreCache>('ScratchMemo');
  const AppShell = app.createToken<{ port: number; cache: ScoreCache }>('AppShell');

  app.bind(StartupConfig, transient(), () => ({ port: 8080 }));

  // Local escape hatch #1: discharges `frozen-none` on this exact edge
  app.registerClass(
    Server,
    HttpServer,
    singleton({ inject: [viaSnapshot(StartupConfig)] })
  );

  // Local escape hatch #2: `memo(tok)` discharges `volatile-state` on itself
  app.bind(ScratchMemo, memo(ScratchMemo), () => new Map<string, number>());

  app.registerFn(
    AppShell,
    singleton({ inject: [Server, viaThunk(ScratchMemo)] }),
    (server, getCache) => ({ port: server.port, cache: getCache() })
  );

  const strictReport = app.assertVerified(POLICIES.strict, (_r, msg) => {
    console.log('  Unexpected warning:', msg);
  });
  console.log(
    '  POLICIES.strict passed cleanly! Violations:',
    strictReport.violations.length
  );

  const auditReport = app.verify(POLICIES.zeroEscapes);
  console.log('  POLICIES.zeroEscapes OK?', auditReport.ok);
  console.log(formatVerificationReport(app, auditReport));

  // Dual-lattice diamond check: unsanitized sibling branch still surfaces on parent
  const SloppySibling = app.createToken<{ port: number }>('SloppySibling');
  const DiamondParent = app.createToken<unknown>('DiamondParent');
  app.bind(SloppySibling, singleton({ captures: [StartupConfig] }), ([c]) => c);
  app.bind(
    DiamondParent,
    singleton({ captures: [Server, SloppySibling] }),
    ([s, sib]) => ({ s, sib })
  );

  const diamondReport = app.verify(POLICIES.strict);
  const parentFact = diamondReport.folded.get(DiamondParent)?.get(StartupConfig);
  console.log(
    '  Dual-lattice diamond caught unsanitized branch on DiamondParent?',
    parentFact?.taints.has('frozen-none') === true,
    '(diamond:',
    parentFact?.diamond,
    ')'
  );
}

// ============================================================================
// LESSON 6: Virtual Proxies — `viaLive` (Sync) & `viaAsync` (Promisified)
// ============================================================================

async function lesson6VirtualProxies(): Promise<void> {
  banner(6, 'Virtual Proxies — `viaLive` (Hot Swap) & `viaAsync` (Sync + Async)');

  interface ClockService {
    now(): number;
  }

  class SystemClock implements ClockService {
    now(): number {
      return Date.now();
    }
  }

  class FixedClock implements ClockService {
    now(): number {
      return 1_700_000_000_000;
    }
  }

  class SyncHasher {
    hash(input: string): string {
      return `sha256:${input.length}:${input}`;
    }
  }

  class Database {
    private readonly url: string;

    constructor(url: string) {
      this.url = url;
    }

    query(sql: string): string {
      return `[${this.url}] ${sql}`;
    }

    close(): void {
      console.log(`  [async dispose] Closed connection to ${this.url}`);
    }
  }

  class RegistrationService {
    private readonly db: Promisified<Database>;
    private readonly hasher: Promisified<SyncHasher>;
    private readonly clock: ClockService;

    constructor(
      db: Promisified<Database>,
      hasher: Promisified<SyncHasher>,
      clock: ClockService
    ) {
      this.db = db;
      this.hasher = hasher;
      this.clock = clock;
    }

    async register(username: string): Promise<string> {
      const digest = await this.hasher.hash(username);
      const result = await this.db.query(`INSERT ${username} (${digest})`);
      return `@${this.clock.now()} -> ${result}`;
    }
  }

  using app = createAssembler();
  const Clock = app.createToken<ClockService>('Clock');
  const Hasher = app.createToken<SyncHasher>('SyncHasher');
  const Db = app.createToken<Promise<Database>>('AsyncDatabase');
  const Reg = app.createToken<RegistrationService>('RegistrationService');

  const rebindClock = app.registerClass(
    Clock,
    SystemClock,
    singleton({ rebindable: true })
  );

  app.registerClass(Hasher, SyncHasher, pure());

  app.registerAsync(
    Db,
    { onDispose: (db) => db.close() },
    async () => {
      await Promise.resolve();
      return new Database('postgres://primary');
    }
  );

  app.registerClass(
    Reg,
    RegistrationService,
    singleton({ inject: [viaAsync(Db), viaAsync(Hasher), viaLive(Clock)] })
  );

  app.assertVerified(POLICIES.strict);

  const reg = app.get(Reg);
  console.log('  Live clock:', await reg.register('piero'));

  rebindClock(FixedClock);
  console.log('  Mock clock:', await reg.register('piero'));

  // Same wiring via raw manual `bind()` + standalone proxy helpers
  const ManualReg = app.createToken<RegistrationService>('ManualReg');
  app.bind(
    ManualReg,
    singleton({ deps: [Db, Hasher, Clock] }),
    (_caps, [getDb, getHasher, getClock]) =>
      new RegistrationService(
        toAsyncProxy(getDb),
        toAsyncProxy(getHasher),
        toLiveProxy(getClock)
      )
  );
  console.log('  Manual proxy:', await app.get(ManualReg).register('ada'));
}

// ============================================================================
// LESSON 7: Eviction Mechanics — Cascade vs. Thunk Isolation vs. Block
// ============================================================================

function lesson7EvictionMechanics(): void {
  banner(7, 'Eviction Mechanics — Cascade, Thunk Isolation & Block');

  {
    using app = createAssembler();
    const Auth = app.createToken<{ version: number }>('Auth');
    const Bridge = app.createToken<{ auth: { version: number } }>('TransientBridge');
    const Coupled = app.createToken<{ ver(): number }>('CoupledCtrl');
    const Isolated = app.createToken<{ ver(): number }>('IsolatedCtrl');

    let ver = 1;
    app.bind(Auth, singleton(), () => ({ version: ver++ }));
    app.bind(
      Bridge,
      transient({ state: 'stateful', captures: [Auth] }),
      ([auth]) => ({ auth })
    );
    app.bind(
      Coupled,
      singleton({
        captures: [Bridge],
        discharges: [allowSnapshot(Bridge)],
        onDispose: () => console.log('  [cascade] CoupledCtrl auto-evicted!'),
      }),
      ([bridge]) => ({ ver: () => bridge.auth.version })
    );
    app.registerFn(
      Isolated,
      singleton({
        inject: [viaThunk(Auth)],
        onDispose: () =>
          console.log('  [cascade] IsolatedCtrl disposed (on shutdown only)'),
      }),
      (getAuth) => ({ ver: () => getAuth().version })
    );

    const coupled1 = app.get(Coupled);
    const isolated = app.get(Isolated);
    console.log(
      '  Before evict(Auth): coupled =',
      coupled1.ver(),
      'isolated =',
      isolated.ver()
    );

    app.evict(Auth);

    const coupled2 = app.get(Coupled);
    console.log(
      '  After  evict(Auth): coupled =',
      coupled2.ver(),
      'isolated =',
      isolated.ver()
    );
  }

  {
    using strictApp = createAssembler({
      allowedStores: ['solid'],
      onEvictCaptured: 'block',
    });
    const Core = strictApp.createToken<{ id: string }>('Core');
    const Consumer = strictApp.createToken<{ core: { id: string } }>('Consumer');

    strictApp.bind(Core, singleton(), () => ({ id: 'core-1' }));
    strictApp.bind(Consumer, singleton({ captures: [Core] }), ([core]) => ({
      core,
    }));

    strictApp.get(Consumer);

    try {
      strictApp.evict(Core);
    } catch (err) {
      if (isKernelError(err)) {
        console.log(
          `  Blocked eviction caught -> KernelError(${err.code}): ${err.message}`
        );
      }
    }
    console.log(
      '  Exiting `using strictApp` (LIFO dispose succeeds under block policy)...'
    );
  }
}

// ============================================================================
// LESSON 8: Quarantining Legacy Dynamic Code with `bindInsecure`
// ============================================================================

function lesson8QuarantiningInsecureCode(): void {
  banner(8, 'Quarantining Legacy Dynamic Code with `bindInsecure`');

  using app = createAssembler();
  const ApiKey = app.createToken<string>('ApiKey');
  const LegacySdk = app.createToken<{ call(): string }>('LegacySdk');
  const CleanGateway = app.createToken<{ run(): string }>('CleanGateway');
  const TaintedService = app.createToken<{ run(): string }>('TaintedService');

  app.registerValue(ApiKey, 'sk-live-123');

  app.bindInsecure(
    LegacySdk,
    {
      storage: 'solid',
      discharges: [[LegacySdk, TAINT_BITS.insecure]],
    },
    (get) => {
      const key = get(ApiKey);
      return { call: () => `legacy-ok(${key})` };
    }
  );

  // Quarantined behind `viaThunk` -> zero `'insecure'` taint propagation
  app.registerFn(
    CleanGateway,
    pure({ inject: [viaThunk(LegacySdk)] }),
    (getSdk) => ({ run: () => getSdk().call() })
  );

  app.assertVerified(POLICIES.strict);
  console.log('  Quarantined gateway output:', app.get(CleanGateway).run());

  // Direct capture triggers `state-leak` + `insecure`
  app.bind(
    TaintedService,
    pure({ captures: [LegacySdk] }),
    ([sdk]) => ({ run: () => sdk.call() })
  );

  const report = app.verify(POLICIES.strict);
  console.log('  Direct capture of insecure LegacySdk rejected?', !report.ok);
  console.log(formatVerificationReport(app, report));
}

// ============================================================================
// LESSON 9: Composable Modules, `as*` Descriptors & Custom `BindingDescriptor`
// ============================================================================

function asTimedSingleton<T>(
  label: string,
  fn: (this: void) => T
): BindingDescriptor<T, void> {
  return {
    bind(container: Container, token: Token<T>): void {
      container.bind(token, singleton(), () => {
        const t0 = performance.now();
        const instance = fn();
        const dt = (performance.now() - t0).toFixed(3);
        console.log(`  [custom descriptor] Built "${label}" in ${dt}ms`);
        return instance;
      });
    },
  };
}

function lesson9ModulesAndCustomDescriptors(): void {
  banner(9, 'Composable Modules, `as*` Descriptors & Custom Protocol');

  class CacheEngine {
    private readonly name: string;

    constructor(name: string) {
      this.name = name;
    }

    describe(): string {
      return `CacheEngine(${this.name})`;
    }
  }

  using app = createAssembler();
  const Name = app.createToken<string>('EngineName');
  const Engine = app.createToken<CacheEngine>('CacheEngine');
  const Summary = app.createToken<string>('Summary');
  const Timed = app.createToken<{ ready: boolean }>('TimedService');

  const registerCacheModule = (asm: Assembler): void => {
    asm.register(Name, asValue('LRU-64'));
    asm.register(Engine, asClass(CacheEngine, pure({ inject: [Name] })));
    asm.register(
      Summary,
      asFactory(pure({ captures: [Engine] }), ([engine]) => engine.describe())
    );
  };

  app.use(registerCacheModule);

  app.register(
    Timed,
    asTimedSingleton('TimedService', () => ({ ready: true }))
  );

  app.assertVerified(POLICIES.strict);
  console.log('  Summary:', app.get(Summary));
  console.log('  Timed:  ', app.get(Timed));
}

// ============================================================================
// LESSON 10: External-App Interop & Ancestor-Only Token Security
// ============================================================================

async function lesson10InteropAndTokenScoping(): Promise<void> {
  banner(10, 'External-App Interop & Ancestor-Only Token Security');

  using rawHost = createContainer({ allowedStores: ['solid', 'weak'] });
  const HostEnv = rawHost.createToken<string>('HostEnv');
  rawHost.bind(HostEnv, pure(), () => 'production-edge');

  const ext1 = extendContainer(rawHost);
  const ext2 = extendContainer(rawHost);
  console.log('  extendContainer memoized (same ref)?', ext1 === ext2);

  const RemoteConfig = ext1.createToken<Promise<{ flag(k: string): boolean }>>(
    'RemoteConfig'
  );
  ext1.registerAsync(RemoteConfig, async () => ({
    flag: (k: string) => k === 'dark-mode',
  }));

  console.log('  Raw host sees RemoteConfig?', rawHost.has(RemoteConfig));

  const externalFacade = ext1.getAsyncProxy(RemoteConfig);
  console.log(
    '  External async proxy dark-mode:',
    await externalFacade.flag('dark-mode')
  );

  using scopeA = ext1.createRequestScope();
  using scopeB = ext1.createRequestScope();

  const PrivateTokenA = scopeA.createToken<string>('PrivateTokenA');
  scopeA.registerValue(PrivateTokenA, 'secret-for-A');
  console.log('  scopeA reads PrivateTokenA:', scopeA.get(PrivateTokenA));

  try {
    scopeB.get(PrivateTokenA);
  } catch (err) {
    if (isKernelError(err)) {
      console.log(`  Sibling isolation enforced -> KernelError(${err.code})`);
    }
  }

  try {
    using broken = createAssembler();
    const Missing = broken.createToken<string>('Missing');
    const Consumer = broken.createToken<string>('Consumer');
    broken.bind(Consumer, singleton({ captures: [Missing] }), ([m]) => m);
    broken.assertVerified(POLICIES.strict);
  } catch (err) {
    if (err instanceof VerificationError) {
      console.log(
        '  Caught VerificationError with structuralErrors:',
        err.report.structuralErrors.length
      );
    }
  }
}

// ============================================================================
// RUN ALL LESSONS
// ============================================================================

async function main(): Promise<void> {
  lesson1LifetimesAndScopes();
  lesson2ClassesFunctionsAndManualFactories();
  lesson3CatchingTrapsAtBoot();
  lesson4EphemeralPassDiamonds();
  lesson5EscapeHatchesAndDischarges();
  await lesson6VirtualProxies();
  lesson7EvictionMechanics();
  lesson8QuarantiningInsecureCode();
  lesson9ModulesAndCustomDescriptors();
  await lesson10InteropAndTokenScoping();
  console.log('\nAll 10 lessons completed.');
}

void main();
