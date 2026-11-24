import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Adjust path to your compiled output of src/index.ts
import { createContainer, TAINT_BITS } from '../dist/index.js';

/**
 * Asserts that `fn` throws a KernelError with the expected machine-readable code.
 */
function assertKernelError(fn, expectedCode, expectedToken) {
  let caught;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error, `Expected KernelError("${expectedCode}"), got no error`);
  assert.equal(caught.name, 'KernelError');
  assert.equal(caught.code, expectedCode);
  if (expectedToken !== undefined) {
    assert.equal(caught.token, expectedToken);
  }
  return caught;
}

// ============================================================================
// 1. TAINT_BITS, SMI TOKENS & HIERARCHICAL TOKEN SCOPING
// ============================================================================

describe('TAINT_BITS & TokenSpace mechanics', () => {
  it('exposes exact frozen 13-bit SMI layout on TAINT_BITS', () => {
    assert.equal(Object.isFrozen(TAINT_BITS), true);
    assert.deepEqual(TAINT_BITS, {
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
    });
  });

  it('mints sequential SMI integer tokens with zero global mutable state', () => {
    const rootA = createContainer({ allowedStores: ['solid'] });
    const rootB = createContainer({ allowedStores: ['solid'] });

    const a0 = rootA.createToken('Alpha');
    const a1 = rootA.createToken();
    const b0 = rootB.createToken('Beta');

    assert.equal(typeof a0, 'number');
    assert.equal(a0, 0);
    assert.equal(a1, 1);
    // Independent roots start their own TokenSpace at 0
    assert.equal(b0, 0);

    assert.equal(rootA.getTokenName(a0), 'Alpha');
    assert.equal(rootA.getTokenName(a1), 'Token#1');
    assert.equal(rootB.getTokenName(b0), 'Beta');
  });

  it('inherits tokens strictly downward and isolates parents, siblings, and cousins', () => {
    const root = createContainer({ allowedStores: ['solid'] });
    const childA = root.createChild({ allowedStores: ['solid'] });
    const childB = root.createChild({ allowedStores: ['solid'] });
    const grandA = childA.createChild({ allowedStores: ['solid'] });
    const grandB = childB.createChild({ allowedStores: ['solid'] });

    const rootTok = root.createToken('RootTok');
    const tokA = childA.createToken('TokA');

    root.bind(rootTok, { storage: 'solid', state: 'stateless' }, () => 'root-val');
    childA.bind(tokA, { storage: 'solid', state: 'stateless' }, () => 'a-val');

    // Ancestor tokens visible to descendants
    assert.equal(grandA.has(rootTok), true);
    assert.equal(grandA.has(tokA), true);
    assert.equal(grandA.get(tokA), 'a-val');

    // Out-of-scope checks: parent, sibling, cousin
    assert.equal(root.has(tokA), false);
    assert.equal(childB.has(tokA), false);
    assert.equal(grandB.has(tokA), false);

    assertKernelError(() => root.get(tokA), 'token-out-of-scope', tokA);
    assertKernelError(() => childB.get(tokA), 'token-out-of-scope', tokA);
    assertKernelError(() => grandB.get(tokA), 'token-out-of-scope', tokA);
    assertKernelError(() => childB.evict(tokA), 'token-out-of-scope', tokA);
    assertKernelError(
      () => childB.bind(tokA, { storage: 'none', state: 'stateless' }, () => 'x'),
      'token-out-of-scope',
      tokA
    );
  });

  it('supports container.use() modules and returns their result', () => {
    const c = createContainer({ allowedStores: ['solid'] });
    const tok = c.createToken('Val');

    const result = c.use((container) => {
      assert.equal(container, c);
      container.bind(tok, { storage: 'solid', state: 'stateless' }, () => 42);
      return 'registered';
    });

    assert.equal(result, 'registered');
    assert.equal(c.get(tok), 42);
  });
});

// ============================================================================
// 2. STORAGE TIERS & ALLOWED STORES
// ============================================================================

describe('Storage tiers (solid, none, ephemeral, weak) & allowedStores', () => {
  it('solid caches once, hits warm fast path, and caches falsy/undefined/null values', () => {
    const c = createContainer({ allowedStores: ['solid'] });
    const cases = [undefined, null, 0, false, '', NaN];

    for (let i = 0; i < cases.length; i++) {
      const expected = cases[i];
      const tok = c.createToken(`Falsy#${i}`);
      let calls = 0;
      c.bind(tok, { storage: 'solid', state: 'stateless' }, () => {
        calls++;
        return expected;
      });

      const first = c.get(tok);
      const second = c.get(tok);
      assert.equal(Object.is(first, expected), true);
      assert.equal(Object.is(second, expected), true);
      assert.equal(calls, 1);
    }
  });

  it('none invokes factory on every get() and treats evict() as no-op', () => {
    const c = createContainer({ allowedStores: [] });
    const tok = c.createToken('Transient');
    let seq = 0;

    c.bind(tok, { storage: 'none', state: 'stateless' }, () => ({ id: ++seq }));

    const a = c.get(tok);
    const b = c.get(tok);
    assert.notEqual(a, b);
    assert.equal(a.id, 1);
    assert.equal(b.id, 2);

    // Must not throw
    c.evict(tok);
    assert.equal(c.get(tok).id, 3);
  });

  it('ephemeral shares within a single get() diamond and flushes in LIFO order', () => {
    const c = createContainer({ allowedStores: [] });
    const disposed = [];
    let uowSeq = 0;

    const uowTok = c.createToken('UoW');
    const branchATok = c.createToken('BranchA');
    const branchBTok = c.createToken('BranchB');
    const rootTok = c.createToken('Root');

    c.bind(
      uowTok,
      {
        storage: 'ephemeral',
        state: 'stateful',
        onDispose: (v) => disposed.push(`uow:${v.id}`),
      },
      () => ({ id: ++uowSeq })
    );
    c.bind(
      branchATok,
      {
        storage: 'ephemeral',
        state: 'stateful',
        captures: [uowTok],
        onDispose: () => disposed.push('branchA'),
      },
      ([uow]) => ({ uow })
    );
    c.bind(
      branchBTok,
      {
        storage: 'ephemeral',
        state: 'stateful',
        captures: [uowTok],
        onDispose: () => disposed.push('branchB'),
      },
      ([uow]) => ({ uow })
    );
    c.bind(
      rootTok,
      {
        storage: 'none',
        state: 'stateless',
        captures: [branchATok, branchBTok],
      },
      ([a, b]) => ({ a, b })
    );

    const pass1 = c.get(rootTok);
    assert.equal(pass1.a.uow, pass1.b.uow);
    assert.equal(pass1.a.uow.id, 1);
    // Created in order: uow, branchA, branchB -> flushed in exact LIFO
    assert.deepEqual(disposed, ['branchB', 'branchA', 'uow:1']);

    const pass2 = c.get(rootTok);
    assert.equal(pass2.a.uow.id, 2);
    assert.notEqual(pass2.a.uow, pass1.a.uow);
  });

  it('flushes already-created ephemerals even when a later factory throws', () => {
    const c = createContainer({ allowedStores: [] });
    const flushed = [];

    const ephTok = c.createToken('Eph');
    const boomTok = c.createToken('Boom');
    const topTok = c.createToken('Top');

    c.bind(
      ephTok,
      {
        storage: 'ephemeral',
        state: 'stateful',
        onDispose: (v) => flushed.push(v.name),
      },
      () => ({ name: 'opened-tx' })
    );
    c.bind(boomTok, { storage: 'none', state: 'stateless' }, () => {
      throw new Error('boom');
    });
    c.bind(
      topTok,
      { storage: 'none', state: 'stateless', captures: [ephTok, boomTok] },
      () => 'unreachable'
    );

    assert.throws(() => c.get(topTok), /boom/);
    assert.deepEqual(flushed, ['opened-tx']);
  });

  it('weak caches objects and functions, and rejects all primitive values', () => {
    const c = createContainer({ allowedStores: ['weak'] });
    const objTok = c.createToken('WeakObj');
    const fnTok = c.createToken('WeakFn');

    let objCalls = 0;
    c.bind(objTok, { storage: 'weak', state: 'stateless' }, () => ({
      n: ++objCalls,
    }));
    const o1 = c.get(objTok);
    const o2 = c.get(objTok);
    assert.equal(o1, o2);
    assert.equal(objCalls, 1);

    let fnCalls = 0;
    c.bind(fnTok, { storage: 'weak', state: 'stateless' }, () => {
      const id = ++fnCalls;
      return () => id;
    });
    const f1 = c.get(fnTok);
    const f2 = c.get(fnTok);
    assert.equal(f1, f2);
    assert.equal(f1(), 1);

    const primitives = [null, undefined, 123, 'str', true, 10n, Symbol('s')];
    for (let i = 0; i < primitives.length; i++) {
      const pTok = c.createToken(`Prim#${i}`);
      const val = primitives[i];
      c.bind(pTok, { storage: 'weak', state: 'stateless' }, () => val);
      assertKernelError(() => c.get(pTok), 'weak-primitive-value', pTok);
    }
  });

  it('enforces allowedStores eagerly for provider targets and at get() for caller targets', () => {
    const noStores = createContainer({ allowedStores: [] });
    const solidTok = noStores.createToken('Solid');
    const weakTok = noStores.createToken('Weak');

    assertKernelError(
      () => noStores.bind(solidTok, { storage: 'solid', state: 'stateless' }, () => 1),
      'disallowed-storage',
      solidTok
    );
    assertKernelError(
      () => noStores.bind(weakTok, { storage: 'weak', state: 'stateless' }, () => ({})),
      'disallowed-storage',
      weakTok
    );

    // Caller-targeted binding succeeds on root even if root disallows solid,
    // fails when resolved on a container disallowing solid, succeeds on child allowing solid.
    const callerTok = noStores.createToken('CallerSolid');
    noStores.bind(
      callerTok,
      { storage: 'solid', target: 'caller', state: 'stateful' },
      () => ({ ok: true })
    );

    assertKernelError(() => noStores.get(callerTok), 'disallowed-storage', callerTok);

    const solidChild = noStores.createChild({ allowedStores: ['solid'] });
    assert.deepEqual(solidChild.get(callerTok), { ok: true });
  });
});

// ============================================================================
// 3. STORAGE TARGETS, LEXICAL SCOPE ISOLATION & CHILD SHADOWING
// ============================================================================

describe('Targets (provider vs caller), lexical scoping & shadowing', () => {
  it('isolates caller-targeted instances per child and disposes them with the child', () => {
    const root = createContainer({ allowedStores: ['solid'] });
    const disposed = [];
    let seq = 0;

    const scopedTok = root.createToken('Scoped');
    root.bind(
      scopedTok,
      {
        storage: 'solid',
        target: 'caller',
        state: 'stateful',
        onDispose: (v) => disposed.push(v.id),
      },
      () => ({ id: ++seq })
    );

    const c1 = root.createChild({ allowedStores: ['solid'] });
    const c2 = root.createChild({ allowedStores: ['solid'] });

    const i1a = c1.get(scopedTok);
    const i1b = c1.get(scopedTok);
    const i2 = c2.get(scopedTok);

    assert.equal(i1a, i1b);
    assert.notEqual(i1a, i2);

    c1.dispose();
    assert.deepEqual(disposed, [1]);
    assert.equal(c2.get(scopedTok), i2);

    c2.dispose();
    assert.deepEqual(disposed, [1, 2]);
  });

  it('resolves provider-retained bindings lexically in owner scope (immune to child overrides)', () => {
    const root = createContainer({ allowedStores: ['solid'] });
    const envTok = root.createToken('Env');
    const providerSvc = root.createToken('ProviderSvc');
    const callerSvc = root.createToken('CallerSvc');
    const transientSvc = root.createToken('TransientSvc');

    root.bind(envTok, { storage: 'solid', state: 'stateless' }, () => 'ROOT');
    root.bind(
      providerSvc,
      { storage: 'solid', target: 'provider', state: 'stateless', captures: [envTok] },
      ([env]) => `provider:${env}`
    );
    root.bind(
      callerSvc,
      { storage: 'solid', target: 'caller', state: 'stateless', captures: [envTok] },
      ([env]) => `caller:${env}`
    );
    root.bind(
      transientSvc,
      { storage: 'none', state: 'stateless', captures: [envTok] },
      ([env]) => `transient:${env}`
    );

    const child = root.createChild({ allowedStores: ['solid'] });
    child.bind(envTok, { storage: 'solid', state: 'stateless' }, () => 'CHILD');

    // Even when first triggered from child, providerSvc resolves envTok in root!
    assert.equal(child.get(providerSvc), 'provider:ROOT');
    // Caller-targeted and transient bindings see child's override
    assert.equal(child.get(callerSvc), 'caller:CHILD');
    assert.equal(child.get(transientSvc), 'transient:CHILD');
  });

  it('evicts cached inherited caller-targeted entry when child installs a shadow binding', () => {
    const root = createContainer({ allowedStores: ['solid'] });
    const tok = root.createToken('Shadowed');
    const disposed = [];

    root.bind(
      tok,
      {
        storage: 'solid',
        target: 'caller',
        state: 'stateful',
        onDispose: (v) => disposed.push(v),
      },
      () => 'from-root'
    );

    const child = root.createChild({ allowedStores: ['solid'] });
    // Warm child's solidStore with inherited caller-targeted instance
    assert.equal(child.get(tok), 'from-root');

    // Now shadow `tok` on child — must evict 'from-root' so warm fast path isn't stale!
    child.bind(tok, { storage: 'solid', state: 'stateful' }, () => 'from-child');
    assert.deepEqual(disposed, ['from-root']);
    assert.equal(child.get(tok), 'from-child');
  });
});

// ============================================================================
// 4. CAPTURES, DEPS THUNKS, RUNTIME CYCLES & ROLLBACK SAFETY
// ============================================================================

describe('Captures, deps thunks, cycles & rollback safety', () => {
  it('passes captures/deps positionally and invokes factories & hooks with this === undefined', () => {
    const c = createContainer({ allowedStores: ['solid'] });
    const aTok = c.createToken('A');
    const bTok = c.createToken('B');
    const targetTok = c.createToken('Target');

    const observedThis = [];

    c.bind(aTok, { storage: 'solid', state: 'stateless' }, function () {
      observedThis.push(this);
      return 'A';
    });
    c.bind(bTok, { storage: 'solid', state: 'stateless' }, function () {
      observedThis.push(this);
      return 'B';
    });
    c.bind(
      targetTok,
      {
        storage: 'solid',
        state: 'stateless',
        captures: [aTok],
        deps: [bTok],
        onDispose: function () {
          observedThis.push(this);
        },
      },
      function ([a], [getB]) {
        observedThis.push(this);
        return `${a}+${getB()}`;
      }
    );

    assert.equal(c.get(targetTok), 'A+B');
    c.evict(targetTok);
    assert.equal(observedThis.length, 4);
    for (const t of observedThis) {
      assert.equal(t, undefined);
    }
  });

  it('detaches deps thunks from capturerStack even when invoked during construction', () => {
    const c = createContainer({ allowedStores: ['solid'] });
    const depTok = c.createToken('Dep');
    const consumerTok = c.createToken('Consumer');
    let consumerDisposed = false;

    c.bind(depTok, { storage: 'solid', state: 'stateful' }, () => ({ v: 1 }));
    c.bind(
      consumerTok,
      {
        storage: 'solid',
        state: 'stateful',
        deps: [depTok],
        onDispose: () => {
          consumerDisposed = true;
        },
      },
      (_caps, [getDep]) => {
        // Invoked synchronously inside constructor, yet MUST NOT capture depTok!
        const initial = getDep();
        return { initial, read: () => getDep() };
      }
    );

    c.get(consumerTok);
    c.evict(depTok);
    assert.equal(consumerDisposed, false);
  });

  it('detects hard capture cycles at runtime and allows lazy thunk cycles', () => {
    const c = createContainer({ allowedStores: ['solid'] });
    const aTok = c.createToken('A');
    const bTok = c.createToken('B');

    c.bind(aTok, { storage: 'solid', state: 'stateless', captures: [bTok] }, ([b]) => b);
    c.bind(bTok, { storage: 'solid', state: 'stateless', captures: [aTok] }, ([a]) => a);

    const err = assertKernelError(() => c.get(aTok), 'capture-cycle', aTok);
    assert.deepEqual(err.relatedTokens, [aTok, bTok, aTok]);

    // Lazy mutual cycle via `deps` resolves cleanly
    const c2 = createContainer({ allowedStores: ['solid'] });
    const xTok = c2.createToken('X');
    const yTok = c2.createToken('Y');

    c2.bind(
      xTok,
      { storage: 'solid', state: 'stateful', deps: [yTok] },
      (_c, [getY]) => ({ name: 'X', peer: () => getY().name })
    );
    c2.bind(
      yTok,
      { storage: 'solid', state: 'stateful', deps: [xTok] },
      (_c, [getX]) => ({ name: 'Y', peer: () => getX().name })
    );

    const x = c2.get(xTok);
    assert.equal(x.peer(), 'Y');
    assert.equal(c2.get(yTok).peer(), 'X');
  });

  it('rolls back partial capture links if a factory throws during construction', () => {
    const c = createContainer({
      allowedStores: ['solid'],
      onEvictCaptured: 'block',
    });
    const depTok = c.createToken('Dep');
    const failingTok = c.createToken('Failing');

    c.bind(depTok, { storage: 'solid', state: 'stateful' }, () => ({ ok: true }));
    c.bind(
      failingTok,
      { storage: 'solid', state: 'stateful', captures: [depTok] },
      () => {
        throw new Error('ctor failed');
      }
    );

    assert.throws(() => c.get(failingTok), /ctor failed/);

    // Because partial links were rolled back, evicting depTok MUST NOT be blocked!
    assert.doesNotThrow(() => c.evict(depTok));
  });
});

// ============================================================================
// 5. EVICTION POLICIES, TRANSITIVE PASS-THROUGH, HOOKS & LIFO DISPOSAL
// ============================================================================

describe('Eviction policies (cascade, block, orphan), hooks & LIFO disposal', () => {
  it('cascades reverse-topologically through transient (none) bridges and fires onDecapture', () => {
    const c = createContainer({
      allowedStores: ['solid'],
      onEvictCaptured: 'cascade',
    });
    const log = [];
    let authVer = 0;

    const authTok = c.createToken('Auth');
    const bridgeTok = c.createToken('Bridge');
    const ctrlATok = c.createToken('CtrlA');
    const ctrlBTok = c.createToken('CtrlB');

    c.bind(
      authTok,
      {
        storage: 'solid',
        state: 'stateful',
        onDecapture: (inst, remaining) => log.push(`decap:auth(v${inst.v}):${remaining}`),
        onDispose: (inst) => log.push(`dispose:auth(v${inst.v})`),
      },
      () => ({ v: ++authVer })
    );
    c.bind(
      bridgeTok,
      { storage: 'none', state: 'stateful', captures: [authTok] },
      ([auth]) => ({ auth })
    );
    c.bind(
      ctrlATok,
      {
        storage: 'solid',
        state: 'stateful',
        captures: [bridgeTok],
        onDispose: () => log.push('dispose:ctrlA'),
      },
      ([b]) => ({ ver: () => b.auth.v })
    );
    c.bind(
      ctrlBTok,
      {
        storage: 'solid',
        state: 'stateful',
        captures: [authTok],
        onDispose: () => log.push('dispose:ctrlB'),
      },
      ([auth]) => ({ ver: () => auth.v })
    );

    assert.equal(c.get(ctrlATok).ver(), 1);
    assert.equal(c.get(ctrlBTok).ver(), 1);

    // Evicting ctrlA alone decrements Auth's capturers from 2 -> 1
    c.evict(ctrlATok);
    assert.deepEqual(log, ['decap:auth(v1):1', 'dispose:ctrlA']);

    // Re-instantiate ctrlA, then evict Auth -> cascades to ctrlB and ctrlA before Auth
    log.length = 0;
    c.get(ctrlATok);
    c.evict(authTok);

    assert.equal(log[log.length - 1], 'dispose:auth(v1)');
    assert.ok(log.includes('dispose:ctrlA'));
    assert.ok(log.includes('dispose:ctrlB'));
    // Rebuilding picks up v2 with no split-brain
    assert.equal(c.get(ctrlATok).ver(), 2);
  });

  it('forwards retained captures through cached ephemeral diamonds for cascade eviction', () => {
    const c = createContainer({ allowedStores: ['solid'] });
    const disposed = [];

    const leafTok = c.createToken('Leaf');
    const ephTok = c.createToken('Eph');
    const leftTok = c.createToken('Left');
    const rightTok = c.createToken('Right');
    const topTok = c.createToken('Top');

    c.bind(
      leafTok,
      {
        storage: 'solid',
        state: 'stateful',
        onDispose: () => disposed.push('leaf'),
      },
      () => ({ v: 1 })
    );
    c.bind(
      ephTok,
      { storage: 'ephemeral', state: 'stateful', captures: [leafTok] },
      ([leaf]) => ({ leaf })
    );
    c.bind(
      leftTok,
      {
        storage: 'solid',
        state: 'stateful',
        captures: [ephTok],
        onDispose: () => disposed.push('left'),
      },
      ([e]) => ({ e })
    );
    c.bind(
      rightTok,
      {
        storage: 'solid',
        state: 'stateful',
        captures: [ephTok],
        onDispose: () => disposed.push('right'),
      },
      ([e]) => ({ e })
    );
    c.bind(
      topTok,
      { storage: 'none', state: 'stateless', captures: [leftTok, rightTok] },
      ([l, r]) => ({ l, r })
    );

    const { l, r } = c.get(topTok);
    // Both left and right received the same cached ephemeral
    assert.equal(l.e, r.e);

    // Evicting leaf MUST cascade to BOTH left (miss) AND right (ephemeral cache hit!)
    c.evict(leafTok);
    assert.ok(disposed.includes('left'));
    assert.ok(disposed.includes('right'));
    assert.equal(disposed[disposed.length - 1], 'leaf');
  });

  it('enforces onEvictCaptured: "block" on evict(), yet disposes cleanly in LIFO order', () => {
    const c = createContainer({
      allowedStores: ['solid', 'weak'],
      onEvictCaptured: 'block',
    });
    const order = [];

    const baseTok = c.createToken('Base');
    const weakMidTok = c.createToken('WeakMid');
    const topTok = c.createToken('Top');

    c.bind(
      baseTok,
      {
        storage: 'solid',
        state: 'stateful',
        onDispose: () => order.push('base'),
      },
      () => ({ id: 'base' })
    );
    c.bind(
      weakMidTok,
      {
        storage: 'weak',
        state: 'stateless',
        captures: [baseTok],
        onDispose: () => order.push('weakMid'),
      },
      ([base]) => ({ base })
    );
    c.bind(
      topTok,
      {
        storage: 'solid',
        state: 'stateful',
        captures: [weakMidTok],
        onDispose: () => order.push('top'),
      },
      ([mid]) => ({ mid })
    );

    const top = c.get(topTok);
    assert.ok(top.mid.base.id === 'base');

    const blockedErr = assertKernelError(() => c.evict(baseTok), 'eviction-blocked', baseTok);
    assert.deepEqual(blockedErr.relatedTokens, [weakMidTok]);

    // LIFO teardown across mixed solid + weak stores succeeds without throwing!
    c.dispose();
    assert.deepEqual(order, ['top', 'weakMid', 'base']);
    assert.equal(c.disposed, true);
    assert.equal(c.has(baseTok), false);

    // Idempotent dispose & dead-container guards
    assert.doesNotThrow(() => c.dispose());
    assertKernelError(() => c.get(baseTok), 'container-disposed');
    assertKernelError(() => c.createToken('Dead'), 'container-disposed');
    assertKernelError(() => c.verify(), 'container-disposed');
  });

  it('supports onEvictCaptured: "orphan" and [Symbol.dispose]()', () => {
    const c = createContainer({
      allowedStores: ['solid'],
      onEvictCaptured: 'orphan',
    });
    const disposed = [];

    const depTok = c.createToken('Dep');
    const capTok = c.createToken('Cap');

    c.bind(
      depTok,
      { storage: 'solid', state: 'stateful', onDispose: () => disposed.push('dep') },
      () => ({ n: 1 })
    );
    c.bind(
      capTok,
      {
        storage: 'solid',
        state: 'stateful',
        captures: [depTok],
        onDispose: () => disposed.push('cap'),
      },
      ([dep]) => ({ dep })
    );

    const cap = c.get(capTok);
    c.evict(depTok);

    // Dep evicted, capturer left alive and orphaned
    assert.deepEqual(disposed, ['dep']);
    assert.equal(c.get(capTok), cap);

    // Symbol.dispose tears down remaining entries cleanly
    c[Symbol.dispose]();
    assert.deepEqual(disposed, ['dep', 'cap']);
    assert.equal(c.disposed, true);
  });

  it('detaches remaining back-references even if an onDecapture callback throws', () => {
    const c = createContainer({
      allowedStores: ['solid'],
      onEvictCaptured: 'block',
    });

    const d1 = c.createToken('D1');
    const d2 = c.createToken('D2');
    const cap = c.createToken('Cap');

    c.bind(
      d1,
      {
        storage: 'solid',
        state: 'stateful',
        onDecapture: () => {
          throw new Error('decapture-boom');
        },
      },
      () => ({ id: 1 })
    );
    c.bind(d2, { storage: 'solid', state: 'stateful' }, () => ({ id: 2 }));
    c.bind(cap, { storage: 'solid', state: 'stateful', captures: [d1, d2] }, () => ({}));

    c.get(cap);
    assert.throws(() => c.evict(cap), /decapture-boom/);

    // Even though d1's onDecapture threw, d2 was STILL detached cleanly!
    assert.doesNotThrow(() => c.evict(d2));
  });
});

// ============================================================================
// 6. PROVIDER-ONLY REBINDING & EXCEPTION ATOMICITY
// ============================================================================

describe('Provider-only rebinding & atomicity', () => {
  it('returns undefined when rebindable is false/omitted and a typed rebinder when true', () => {
    const c = createContainer({ allowedStores: ['solid'] });
    const fixedTok = c.createToken('Fixed');
    const mutTok = c.createToken('Mut');

    const noHandle = c.bind(fixedTok, { storage: 'solid', state: 'stateless' }, () => 1);
    assert.equal(noHandle, undefined);

    const rebind = c.bind(
      mutTok,
      { storage: 'solid', state: 'stateless', rebindable: true },
      () => 'v1'
    );
    assert.equal(typeof rebind, 'function');
    assert.equal(c.get(mutTok), 'v1');

    rebind(() => 'v2');
    assert.equal(c.get(mutTok), 'v2');
  });

  it('is strongly exception-safe: blocked eviction leaves the original factory intact', () => {
    const c = createContainer({
      allowedStores: ['solid'],
      onEvictCaptured: 'block',
    });
    const clockTok = c.createToken('Clock');
    const holderTok = c.createToken('Holder');

    const rebindClock = c.bind(
      clockTok,
      { storage: 'solid', state: 'stateless', rebindable: true },
      () => 100
    );
    c.bind(
      holderTok,
      { storage: 'solid', state: 'stateful', captures: [clockTok] },
      ([t]) => ({ t })
    );

    c.get(holderTok);
    assertKernelError(() => rebindClock(() => 999), 'eviction-blocked', clockTok);

    // After evicting holder and clock, factory must STILL be the original () => 100
    c.evict(holderTok);
    c.evict(clockTok);
    assert.equal(c.get(clockTok), 100);

    // Calling rebind after dispose throws container-disposed
    c.dispose();
    assertKernelError(() => rebindClock(() => 200), 'container-disposed');
  });

  it('rebinds caller-targeted bindings for future scopes without mutating existing scopes', () => {
    const root = createContainer({ allowedStores: ['solid'] });
    const tok = root.createToken('ScopedMut');

    const rebind = root.bind(
      tok,
      { storage: 'solid', target: 'caller', state: 'stateful', rebindable: true },
      () => 'old'
    );

    const child1 = root.createChild({ allowedStores: ['solid'] });
    assert.equal(child1.get(tok), 'old');

    rebind(() => 'new');
    // Existing cached child1 keeps its instance; new child2 sees 'new'
    assert.equal(child1.get(tok), 'old');
    const child2 = root.createChild({ allowedStores: ['solid'] });
    assert.equal(child2.get(tok), 'new');
  });
});

// ============================================================================
// 7. bindInsecure ESCAPE HATCH
// ============================================================================

describe('bindInsecure escape hatch', () => {
  it('resolves dynamically, tracks synchronous construction captures, and respects lexical scope', () => {
    const root = createContainer({ allowedStores: ['solid'] });
    const cfgTok = root.createToken('Cfg');
    const lateTok = root.createToken('Late');
    const legacyTok = root.createToken('Legacy');

    let legacyDisposed = 0;

    root.bind(cfgTok, { storage: 'solid', state: 'stateful' }, () => ({ env: 'root' }));
    root.bind(lateTok, { storage: 'solid', state: 'stateful' }, () => ({ v: 1 }));

    const rebindLegacy = root.bindInsecure(
      legacyTok,
      {
        storage: 'solid',
        rebindable: true,
        onDispose: () => {
          legacyDisposed++;
        },
      },
      (get) => {
        // Synchronous resolution during construction -> captured!
        const cfg = get(cfgTok);
        // Deferred resolution after construction -> NOT captured!
        return { env: cfg.env, readLate: () => get(lateTok).v };
      }
    );

    const child = root.createChild({ allowedStores: ['solid'] });
    child.bind(cfgTok, { storage: 'solid', state: 'stateful' }, () => ({ env: 'child' }));

    // Lexical scope isolation: provider-targeted insecure binding resolves in root!
    const inst = child.get(legacyTok);
    assert.equal(inst.env, 'root');
    assert.equal(inst.readLate(), 1);

    // Evicting lateTok does NOT cascade to legacyTok
    root.evict(lateTok);
    assert.equal(legacyDisposed, 0);

    // Evicting cfgTok DOES cascade to legacyTok (synchronous spy tracking)
    root.evict(cfgTok);
    assert.equal(legacyDisposed, 1);

    // Rebinding works
    rebindLegacy(() => ({ env: 'swapped', readLate: () => 99 }));
    assert.equal(root.get(legacyTok).env, 'swapped');
  });
});

// ============================================================================
// 8. bind() VALIDATION GUARDS (SMALL <=4 & LARGE >4 PATHS)
// ============================================================================

describe('bind() input validation guards', () => {
  it('rejects duplicate bindings and edge errors on both small (<=4) and large (>4) paths', () => {
    const c = createContainer({ allowedStores: ['solid'] });
    const toks = Array.from({ length: 7 }, (_, i) => c.createToken(`T${i}`));

    c.bind(toks[0], { storage: 'none', state: 'stateless' }, () => 0);
    assertKernelError(
      () => c.bind(toks[0], { storage: 'none', state: 'stateless' }, () => 1),
      'duplicate-binding',
      toks[0]
    );

    // Small path (<= 4)
    const sDupCap = c.createToken('SmallDupCap');
    assertKernelError(
      () =>
        c.bind(
          sDupCap,
          { storage: 'none', state: 'stateless', captures: [toks[0], toks[0]] },
          () => 0
        ),
      'duplicate-capture',
      sDupCap
    );

    const sDupDep = c.createToken('SmallDupDep');
    assertKernelError(
      () =>
        c.bind(
          sDupDep,
          { storage: 'none', state: 'stateless', deps: [toks[0], toks[0]] },
          () => 0
        ),
      'duplicate-dep',
      sDupDep
    );

    const sOverlap = c.createToken('SmallOverlap');
    assertKernelError(
      () =>
        c.bind(
          sOverlap,
          { storage: 'none', state: 'stateless', captures: [toks[0]], deps: [toks[0]] },
          () => 0
        ),
      'overlapping-capture-and-dep',
      sOverlap
    );

    // Large path (> 4)
    const lDupCap = c.createToken('LargeDupCap');
    assertKernelError(
      () =>
        c.bind(
          lDupCap,
          {
            storage: 'none',
            state: 'stateless',
            captures: [toks[0], toks[1], toks[2], toks[3], toks[4], toks[2]],
          },
          () => 0
        ),
      'duplicate-capture',
      lDupCap
    );

    const lDupDep = c.createToken('LargeDupDep');
    assertKernelError(
      () =>
        c.bind(
          lDupDep,
          {
            storage: 'none',
            state: 'stateless',
            deps: [toks[0], toks[1], toks[2], toks[3], toks[4], toks[1]],
          },
          () => 0
        ),
      'duplicate-dep',
      lDupDep
    );

    const lOverlap = c.createToken('LargeOverlap');
    assertKernelError(
      () =>
        c.bind(
          lOverlap,
          {
            storage: 'none',
            state: 'stateless',
            captures: [toks[0], toks[1], toks[2], toks[3], toks[4]],
            deps: [toks[5], toks[3]],
          },
          () => 0
        ),
      'overlapping-capture-and-dep',
      lOverlap
    );
  });

  it('rejects out-of-scope tokens in discharges', () => {
    const root = createContainer({ allowedStores: ['solid'] });
    const child = root.createChild({ allowedStores: ['solid'] });
    const childTok = child.createToken('ChildTok');
    const rootTok = root.createToken('RootTok');

    assertKernelError(
      () =>
        root.bind(
          rootTok,
          {
            storage: 'solid',
            state: 'stateless',
            discharges: [[childTok, TAINT_BITS['frozen-none']]],
          },
          () => 1
        ),
      'token-out-of-scope',
      childTok
    );
  });
});

// ============================================================================
// 9. verify() STRUCTURAL VALIDATION & COMPLETE 4×4 STORAGE MATRIX
// ============================================================================

describe('verify() structural checks & complete 4x4 storage capture matrix', () => {
  it('is purely read-only (executes zero factories) and reports all structural error kinds', () => {
    let factoryCalls = 0;
    const root = createContainer({ allowedStores: ['solid'] });
    const childOnlyTok = root.createToken('ChildOnly');
    const rootSvc = root.createToken('RootSvc');
    const scopedTok = root.createToken('Scoped');
    const cycA = root.createToken('CycA');
    const cycB = root.createToken('CycB');
    const missingDep = root.createToken('MissingDep');
    const callerConsumer = root.createToken('CallerConsumer');

    // 1. Provider-targeted root binding capturing a token bound ONLY on child -> lexical unbound error!
    root.bind(
      rootSvc,
      { storage: 'solid', target: 'provider', state: 'stateless', captures: [childOnlyTok] },
      () => {
        factoryCalls++;
        return 1;
      }
    );
    // 2. Caller-targeted solid binding
    root.bind(
      scopedTok,
      { storage: 'solid', target: 'caller', state: 'stateless' },
      () => {
        factoryCalls++;
        return 2;
      }
    );
    // 3. Hard capture cycle
    root.bind(cycA, { storage: 'none', state: 'stateless', captures: [cycB] }, () => ++factoryCalls);
    root.bind(cycB, { storage: 'none', state: 'stateless', captures: [cycA] }, () => ++factoryCalls);

    // Child disallows solid stores, binds childOnlyTok, and has an unbound dep
    const child = root.createChild({ allowedStores: [] });
    child.bind(childOnlyTok, { storage: 'none', state: 'stateless' }, () => ++factoryCalls);
    child.bind(
      callerConsumer,
      { storage: 'none', state: 'stateless', deps: [missingDep] },
      () => ++factoryCalls
    );

    const report = child.verify();
    assert.equal(factoryCalls, 0);
    assert.equal(report.ok, false);

    const kinds = report.structuralErrors.map((e) => e.kind);
    assert.ok(kinds.includes('disallowed-caller-store'));
    assert.ok(kinds.includes('capture-cycle'));

    const lexicalErr = report.structuralErrors.find(
      (e) =>
        e.kind === 'unbound-dependency' &&
        e.dependent === rootSvc &&
        e.missing === childOnlyTok
    );
    assert.ok(lexicalErr);
    assert.equal(lexicalErr.edge, 'capture');
    assert.equal(lexicalErr.resolutionScope, 'provider');

    const callerErr = report.structuralErrors.find(
      (e) =>
        e.kind === 'unbound-dependency' &&
        e.dependent === callerConsumer &&
        e.missing === missingDep
    );
    assert.ok(callerErr);
    assert.equal(callerErr.edge, 'dep');
    assert.equal(callerErr.resolutionScope, 'caller');
  });

  it('emits exact bitmasks for all 16 entries of the 4x4 storage capture matrix', () => {
    const storages = ['none', 'ephemeral', 'solid', 'weak'];
    const expected = {
      none: {
        none: 0,
        ephemeral: TAINT_BITS['escaped-ephemeral'],
        solid: 0,
        weak: 0,
      },
      ephemeral: {
        none: TAINT_BITS['frozen-none'],
        ephemeral: 0,
        solid: TAINT_BITS['eviction-coupled'],
        weak: TAINT_BITS['weak-pinned'],
      },
      solid: {
        none: TAINT_BITS['frozen-none'],
        ephemeral: TAINT_BITS['captive-ephemeral'],
        solid: TAINT_BITS['eviction-coupled'],
        weak: TAINT_BITS['weak-pinned'] | TAINT_BITS['eviction-coupled'],
      },
      weak: {
        none: TAINT_BITS['frozen-none'],
        ephemeral: TAINT_BITS['captive-ephemeral'],
        solid: TAINT_BITS['eviction-coupled'],
        weak: TAINT_BITS['weak-pinned'] | TAINT_BITS['eviction-coupled'],
      },
    };

    const c = createContainer({ allowedStores: ['solid', 'weak'] });
    const depTokens = {};
    for (const s of storages) {
      const tok = c.createToken(`dep_${s}`);
      c.bind(tok, { storage: s, state: 'stateless' }, () => ({}));
      depTokens[s] = tok;
    }

    const pairs = [];
    for (const a of storages) {
      for (const b of storages) {
        const tok = c.createToken(`${a}_captures_${b}`);
        c.bind(tok, { storage: a, state: 'stateless', captures: [depTokens[b]] }, () => ({}));
        pairs.push({ a, b, tok, depTok: depTokens[b] });
      }
    }

    const report = c.verify();
    assert.equal(report.ok, true);

    for (const { a, b, tok, depTok } of pairs) {
      const fact = report.folded.get(tok)?.get(depTok);
      assert.ok(fact, `Missing fact for ${a} -> ${b}`);
      assert.equal(
        fact.mask,
        expected[a][b],
        `Matrix mismatch for ${a} -> ${b}: got ${fact.mask}, expected ${expected[a][b]}`
      );
      assert.equal(fact.relation, 'direct');
      assert.equal(fact.diamond, false);
    }
  });
});

// ============================================================================
// 10. verify() SEMANTIC TAINTS, DIAMONDS, SHADOWING & PROPAGATION
// ============================================================================

describe('verify() semantic taints, diamonds, shadowing & propagation', () => {
  it('detects captive-caller, volatile-state, state-leak, pinned-mutable, insecure, and thunk-cycle', () => {
    const c = createContainer({ allowedStores: ['solid', 'weak'] });

    const scopedTok = c.createToken('Scoped');
    const mutTok = c.createToken('Mut');
    const weakStateful = c.createToken('WeakStateful');
    const insecureTok = c.createToken('Insecure');
    const solidProvider = c.createToken('SolidProvider');
    const pureConsumer = c.createToken('PureConsumer');
    const quarantined = c.createToken('Quarantined');
    const cyc1 = c.createToken('ThunkCyc1');
    const cyc2 = c.createToken('ThunkCyc2');

    c.bind(scopedTok, { storage: 'solid', target: 'caller', state: 'stateless' }, () => 1);
    c.bind(mutTok, { storage: 'solid', state: 'stateless', rebindable: true }, () => 2);
    c.bind(weakStateful, { storage: 'weak', state: 'stateful' }, () => ({}));
    c.bindInsecure(insecureTok, { storage: 'solid' }, () => ({}));

    c.bind(
      solidProvider,
      { storage: 'solid', target: 'provider', state: 'stateful', captures: [scopedTok, mutTok] },
      () => ({})
    );
    c.bind(
      pureConsumer,
      { storage: 'solid', state: 'stateless', captures: [insecureTok] },
      () => ({})
    );
    // Thunk firewall: does NOT inherit insecure or state-leak
    c.bind(
      quarantined,
      { storage: 'solid', state: 'stateless', deps: [insecureTok] },
      () => ({})
    );
    // Lazy cycle involving 1 capture + 1 thunk
    c.bind(cyc1, { storage: 'solid', state: 'stateless', captures: [cyc2] }, () => 1);
    c.bind(cyc2, { storage: 'solid', state: 'stateless', deps: [cyc1] }, () => 2);

    const report = c.verify();
    assert.equal(report.ok, true);

    assert.equal(
      report.folded.get(solidProvider)?.get(scopedTok)?.taints.has('captive-caller'),
      true
    );
    assert.equal(
      report.folded.get(solidProvider)?.get(mutTok)?.taints.has('pinned-mutable'),
      true
    );

    const weakSelf = report.folded.get(weakStateful)?.get(weakStateful);
    assert.equal(weakSelf?.relation, 'self');
    assert.equal(weakSelf?.taints.has('volatile-state'), true);

    const insecureSelf = report.folded.get(insecureTok)?.get(insecureTok);
    assert.equal(insecureSelf?.taints.has('insecure'), true);

    const pureFact = report.folded.get(pureConsumer)?.get(insecureTok);
    assert.equal(pureFact?.taints.has('insecure'), true);
    assert.equal(pureFact?.taints.has('state-leak'), true);

    // Quarantined has no captured facts at all
    assert.equal(report.folded.get(quarantined)?.size, 0);

    // Both nodes in thunk cycle get 'thunk-cycle' on self
    assert.equal(report.folded.get(cyc1)?.get(cyc1)?.taints.has('thunk-cycle'), true);
    assert.equal(report.folded.get(cyc2)?.get(cyc2)?.taints.has('thunk-cycle'), true);
  });

  it('recomputes local storage taints on transitive paths (escaped-ephemeral -> captive-ephemeral)', () => {
    const c = createContainer({ allowedStores: ['solid'] });
    const eph = c.createToken('Eph');
    const trans = c.createToken('Trans');
    const solid = c.createToken('Solid');

    c.bind(eph, { storage: 'ephemeral', state: 'stateless' }, () => 1);
    c.bind(trans, { storage: 'none', state: 'stateless', captures: [eph] }, ([e]) => e);
    c.bind(solid, { storage: 'solid', state: 'stateless', captures: [trans] }, ([t]) => t);

    const report = c.verify();

    const transFact = report.folded.get(trans)?.get(eph);
    assert.equal(transFact?.taints.has('escaped-ephemeral'), true);
    assert.equal(transFact?.taints.has('captive-ephemeral'), false);

    const solidFact = report.folded.get(solid)?.get(eph);
    assert.equal(solidFact?.relation, 'transitive');
    assert.equal(solidFact?.taints.has('captive-ephemeral'), true);
    // escaped-ephemeral MUST NOT propagate to retained ancestors
    assert.equal(solidFact?.taints.has('escaped-ephemeral'), false);
  });

  it('distinguishes split-state-diamond vs shared-diamond and direct dominating transitive', () => {
    const c = createContainer({ allowedStores: ['solid'] });

    const statefulNone = c.createToken('StatefulNone');
    const sharedSolid = c.createToken('SharedSolid');
    const left = c.createToken('Left');
    const right = c.createToken('Right');
    const top = c.createToken('Top');

    c.bind(statefulNone, { storage: 'none', state: 'stateful' }, () => ({}));
    c.bind(sharedSolid, { storage: 'solid', state: 'stateful' }, () => ({}));
    c.bind(
      left,
      { storage: 'solid', state: 'stateful', captures: [statefulNone, sharedSolid] },
      () => ({})
    );
    c.bind(
      right,
      { storage: 'solid', state: 'stateful', captures: [statefulNone, sharedSolid] },
      () => ({})
    );
    // Top captures left & right AND directly captures sharedSolid (direct dominates transitive!)
    c.bind(
      top,
      { storage: 'solid', state: 'stateful', captures: [left, right, sharedSolid] },
      () => ({})
    );

    const report = c.verify();

    const splitFact = report.folded.get(top)?.get(statefulNone);
    assert.equal(splitFact?.diamond, true);
    assert.equal(splitFact?.relation, 'transitive');
    assert.equal(splitFact?.taints.has('split-state-diamond'), true);
    assert.equal(splitFact?.taints.has('shared-diamond'), false);

    const sharedFact = report.folded.get(top)?.get(sharedSolid);
    assert.equal(sharedFact?.diamond, true);
    assert.equal(sharedFact?.relation, 'direct');
    assert.equal(sharedFact?.taints.has('shared-diamond'), true);
    assert.equal(sharedFact?.taints.has('split-state-diamond'), false);
  });

  it('detects split-state-diamond across shadowed parent/child stateful bindings', () => {
    const root = createContainer({ allowedStores: ['solid'] });
    const stateTok = root.createToken('State');
    const rootSvc = root.createToken('RootSvc');

    root.bind(stateTok, { storage: 'solid', state: 'stateful' }, () => ({ who: 'root' }));
    root.bind(
      rootSvc,
      { storage: 'solid', target: 'provider', state: 'stateful', captures: [stateTok] },
      ([s]) => ({ s })
    );

    const child = root.createChild({ allowedStores: ['solid'] });
    // Shadow stateTok on child; rootSvc still lexically sees root's binding while child sees child's!
    child.bind(stateTok, { storage: 'solid', state: 'stateful' }, () => ({ who: 'child' }));
    const childJoin = child.createToken('ChildJoin');
    child.bind(
      childJoin,
      { storage: 'solid', state: 'stateful', captures: [rootSvc, stateTok] },
      ([r, s]) => ({ r, s })
    );

    const report = child.verify();
    const fact = report.folded.get(childJoin)?.get(stateTok);
    assert.equal(fact?.diamond, true);
    assert.equal(fact?.taints.has('split-state-diamond'), true);
  });
});

// ============================================================================
// 11. DUAL-LATTICE DISCHARGES & POLICY EVALUATION
// ============================================================================

describe('verify() dual-lattice discharges & policy evaluation', () => {
  it('locally discharges self and capture taints, keeps sanitized ancestors clean, and stays auditable', () => {
    const c = createContainer({ allowedStores: ['solid', 'weak'] });

    const cfg = c.createToken('Config');
    const server = c.createToken('Server');
    const app = c.createToken('App');
    const memoTok = c.createToken('Memo');

    c.bind(cfg, { storage: 'none', state: 'stateless' }, () => ({ port: 8080 }));
    c.bind(
      server,
      {
        storage: 'solid',
        state: 'stateful',
        captures: [cfg],
        discharges: [[cfg, TAINT_BITS['frozen-none']]],
      },
      ([config]) => ({ config })
    );
    c.bind(
      app,
      { storage: 'solid', state: 'stateful', captures: [server] },
      ([srv]) => ({ srv })
    );
    c.bind(
      memoTok,
      {
        storage: 'weak',
        state: 'stateful',
        discharges: [[memoTok, TAINT_BITS['volatile-state']]],
      },
      () => new Map()
    );

    const strictPolicy = (_dep, fact) => {
      const deny = TAINT_BITS['volatile-state'] | TAINT_BITS['frozen-none'];
      return (fact.mask & deny) !== 0 ? 'deny' : 'allow';
    };

    const strictReport = c.verify(strictPolicy);
    assert.equal(strictReport.ok, true);
    assert.equal(strictReport.violations.length, 0);

    // Server's fact records frozen-none in dischargedMask (not active mask)
    const srvCfg = strictReport.folded.get(server)?.get(cfg);
    assert.equal(srvCfg?.mask, 0);
    assert.equal(srvCfg?.dischargedMask, TAINT_BITS['frozen-none']);
    assert.equal(srvCfg?.taints.size, 0);
    assert.equal(srvCfg?.dischargedTaints.has('frozen-none'), true);

    // Ancestor App does NOT re-emit frozen-none along the sanitized branch
    const appCfg = strictReport.folded.get(app)?.get(cfg);
    assert.equal(appCfg?.mask, 0);
    assert.equal(appCfg?.taints.has('frozen-none'), false);

    // Audit policy sees dischargedMask !== 0 even when active mask === 0
    const auditPolicy = (_dep, fact) =>
      fact.dischargedMask !== 0 ? 'deny' : 'allow';
    const auditReport = c.verify(auditPolicy);
    assert.equal(auditReport.ok, false);
    assert.equal(auditReport.violations.length, 2); // server->cfg + memoTok(self)
  });

  it('enforces dual-lattice diamond soundness (OR may-taint, AND must-sanitize)', () => {
    const c = createContainer({ allowedStores: ['solid'] });

    const cfg = c.createToken('Config');
    const cleanA = c.createToken('CleanA');
    const cleanB = c.createToken('CleanB');
    const sloppy = c.createToken('Sloppy');
    const bothCleanParent = c.createToken('BothCleanParent');
    const mixedParent = c.createToken('MixedParent');

    c.bind(cfg, { storage: 'none', state: 'stateless' }, () => ({ port: 80 }));
    c.bind(
      cleanA,
      {
        storage: 'solid',
        state: 'stateful',
        captures: [cfg],
        discharges: [[cfg, TAINT_BITS['frozen-none']]],
      },
      ([x]) => x
    );
    c.bind(
      cleanB,
      {
        storage: 'solid',
        state: 'stateful',
        captures: [cfg],
        discharges: [[cfg, TAINT_BITS['frozen-none']]],
      },
      ([x]) => x
    );
    c.bind(sloppy, { storage: 'solid', state: 'stateful', captures: [cfg] }, ([x]) => x);

    c.bind(
      bothCleanParent,
      { storage: 'solid', state: 'stateful', captures: [cleanA, cleanB] },
      () => ({})
    );
    c.bind(
      mixedParent,
      { storage: 'solid', state: 'stateful', captures: [cleanA, sloppy] },
      () => ({})
    );

    const report = c.verify();

    // Both branches sanitized frozen-none -> bothCleanParent stays clean of frozen-none!
    const bothFact = report.folded.get(bothCleanParent)?.get(cfg);
    assert.equal(bothFact?.diamond, true);
    assert.equal(bothFact?.taints.has('frozen-none'), false);

    // One branch unsanitized -> mixedParent MUST surface frozen-none!
    const mixedFact = report.folded.get(mixedParent)?.get(cfg);
    assert.equal(mixedFact?.diamond, true);
    assert.equal(mixedFact?.taints.has('frozen-none'), true);
  });

  it('distinguishes warn (ok: true) from deny (ok: false) and ORs duplicate discharge entries', () => {
    const c = createContainer({ allowedStores: ['solid'] });
    const a = c.createToken('A');
    const b = c.createToken('B');

    c.bind(a, { storage: 'none', state: 'stateful' }, () => ({}));
    c.bind(
      b,
      {
        storage: 'solid',
        state: 'stateless',
        captures: [a],
        // Two separate entries for same origin combine via bitwise OR
        discharges: [
          [a, TAINT_BITS['frozen-none']],
          [a, TAINT_BITS['state-leak']],
        ],
      },
      ([x]) => x
    );

    const reportCleared = c.verify((_dep, fact) =>
      fact.mask !== 0 ? 'deny' : 'allow'
    );
    assert.equal(reportCleared.ok, true);
    assert.equal(
      reportCleared.folded.get(b)?.get(a)?.dischargedMask,
      TAINT_BITS['frozen-none'] | TAINT_BITS['state-leak']
    );

    const warnReport = c.verify((_dep, fact) =>
      fact.dischargedMask !== 0 ? 'warn' : 'allow'
    );
    assert.equal(warnReport.ok, true);
    assert.equal(warnReport.violations.length, 1);
    assert.equal(warnReport.violations[0].action, 'warn');
  });
});

// ============================================================================
// 12. WEAKREF GC RECLAMATION (ACTIVE WHEN RUN WITH `node --expose-gc`)
// ============================================================================

describe('WeakRef GC reclamation', () => {
  const hasGc = typeof globalThis.gc === 'function';

  it('fires onDispose(undefined) and parent onDecapture after V8 collects a weak entry', {
    skip: !hasGc ? 'Run with `node --expose-gc --test` to execute GC test' : false,
  }, async () => {
    const c = createContainer({ allowedStores: ['solid', 'weak'] });
    const baseTok = c.createToken('Base');
    const weakTok = c.createToken('Weak');

    let weakDisposedArg = 'NOT_CALLED';
    let baseDecapturedRemaining = -1;

    c.bind(
      baseTok,
      {
        storage: 'solid',
        state: 'stateful',
        onDecapture: (_inst, remaining) => {
          baseDecapturedRemaining = remaining;
        },
      },
      () => ({ keep: true })
    );
    c.bind(
      weakTok,
      {
        storage: 'weak',
        state: 'stateless',
        captures: [baseTok],
        onDispose: (inst) => {
          weakDisposedArg = inst;
        },
      },
      ([base]) => ({ ref: base, payload: new Array(1024).fill(1) })
    );

    // Create and immediately drop strong reference in an inner scope
    (() => {
      const tmp = c.get(weakTok);
      assert.ok(tmp.ref.keep);
    })();

    // Give V8 FinalizationRegistry a few GC + microtask/timer turns
    for (let i = 0; i < 10 && weakDisposedArg === 'NOT_CALLED'; i++) {
      globalThis.gc();
      await new Promise((r) => setTimeout(r, 10));
    }

    assert.equal(weakDisposedArg, undefined);
    assert.equal(baseDecapturedRemaining, 0);
  });
});
