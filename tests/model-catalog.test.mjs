import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { claudeModels, codexModels, modelMenu } from '../skills/cross-debate/scripts/lib/model-catalog.mjs';

test('model menus put CLI default first, one current choice per family, existing choice next, and custom last', () => {
  const claude = modelMenu('claude', ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'], 'my-claude');
  assert.deepEqual(claude.map(x => x.value), ['default', 'claude-opus-5-5', 'claude-sonnet-5-5', 'my-claude', 'other']);
  assert.equal(claude[1].hint, undefined);
  assert.deepEqual(modelMenu('codex', ['gpt-5.4', 'gpt-5.3', 'codex-mini'], 'gpt-5.4').map(x => x.value), ['default', 'gpt-5.4', 'codex-mini', 'other']);
});

test('Codex menus keep the newest model of each tier instead of collapsing every GPT model into one', () => {
  const served = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'];
  assert.deepEqual(modelMenu('codex', served).map(x => x.value), ['default', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.5', 'other']);
});

test('Claude menus fall back to versioned model IDs for every family, including Fable', () => {
  assert.deepEqual(modelMenu('claude', null).map(x => x.value),
    ['default', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'other']);
});

const fakeChild = respond => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.calls = [];
  child.stdin = { write: line => {
    const message = JSON.parse(line);
    child.calls.push(message);
    const reply = respond(message);
    if (reply) queueMicrotask(() => child.stdout.write(`${JSON.stringify(reply)}\n`));
  } };
  child.kill = () => { child.killed = true; };
  return child;
};

test('Claude lists the account\'s versioned models through the initialize control request, never a turn', async () => {
  let spawned;
  const child = fakeChild(message => message.type === 'control_request' && { type: 'control_response', response: {
    subtype: 'success', request_id: message.request_id,
    response: { models: [{ value: 'default', resolvedModel: 'claude-opus-5' }, { value: 'opus', resolvedModel: 'claude-opus-5-5' },
      { value: 'fable', resolvedModel: 'claude-fable-5-1' }, { value: 'custom-alias' }] },
  } });
  const models = await claudeModels({ spawnImpl: (command, args) => { spawned = { command, args }; return child; } });
  assert.deepEqual(models, ['claude-opus-5-5', 'claude-fable-5-1', 'custom-alias'], 'an older Default resolution must not hide the newer Opus');
  assert.equal(spawned.command, 'claude');
  for (const flag of ['--safe-mode', '--no-session-persistence', '--input-format']) assert.ok(spawned.args.includes(flag), flag);
  assert.deepEqual(child.calls, [{ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } }]);
  assert.equal(child.killed, true);
});

test('Claude falls back to versioned IDs when the CLI fails or never answers', async () => {
  const versioned = ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'];
  assert.deepEqual(await claudeModels({ spawnImpl: () => { throw new Error('ENOENT'); } }), versioned);
  assert.deepEqual(await claudeModels({ spawnImpl: () => fakeChild(() => null), timeout: 5 }), versioned);
});

test('Codex asks app-server only for the catalog after initialization, never starts a review turn', async () => {
  const calls = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = { write: line => {
    const message = JSON.parse(line);
    calls.push(message);
    if (message.method === 'initialize') queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`));
    if (message.method === 'model/list') queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: 2, result: { data: [{ model: 'gpt-5.4' }] } })}\n`));
  } };
  child.kill = () => {};
  const models = await codexModels({ spawnImpl: (command, args) => {
    assert.equal(command, 'codex'); assert.deepEqual(args, ['app-server', '--listen', 'stdio://']); return child;
  } });
  assert.deepEqual(models, ['gpt-5.4']);
  assert.deepEqual(calls.map(call => call.method), ['initialize', 'initialized', 'model/list']);
});

test('Codex catalog timeout falls back without exposing child diagnostics', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = { write() {} };
  let killed = false;
  child.kill = () => { killed = true; };
  assert.deepEqual(await codexModels({ spawnImpl: () => child, timeout: 5 }), ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-terra']);
  assert.equal(killed, true);
});
