import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reviewerReadiness, hookEntries, mergeHooks } from '../skills/cross-debate/scripts/setup.mjs';

const originalEnv = { ...process.env };
const git = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
const cli = fileURLToPath(new URL('../skills/cross-debate/scripts/debate.mjs', import.meta.url));
const fleet = implementer => ({ version: 'delegate-fleet.v1', lanes: Object.fromEntries(
  ['plan-main', 'plan-debate', 'review-main', 'review-debate'].map(name => [name, { implementer }]),
) });
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
let home, repo, globalFile, projectFile;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cross-debate-readiness-')));
  for (const name of Object.keys(process.env)) if (/^(GIT_|DEBATE|DELEGATE_|CODEX_|CLAUDE_)/.test(name)) delete process.env[name];
  Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), DEBATE_HOME: path.join(home, 'state'),
    PATH: path.join(home, 'bin'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
  write(path.join(home, 'bin/claude'), '#!/bin/sh\nprintf called > "$HOME/reviewer-called"\nexit 99\n');
  fs.chmodSync(path.join(home, 'bin/claude'), 0o755);
  fs.symlinkSync(git, path.join(home, 'bin/git'));
  repo = path.join(home, 'repo'); fs.mkdirSync(repo);
  assert.equal(spawnSync(git, ['init', '-q', repo]).status, 0);
  globalFile = path.join(home, '.config/delegate-skills/config.json');
  projectFile = path.join(repo, '.delegate/config.json');
  write(globalFile, JSON.stringify(fleet('claude')));
});

afterEach(() => {
  assert.equal(fs.existsSync(path.join(home, 'reviewer-called')), false, 'readiness must not invoke reviewer CLIs');
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  fs.rmSync(home, { recursive: true, force: true });
});

const doctor = (...args) => spawnSync(process.execPath, [cli, 'setup', 'doctor', '--cwd', repo, ...args], { encoding: 'utf8' });
function project(lanes, { trust = false } = {}) {
  const text = JSON.stringify({ version: 'delegate-fleet.v1', lanes });
  write(projectFile, text);
  if (trust) write(path.join(repo, '.git/delegate-skills/project-config.sha256'), createHash('sha256').update(text).digest('hex'));
}

test('doctor fails when its configured reviewer is missing even though another CLI is present', () => {
  write(globalFile, JSON.stringify(fleet('codex')));
  const result = doctor();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /reviewer CLIs: claude/);
  assert.match(result.stdout, /✗ lane review-main: codex .*codex is not on PATH/);
});

test('untrusted project plan overrides fail doctor and prospective installation checks', async () => {
  project({ 'plan-main': { implementer: 'claude', model: 'project-model' } });
  const before = fs.readFileSync(projectFile, 'utf8');
  const ready = await reviewerReadiness(repo, { globalConfig: fleet('claude'), seats: ['claude'] });
  assert.equal(ready.ok, false);
  assert.match(ready.checks.find(check => check.lane === 'plan-main').error, /requires explicit project configuration trust/);
  assert.equal(ready.lanes['plan-main'].source, 'project');
  assert.equal(fs.readFileSync(projectFile, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(repo, '.git/delegate-skills')), false);
  const result = doctor();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /✗ lane plan-main: .*requires explicit project configuration trust/);
});

test('trusted project code reviewer overrides still fail the global binding requirement', async () => {
  project({ 'review-main': { implementer: 'claude' } }, { trust: true });
  const ready = await reviewerReadiness(repo);
  assert.equal(ready.ok, false);
  assert.match(ready.checks.find(check => check.lane === 'review-main').error, /must use a global binding/);
  const result = doctor();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /✗ lane review-main: .*must use a global binding/);
});

test('prospective global settings replace existing globals without writing and retain trusted plan overrides', async () => {
  write(globalFile, JSON.stringify(fleet('codex')));
  project({ 'plan-main-codex': { implementer: 'claude', model: 'project-model' } }, { trust: true });
  const before = fs.readFileSync(globalFile, 'utf8');
  const ready = await reviewerReadiness(repo, { globalConfig: fleet('claude'), seats: ['codex'] });
  assert.equal(ready.ok, true, JSON.stringify(ready.checks));
  assert.deepEqual(ready.lanes['plan-main-codex'], { implementer: 'claude', model: 'project-model', source: 'project' });
  assert.equal(ready.lanes['review-main'].implementer, 'claude');
  assert.equal(fs.readFileSync(globalFile, 'utf8'), before);
  fs.rmSync(globalFile);
  assert.equal((await reviewerReadiness(repo, { globalConfig: fleet('claude'), seats: ['codex'] })).ok, true);
  assert.equal(fs.existsSync(globalFile), false, 'a fresh installation can check its settings before creating the config');
});

test('selected-host doctor checks only its effective plan lane and hook definitions', () => {
  const config = fleet('claude');
  config.lanes['plan-main-codex'] = { implementer: 'codex' };
  write(globalFile, JSON.stringify(config));
  const result = doctor('--agent', 'claude');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /✓ reviewer CLIs: claude/);
  assert.match(result.stdout, /supported.*diversity/);
  assert.match(result.stdout, /hooks claude:/);
  assert.doesNotMatch(result.stdout, /hooks (codex|cursor|opencode):|lane plan-main-codex:|seat codex:/);
  assert.match(result.stdout, /sign-in: unverified/);
  assert.equal(doctor().status, 1, 'all-host mode still checks the missing Codex reviewer');
  const invalid = doctor('--agent', 'unknown');
  assert.equal(invalid.status, 2);
  assert.match(invalid.stdout, /--agent must be/);
});

test('doctor reports Git default and Codex manual settings without parsing TOML', () => {
  write(path.join(home, '.codex/config.toml'), 'deliberately invalid TOML');
  let result = doctor('--agent', 'codex');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /automatic reviews: on: Git default/);
  assert.match(result.stdout, /does not parse config.toml\. /);
  assert.doesNotMatch(result.stdout, /native trust/);
  assert.match(result.stdout, /features.hooks = true.*sandbox_workspace_write.writable_roots/);
  assert.ok(result.stdout.includes(process.env.DEBATE_HOME));
  assert.equal(spawnSync(git, ['-C', repo, 'config', '--local', 'debate.enabled', 'true']).status, 0);
  result = doctor('--agent', 'codex');
  assert.match(result.stdout, /automatic reviews: on: explicitly enabled/);
  assert.equal(spawnSync(git, ['-C', repo, 'config', '--local', 'debate.enabled', 'false']).status, 0);
  assert.match(doctor('--agent', 'codex').stdout, /automatic reviews: off: explicit project opt-out/);
  result = doctor('--agent', 'codex', '--cwd', home);
  assert.match(result.stdout, /automatic reviews: off: not a Git repository/);
});

test('doctor run from the shared install finds Codex hooks written for the catalog path and reports an untrusted one', () => {
  const codexHome = path.join(home, '.codex');
  process.env.CODEX_HOME = codexHome;
  write(globalFile, JSON.stringify(fleet('codex')));
  const entries = hookEntries('codex', path.join(codexHome, 'skills/cross-debate/scripts/debate.mjs'));
  write(entries.file, JSON.stringify(mergeHooks('codex', {}, entries)));
  const hooks = Object.values(entries.events).flat().map(({ command }, i) => ({
    key: `${entries.file}:${i}`, command, source: 'user', currentHash: `sha256:${i}`, trustStatus: i ? 'trusted' : 'untrusted',
  }));
  hooks.push({ key: 'other', command: 'echo other', source: 'user', trustStatus: 'untrusted' });
  // A fake app-server: answers initialize and hooks/list, and records any other method.
  write(path.join(home, 'bin/codex'), `#!${process.execPath}
const fs = require('node:fs');
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (let end; (end = buffer.indexOf('\\n')) >= 0; buffer = buffer.slice(end + 1)) {
    const message = JSON.parse(buffer.slice(0, end));
    if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: {} }));
    else if (message.method === 'hooks/list') console.log(JSON.stringify({ id: message.id, result: { data: [{ hooks: ${JSON.stringify(hooks)} }] } }));
    else if (message.method !== 'initialized') fs.writeFileSync(${JSON.stringify(path.join(home, 'unexpected-call'))}, message.method);
  }
});
`);
  fs.chmodSync(path.join(home, 'bin/codex'), 0o755);
  const result = doctor('--agent', 'codex');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /✓ hooks codex: definition marker found/);
  assert.ok(result.stdout.includes(`! codex hook trust: ${entries.file}:0 (untrusted); rerun the installer or run /hooks in Codex`), result.stdout);
  assert.equal(fs.existsSync(path.join(home, 'unexpected-call')), false, 'doctor must stay read-only');
});
