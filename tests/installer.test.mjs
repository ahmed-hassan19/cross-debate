import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parse } from '@rainbowatcher/toml-edit-js';
import { install, prepareInstall, applyInstall, mergeCodex } from '../bin/cross-debate.mjs';

const originalEnv = { ...process.env };
const git = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
const fleet = { version: 'delegate-fleet.v1', lanes: {
  'plan-main': { implementer: 'codex' }, 'plan-debate': { implementer: 'claude' },
  'review-main': { implementer: 'claude' }, 'review-debate': { implementer: 'codex' },
  docs: { implementer: 'claude', model: 'sonnet' },
} };
let home, target, config, settings, hooks, toml;
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const read = file => fs.readFileSync(file, 'utf8');
const json = file => JSON.parse(read(file));
const plan = (extra = {}) => prepareInstall({ hosts: ['claude', 'codex'], config: fleet, cwd: home, ...extra });

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cross-debate-installer-')));
  for (const key of Object.keys(process.env)) if (/^(GIT_|DEBATE|DELEGATE_|CODEX_|CLAUDE_)/.test(key)) delete process.env[key];
  Object.assign(process.env, { HOME: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    XDG_CONFIG_HOME: path.join(home, '.config'), DEBATE_HOME: path.join(home, 'state'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', PATH: path.join(home, 'bin') });
  for (const cli of ['claude', 'codex']) {
    write(path.join(home, 'bin', cli), '#!/bin/sh\nprintf called > "$HOME/cli-called"\nexit 99\n');
    fs.chmodSync(path.join(home, 'bin', cli), 0o755);
  }
  fs.symlinkSync(git, path.join(home, 'bin', 'git'));
  target = path.join(home, '.agents/skills/cross-debate');
  config = path.join(home, '.config/delegate-skills/config.json');
  settings = path.join(home, '.claude/settings.json'); hooks = path.join(home, '.codex/hooks.json');
  toml = path.join(home, '.codex/config.toml');
});
afterEach(() => {
  assert.equal(fs.existsSync(path.join(home, 'cli-called')), false, 'installer must not call reviewer CLIs');
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  fs.rmSync(home, { recursive: true, force: true });
});

test('cancelling at the Apply prompt leaves the fresh home untouched', async () => {
  let cancelled = '';
  const ui = { intro() {}, note() {}, outro() {}, log: { info() {} }, isCancel: () => false,
    multiselect: async () => ['claude', 'codex'], select: async () => 'default', confirm: async () => false,
    cancel: message => { cancelled = message; } };
  assert.equal(await install(ui, home), 0);
  assert.match(cancelled, /Cancelled/);
  assert.deepEqual(fs.readdirSync(home), ['bin']);
});

test('install merges settings and comments; repeat installation preserves hooks and project enrollment', () => {
  const unrelated = { hooks: [{ type: 'command', command: 'other-tool' }] };
  write(settings, JSON.stringify({ theme: 'dark', hooks: { Stop: [unrelated] }, permissions: { allow: ['Bash(git status)'], deny: ['Read(secret)'] } }));
  write(hooks, JSON.stringify({ hooks: { Stop: [unrelated] } }));
  write(config, JSON.stringify(fleet));
  write(toml, '# user config\nmodel = "chosen"\n[features]\nother = true\nhooks = false # hook preference\n[sandbox_workspace_write]\nwritable_roots = ["/work"] # existing roots\n');
  assert.equal(spawnSync(git, ['init', '-q', home]).status, 0);
  applyInstall(plan({ attach: true }));
  const version = JSON.parse(read(path.resolve('package.json'))).version;
  assert.equal(read(path.join(target, 'VERSION')).trim(), version);
  const installedVersion = spawnSync(process.execPath, [path.join(target, 'scripts/debate.mjs'), '--version'], { encoding: 'utf8' });
  assert.equal(installedVersion.status, 0, installedVersion.stderr);
  assert.equal(installedVersion.stdout.trim(), `cross-debate ${version}`);
  assert.equal(json(settings).theme, 'dark');
  assert.deepEqual(json(settings).permissions.deny, ['Read(secret)']);
  assert.ok(json(settings).permissions.allow.includes('Bash(git status)'));
  for (const file of [settings, hooks]) assert.deepEqual(json(file).hooks.Stop[0], unrelated);
  assert.deepEqual(json(config).lanes.docs, fleet.lanes.docs);
  const parsed = parse(read(toml));
  assert.equal(parsed.model, 'chosen'); assert.deepEqual(parsed.features, { other: true, hooks: true });
  assert.deepEqual(parsed.sandbox_workspace_write.writable_roots, ['/work', process.env.DEBATE_HOME]);
  for (const comment of ['# user config', '# hook preference', '# existing roots']) assert.ok(read(toml).includes(comment));
  const first = [settings, hooks, toml].map(read);
  const again = plan({ attach: true }); assert.equal(again.attach, false); applyInstall(again);
  assert.deepEqual([settings, hooks, toml].map(read), first);
  assert.equal(spawnSync(git, ['-C', home, 'config', '--local', '--get', 'debate.enabled'], { encoding: 'utf8' }).stdout.trim(), 'true');
});

test('version works before installation and distinguishes an older installed skill', () => {
  const args = [path.resolve('bin/cross-debate.mjs'), '--version'];
  const fresh = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stdout, /^cross-debate \d+\.\d+\.\d+\n$/);
  write(path.join(target, 'SKILL.md'), 'name: cross-debate');
  write(path.join(target, 'VERSION'), '0.0.1\n');
  const older = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(older.status, 0, older.stderr);
  assert.match(older.stdout, /Installed skill: 0\.0\.1/);
});

for (const format of ['JSON', 'TOML']) test(`malformed ${format} is rejected before installation writes`, () => {
  const file = format === 'JSON' ? settings : toml;
  write(file, format === 'JSON' ? '{bad json' : '[features\nhooks = true');
  const before = read(file);
  assert.throws(() => plan());
  assert.equal(read(file), before); assert.equal(fs.existsSync(target), false); assert.equal(fs.existsSync(config), false);
});

test('legacy symlink migration preserves its checkout and keeps old runtime commands accessible', () => {
  const checkout = path.join(home, 'checkout'); const legacy = path.join(home, '.agents/skills/debate');
  write(path.join(checkout, 'SKILL.md'), '---\nname: debate\n---\n');
  write(path.join(checkout, 'scripts/debate.mjs'), 'console.log("old checkout");\n');
  write(path.join(checkout, 'scripts/lib/common.mjs'), "export const schema = 'debate.run.v1';\n");
  fs.mkdirSync(path.dirname(legacy), { recursive: true }); fs.symlinkSync(checkout, legacy);
  const originals = ['SKILL.md', 'scripts/debate.mjs', 'scripts/lib/common.mjs'].map(name => [name, read(path.join(checkout, name))]);
  applyInstall(plan());
  for (const [name, text] of originals) assert.equal(read(path.join(checkout, name)), text);
  assert.equal(fs.existsSync(path.join(legacy, 'SKILL.md')), false);
  const help = spawnSync(process.execPath, [path.join(legacy, 'scripts/debate.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /plan <command>/);
});

test('a shared catalog parent stays linked and is installed only once', () => {
  const shared = path.dirname(target); const claudeSkills = path.join(home, '.claude/skills');
  fs.mkdirSync(shared, { recursive: true }); fs.mkdirSync(path.dirname(claudeSkills), { recursive: true });
  fs.symlinkSync(shared, claudeSkills);
  applyInstall(plan()); applyInstall(plan());
  assert.equal(fs.readlinkSync(claudeSkills), shared);
  assert.equal(fs.lstatSync(target).isDirectory(), true);
  assert.equal(fs.realpathSync(path.join(claudeSkills, 'cross-debate')), target);
});

test('an unselected host keeps its shared legacy registration', () => {
  const shared = path.join(home, '.agents/skills/debate'); const legacy = path.join(home, '.claude/skills/debate');
  fs.mkdirSync(path.dirname(shared), { recursive: true }); fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.symlinkSync(path.resolve('skills/cross-debate'), shared); fs.symlinkSync(shared, legacy);
  const pending = plan({ hosts: ['codex'] }); assert.deepEqual(pending.retainedHosts, ['Claude Code']); applyInstall(pending);
  assert.equal(fs.existsSync(path.join(legacy, 'SKILL.md')), true); assert.equal(fs.readlinkSync(legacy), shared);
});

test('reviewer settings changed during the wizard are not overwritten', async () => {
  write(config, JSON.stringify(fleet)); let failure = ''; const changed = JSON.stringify({ ...fleet, lanes: {} });
  const ui = { intro() {}, note() {}, isCancel: () => false, multiselect: async () => ['claude'],
    select: async () => { write(config, changed); return 'default'; },
    confirm: async () => assert.fail('changed settings must be rejected before Apply'),
    cancel: message => { failure = message; } };
  assert.equal(await install(ui, home), 1); assert.match(failure, /Reviewer settings changed/);
  assert.equal(read(config), changed); assert.equal(fs.existsSync(target), false);
});

test('project reviewer overrides are checked before Apply and never silently trusted', async () => {
  assert.equal(spawnSync(git, ['init', '-q', home]).status, 0);
  const project = path.join(home, '.delegate/config.json');
  const before = JSON.stringify({ version: 'delegate-fleet.v1', lanes: { 'plan-main': { implementer: 'claude' } } });
  write(project, before);
  let failure = '', confirms = 0;
  const ui = { intro() {}, note() {}, isCancel: () => false,
    multiselect: async () => ['claude'], select: async () => 'default',
    confirm: async () => { assert.equal(++confirms, 1, 'Apply must not be offered'); return true; },
    cancel: message => { failure = message; } };
  assert.equal(await install(ui, home), 1);
  assert.match(failure, /requires explicit project configuration trust/);
  assert.equal(read(project), before);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(config), false);
  assert.equal(fs.existsSync(path.join(home, '.git/delegate-skills')), false);
  assert.notEqual(spawnSync(git, ['-C', home, 'config', '--local', '--get', 'debate.enabled'], { encoding: 'utf8' }).stdout.trim(), 'true');
});

test('the summary shows effective trusted project reviewers, including a replacement for a missing global CLI', async () => {
  assert.equal(spawnSync(git, ['init', '-q', home]).status, 0);
  fs.rmSync(path.join(home, 'bin/codex'));
  const global = structuredClone(fleet);
  global.lanes['review-debate'] = { implementer: 'claude' };
  write(config, JSON.stringify(global));
  const project = JSON.stringify({ version: 'delegate-fleet.v1', lanes: { 'plan-main': { implementer: 'claude', model: 'project-reviewer' } } });
  write(path.join(home, '.delegate/config.json'), project);
  write(path.join(home, '.git/delegate-skills/project-config.sha256'), createHash('sha256').update(project).digest('hex'));
  const notes = [];
  const ui = { intro() {}, outro() {}, log: { info() {} }, isCancel: () => false,
    note: text => notes.push(text), multiselect: async () => ['claude'], select: async () => 'default',
    confirm: async () => true, cancel: message => assert.fail(message) };
  assert.equal(await install(ui, home), 0);
  assert.match(notes.join('\n'), /Plan reviewers: claude \/ project-reviewer \(project override\)/);
  assert.equal(json(config).lanes['plan-main'].implementer, 'codex', 'the shared global lane remains unchanged');
});

test('custom reviewers validate model input and persist models and reasoning effort', async () => {
  const selections = ['custom', 'codex', 'claude'];
  const answers = ['example-codex', 'high', 'example-claude', 'medium'];
  const ui = { intro() {}, note() {}, outro() {}, log: { info() {} }, isCancel: () => false,
    multiselect: async () => ['codex'], select: async () => selections.shift(), confirm: async () => true,
    text: async options => {
      if (options.message.includes('model')) assert.ok(options.validate('invalid model with spaces'));
      const value = answers.shift(); assert.equal(options.validate(value), undefined); return value;
    }, cancel: message => assert.fail(message) };
  assert.equal(await install(ui, home), 0);
  assert.deepEqual(json(config).lanes['review-main'], { implementer: 'codex', model: 'example-codex', effort: 'high' });
  assert.deepEqual(json(config).lanes['plan-main'], { implementer: 'claude', model: 'example-claude', effort: 'medium' });
});

test('Codex merge handles dotted keys and inline features, rejecting unsupported inline roots', () => {
  for (const text of ['features.hooks = false\nsandbox_workspace_write.writable_roots = ["/work"]\n',
    'features = { hooks = false, other = true }\n[sandbox_workspace_write]\nwritable_roots = ["/work"]\n']) {
    const merged = mergeCodex(text, '/state'); const result = parse(merged);
    assert.equal(result.features.hooks, true);
    assert.deepEqual(result.sandbox_workspace_write.writable_roots, ['/work', '/state']);
    assert.equal(mergeCodex(merged, '/state'), merged);
  }
  assert.throws(() => mergeCodex('sandbox_workspace_write = { writable_roots = ["/work"] }\n', '/state'), /Cannot preserve this inline/);
  assert.throws(() => mergeCodex('[sandbox_workspace_write]\nwritable_roots = [42]\n', '/state'), /array of paths/);
});

test('an apply failure restores original settings and removes newly installed paths', () => {
  const original = '{"theme":"dark"}\n'; write(settings, original); write(config, JSON.stringify(fleet));
  const legacy = path.join(home, '.agents/skills/debate');
  const relative = path.relative(path.dirname(legacy), path.resolve('skills/cross-debate'));
  fs.mkdirSync(path.dirname(legacy), { recursive: true }); fs.symlinkSync(relative, legacy);
  const beforeConfig = read(config); const pending = plan(); const blocker = path.join(home, 'not-a-directory');
  write(blocker, 'keep');
  pending.changes.push({ file: path.join(blocker, 'child'), kind: 'text', value: 'fail', before: '', previous: null });
  assert.throws(() => applyInstall(pending), /ENOTDIR/);
  assert.equal(read(settings), original); assert.equal(read(config), beforeConfig); assert.equal(read(blocker), 'keep');
  assert.equal(fs.readlinkSync(legacy), relative);
  for (const file of [target, hooks, toml, path.join(home, '.claude/skills/cross-debate')]) assert.equal(fs.existsSync(file), false);
});
