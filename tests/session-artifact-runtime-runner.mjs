// Run with the installed host's Electron in Node mode. Only this repository's
// temporary directory is written; user sessions and host packages are read-only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadArtifactRuntime, SUPPORTED_LEASE_VERSIONS } from '../scripts/lib/session-artifact-runtime.mjs';

import fs from 'node:fs';
const traceStarted = performance.now();
const trace = (phase, details = {}) => {
  if (process.env.DSH_HOST_TEST_TRACE !== '1') return;
  const entry = { phase, at: Date.now(), ms: Math.round(performance.now() - traceStarted), pid: process.pid,
    resources: process.getActiveResourcesInfo(), cpu: process.cpuUsage(), ...details };
  const line = `${JSON.stringify(entry)}\n`;
  process.stderr.write(line);
  if (process.env.DSH_HOST_TEST_TRACE_DIR) {
    fs.mkdirSync(process.env.DSH_HOST_TEST_TRACE_DIR, { recursive: true });
    fs.appendFileSync(join(process.env.DSH_HOST_TEST_TRACE_DIR, `runtime-${process.pid}.jsonl`), line);
  }
};
// Opt-in evidence: DSH_HOST_TEST_TRACE=1; DSH_HOST_TEST_TRACE_DIR can retain JSONL in repo .tmp.
trace('entry', { execPath: process.execPath, node: process.versions.node, electron: process.versions.electron,
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE, connected: process.connected });
if (process.env.DSH_HOST_TEST_TRACE === '1') {
  process.on('beforeExit', code => trace('beforeExit', { code }));
  process.once('exit', code => trace('exit', { code }));
  setInterval(() => trace('still-active'), 5000).unref();
}
const root = process.env.DSH_SESSION_FORMAT_HOST_ROOT ?? 'D:/devlop/DeepSeek Harness/resources/app.asar/dsh';
const repo = fileURLToPath(new URL('../', import.meta.url));
const hostRequire = createRequire(join(root, 'package.json'));
trace('runtime-import-start');
const runtime = await loadArtifactRuntime(root);
const persistenceEntry = hostRequire.resolve('@deepseek-ai/dsh-session-persistence-jsonl');
const { version } = JSON.parse(await readFile(join(dirname(persistenceEntry), '..', 'package.json'), 'utf8'));
const leaseProtocolVerified = SUPPORTED_LEASE_VERSIONS.includes(version);
trace('runtime-import-end');
const completed = [];
function complete(phase) { completed.push(phase); trace(phase); }
const header = { type: 'session', version: 4, id: 'cli-task-runtime-test', createdAt: 1,
  isSeeded: false, delegationDepth: 0, origin: 'subagent', parentSession: 'parent-runtime-test' };
const row = (type, data, seq) => ({ type, data, seq, time: seq + 1 });
const turn = number => [
  ['turn/start', { turn: number }],
  ['request/context', { provider: 'test', model: 'test' }],
  ['step/start', { turn: number, step: 1 }],
  ['assistant/attempt', { turn: number, step: 1, stream: [
    { type: 'chunk', time: 4, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } } },
  ] }],
  ['step/end', { turn: number, step: 1 }],
  ['turn/end', { turn: number, reason: { kind: 'error', error: { code: 'TEST', message: 'test only' } } }],
];
const rows = [header, ...turn(1).map(([type, data], seq) => row(type, data, seq))];
runtime.validateRows(rows); complete('full-v4-lifecycle');
assert.throws(() => runtime.validateRows([header, row('request/context', { provider: 'test', model: 'test' }, 0)]), /request\/context is outside an open turn/);
complete('real-context-outside-turn-rejected');
const twoTurns = [header, ...[...turn(1), ...turn(2)].map(([type, data], seq) => row(type, data, seq))];
runtime.validateRows(twoTurns); complete('turn-local-step-reset');
assert.throws(() => runtime.validateRows([header, ...rows.slice(1).map(event => event.type === 'step/start' ? { ...event, data: { turn: 1, step: 2 } } : event)]), /step\/start does not match/);
complete('invalid-step-rejected');
runtime.validateRows([header, { ...row('maestro/cli-child', { usageId: 'stable-usage', accounting: 'native-mirror-of-parent-cli-ledger' }, 0), ignorable: true }]);
assert.throws(() => runtime.validateRows([header, row('maestro/cli-child', {}, 0)]));
complete('ignorable-extension-admission');
assert.throws(() => runtime.validateRows([header, { ...row('session/end-seed', {}, 0), inherited: true }]));
complete('unseeded-marker-rejected');

await mkdir(join(repo, '.tmp'), { recursive: true });
const dir = await mkdtemp(join(repo, '.tmp', 'runtime-lease-'));
const lockPath = join(dir, 'session.lock');
let heldNative;
let heldAdapter;
try {
  if (!leaseProtocolVerified) {
    const unverifiedDir = join(dir, 'must-not-be-created');
    await assert.rejects(runtime.acquireLease(unverifiedDir, header.id), /session write lease protocol is unverified/);
    await assert.rejects(stat(unverifiedDir), error => error.code === 'ENOENT');
    complete('unverified-write-lease-refused-before-writes');
  } else {
  if (process.platform === 'win32') {
    // Independent native owner follows the installed persistence protocol,
    // without importing or calling any adapter lock implementation.
    trace('native-addon-import-start');
    const { default: koffi } = await import(pathToFileURL(hostRequire.resolve('koffi')).href);
    trace('native-addon-import-end');
    const lib = koffi.load('kernel32.dll');
    const create = lib.func('__stdcall', 'CreateSemaphoreW', 'intptr', ['void*', 'int', 'int', 'str16']);
    const wait = lib.func('__stdcall', 'WaitForSingleObject', 'uint', ['intptr', 'uint']);
    const release = lib.func('__stdcall', 'ReleaseSemaphore', 'int', ['intptr', 'int', 'void*']);
    const close = lib.func('__stdcall', 'CloseHandle', 'int', ['intptr']);
    const expectedName = 'Local' + String.fromCharCode(92) + 'dsh-session-lock-' + createHash('sha256').update(resolve(lockPath).toLowerCase()).digest('hex');
    const handle = create(null, 1, 1, expectedName);
    assert(handle);
    let owned = false;
    heldNative = { async release() {
      if (owned) { assert.equal(release(handle, 1, null), 1); owned = false; }
      assert.equal(close(handle), 1);
    } };
    assert.equal(wait(handle, 0), 0); owned = true;
    await assert.rejects(runtime.acquireLease(dir, header.id), error => error.code === 'SESSION_ALREADY_OWNED');
    complete('independent-native-writer-blocks-adapter');
    assert.equal(release(handle, 1, null), 1); owned = false;
    heldAdapter = await runtime.acquireLease(dir, header.id);
    assert.equal(wait(handle, 0), 258);
    complete('adapter-blocks-independent-native-writer');
    await heldAdapter.release(); await heldAdapter.release(); heldAdapter = undefined;
    assert.equal(wait(handle, 0), 0); owned = true;
    complete('adapter-release-idempotent-and-native-reacquires');
    await heldNative.release(); heldNative = undefined;
  } else {
    const { tryLockExclusive } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/node-addon-system/flock')).href);
    const handle = await open(lockPath, 'w');
    heldNative = { release: () => handle.close() };
    await tryLockExclusive(handle.fd);
    await assert.rejects(runtime.acquireLease(dir, header.id), error => error.code === 'SESSION_ALREADY_OWNED');
    complete('independent-native-writer-blocks-adapter');
    await heldNative.release(); heldNative = undefined;
    heldAdapter = await runtime.acquireLease(dir, header.id);
    const contender = await open(lockPath, 'w');
    try {
      await assert.rejects(tryLockExclusive(contender.fd), error => error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK');
      complete('adapter-blocks-independent-native-writer');
      await heldAdapter.release(); await heldAdapter.release(); heldAdapter = undefined;
      await tryLockExclusive(contender.fd);
      complete('adapter-release-idempotent-and-native-reacquires');
    } finally { await contender.close(); }
  }
  const next = await runtime.acquireLease(dir, header.id);
  await next.release(); complete('adapter-reacquires-after-native-close');
  }
} finally {
  if (heldAdapter) await heldAdapter.release();
  if (heldNative) await heldNative.release();
  assert(dir.startsWith(join(repo, '.tmp', 'runtime-lease-')));
  await rm(dir, { recursive: true, force: true });
}
console.log(JSON.stringify({ version, platform: process.platform, leaseProtocolVerified, completed, userSessionsUntouched: true }));
trace('report-written');
