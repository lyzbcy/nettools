'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let api = {};
try { api = require('../src/core/settings.cjs'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const defaults = { enabled: false, intervalMinutes: 30, restartOnTimeout: false, launchAtLogin: false };
function requireApi(name) { assert.equal(typeof api[name], 'function', `${name} must be exported`); return api[name]; }
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nettools-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'private', 'settings.json') };
}
test('safe defaults never inherit old restart policy', () => {
  assert.deepEqual(api.DEFAULT_SETTINGS, defaults);
  assert.deepEqual(requireApi('validateSettings')({}), defaults);
  assert.throws(() => api.validateSettings({ superguard: true }));
});
test('strict schema permits integer intervals 1 through 1440 only', () => {
  const validate = requireApi('validateSettings');
  for (const intervalMinutes of [1, 5, 30, 1440]) assert.equal(validate({ intervalMinutes }).intervalMinutes, intervalMinutes);
  for (const intervalMinutes of [0, -1, 1441, 1.5, '30', NaN, Infinity]) assert.throws(() => validate({ intervalMinutes }));
  for (const key of ['enabled', 'restartOnTimeout', 'launchAtLogin']) {
    for (const value of ['true', 1, null]) assert.throws(() => validate({ [key]: value }));
  }
  for (const input of [null, [], 'bad']) assert.throws(() => validate(input));
  assert.throws(() => validate({ unexpected: true }));
});
test('missing settings are safe and durable writes round trip', t => {
  const { file } = fixture(t);
  const load = requireApi('loadSettings');
  assert.deepEqual(load(file), defaults);
  const next = { enabled: true, intervalMinutes: 17, restartOnTimeout: true, launchAtLogin: true };
  assert.deepEqual(requireApi('saveSettings')(file, next), next);
  assert.deepEqual(load(file), next);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), next);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(path.dirname(file)).filter(n => n.endsWith('.tmp')).length, 0);
});
test('corrupt and legacy settings are preserved in backups and replaced safely', t => {
  const { dir, file } = fixture(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const load = requireApi('loadSettings');
  for (const contents of ['{broken', JSON.stringify({ superguard: true, restartOnTimeout: true }), JSON.stringify({ enabled: true, intervalMinutes: 0 })]) {
    fs.writeFileSync(file, contents);
    assert.deepEqual(load(file), defaults);
    const backups = fs.readdirSync(path.dirname(file)).filter(n => n.includes('.corrupt-'));
    assert.ok(backups.some(n => fs.readFileSync(path.join(path.dirname(file), n), 'utf8') === contents));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), defaults);
  }
  assert.ok(fs.existsSync(dir));
});
test('invalid save leaves last valid file unchanged', t => {
  const { file } = fixture(t);
  const save = requireApi('saveSettings');
  save(file, { intervalMinutes: 10 });
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => save(file, { intervalMinutes: 0 }));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
