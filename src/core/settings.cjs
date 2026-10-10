'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULT_SETTINGS = Object.freeze({
  enabled: false, intervalMinutes: 30, restartOnTimeout: false, launchAtLogin: false,
});

/** Validate a partial settings object and return a new complete settings object.
 * Unknown (including legacy superguard) keys and invalid types are rejected.
 */
function validateSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Settings must be an object');
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) throw new TypeError(`Unknown setting: ${key}`);
  }
  const settings = { ...DEFAULT_SETTINGS, ...input };
  for (const key of ['enabled', 'restartOnTimeout', 'launchAtLogin']) {
    if (typeof settings[key] !== 'boolean') throw new TypeError(`${key} must be a boolean`);
  }
  if (!Number.isInteger(settings.intervalMinutes) || settings.intervalMinutes < 1 || settings.intervalMinutes > 1440) {
    throw new RangeError('intervalMinutes must be an integer between 1 and 1440');
  }
  return settings;
}

// File contents are flushed before atomic replacement. Flush the directory too
// where the filesystem supports it; Windows does not support directory fsync.
function syncDirectory(dir) {
  let fd;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); }
  catch (error) { if (!['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Synchronously save validated JSON by durable, atomic same-directory rename.
 * Returns the complete settings; filesystem errors propagate to the caller.
 */
function saveSettings(filePath, input) {
  const settings = validateSettings(input);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, filePath);
    syncDirectory(dir);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return settings;
}

/** Synchronously read settings. A missing file returns safe defaults. Invalid
 * JSON/schema is renamed to a unique .corrupt-* backup, then replaced with safe
 * defaults. Permission and other filesystem errors propagate (never look valid).
 * No legacy restart/superguard migration is performed.
 */
function loadSettings(filePath) {
  let contents;
  try { contents = fs.readFileSync(filePath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { ...DEFAULT_SETTINGS }; throw error; }
  try { return validateSettings(JSON.parse(contents)); }
  catch (error) {
    if (!(error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError)) throw error;
    fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}-${randomUUID()}`);
    return saveSettings(filePath, DEFAULT_SETTINGS);
  }
}

module.exports = { DEFAULT_SETTINGS, validateSettings, loadSettings, saveSettings };
