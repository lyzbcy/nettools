'use strict';
const { performance } = require('node:perf_hooks');
const { validateSettings } = require('./settings.cjs');

const REPAIR_WINDOW_MS = 5 * 60000;
const RETRY_MS = 15000;
const CHECK_TIMEOUT_MS = 30000;
const REPAIR_TIMEOUT_MS = 45000;
const RESTART_COUNTDOWN_MS = 60000;
const CANCELLED = Object.freeze({ code: 'ABORTED', message: 'Operation cancelled' });
const CLEANUP_PENDING = Object.freeze({ code: 'OPERATION_CLEANUP', message: 'Previous operation is still exiting; waiting for confirmed completion' });
const copy = value => value == null ? value : structuredClone(value);
const errorInfo = error => ({ code: String(error?.code || 'OPERATION_FAILED'), message: String(error?.message || error || 'Operation failed') });

/** Main-process watchdog, with no Electron or OS calls of its own.
 * check({signal}) must resolve {ok:boolean, issue?:any}; repair(issue,{signal})
 * and restart({signal}) must resolve structured results and respect abort.
 * clock.now() uses monotonic milliseconds; snapshot times use that same origin.
 * checkTimeoutMs=30000, repairTimeoutMs=45000, retryMs=15000 may be injected;
 * operation timeouts never extend the independent five minute repair deadline.
 * beforeRestart({signal}) may persist a reboot guard; false/{ok:false} vetoes it.
 * start/resume/checkNow/updateSettings return promises; stop/suspend/cancelRestart
 * are synchronous cancellations. start() respects the explicit enabled setting.
 * Cancelling/timeout settles the UI-facing promise, but the underlying operation
 * holds a separate barrier until its promise actually settles. No other injected
 * operation can run before then; an unconfirmed hang prevents automatic restart.
 */
class Watchdog {
  constructor({ check, repair, restart, clock, settings, onState, onLog, beforeRestart,
    checkTimeoutMs = CHECK_TIMEOUT_MS, repairTimeoutMs = REPAIR_TIMEOUT_MS, retryMs = RETRY_MS } = {}) {
    for (const [name, fn] of Object.entries({ check, repair, restart })) {
      if (typeof fn !== 'function') throw new TypeError(`${name} must be a function`);
    }
    this.check = check; this.repair = repair; this.restart = restart; this.beforeRestart = beforeRestart;
    this.clock = clock || { now: () => performance.now(), setTimeout, clearTimeout };
    for (const name of ['now', 'setTimeout', 'clearTimeout']) if (typeof this.clock[name] !== 'function') throw new TypeError(`clock.${name} must be a function`);
    this.settings = validateSettings(settings);
    for (const [name, value] of Object.entries({ checkTimeoutMs, repairTimeoutMs, retryMs })) {
      if (!Number.isInteger(value) || value < 1 || value > REPAIR_WINDOW_MS) throw new RangeError(`${name} must be an integer between 1 and ${REPAIR_WINDOW_MS}`);
    }
    this.checkTimeoutMs = checkTimeoutMs; this.repairTimeoutMs = repairTimeoutMs; this.retryMs = retryMs;
    this.onState = onState; this.onLog = onLog;
    this.running = false; this.suspended = false; this.generation = 0;
    this.session = null; this.periodicTimer = null; this.periodicVersion = 0; this.restartAttempted = false;
    this.pendingOperation = null; this.queuedCheck = false;
    this.status = { state: 'stopped', nextCheckAt: null, repairStartedAt: null, repairDeadlineAt: null,
      restartAt: null, lastCheckAt: null, lastResult: null, resultVersion: 0, lastError: null };
  }

  snapshot() { return copy({ ...this.status, ...this.settings, running: this.running, suspended: this.suspended,
    restartAttempted: this.restartAttempted, canCancelRestart: !!this.session?.restartFlow && this.status.state!=='restarting', operationPending: !!this.pendingOperation,
    operationCleanupPending: !!this.pendingOperation?.controller.signal.aborted, pendingAction: this.pendingOperation?.action || null }); }
  _publish() {
    // Observer/UI errors must never break cancellation or the safety deadline.
    try { this.onState?.(this.snapshot()); } catch { /* observer isolation */ }
  }
  _log(action, extra = {}) {
    try { this.onLog?.(copy({ action, time: this.clock.now(), ...extra })); } catch { /* observer isolation */ }
  }
  _error(error, action) { this.status.lastError = errorInfo(error); this._log(action, { error: this.status.lastError }); this._publish(); }
  _active() { return this.running && !this.suspended && this.settings.enabled; }
  _valid(session) { return this._active() && this.session === session && session.generation === this.generation && !session.controller.signal.aborted; }
  _clearPeriodic() {
    this.periodicVersion++;
    if (this.periodicTimer !== null) this.clock.clearTimeout(this.periodicTimer);
    this.periodicTimer = null; this.status.nextCheckAt = null;
  }
  _invalidate() {
    this.generation++;
    if (this.session) {
      this.session.controller.abort();
      for (const timer of this.session.timers) this.clock.clearTimeout(timer);
    }
    this.session = null;
  }
  _clearSessionTimes() { this.status.repairStartedAt = null; this.status.repairDeadlineAt = null; this.status.restartAt = null; }
  _newSession(kind) {
    const session = { generation: this.generation, kind, controller: new AbortController(), timers: new Set(), permissionBlocked: false, busy: false };
    this.session = session; return session;
  }
  _timer(session, delay, fn) {
    const timer = this.clock.setTimeout(() => {
      session.timers.delete(timer);
      if (this._valid(session)) fn();
    }, Math.max(0, delay));
    session.timers.add(timer); return timer;
  }
  _schedulePeriodic() {
    this._clearPeriodic();
    if (!this._active()) return;
    this.status.nextCheckAt = this.clock.now() + this.settings.intervalMinutes * 60000;
    const version = this.periodicVersion;
    this.periodicTimer = this.clock.setTimeout(() => {
      if (version !== this.periodicVersion || !this._active()) return;
      this.periodicTimer = null;
      // Sessions may advance generation while the periodic cadence stays intact.
      this._schedulePeriodic();
      void this.checkNow();
    }, this.settings.intervalMinutes * 60000);
    this._publish();
  }

  start() {
    if (this.running) return Promise.resolve(this.snapshot());
    this.running = true;
    if (this.suspended) { this.status.state = 'suspended'; this._publish(); return Promise.resolve(this.snapshot()); }
    if (!this.settings.enabled) { this.status.state = 'disabled'; this._publish(); return Promise.resolve(this.snapshot()); }
    this._schedulePeriodic(); return this.checkNow();
  }
  stop() {
    this.queuedCheck = false;
    this.running = false; this.suspended = false; this._clearPeriodic(); this._invalidate(); this._clearSessionTimes();
    this.status.state = 'stopped'; this._publish(); return this.snapshot();
  }
  suspend() {
    this.queuedCheck = false;
    this.suspended = true; this._clearPeriodic(); this._invalidate(); this._clearSessionTimes();
    this.status.state = 'suspended'; this._log('watchdog-suspended'); this._publish(); return this.snapshot();
  }
  resume() {
    if (!this.suspended) return Promise.resolve(this.snapshot());
    this.suspended = false;
    if (!this._active()) { this.status.state = this.running ? 'disabled' : 'stopped'; this._publish(); return Promise.resolve(this.snapshot()); }
    this._schedulePeriodic(); return this.checkNow();
  }
  updateSettings(patch) {
    // Validate before mutation so an invalid edit cannot cancel legitimate work.
    const validatedPatch = validateSettings(patch);
    const next = validateSettings({ ...this.settings, ...Object.fromEntries(Object.keys(patch).map(key => [key, validatedPatch[key]])) });
    if (Object.keys(next).every(key => next[key] === this.settings[key])) return Promise.resolve(this.snapshot());
    this.queuedCheck = false;
    this.settings = next; this._clearPeriodic(); this._invalidate(); this._clearSessionTimes();
    if (!this._active()) { this.status.state = this.suspended ? 'suspended' : this.running ? 'disabled' : 'stopped'; this._publish(); return Promise.resolve(this.snapshot()); }
    this._schedulePeriodic(); return this.checkNow();
  }
  cancelRestart() {
    if (!this.session?.restartFlow) return this.snapshot();
    this.queuedCheck = false;
    this._log('restart-cancelled'); this._finish(this.session); return this.snapshot();
  }
  checkNow() {
    if (!this._active() || this.session) return Promise.resolve(this.snapshot());
    if (this.pendingOperation) {
      this.queuedCheck = true; this.status.state = 'idle'; this.status.lastResult = null; this.status.resultVersion++;
      this._error(CLEANUP_PENDING, 'operation-cleanup'); return Promise.resolve(this.snapshot());
    }
    const session = this._newSession('check');
    this.status.state = 'checking'; this._publish();
    session.promise = this._initialCheck(session);
    return session.promise.then(() => this.snapshot());
  }

  _resumeQueuedCheck() {
    if (!this.queuedCheck || this.pendingOperation || this.session || !this._active()) return;
    this.queuedCheck = false;
    void this.checkNow();
  }
  // The deadline-facing settlement and actual completion are deliberately
  // separate. Only actual completion releases the cross-session action barrier.
  async _operation(session, action, fn, timeout = this.checkTimeoutMs) {
    if (!this._valid(session)) return { completed: false, error: CANCELLED };
    if (this.pendingOperation) return { completed: false, error: CLEANUP_PENDING };
    const controller = new AbortController();
    const pending = { action, controller };
    this.pendingOperation = pending;
    const start = this.clock.now();
    session.busy = true;
    const outcome = await new Promise(resolve => {
      let settled = false;
      const settle = result => {
        if (settled) return;
        settled = true; this.clock.clearTimeout(timer);
        session.controller.signal.removeEventListener('abort', aborted);
        resolve(result);
      };
      const aborted = () => { controller.abort(); settle({ completed: false, error: CANCELLED }); };
      const timer = this.clock.setTimeout(() => {
        controller.abort(); settle({ completed: false, error: { code: 'TIMEOUT', message: `${action} timed out` } });
      }, timeout);
      session.controller.signal.addEventListener('abort', aborted, { once: true });
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw CANCELLED;
        return fn(controller.signal);
      }).then(value => {
        if (this.pendingOperation === pending) this.pendingOperation = null;
        if (action === 'network-check' && typeof value?.ok !== 'boolean') {
          settle({ completed: false, error: { code: 'INVALID_RESULT', message: 'Network check returned no valid result' } });
        } else settle({ completed: true, value });
        this._publish(); this._resumeQueuedCheck();
      }, error => {
        if (this.pendingOperation === pending) this.pendingOperation = null;
        settle({ completed: false, error: errorInfo(error) });
        this._publish(); this._resumeQueuedCheck();
      });
    });
    session.busy = false;
    const successful = outcome.completed && (action === 'reboot-guard' ? outcome.value !== false && outcome.value?.ok !== false : outcome.value?.ok === true);
    if (this._valid(session)) this._log(action, { durationMs: this.clock.now() - start, ok: successful, ...(outcome.completed ? {} : { error: outcome.error }) });
    return outcome;
  }
  async _check(session) {
    if (!this._valid(session)) return null;
    if (this.pendingOperation) { this.status.lastResult = null; this.status.resultVersion++; this._error(CLEANUP_PENDING, 'network-check-failed'); return null; }
    this.status.lastCheckAt = this.clock.now(); this._publish();
    const outcome = await this._operation(session, 'network-check', signal => this.check({ signal }));
    if (!this._valid(session)) return null;
    this.status.resultVersion++;
    if (!outcome.completed) { this.status.lastResult = null; this._error(outcome.error, 'network-check-failed'); return null; }
    if (typeof outcome.value?.ok !== 'boolean') { this.status.lastResult = null; this._error({ code: 'INVALID_RESULT', message: 'Network check returned no valid result' }, 'network-check-failed'); return null; }
    this.status.lastResult = copy(outcome.value);
    if (outcome.value.ok) this.status.lastError = null;
    this._publish(); return outcome.value;
  }
  async _initialCheck(session) {
    const result = await this._check(session);
    if (!this._valid(session)) return;
    if (!result || result.ok) { this._finish(session); return; }
    session.kind = 'repair'; session.issue = result.issue;
    this.status.state = 'repairing'; this.status.repairStartedAt = this.clock.now();
    this.status.repairDeadlineAt = this.clock.now() + REPAIR_WINDOW_MS;
    this._timer(session, REPAIR_WINDOW_MS, () => this._deadline(session));
    this._log('repair-started', { deadlineAt: this.status.repairDeadlineAt }); this._publish();
    await this._repairRound(session, false);
  }
  async _repairRound(session, precheck = true) {
    if (!this._valid(session)) return;
    if (precheck) {
      const result = await this._check(session);
      if (!this._valid(session)) return;
      if (result?.ok) { this._finish(session); return; }
      if (!result) { this._retry(session); return; }
      session.issue = result.issue;
    }
    if (!session.permissionBlocked) {
      // A repair may legitimately need tens of seconds. The retry pause is
      // independent of that runtime; the global deadline still wins every race.
      const repairBudget = Math.min(this.repairTimeoutMs, Math.max(0, this.status.repairDeadlineAt - this.clock.now()));
      const outcome = await this._operation(session, 'network-repair', signal => this.repair(session.issue, { signal }), repairBudget);
      if (!this._valid(session)) return;
      const failure = !outcome.completed ? outcome.error : outcome.value?.ok === false ? outcome.value.error || outcome.value : null;
      if (failure) {
        this._error(failure, 'network-repair-failed');
        if (['PERMISSION_REQUIRED', 'PERMISSION_DENIED', 'UNAUTHORIZED', 'AUTHORIZATION_REQUIRED'].includes(this.status.lastError.code)) session.permissionBlocked = true;
      }
      const result = await this._check(session);
      if (!this._valid(session)) return;
      if (result?.ok) { this._finish(session); return; }
    }
    this._retry(session);
  }
  _retry(session) {
    if (!this._valid(session)) return;
    const remaining = this.status.repairDeadlineAt - this.clock.now();
    if (remaining > 0) this._timer(session, Math.min(this.retryMs, remaining), () => { void this._repairRound(session); });
  }
  _finish(session) {
    if (!this._valid(session)) return;
    this._invalidate(); this._clearSessionTimes(); this.status.state = 'idle'; this._publish();
  }
  _deadline(session) {
    if (!this._valid(session)) return;
    const canRestart = this.settings.restartOnTimeout && !this.restartAttempted;
    this._invalidate(); this._clearSessionTimes();
    const error = { code: 'REPAIR_TIMEOUT', message: 'Network did not recover within five minutes' };
    if (!this.status.lastError) this.status.lastError = error;
    this._log('repair-timeout', { ok: false, error });
    if (!this._active()) return;
    if (!canRestart) { this.status.state = 'idle'; this._publish(); return; }
    const final = this._newSession('deadline-check'); final.restartFlow = true;
    this.status.state = 'checking'; this._publish(); void this._verifyCountdown(final);
  }
  async _verifyCountdown(session) {
    const result = await this._check(session);
    if (!this._valid(session)) return;
    if (!result || result.ok) { this._finish(session); return; }
    session.kind = 'countdown'; this.status.state = 'countdown'; this.status.restartAt = this.clock.now() + RESTART_COUNTDOWN_MS;
    this._timer(session, RESTART_COUNTDOWN_MS, () => this._restartDue(session));
    this._timer(session, RETRY_MS, () => { void this._pollCountdown(session); });
    this._log('restart-countdown', { restartAt: this.status.restartAt }); this._publish();
  }
  async _pollCountdown(session) {
    const result = await this._check(session);
    if (!this._valid(session)) return;
    // Unknown connectivity is not adequate evidence for an automatic restart.
    if (!result || result.ok) { this._finish(session); return; }
    if (this.clock.now() + RETRY_MS < this.status.restartAt) this._timer(session, RETRY_MS, () => { void this._pollCountdown(session); });
  }
  _restartDue(session) {
    if (!this._valid(session)) return;
    this._invalidate(); this.status.restartAt = null;
    const final = this._newSession('restart-check'); final.restartFlow = true;
    this.status.state = 'checking'; this._publish(); void this._performRestart(final);
  }
  async _performRestart(session) {
    const result = await this._check(session);
    if (!this._valid(session)) return;
    if (!result || result.ok || !this.settings.restartOnTimeout || this.restartAttempted) { this._finish(session); return; }
    this.restartAttempted = true; this._publish();
    if (this.beforeRestart) {
      const marker = await this._operation(session, 'reboot-guard', signal => this.beforeRestart({ signal }));
      if (!this._valid(session)) return;
      if (!marker.completed || marker.value === false || marker.value?.ok === false) {
        this._error(marker.error || marker.value?.error || { code: 'REBOOT_GUARD', message: 'Reboot guard refused restart' }, 'restart-blocked'); this._finish(session); return;
      }
      // Persisting the guard may take time; recovery during that operation must
      // still veto the system action, including a hanging or failed recheck.
      const fresh = await this._check(session);
      if (!this._valid(session)) return;
      if (!fresh || fresh.ok) { this._finish(session); return; }
    }
    if (!this._valid(session) || !this.settings.restartOnTimeout) return;
    this.status.state = 'restarting'; this._publish();
    const outcome = await this._operation(session, 'system-restart', signal => this.restart({ signal }));
    if (!this._valid(session)) return;
    if (!outcome.completed || outcome.value?.ok === false) this._error(outcome.error || outcome.value?.error || { code: 'RESTART_FAILED', message: 'Restart failed' }, 'restart-failed');
    this._finish(session);
  }
}

module.exports = { Watchdog };
