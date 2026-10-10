'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
let Watchdog;
try { ({ Watchdog } = require('../src/core/watchdog.cjs')); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
async function immediate(promise) {
  let done = false; let result;
  promise.then(value => { done = true; result = value; });
  await flush();
  assert.equal(done, true, 'UI action must settle without waiting for operation cleanup');
  return result;
}
class Clock {
  time = 0; id = 0; timers = new Map();
  now = () => this.time;
  setTimeout = (fn, delay) => { const id = ++this.id; this.timers.set(id, { at: this.time + delay, fn }); return id; };
  clearTimeout = id => this.timers.delete(id);
  async advance(ms) {
    const end = this.time + ms;
    await flush();
    while (true) {
      const next = [...this.timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.time = next[1].at; this.timers.delete(next[0]); next[1].fn(); await flush();
    }
    this.time = end; await flush();
  }
}
function fixture(options = {}) {
  assert.equal(typeof Watchdog, 'function', 'Watchdog must be exported');
  const clock = new Clock();
  const calls = { checks: [], repairs: [], restarts: [], states: [], logs: [] };
  let online = options.online !== false;
  const check = options.check || (async ({ signal }) => { calls.checks.push({ time: clock.now(), signal }); return { ok: online, issue: online ? null : 'dns' }; });
  const repair = options.repair || (async (issue, { signal }) => { calls.repairs.push({ issue, time: clock.now(), signal }); return { ok: true }; });
  const restart = options.restart || (async ({ signal }) => { calls.restarts.push({ time: clock.now(), signal }); return { ok: true }; });
  const guard = new Watchdog({ clock, check, repair, restart, settings: { enabled: true, ...options.settings }, beforeRestart: options.beforeRestart,
    checkTimeoutMs: options.checkTimeoutMs ?? 10000, repairTimeoutMs: options.repairTimeoutMs ?? 15000, retryMs: options.retryMs ?? 15000,
    onState: s => calls.states.push(s), onLog: l => calls.logs.push(l) });
  return { guard, clock, calls, setOnline(value) { online = value; } };
}
test('disabled defaults have no background or system actions', async () => {
  const { guard, clock, calls } = fixture({ settings: { enabled: false } });
  await guard.start(); await clock.advance(3600000);
  assert.equal(guard.snapshot().enabled, false); assert.equal(guard.snapshot().intervalMinutes, 30);
  assert.equal(guard.snapshot().restartOnTimeout, false); assert.equal(calls.checks.length, 0); assert.equal(calls.repairs.length, 0);
});
test('enabled start checks immediately then follows custom interval', async () => {
  const { guard, clock, calls } = fixture({ settings: { intervalMinutes: 17 } });
  await guard.start(); assert.equal(calls.checks.length, 1); assert.equal(calls.repairs.length, 0);
  assert.equal(guard.snapshot().nextCheckAt, 17 * 60000);
  await clock.advance(17 * 60000 - 1); assert.equal(calls.checks.length, 1);
  await clock.advance(1); assert.equal(calls.checks.length, 2); assert.equal(guard.snapshot().lastCheckAt, clock.now());
});
test('repair starts immediately and recovery ends its five minute window', async () => {
  const { guard, clock, calls, setOnline } = fixture({ online: false });
  await guard.start(); assert.equal(calls.repairs.length, 1); assert.equal(guard.snapshot().repairStartedAt, 0);
  assert.equal(guard.snapshot().repairDeadlineAt, 300000);
  setOnline(true); await clock.advance(15000);
  assert.equal(guard.snapshot().state, 'idle'); assert.equal(guard.snapshot().repairDeadlineAt, null);
  assert.equal(calls.restarts.length, 0);
});
test('exact five minute deadline stops repair with default no action and preserves interval', async () => {
  const { guard, clock, calls } = fixture({ online: false });
  await guard.start(); await clock.advance(299999); assert.equal(guard.snapshot().state, 'repairing');
  await clock.advance(1); assert.equal(guard.snapshot().state, 'idle'); assert.equal(calls.restarts.length, 0);
  assert.equal(guard.snapshot().lastError?.code, 'REPAIR_TIMEOUT');
  assert.ok(calls.logs.some(entry => entry.action === 'repair-timeout' && entry.ok === false));
  assert.equal(guard.snapshot().nextCheckAt, 1800000);
  const repairs = calls.repairs.length; await clock.advance(300000); assert.equal(calls.repairs.length, repairs);
});
test('explicit restart gets final checks and a sixty second countdown', async () => {
  let markers = 0;
  const { guard, clock, calls } = fixture({ online: false, settings: { restartOnTimeout: true }, beforeRestart: async () => { markers++; return true; } });
  await guard.start(); await clock.advance(300000);
  assert.equal(guard.snapshot().state, 'countdown'); assert.equal(guard.snapshot().restartAt, 360000);
  await clock.advance(59999); assert.equal(calls.restarts.length, 0);
  await clock.advance(1); assert.equal(calls.restarts.length, 1); assert.equal(markers, 1);
  assert.equal(calls.checks.at(-1).time, 360000);
  await clock.advance(1800000); assert.equal(calls.restarts.length, 1);
});
test('user cancellation prevents a countdown restart', async () => {
  const { guard, clock, calls } = fixture({ online: false, settings: { restartOnTimeout: true } });
  await guard.start(); await clock.advance(300000); guard.cancelRestart();
  assert.equal(guard.snapshot().restartAt, null); await clock.advance(60000); assert.equal(calls.restarts.length, 0);
});
test('countdown polling cancels as soon as network recovers', async () => {
  const { guard, clock, calls, setOnline } = fixture({ online: false, settings: { restartOnTimeout: true } });
  await guard.start(); await clock.advance(300000); setOnline(true); await clock.advance(15000);
  assert.equal(guard.snapshot().state, 'idle'); await clock.advance(60000); assert.equal(calls.restarts.length, 0);
});
test('network recovery at the final check prevents restart', async () => {
  const { guard, clock, calls, setOnline } = fixture({ online: false, settings: { restartOnTimeout: true } });
  await guard.start(); await clock.advance(359999); setOnline(true); await clock.advance(1);
  assert.equal(calls.restarts.length, 0); assert.equal(guard.snapshot().state, 'idle');
});
test('hanging repair is aborted and cannot delay the global five minute deadline', async () => {
  let signal;
  const { guard, clock } = fixture({ online: false, repair: async (_issue, context) => { signal = context.signal; return new Promise(() => {}); } });
  guard.start(); await flush(); await clock.advance(300000);
  assert.equal(signal.aborted, true); assert.equal(guard.snapshot().state, 'idle');
});
test('hanging final check never blindly restarts', async () => {
  let context; let checks = 0;
  const { guard, clock, calls } = fixture({ settings: { restartOnTimeout: true }, check: async ({ signal }) => {
    checks++; if (clock.now() >= 300000) { context = signal; return new Promise(() => {}); } return { ok: false, issue: 'dns' };
  } });
  await guard.start(); await clock.advance(370000);
  assert.ok(checks > 1); assert.equal(context.aborted, true); assert.equal(calls.restarts.length, 0);
  assert.equal(guard.snapshot().restartAt, null); assert.match(guard.snapshot().lastError.message, /timed out/i);
});
test('checks are single flight and late results after stop cannot change state', async () => {
  let resolve; let signal; let checks = 0;
  const { guard, clock, calls } = fixture({ check: ({ signal: supplied }) => { checks++; signal = supplied; return new Promise(r => { resolve = r; }); } });
  const pending = guard.start(); await flush(); guard.checkNow(); guard.checkNow(); assert.equal(checks, 1);
  guard.stop(); assert.equal(signal.aborted, true); resolve({ ok: false, issue: 'dns' }); await pending; await clock.advance(300000);
  assert.equal(guard.snapshot().state, 'stopped'); assert.equal(calls.repairs.length, 0); assert.equal(calls.restarts.length, 0);
});
test('suspend invalidates countdown and resume starts a fresh check without sleep elapsed', async () => {
  const { guard, clock, calls } = fixture({ online: false, settings: { restartOnTimeout: true } });
  await guard.start(); await clock.advance(300000); guard.suspend(); await clock.advance(3600000);
  assert.equal(guard.snapshot().state, 'suspended'); assert.equal(calls.restarts.length, 0);
  await guard.resume(); assert.equal(guard.snapshot().repairStartedAt, clock.now());
  await clock.advance(299999); assert.equal(calls.restarts.length, 0);
});
test('settings updates cancel old work and use new interval immediately', async () => {
  const { guard, clock, calls, setOnline } = fixture({ online: false, settings: { restartOnTimeout: true } });
  await guard.start(); await clock.advance(300000); setOnline(true);
  await guard.updateSettings({ intervalMinutes: 5, restartOnTimeout: false });
  assert.equal(guard.snapshot().nextCheckAt, clock.now() + 300000); assert.equal(guard.snapshot().restartAt, null);
  await clock.advance(60000); assert.equal(calls.restarts.length, 0);
  await guard.updateSettings({ enabled: false }); const checks = calls.checks.length; await clock.advance(600000);
  assert.equal(calls.checks.length, checks); assert.equal(guard.snapshot().state, 'disabled');
});
test('changing a setting during a hanging repair aborts it and ignores its late result', async () => {
  let resolve; let signal;
  const { guard, calls, setOnline } = fixture({ online: false, repair: (_issue, context) => { signal = context.signal; return new Promise(r => { resolve = r; }); } });
  const pending = guard.start(); await flush(); setOnline(true);
  await guard.updateSettings({ intervalMinutes: 1 }); assert.equal(signal.aborted, true);
  resolve({ ok: false }); await pending; await flush(); assert.equal(guard.snapshot().state, 'idle'); assert.equal(calls.restarts.length, 0);
});
test('permission failure is visible and privileged repair is not retried in the same session', async () => {
  let repairs = 0;
  const { guard, clock, calls } = fixture({ online: false, repair: async () => { repairs++; return { ok: false, error: { code: 'PERMISSION_REQUIRED', message: 'Authorization required' } }; } });
  await guard.start(); await clock.advance(30000);
  assert.equal(repairs, 1); assert.equal(guard.snapshot().lastError.code, 'PERMISSION_REQUIRED'); assert.ok(calls.checks.length >= 3);
});
test('reboot marker refusal or failure prevents the restart', async () => {
  for (const beforeRestart of [async () => false, async () => { throw new Error('marker write failed'); }]) {
    const { guard, clock, calls } = fixture({ online: false, settings: { restartOnTimeout: true }, beforeRestart });
    await guard.start(); await clock.advance(370000); assert.equal(calls.restarts.length, 0);
    assert.ok(guard.snapshot().lastError);
  }
});
test('invalid settings update does not invalidate an active countdown', async () => {
  const { guard, clock } = fixture({ online: false, settings: { restartOnTimeout: true } });
  await guard.start(); await clock.advance(300000);
  assert.throws(() => guard.updateSettings({ intervalMinutes: 0 })); assert.equal(guard.snapshot().restartAt, 360000);
});
test('onState snapshots are isolated from caller mutation', async () => {
  const { guard, calls } = fixture(); await guard.start();
  const state = guard.snapshot(); state.lastResult.ok = false;
  calls.states.at(-1).intervalMinutes = 0;
  assert.equal(guard.snapshot().lastResult.ok, true); assert.equal(guard.snapshot().intervalMinutes, 30);
});
test('configured timeouts allow thirty second diagnostics and twenty second repairs', async () => {
  let online = false; const signals = [];
  const { guard, clock } = fixture({ checkTimeoutMs: 40000, repairTimeoutMs: 45000, check: ({ signal }) => {
    signals.push(signal);
    return new Promise(resolve => clock.setTimeout(() => resolve({ ok: online, issue: 'dns' }), 30000));
  }, repair: (_issue, { signal }) => {
    signals.push(signal);
    return new Promise(resolve => clock.setTimeout(() => { online = true; resolve({ ok: true }); }, 20000));
  } });
  const pending = guard.start(); await clock.advance(30000);
  assert.equal(guard.snapshot().repairStartedAt, 30000); assert.equal(guard.snapshot().repairDeadlineAt, 330000);
  await clock.advance(50000); await pending;
  assert.equal(guard.snapshot().lastResult?.ok, true); assert.equal(guard.snapshot().state, 'idle');
  assert.ok(signals.every(signal => !signal.aborted));
});
test('recovery during reboot marker persistence is checked again before system restart', async () => {
  let online = false;
  const { guard, clock, calls } = fixture({ settings: { restartOnTimeout: true },
    check: async () => ({ ok: online, issue: 'dns' }), beforeRestart: async () => { online = true; return true; } });
  await guard.start(); await clock.advance(360000);
  assert.equal(calls.restarts.length, 0); assert.equal(guard.snapshot().lastResult.ok, true);
});
test('cancel during the final pre-restart check aborts its signal and ignores late failure', async () => {
  let resolve; let signal;
  const { guard, clock, calls } = fixture({ settings: { restartOnTimeout: true }, check: ({ signal: supplied }) => {
    if (clock.now() < 360000) return Promise.resolve({ ok: false, issue: 'dns' });
    signal = supplied; return new Promise(r => { resolve = r; });
  } });
  await guard.start(); await clock.advance(360000); guard.cancelRestart();
  assert.equal(signal.aborted, true); resolve({ ok: false, issue: 'dns' }); await flush();
  assert.equal(calls.restarts.length, 0); assert.equal(guard.snapshot().state, 'idle');
});
test('a hanging initial check is bounded and cannot initiate repair without diagnosis', async () => {
  let signal;
  const { guard, clock, calls } = fixture({ check: context => { signal = context.signal; return new Promise(() => {}); } });
  const pending = guard.start(); await clock.advance(10000); await pending;
  assert.equal(signal.aborted, true); assert.equal(calls.repairs.length, 0); assert.equal(guard.snapshot().lastError.code, 'TIMEOUT');
  assert.equal(guard.snapshot().state, 'idle');
});
test('failed latest check cannot retain a previous green network result', async () => {
  let healthy = true;
  const { guard, clock } = fixture({ settings: { intervalMinutes: 1 }, check: async () => {
    if (healthy) return { ok: true };
    throw Object.assign(new Error('Network check unavailable'), { code: 'CHECK_FAILED' });
  } });
  await guard.start(); healthy = false; await clock.advance(60000);
  assert.equal(guard.snapshot().lastResult, null); assert.equal(guard.snapshot().lastError.code, 'CHECK_FAILED');
});
test('retry pauses follow command completion while command hangs stay bounded', async () => {
  const repairTimes = []; const signals = [];
  const { guard, clock } = fixture({ online: false, repairTimeoutMs: 45000, repair: (_issue, { signal }) => {
    repairTimes.push(clock.now()); signals.push(signal); return new Promise(resolve => signal.addEventListener('abort', () => resolve({ ok: false }), { once: true }));
  } });
  const pending = guard.start(); await clock.advance(45000); await pending;
  assert.equal(signals[0].aborted, true); assert.deepEqual(repairTimes, [0]);
  await clock.advance(14999); assert.deepEqual(repairTimes, [0]);
  await clock.advance(1); assert.deepEqual(repairTimes, [0, 60000]);
  await clock.advance(240000); assert.equal(guard.snapshot().state, 'idle'); assert.ok(signals.every(signal => signal.aborted));
});
test('global repair deadline takes precedence over a longer command timeout', async () => {
  let signal;
  const { guard, clock } = fixture({ online: false, repairTimeoutMs: 300000, repair: (_issue, context) => {
    signal = context.signal; return new Promise(() => {});
  } });
  const pending = guard.start(); await clock.advance(299999); assert.equal(signal.aborted, false);
  await clock.advance(1); await pending; assert.equal(signal.aborted, true); assert.equal(guard.snapshot().state, 'idle');
});
test('settings changes wait for actual delayed repair cleanup without blocking their response', async () => {
  let activeRepairs = 0; let peak = 0; let repairs = 0; let checksDuringRepair = 0;
  const { guard, clock } = fixture({ check: async () => {
    if (activeRepairs) checksDuringRepair++;
    return { ok: false, issue: 'dns' };
  }, repair: (_issue, { signal }) => {
    repairs++; activeRepairs++; peak = Math.max(peak, activeRepairs);
    return new Promise(resolve => signal.addEventListener('abort', () => clock.setTimeout(() => {
      activeRepairs--; resolve({ ok: false });
    }, 1000), { once: true }));
  } });
  guard.start(); await flush();
  const settings = await immediate(guard.updateSettings({ intervalMinutes: 5 }));
  assert.equal(clock.now(), 0); assert.equal(settings.lastError?.code, 'OPERATION_CLEANUP');
  assert.equal(repairs, 1); assert.equal(checksDuringRepair, 0);
  await clock.advance(999); assert.equal(repairs, 1);
  await clock.advance(1); assert.equal(repairs, 2); assert.equal(peak, 1); assert.equal(checksDuringRepair, 0);
  guard.stop(); await clock.advance(1000);
});
test('stop and start cannot overlap a repair still processing its abort', async () => {
  let active = 0; let peak = 0; let repairs = 0;
  const { guard, clock } = fixture({ online: false, repair: (_issue, { signal }) => {
    active++; repairs++; peak = Math.max(peak, active);
    return new Promise(resolve => signal.addEventListener('abort', () => clock.setTimeout(() => {
      active--; resolve({ ok: false });
    }, 1000), { once: true }));
  } });
  guard.start(); await flush(); guard.stop(); await immediate(guard.start());
  assert.equal(repairs, 1); await clock.advance(1000); assert.equal(repairs, 2); assert.equal(peak, 1);
  guard.stop(); await clock.advance(1000);
});
test('timeout retains the operation barrier until delayed cleanup really completes', async () => {
  let active = 0; let checksDuringRepair = 0;
  const { guard, clock } = fixture({ repairTimeoutMs: 1000, check: async () => {
    if (active) checksDuringRepair++;
    return { ok: false, issue: 'dns' };
  }, repair: (_issue, { signal }) => {
    active++;
    return new Promise(resolve => signal.addEventListener('abort', () => clock.setTimeout(() => {
      active--; resolve({ ok: false });
    }, 1000), { once: true }));
  } });
  const pending = guard.start(); await clock.advance(1000); await pending;
  assert.equal(checksDuringRepair, 0); assert.equal(guard.snapshot().lastError?.code, 'OPERATION_CLEANUP');
  await clock.advance(1000); assert.equal(active, 0); assert.equal(checksDuringRepair, 0);
  guard.stop();
});
test('a never-settling aborted repair blocks every later action and any automatic restart', async () => {
  let repairs = 0;
  const { guard, clock, calls } = fixture({ online: false, settings: { restartOnTimeout: true }, repair: () => {
    repairs++; return new Promise(() => {});
  } });
  const pending = guard.start(); await clock.advance(300000); await pending;
  assert.equal(guard.snapshot().state, 'idle'); assert.equal(guard.snapshot().restartAt, null);
  assert.equal(calls.checks.length, 1); assert.equal(repairs, 1); assert.equal(calls.restarts.length, 0);
  await immediate(guard.updateSettings({ intervalMinutes: 1 })); guard.stop(); await immediate(guard.start()); await clock.advance(600000);
  assert.equal(calls.checks.length, 1); assert.equal(repairs, 1); assert.equal(calls.restarts.length, 0);
  assert.equal(guard.snapshot().operationCleanupPending, true); assert.equal(guard.snapshot().lastError?.code, 'OPERATION_CLEANUP');
});
test('invalid network results never produce a successful check log', async () => {
  for (const ok of [null, undefined, 'true', 1]) {
    const { guard, calls } = fixture({ check: async () => ({ ok }) });
    await guard.start();
    assert.equal(guard.snapshot().lastError?.code, 'INVALID_RESULT');
    assert.ok(calls.logs.some(entry => entry.action === 'network-check' && entry.ok === false));
    assert.equal(calls.logs.some(entry => entry.action === 'network-check' && entry.ok === true), false);
  }
});
