import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { codexHookStatus, trustCodexHooks } from '../skills/cross-debate/scripts/lib/codex-hooks.mjs';

const EVENTS = ['PreToolUse', 'SessionStart', 'UserPromptSubmit', 'Stop'];
const command = event => `node "/home/.codex/skills/cross-debate/scripts/debate.mjs" hook codex ${event}`;
const commands = EVENTS.map(command);
const hook = (event, trustStatus = 'untrusted', extra = {}) =>
  ({ key: `/home/.codex/hooks.json:${event}:0:0`, command: command(event), source: 'user', currentHash: `sha256:${event}`, trustStatus, ...extra });
const others = [
  { key: 'herdr', command: 'herdr hook', source: 'user', currentHash: 'sha256:h', trustStatus: 'untrusted' },
  { key: 'plugin', command: command('Stop'), source: 'plugin', currentHash: 'sha256:p', trustStatus: 'untrusted' },
];

/** A fake app-server: `lists` answers successive hooks/list calls; `reply` overrides any response. */
function appServer({ lists = [], reply = () => undefined } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.calls = [];
  child.stdin = { write: line => {
    const message = JSON.parse(line);
    child.calls.push(message);
    if (message.id === undefined) return;
    let response = reply(message);
    if (response === undefined) {
      if (message.method === 'initialize') response = { id: message.id, result: {} };
      else if (message.method === 'hooks/list') response = { id: message.id, result: { data: [{ hooks: lists.shift() ?? [] }] } };
      else if (message.method === 'config/batchWrite') response = { id: message.id, result: { status: 'ok' } };
    }
    if (response) queueMicrotask(() => child.stdout.write(`${JSON.stringify(response)}\n`));
  } };
  child.kill = () => { child.killed = true; };
  return child;
}
const methods = child => child.calls.map(call => call.method);

test('trusts only exact-match user hooks that are untrusted or modified, then confirms with a second list', async () => {
  const first = [hook('PreToolUse'), hook('SessionStart', 'modified'), hook('UserPromptSubmit', 'trusted'), hook('Stop'), ...others];
  const child = appServer({ lists: [first, EVENTS.map(event => hook(event, 'trusted'))] });
  const result = await trustCodexHooks({ commands, spawnImpl: (cli, args) => {
    assert.equal(cli, 'codex'); assert.deepEqual(args, ['app-server', '--listen', 'stdio://']); return child;
  } });
  assert.deepEqual(result, { ok: true, pending: [], missing: [] });
  assert.deepEqual(methods(child), ['initialize', 'initialized', 'hooks/list', 'config/batchWrite', 'hooks/list']);
  const [edit] = child.calls.find(call => call.method === 'config/batchWrite').params.edits;
  assert.equal(edit.keyPath, 'hooks.state');
  assert.equal(edit.mergeStrategy, 'upsert');
  assert.deepEqual(edit.value, Object.fromEntries(['PreToolUse', 'SessionStart', 'Stop'].map(event => [hook(event).key, { trusted_hash: `sha256:${event}` }])),
    'herdr, plugin and already-trusted hooks stay out of the write');
  assert.equal(child.killed, true);
});

test('skips the write when every owned hook is already trusted', async () => {
  const trusted = EVENTS.map(event => hook(event, 'trusted'));
  const child = appServer({ lists: [trusted, trusted] });
  assert.deepEqual(await trustCodexHooks({ commands, spawnImpl: () => child }), { ok: true, pending: [], missing: [] });
  assert.ok(!methods(child).includes('config/batchWrite'));
});

test('reports pending keys when the confirming list still shows a hook untrusted', async () => {
  const child = appServer({ lists: [EVENTS.map(event => hook(event)), EVENTS.map(event => hook(event, event === 'Stop' ? 'untrusted' : 'trusted'))] });
  assert.deepEqual(await trustCodexHooks({ commands, spawnImpl: () => child }), { ok: false, pending: [hook('Stop').key], missing: [] });
});

test('reports missing events for an empty list, a partial list, and a hook that disappears between lists', async () => {
  const run = lists => trustCodexHooks({ commands, spawnImpl: () => appServer({ lists }) });
  assert.deepEqual(await run([[], []]), { ok: false, pending: [], missing: EVENTS });
  const partial = EVENTS.slice(0, 2).map(event => hook(event, 'trusted'));
  assert.deepEqual(await run([partial, partial]), { ok: false, pending: [], missing: ['UserPromptSubmit', 'Stop'] });
  assert.deepEqual(await run([EVENTS.map(event => hook(event)), EVENTS.slice(1).map(event => hook(event, 'trusted'))]),
    { ok: false, pending: [], missing: ['PreToolUse'] });
});

test('resolves null without throwing on spawn error, JSON-RPC error, unexpected shape, and timeout', async () => {
  assert.equal(await trustCodexHooks({ commands, spawnImpl: () => { throw new Error('ENOENT'); } }), null);
  const oldCodex = appServer({ reply: message => message.method === 'hooks/list' ? { id: message.id, error: { code: -32601, message: 'method not found' } } : undefined });
  assert.equal(await trustCodexHooks({ commands, spawnImpl: () => oldCodex }), null);
  const odd = appServer({ reply: message => message.method === 'hooks/list' ? { id: message.id, result: {} } : undefined });
  assert.equal(await codexHookStatus({ owns: () => true, events: EVENTS, spawnImpl: () => odd }), null);
  const silent = appServer({ reply: () => null });
  assert.equal(await trustCodexHooks({ commands, spawnImpl: () => silent, timeout: 5 }), null);
  assert.equal(silent.killed, true);
});

test('status is read-only and reports every event missing for an empty list', async () => {
  const owns = text => text.includes('debate.mjs" hook codex');
  const empty = appServer({ lists: [[]] });
  assert.deepEqual(await codexHookStatus({ owns, events: EVENTS, spawnImpl: () => empty }), { hooks: [], missing: EVENTS });
  const child = appServer({ lists: [[hook('Stop', 'modified'), ...others]] });
  assert.deepEqual(await codexHookStatus({ owns, events: EVENTS, spawnImpl: () => child }),
    { hooks: [{ key: hook('Stop').key, eventName: 'Stop', currentHash: 'sha256:Stop', trustStatus: 'modified' }], missing: EVENTS.slice(0, 3) });
  assert.deepEqual(methods(child), ['initialize', 'initialized', 'hooks/list']);
});

test('decodes a multibyte character split across stdout chunks', async () => {
  const unicode = event => `node "/home/José/.codex/skills/cross-debate/scripts/debate.mjs" hook codex ${event}`;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = { write: line => {
    const message = JSON.parse(line);
    if (message.method === 'initialize') queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`));
    if (message.method !== 'hooks/list') return;
    const hooks = EVENTS.map(event => ({ key: `/home/José/${event}`, command: unicode(event), source: 'user', trustStatus: 'trusted' }));
    const bytes = Buffer.from(`${JSON.stringify({ id: message.id, result: { data: [{ hooks }] } })}\n`);
    const split = bytes.indexOf(Buffer.from('é')) + 1;
    queueMicrotask(() => { child.stdout.write(bytes.subarray(0, split)); child.stdout.write(bytes.subarray(split)); });
  } };
  child.kill = () => {};
  const status = await codexHookStatus({ owns: text => EVENTS.map(unicode).includes(text), events: EVENTS, spawnImpl: () => child });
  assert.deepEqual(status.missing, []);
  assert.equal(status.hooks[0].key, '/home/José/PreToolUse');
});
