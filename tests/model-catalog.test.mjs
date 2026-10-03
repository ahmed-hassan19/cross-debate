import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { claudeModels, codexModels, modelMenu } from '../skills/cross-debate/scripts/lib/model-catalog.mjs';

test('model menus put CLI default first, one current choice per family, existing choice next, and custom last', () => {
  const claude = modelMenu('claude', ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'], 'my-claude');
  assert.deepEqual(claude.map(x => x.value), ['default', 'claude-opus-5-5', 'claude-sonnet-5-5', 'my-claude', 'other']);
  assert.equal(claude[1].hint, 'catalog suggestion; access not verified');
  assert.deepEqual(modelMenu('codex', ['gpt-5.4', 'gpt-5.3', 'codex-mini'], 'gpt-5.4').map(x => x.value), ['default', 'gpt-5.4', 'codex-mini', 'other']);
});

test('Claude uses aliases without a key, and the Models API only with an existing key', async () => {
  assert.deepEqual(await claudeModels({ key: '', fetchImpl: () => assert.fail('no request without a key') }), ['opus', 'sonnet', 'haiku']);
  let request;
  const live = await claudeModels({ key: 'private-key', fetchImpl: async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ data: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-opus-5-5' }] }) };
  } });
  assert.deepEqual(live, ['claude-sonnet-5-5', 'claude-opus-5-5']);
  assert.equal(request.url, 'https://api.anthropic.com/v1/models?limit=100');
  assert.equal(request.options.headers['x-api-key'], 'private-key');
  assert.deepEqual(await claudeModels({ key: 'private-key', fetchImpl: () => { throw new Error('private-key'); } }), ['opus', 'sonnet', 'haiku']);
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
  assert.deepEqual(await codexModels({ spawnImpl: () => child, timeout: 5 }), ['gpt-5.4', 'gpt-5.4-mini']);
  assert.equal(killed, true);
});
