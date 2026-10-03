// Host adapters, setup, dependency lookup, plan lane precedence, the router, and review backend guards. Offline and hermetic.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '..', 'skills', 'cross-debate');
const SCRIPTS = path.join(SKILL, 'scripts');
const CLI = path.join(SCRIPTS, 'debate.mjs');
const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'debate-hosts-')));
const HOME = path.join(SCRATCH, 'debate-home');
const XDG = path.join(SCRATCH, 'xdg');
const BIN = path.join(SCRATCH, 'bin');

process.env.HOME = path.join(SCRATCH, 'user-home');
fs.mkdirSync(process.env.HOME, { recursive: true });
for (const name of ['DELEGATE_SKILLS_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SESSION_ID', 'CODEX_THREAD_ID', 'DEBATE', 'DEBATE_CHILD']) delete process.env[name];
process.env.DEBATE_HOME = HOME;
process.env.XDG_CONFIG_HOME = XDG;
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_SYSTEM = '/dev/null';
fs.mkdirSync(path.join(XDG, 'delegate-skills'), { recursive: true });
fs.copyFileSync(path.join(HERE, 'fixtures', 'lane-config.json'), path.join(XDG, 'delegate-skills', 'config.json'));
fs.mkdirSync(BIN, { recursive: true });
for (const tool of ['git', 'sh', 'env']) {
  const r = spawnSync('which', [tool], { encoding: 'utf8' });
  if (r.status === 0) fs.symlinkSync(r.stdout.trim(), path.join(BIN, tool));
}
fs.symlinkSync(process.execPath, path.join(BIN, 'node'));
process.env.PATH = `${BIN}:/usr/bin:/bin`;

const common = await import(path.join(SCRIPTS, 'lib', 'common.mjs'));
const hooks = await import(path.join(SCRIPTS, 'hooks.mjs'));
const plan = await import(path.join(SCRIPTS, 'plan.mjs'));
const setup = await import(path.join(SCRIPTS, 'setup.mjs'));
common.ensureHome(HOME);
after(() => { fs.rmSync(SCRATCH, { recursive: true, force: true }); });

function run(args, opts = {}) {
  return spawnSync(process.execPath, [opts.cli || CLI, ...args], { encoding: 'utf8', cwd: SCRATCH, input: opts.input, env: { ...process.env, ...(opts.env || {}) } });
}
function enrolledRepo(name) {
  const dir = path.join(SCRATCH, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'], ['config', 'commit.gpgsign', 'false'], ['commit', '-q', '--allow-empty', '-m', 'init']]) {
    assert.equal(spawnSync('git', args, { cwd: dir }).status, 0);
  }
  common.changeRepositoryScope(dir, true, HOME);
  return dir;
}
function binWith(names) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, 'clis-'));
  for (const name of names) { fs.writeFileSync(path.join(dir, name), '#!/bin/sh\nexit 0\n'); fs.chmodSync(path.join(dir, name), 0o755); }
  return `${dir}:${BIN}:/usr/bin:/bin`;
}

test('cursor and opencode render a denied push in their own formats; the generated OpenCode plugin throws', async () => {
  const repo = enrolledRepo('gate-repo');
  const cursor = run(['hook', 'cursor', 'beforeShellExecution'], { input: JSON.stringify({ conversation_id: 'c0ffee00-0000-4000-8000-000000000001', command: 'git push origin main', cwd: repo, workspace_roots: [repo] }) });
  assert.equal(cursor.status, 0, cursor.stderr);
  const denied = JSON.parse(cursor.stdout);
  assert.equal(denied.permission, 'deny');
  assert.match(denied.agent_message, /debate-code: unsupported push command/);
  assert.equal(denied.user_message, denied.agent_message);

  const oc = hooks.handleHook('opencode', 'tool.execute.before', { sessionID: 'ses_1', directory: repo, tool: 'bash', args: { command: 'git push origin main' } }, { home: HOME });
  assert.equal(oc.output.deny, true);
  assert.match(oc.output.reason, /approve-push/);
  assert.equal(hooks.handleHook('opencode', 'tool.execute.before', { sessionID: 'ses_1', directory: repo, tool: 'read', args: { filePath: 'x' } }, { home: HOME }).output, null);
  assert.equal(hooks.handleHook('cursor', 'beforeShellExecution', { conversation_id: 'c1', command: 'git status', cwd: repo }, { home: HOME }).output, null);

  const pluginFile = path.join(SCRATCH, 'plugin', 'debate.mjs'); // Node 18 needs .mjs for ESM; OpenCode (Bun) loads the .js
  fs.mkdirSync(path.dirname(pluginFile), { recursive: true });
  fs.writeFileSync(pluginFile, setup.opencodePlugin(CLI));
  const { DebateGitGate } = await import(pathToFileURL(pluginFile).href);
  const gate = await DebateGitGate({ directory: repo });
  await assert.rejects(gate['tool.execute.before']({ tool: 'bash', sessionID: 'ses_1', callID: 'c' }, { args: { command: 'git push origin main' } }), /unsupported push command/);
  await gate['tool.execute.before']({ tool: 'bash', sessionID: 'ses_1', callID: 'c' }, { args: { command: 'git status' } });
});

test('unmapped events pass through for every host, and an unknown agent is a usage error', () => {
  for (const [agent, event] of [['cursor', 'stop'], ['opencode', 'session.idle'], ['claude', 'Notification'], ['codex', 'PostToolUse']]) {
    const r = hooks.handleHook(agent, event, { session_id: 's1' }, { home: HOME });
    assert.equal(r.output, null);
    assert.match(r.note, /unmapped event/);
  }
  assert.throws(() => hooks.handleHook('vim', 'Stop', {}, { home: HOME }), /agent must be one of/);
  const cli = run(['hook', 'vim', 'Stop'], { input: '{}' });
  assert.equal(cli.status, 0, 'hook failures never block the host');
  assert.equal(cli.stdout, '');
});

test('mergeHooks is idempotent, keeps unrelated hooks, and replaces earlier debate entries for that agent only', () => {
  const cli = '/opt/skills/cross-debate/scripts/debate.mjs';
  const existing = {
    permissions: { allow: ['Bash(ls:*)'] },
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'node other.js' }] }, { hooks: [{ type: 'command', command: 'node "/old/debate/scripts/debate.mjs" hook claude Stop' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "/old/debate/scripts/debate.mjs" hook codex PreToolUse' }] }],
    },
  };
  const entries = setup.hookEntries('claude', cli);
  const once = setup.mergeHooks('claude', existing, entries);
  assert.deepEqual(setup.mergeHooks('claude', once, entries), once);
  const commands = Object.values(once.hooks).flat().flatMap(g => g.hooks.map(h => h.command));
  assert.ok(commands.includes('node other.js'));
  assert.ok(!commands.some(c => c.includes('/old/') && c.includes('hook claude')));
  assert.ok(commands.some(c => c.includes('/old/') && c.includes('hook codex')), 'another agent’s entries are untouched');
  assert.deepEqual(once.hooks.PreToolUse.slice(1).map(g => g.matcher), ['Bash', 'ExitPlanMode']);
  assert.ok(once.permissions.allow.includes('Bash(ls:*)'));
  assert.ok(once.permissions.allow.includes(`Bash(node ${JSON.stringify(cli)}:*)`));
  const cursor = setup.mergeHooks('cursor', { version: 1, hooks: { beforeShellExecution: [{ command: './audit.sh' }] } }, setup.hookEntries('cursor', cli));
  assert.deepEqual(setup.mergeHooks('cursor', cursor, setup.hookEntries('cursor', cli)), cursor);
  assert.equal(cursor.hooks.beforeShellExecution.length, 2);
});

test('the bundled delegate-skills copy always wins over an installed one; only DELEGATE_SKILLS_DIR overrides it', () => {
  const installed = path.join(process.env.HOME, '.agents', 'skills', 'codex-delegate', 'scripts');
  fs.mkdirSync(installed, { recursive: true });
  fs.writeFileSync(path.join(installed, 'relay.mjs'), '');
  try {
    assert.ok(common.findScript('codex-delegate', 'relay.mjs').startsWith(common.VENDOR_SKILLS_DIR));
    assert.ok(common.findScript('delegate-setup', 'config.mjs').startsWith(common.VENDOR_SKILLS_DIR));
    process.env.DELEGATE_SKILLS_DIR = path.join(process.env.HOME, '.agents', 'skills');
    assert.equal(common.findScript('codex-delegate', 'relay.mjs'), path.join(installed, 'relay.mjs'));
    assert.ok(common.findScript('delegate-setup', 'config.mjs').startsWith(common.VENDOR_SKILLS_DIR), 'missing files still come from the bundle');
  } finally {
    delete process.env.DELEGATE_SKILLS_DIR;
    fs.rmSync(path.join(process.env.HOME, '.agents'), { recursive: true, force: true });
  }
  const doctor = run(['setup', 'doctor', '--cwd', SCRATCH]);
  assert.match(doctor.stdout, /delegate-setup\/config\.mjs: .*\(bundled\)/);
  assert.match(doctor.stdout, /lane review-main: codex/);
});

test('plan-main-<seat> wins by presence and then resolves strictly; a broken seat lane is never masked by plan-main', () => {
  const fleetFile = path.join(XDG, 'delegate-skills', 'config.json');
  const original = fs.readFileSync(fleetFile, 'utf8');
  const stubRoot = path.join(SCRATCH, 'stub-skills');
  const relayDir = path.join(stubRoot, 'claude-delegate', 'scripts');
  fs.mkdirSync(relayDir, { recursive: true });
  fs.writeFileSync(path.join(relayDir, 'relay.mjs'), 'console.log("usage: relay --brief <file>");');
  try {
    assert.deepEqual(plan.planLanes('claude', SCRATCH), ['plan-main-claude', 'plan-debate']);
    assert.deepEqual(plan.planLanes('cursor', SCRATCH), ['plan-main', 'plan-debate']);
    const fleet = JSON.parse(original);
    fleet.lanes['plan-main'] = { implementer: 'codex' };
    fleet.lanes['plan-main-codex'] = { implementer: 'claude' };
    fleet.lanes['plan-debate'] = { implementer: 'codex' };
    fs.writeFileSync(fleetFile, JSON.stringify({ ...fleet, version: 'delegate-fleet.v1' }));
    process.env.DELEGATE_SKILLS_DIR = stubRoot;
    const broken = plan.planPreflight('codex', SCRATCH);
    assert.equal(broken.ok, false);
    assert.match(broken.reason, /primary reviewer preflight: reviewer claude lacks a read-only relay/);
  } finally {
    delete process.env.DELEGATE_SKILLS_DIR;
    fs.writeFileSync(fleetFile, original);
  }
});

test('setup lanes proposes only missing lanes, pairs seats with another CLI, and refuses an opencode lane without a model', () => {
  const three = setup.proposeLanes(['codex', 'claude', 'opencode'], { 'review-main': { implementer: 'opencode', model: 'p/m' } });
  assert.equal(three.lanes['review-main'], undefined, 'existing lanes are never replaced');
  assert.deepEqual(three.lanes['plan-main-claude'], { implementer: 'codex' });
  assert.deepEqual(three.lanes['plan-main-codex'], { implementer: 'codex' }, 'never the plan-debate CLI; a modelless opencode lane ranks last');
  assert.deepEqual(three.lanes['plan-main-opencode'], { implementer: 'codex' });
  const seats = ['codex', 'claude', 'opencode'];
  assert.equal(setup.seatPairs({ ...three.lanes, 'review-main': {} }, seats).filter(l => /repeats the primary/.test(l)).length, 0);
  assert.deepEqual(setup.proposeLanes(seats, {}, { opencodeModel: 'p/m' }).lanes['plan-main-codex'], { implementer: 'opencode', model: 'p/m' });
  assert.deepEqual(three.lanes['plan-debate'], { implementer: 'claude' });
  assert.deepEqual(three.lanes['review-debate'], { implementer: 'codex' });
  assert.deepEqual(three.templates, {});
  const single = setup.proposeLanes(['codex'], {});
  assert.deepEqual(Object.keys(single.lanes).sort(), ['plan-debate', 'plan-main', 'review-debate', 'review-main']);
  assert.match(single.warnings[0], /supported single-CLI setup.*diversity/);
  assert.deepEqual(setup.proposeLanes(['claude', 'opencode'], {}, { opencodeModel: 'provider/model' }).lanes['review-debate'], { implementer: 'opencode', model: 'provider/model' });

  const xdg = path.join(SCRATCH, 'fresh-xdg');
  const r = run(['setup', 'lanes'], { env: { XDG_CONFIG_HOME: xdg, PATH: binWith(['claude', 'opencode']) } });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /--opencode-model/);
  assert.match(r.stdout, /"model": "<provider\/model>"/);
  assert.equal(fs.existsSync(path.join(xdg, 'delegate-skills', 'config.json')), false);
  const ok = run(['setup', 'lanes'], { env: { XDG_CONFIG_HOME: xdg, PATH: binWith(['claude', 'codex']) } });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /seat claude: plan reviewers codex then claude \(secondary is the seat's own CLI/);
  assert.match(ok.stdout, /dry run/);
  assert.equal(fs.existsSync(path.join(xdg, 'delegate-skills', 'config.json')), false);
});

test('setup hooks prints entries through the invoked symlink path, and --write refuses without a terminal', () => {
  const catalog = path.join(SCRATCH, 'catalog');
  fs.mkdirSync(catalog, { recursive: true });
  fs.symlinkSync(SKILL, path.join(catalog, 'cross-debate'));
  const linked = path.join(catalog, 'cross-debate', 'scripts', 'debate.mjs');
  const claudeDir = path.join(SCRATCH, 'claude-config');
  const r = run(['setup', 'hooks', '--agent', 'claude'], { cli: linked, env: { CLAUDE_CONFIG_DIR: claudeDir } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`Bash(node ${JSON.stringify(linked)}:*)`));
  assert.ok(r.stdout.includes(`Bash(node ${JSON.stringify(fs.realpathSync(CLI))}:*)`));
  assert.ok(r.stdout.includes(`node ${JSON.stringify(linked).replace(/"/g, '\\"')} hook claude Stop`));
  for (const agent of ['codex', 'cursor', 'opencode']) {
    const printed = run(['setup', 'hooks', '--agent', agent], { cli: linked, env: { CODEX_HOME: path.join(SCRATCH, 'codex-home') } });
    assert.equal(printed.status, 0, printed.stderr);
    assert.ok(printed.stdout.includes('hook'), agent);
  }
  assert.match(run(['setup', 'hooks', '--agent', 'codex'], { env: { CODEX_HOME: path.join(SCRATCH, 'codex-home') } }).stdout, /\[sandbox_workspace_write\]\nwritable_roots/);
  const write = run(['setup', 'hooks', '--agent', 'claude', '--write'], { cli: linked, env: { CLAUDE_CONFIG_DIR: claudeDir } });
  assert.equal(write.status, 2);
  assert.match(write.stdout, /interactive terminal/);
  assert.equal(fs.existsSync(path.join(claudeDir, 'settings.json')), false);
});

test('the router keeps the review backend’s exit contract: thrown failures exit 1 with the debate-review: prefix, usage exits 2', () => {
  const copy = path.join(SCRATCH, 'rejecting', 'debate');
  fs.cpSync(SKILL, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'scripts', 'review.mjs'), "export async function main() { throw new Error('backend exploded'); }\n");
  const failed = run(['review', '--local'], { cli: path.join(copy, 'scripts', 'debate.mjs') });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /^debate-review: backend exploded$/m);
  const misuse = run(['review', '--local', '--dry-run']);
  assert.equal(misuse.status, 2);
  assert.match(misuse.stderr, /^debate-review: --local and --dry-run do not combine/m);
  assert.equal(run(['nope']).status, 2);
});

test('the router forwards plan scope and code scope to the shared scope command', () => {
  const repo = enrolledRepo('scope-forward');
  for (const cmd of ['plan', 'code']) {
    const r = run([cmd, 'scope', 'status', '--cwd', repo]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(JSON.parse(r.stdout).effective, true);
  }
});

test('review refuses to send a diff with a secret to any reviewer', () => {
  const repo = enrolledRepo('review-secret');
  fs.writeFileSync(path.join(repo, 'settings.py'), `${'api_' + 'key = '}"abc123"\n`);
  const r = run(['review', '--local', '--repo-dir', repo, '--base', 'HEAD']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^debate-review: 1 potential secret\(s\) in the diff; no reviewer ran: settings\.py/m);
});

test('dispatch discards output from a relay that reports a read-only violation', async () => {
  const skills = path.join(SCRATCH, 'violating-skills');
  const relay = path.join(skills, 'claude-delegate', 'scripts', 'relay.mjs');
  fs.mkdirSync(path.dirname(relay), { recursive: true });
  fs.writeFileSync(relay, `import fs from 'node:fs';
const a = process.argv;
if (a.includes('--help')) { console.log('--read-only'); process.exit(0); }
fs.writeFileSync(a[a.indexOf('--out-dir') + 1] + '/result.json', JSON.stringify({ status: 'completed', readOnlyViolation: true, finalMessage: '{"summary":"x","findings":[]}' }));
`);
  const { dispatch } = await import(path.join(SCRIPTS, 'lib', 'dispatch.mjs'));
  process.env.DELEGATE_SKILLS_DIR = skills;
  try {
    const outDir = fs.mkdtempSync(path.join(SCRATCH, 'dispatch-'));
    assert.throws(() => dispatch({ role: 'main', who: { implementer: 'claude' }, brief: 'b', cwd: SCRATCH, outDir, timeout: '1m' }), /read-only violation; its output is discarded/);
  } finally { delete process.env.DELEGATE_SKILLS_DIR; }
});

test('diff paths decode Git quoting and the tab Git appends to names with spaces', async () => {
  const { diffPath, diffLineMap } = await import(path.join(SCRIPTS, 'lib', 'diff.mjs'));
  assert.equal(diffPath('"b/caf\\303\\251.py"'), 'café.py');
  assert.equal(diffPath('b/a b.txt\t'), 'a b.txt');
  assert.equal(diffPath('"b/tab\\there\\"q\\\\"'), 'tab\there"q\\');
  assert.equal(diffPath('/dev/null'), '/dev/null');
  assert.equal(diffPath('"b/q\\"\u{1F600}.py"'), 'q"\u{1F600}.py', 'a literal non-BMP character in a quoted header survives');
  const map = diffLineMap('diff --git a/x b/x\n--- /dev/null\n+++ "b/caf\\303\\251.py"\n@@ -0,0 +1 @@\n+x\n');
  assert.deepEqual([...map.get('café.py')], [1]);
  assert.equal(common.scanDiffForSecrets(`+++ "b/caf\\303\\251.py"\n+${'api_' + 'key = '}"v"\n`)[0].file, 'café.py');
});

test('a stale lock from a dead owner is reclaimed, and the reclaimer releases only its own lock', () => {
  const lock = path.join(SCRATCH, 'locks', 'x.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, token: 'dead', at: Date.now() }));
  assert.equal(common.withLock(lock, () => JSON.parse(fs.readFileSync(lock, 'utf8')).token !== 'dead'), true);
  assert.equal(fs.existsSync(lock), false);
  assert.deepEqual(fs.readdirSync(path.dirname(lock)), []);
});

function commitAllIn(repo, message) {
  for (const args of [['add', '-A'], ['commit', '-q', '-m', message]]) assert.equal(spawnSync('git', args, { cwd: repo }).status, 0);
}

test('review strips checkout agent configuration before a reviewer starts and hands it the diff as files', () => {
  const repo = enrolledRepo('review-agent-config');
  fs.mkdirSync(path.join(repo, '.claude'));
  fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), '{"hooks":{}}\n');
  fs.writeFileSync(path.join(repo, '.mcp.json'), '{}\n');
  fs.writeFileSync(path.join(repo, 'app.js'), 'export const x = 1;\n');
  commitAllIn(repo, 'feat: app');
  const skills = path.join(SCRATCH, 'recording-skills');
  const record = path.join(SCRATCH, 'relay-saw.json');
  const relay = path.join(skills, 'claude-delegate', 'scripts', 'relay.mjs');
  fs.mkdirSync(path.dirname(relay), { recursive: true });
  fs.writeFileSync(relay, `import fs from 'node:fs';
const a = process.argv;
if (a.includes('--help')) { console.log('--read-only'); process.exit(0); }
const cwd = a[a.indexOf('--cd') + 1];
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ claude: fs.existsSync(cwd + '/.claude'), mcp: fs.existsSync(cwd + '/.mcp.json'), app: fs.existsSync(cwd + '/app.js'), diff: fs.readFileSync(cwd + '/.debate-review/diff.patch', 'utf8') }));
fs.writeFileSync(a[a.indexOf('--out-dir') + 1] + '/result.json', JSON.stringify({ status: 'failed' }));
`);
  const r = run(['review', '--local', '--repo-dir', repo, '--base', 'HEAD~1', '--main', 'claude', '--debate', 'claude'], { env: { DELEGATE_SKILLS_DIR: skills } });
  assert.equal(r.status, 1, r.stderr);
  const saw = JSON.parse(fs.readFileSync(record, 'utf8'));
  assert.deepEqual({ claude: saw.claude, mcp: saw.mcp, app: saw.app }, { claude: false, mcp: false, app: true });
  assert.match(saw.diff, /^\+\+\+ b\/\.claude\/settings\.json$/m);
  assert.equal(fs.existsSync(path.join(repo, '.claude', 'settings.json')), true, 'the user checkout is untouched');
});

test('review refuses a checkout-provided .debate-review entry instead of writing through it', () => {
  const repo = enrolledRepo('review-symlink');
  const outside = path.join(SCRATCH, 'outside-target');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(repo, '.debate-review'));
  fs.writeFileSync(path.join(repo, 'app.js'), 'export const y = 2;\n');
  commitAllIn(repo, 'feat: symlink');
  const r = run(['review', '--local', '--repo-dir', repo, '--base', 'HEAD~1', '--main', 'claude', '--debate', 'claude']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /contains \.debate-review; refusing/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('hunk counts keep added lines that look like file headers inside the hunk, for anchors and the secret scan', async () => {
  const { diffLineMap } = await import(path.join(SCRIPTS, 'lib', 'diff.mjs'));
  const diff = 'diff --git a/c.c b/c.c\n--- a/c.c\n+++ b/c.c\n@@ -1,2 +1,3 @@\n int a;\n+++ counter;\n--- ' + 'api_' + 'key = "old"\n+b;\n';
  assert.deepEqual([...diffLineMap(diff).keys()], ['c.c']);
  assert.deepEqual([...diffLineMap(diff).get('c.c')], [1, 2, 3]);
  const hits = common.scanDiffForSecrets(diff);
  assert.deepEqual(hits.map(h => [h.file, h.diffLine]), [['c.c', 7]]);
});

test('stale-lock reclaim removes only the inspected lock and yields to a reclaimer in progress', () => {
  const dir = path.join(SCRATCH, 'reclaim');
  fs.mkdirSync(dir);
  const lock = path.join(dir, 'y.lock');
  fs.writeFileSync(lock, 'successor');
  common.reclaimStaleLock(lock, 'stale');
  assert.equal(fs.readFileSync(lock, 'utf8'), 'successor');
  fs.writeFileSync(`${lock}.reclaim`, '');
  common.reclaimStaleLock(lock, 'successor');
  assert.equal(fs.existsSync(lock), true, 'a fresh reclaim file means another reclaimer is working');
  fs.rmSync(`${lock}.reclaim`);
  common.reclaimStaleLock(lock, 'successor');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('dispatch never accepts a result.json left by an earlier run on the same head', async () => {
  const skills = path.join(SCRATCH, 'early-exit-skills');
  const relay = path.join(skills, 'codex-delegate', 'scripts', 'relay.mjs');
  fs.mkdirSync(path.dirname(relay), { recursive: true });
  fs.writeFileSync(relay, "if (process.argv.includes('--help')) { console.log('--read-only'); process.exit(0); }\nprocess.stderr.write('relay: bad --timeout\\n'); process.exit(2);\n");
  const outDir = fs.mkdtempSync(path.join(SCRATCH, 'rerun-'));
  fs.mkdirSync(path.join(outDir, 'main'));
  fs.writeFileSync(path.join(outDir, 'main', 'result.json'), JSON.stringify({ status: 'completed', finalMessage: 'stale findings' }));
  const { dispatch } = await import(path.join(SCRIPTS, 'lib', 'dispatch.mjs'));
  process.env.DELEGATE_SKILLS_DIR = skills;
  try {
    assert.throws(() => dispatch({ role: 'main', who: { implementer: 'codex' }, brief: 'b', cwd: SCRATCH, outDir, timeout: 'x' }), /relay exited 2 without writing result\.json/);
  } finally { delete process.env.DELEGATE_SKILLS_DIR; }
});

test('an explicit opencode reviewer is refused up front because only a lane supplies its model', async () => {
  const { resolveRole } = await import(path.join(SCRIPTS, 'lib', 'dispatch.mjs'));
  assert.throws(() => resolveRole('main', { explicit: 'opencode', lane: 'review-main', cwd: SCRATCH }), /pass --main-lane <lane> instead of --main opencode/);
  assert.deepEqual(resolveRole('debate', { explicit: 'claude', lane: 'review-debate', cwd: SCRATCH }), { implementer: 'claude', lane: null, dials: {} });
});

test('setup hooks refuses an install path the shell would expand inside double quotes', () => {
  for (const bad of ['/tmp/a$b/debate.mjs', '/tmp/a`b`/debate.mjs', '/tmp/a"b/debate.mjs', '/tmp/a\\b/debate.mjs']) {
    assert.throws(() => setup.hookEntries('claude', bad), /rename or move the skill directory/, bad);
  }
  assert.equal(setup.hookEntries('claude', '/tmp/plain dir/debate.mjs').events.Stop[0].command, 'node "/tmp/plain dir/debate.mjs" hook claude Stop');
});

test('reviewer JSON survives a ``` fence inside a JSON string, and the last parseable block wins', async () => {
  const { extractJson } = await import(path.join(SCRIPTS, 'lib', 'dispatch.mjs'));
  const doc = { schema: 's', findings: [{ evidence: 'a plan ending with an unmatched ``` or ~~~ fence' }] };
  const message = `notes\n\`\`\`json\n{"old": true}\n\`\`\`\nfinal:\n\`\`\`json\n${JSON.stringify(doc, null, 2)}\n\`\`\`\n`;
  assert.deepEqual(extractJson(message), doc);
  assert.deepEqual(common.extractJson(message), doc);
  assert.throws(() => extractJson('```json\n{"broken": \n```'), /no parseable JSON block/);
  assert.deepEqual(extractJson('prefix {"bare": 1} suffix'), { bare: 1 });
});

test('a lane resolves in the orchestrator and reaches the relay as explicit dials, never as --lane', async () => {
  const { resolveRole, dispatch } = await import(path.join(SCRIPTS, 'lib', 'dispatch.mjs'));
  const who = resolveRole('main', { lane: 'review-main', cwd: SCRATCH });
  assert.deepEqual(who, { implementer: 'codex', lane: 'review-main', dials: { model: 'model-a', effort: 'medium' } });
  const skills = path.join(SCRATCH, 'argv-skills');
  const record = path.join(SCRATCH, 'relay-argv.json');
  const relay = path.join(skills, 'codex-delegate', 'scripts', 'relay.mjs');
  fs.mkdirSync(path.dirname(relay), { recursive: true });
  fs.writeFileSync(relay, `import fs from 'node:fs';
const a = process.argv;
if (a.includes('--help')) { console.log('--read-only'); process.exit(0); }
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(a.slice(2)));
fs.writeFileSync(a[a.indexOf('--out-dir') + 1] + '/result.json', JSON.stringify({ status: 'completed', finalMessage: '{}' }));
`);
  process.env.DELEGATE_SKILLS_DIR = skills;
  try {
    dispatch({ role: 'main', who, brief: 'b', cwd: SCRATCH, outDir: fs.mkdtempSync(path.join(SCRATCH, 'argv-')), timeout: '1m' });
  } finally { delete process.env.DELEGATE_SKILLS_DIR; }
  const argv = JSON.parse(fs.readFileSync(record, 'utf8'));
  assert.equal(argv.includes('--lane'), false);
  assert.deepEqual(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2), ['--model', 'model-a']);
  assert.deepEqual(argv.slice(argv.indexOf('--effort'), argv.indexOf('--effort') + 2), ['--effort', 'medium']);
});

test('a plan with an unclosed code fence is refused instead of hiding its review block inside the fence', () => {
  assert.match(common.splitPlan('# Plan\n\n1. step\n\n```sh\nmake test\n').error, /unclosed code fence opened at line 5/);
  assert.equal(common.splitPlan('# Plan\n\n```sh\nmake test\n```\n').error, null);
  assert.equal(common.splitPlan('# Plan\n\n~~~\ncode\n~~~\n').error, null);
});

test('a project lane reaches a reviewer only when the project config is trusted', async () => {
  const { resolveRole } = await import(path.join(SCRIPTS, 'lib', 'dispatch.mjs'));
  const repo = enrolledRepo('project-lane');
  const file = path.join(repo, '.delegate', 'config.json');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ version: 'delegate-fleet.v1', lanes: { 'review-main': { implementer: 'claude', model: 'repo-picked' } } }));
  assert.throws(() => resolveRole('main', { lane: 'review-main', cwd: repo }), /untrusted project config/);
  const config = await import(path.join(SKILL, 'vendor', 'delegate-skills', 'delegate-setup', 'scripts', 'config.mjs'));
  const gitDir = spawnSync('git', ['-C', repo, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).stdout.trim();
  fs.mkdirSync(path.join(gitDir, 'delegate-skills'), { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'delegate-skills', 'project-config.sha256'), config.readConfigFile(file).digest);
  assert.deepEqual(resolveRole('main', { lane: 'review-main', cwd: repo }), { implementer: 'claude', lane: 'review-main', dials: { model: 'repo-picked' } });
});

test('plan briefs substitute in one pass, so placeholders inside the plan stay literal', () => {
  const run = plan.newPlanRun({ seat: 'claude', sessionId: 's-brief', cwd: SCRATCH, origin: 'stdin' });
  const brief = plan.buildBrief(run, 1, 'Keep {{NEXT_FINDING_ID}} and {{HISTORY}} literal.', { implementer: 'codex' });
  assert.ok(brief.includes('Keep {{NEXT_FINDING_ID}} and {{HISTORY}} literal.'));
  assert.equal(/{{(ROUND|PLAN|TOOLING|REVIEWER_ROLE)}}/.test(brief), false);
});

test('doctor finds hooks that setup merged into a JSON settings file', () => {
  const claudeDir = path.join(SCRATCH, 'doctor-claude');
  fs.mkdirSync(claudeDir);
  const entries = setup.hookEntries('claude', CLI);
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(setup.mergeHooks('claude', {}, entries), null, 2));
  const doctor = run(['setup', 'doctor', '--cwd', SCRATCH], { env: { CLAUDE_CONFIG_DIR: claudeDir } });
  assert.match(doctor.stdout, /✓ hooks claude: /);
});

test('push forms the shell rewrites stay gated: continuations, expanding heredocs, backquotes, reserved words, non-literal words', () => {
  const repo = enrolledRepo('gate-shell-forms');
  const decide = (command) => common.gitGateDecision({ command, cwd: repo, home: HOME }).decision;
  for (const command of [
    'git \\\npush origin main',
    'git "pu\\\nsh" origin main',
    'cat <<EOF\n$(git push origin main)\nEOF',
    'cat <<-EOF\n\t`git push origin main`\n\tEOF',
    'echo `git push origin main`',
    'echo "`git push origin main`"',
    '$(echo git) push origin main',
    '{ git push origin main; }',
    'if true; then git push origin main; fi',
    'while true; do git push origin main; done',
    '! git push origin main',
    'p=push; git $p origin main',
    "git $'push' origin main",
    'g=git; $g push origin main',
    'sudo $g push origin main',
  ]) assert.equal(decide(command), 'deny', JSON.stringify(command));
  for (const command of [
    "cat <<'EOF'\n$(git push origin main)\nEOF",
    'cat <<\\EOF\n`git push origin main`\nEOF',
    'cat <<EOF\ndocs: git push origin main\nEOF',
    'git \\\nstatus',
    'echo "$(git status)"',
    '{ git status; }',
  ]) assert.equal(decide(command), 'pass', JSON.stringify(command));
});

test('setup flags a plan pairing whose secondary repeats the primary reviewer', () => {
  const ok = run(['setup', 'lanes'], { env: { XDG_CONFIG_HOME: path.join(SCRATCH, 'pairing-xdg'), PATH: binWith(['claude', 'codex']) } });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /seat codex: plan reviewers codex then claude\n/, 'the default proposal gives every seat two models');
  assert.match(setup.seatPairs({ 'plan-main': { implementer: 'claude' }, 'plan-debate': { implementer: 'claude' } }, ['codex'])[0],
    /seat codex: plan reviewers claude then claude \(secondary repeats the primary reviewer/);
});

test('a debate reviewer that supplies new_findings as anything but an array is rejected, not read as clean', async () => {
  const { validateDebate } = await import(path.join(SCRIPTS, 'lib', 'validate.mjs'));
  const doc = (extra) => ({ schema: 'debate-review.debate.v1', verdicts: [], ...extra });
  assert.deepEqual(validateDebate(doc({}), { findings: [] }).new_findings, []);
  for (const bad of [{ id: 'D1' }, 'D1', null]) assert.throws(() => validateDebate(doc({ new_findings: bad }), { findings: [] }), /new_findings must be an array/);
  const incomplete = doc({ verdicts: [{ id: 'F1', verdict: 'confirm' }] });
  assert.throws(() => validateDebate(incomplete, { findings: [{ id: 'F1' }, { id: 'F2' }] }), /F2 has no debate verdict/);
  assert.equal(incomplete.verdicts.length, 1, 'the validator must not invent agreement');
});

test('plan pairing compares models, so two lanes on one CLI with different models are not flagged', () => {
  const lanes = { 'plan-main-codex': { implementer: 'claude', model: 'model-a' }, 'plan-debate': { implementer: 'claude', model: 'model-b' } };
  assert.equal(setup.seatPairs(lanes, ['codex'])[0], 'seat codex: plan reviewers claude then claude');
  assert.match(setup.seatPairs({ ...lanes, 'plan-debate': { implementer: 'claude', model: 'model-a' } }, ['codex'])[0], /repeats the primary reviewer/);
});

// ---------- setup init ----------

/** An ask that answers from per-question queues (first matching rule with answers left), else Enter. */
function scripted(rules = []) {
  const asked = [];
  const ask = (question) => {
    asked.push(question);
    for (const [pattern, answers] of rules) if (pattern.test(question) && answers.length) return answers.shift();
    return '';
  };
  ask.asked = asked;
  return ask;
}
/** Run the wizard against a fresh HOME and config dir with the given CLIs on PATH; stdout is captured. */
async function init(clis, ask, { runner = () => 0, home, xdg } = {}) {
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  const scratch = fs.mkdtempSync(path.join(SCRATCH, 'init-'));
  process.env.HOME = home ?? path.join(scratch, 'home');
  fs.mkdirSync(process.env.HOME, { recursive: true });
  const configHome = xdg ?? path.join(scratch, 'xdg');
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.PATH = binWith(clis);
  const write = process.stdout.write;
  let text = '';
  process.stdout.write = (chunk) => { text += chunk; return true; };
  try {
    await setup.runInit({ ask, runner });
  } finally {
    process.stdout.write = write;
    Object.assign(process.env, saved);
  }
  const file = path.join(configHome, 'delegate-skills', 'config.json');
  return { xdg: configHome, text, lanes: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).lanes : null };
}

test('setup init: Enter on every prompt writes exactly the proposed lanes, and n at the confirm writes nothing', async () => {
  const accepted = await init(['claude', 'codex'], scripted([[/Write this change/, ['y']]]));
  assert.deepEqual(accepted.lanes, setup.proposeLanes(['claude', 'codex'], {}).lanes);
  assert.equal(accepted.text.includes('discovering models'), false, 'accepting the defaults skips model discovery');
  assert.match(accepted.text, /\+ review-debate: codex default model/, 'the write preview names each lane');
  assert.match(accepted.text, /\[sandbox_workspace_write\]\nwritable_roots/, 'init shows the Codex config.toml lines when it offers Codex hooks');
  assert.match(accepted.text, /seat claude: plan reviewers codex then claude/);
  const declined = await init(['claude', 'codex'], scripted([[/Write this change/, ['n']]]));
  assert.equal(declined.lanes, null);
  assert.match(declined.text, /not written/);
});

test('setup init binds the chosen CLI, model and effort, and re-prompts an invalid effort', async () => {
  const ask = scripted([
    [/^review-main CLI/, ['codex']], [/^review-main model \(/, ['Enter another model']], [/^review-main model ID/, ['gpt-5.5']], [/^review-main effort/, ['high']],
    [/^plan-main effort/, ['bogus', 'xhigh']], [/own first plan reviewer/, ['n']], [/Change any/, ['y']], [/Write this change/, ['y']],
  ]);
  const { lanes, xdg } = await init(['claude', 'codex'], ask);
  assert.deepEqual(lanes['review-main'], { implementer: 'codex', model: 'gpt-5.5', effort: 'high' });
  assert.deepEqual(lanes['plan-main'], { implementer: 'claude', effort: 'xhigh' });
  assert.equal(ask.asked.filter(q => /^plan-main effort/.test(q)).length, 2);
  const again = await init(['claude', 'codex'], scripted([[/own first plan reviewer/, ['n']]]), { xdg });
  assert.match(again.text, /lanes unchanged; nothing to write/);
  assert.equal(lanes['plan-main-claude'], undefined);
});

test('setup init re-prompts an opencode lane until it has a provider/model', async () => {
  const ask = scripted([[/^review-debate model/, ['', 'default', 'prov/m']], [/own first plan reviewer/, ['n']], [/Write this change/, ['y']]]);
  const { lanes } = await init(['claude', 'opencode'], ask);
  assert.deepEqual(lanes['review-debate'], { implementer: 'opencode', model: 'prov/m' });
  assert.equal(ask.asked.filter(q => /^review-debate model/.test(q)).length, 3);
});

test('setup init installs only missing optional skills with the official argv, and a failed command does not stop it', async () => {
  const calls = [];
  const runner = (argv) => { calls.push(argv); return calls.length === 1 ? 1 : 0; };
  const { text } = await init(['claude', 'codex'], scripted([[/Configure reviewer lanes/, ['n']], [/Install (ponytail|babysit-pr)/, ['y', 'y']]]), { runner });
  assert.deepEqual(calls, [
    ['claude', 'plugin', 'marketplace', 'add', 'DietrichGebert/ponytail'],
    ['codex', 'plugin', 'marketplace', 'add', 'DietrichGebert/ponytail'],
    ['codex', 'plugin', 'add', 'ponytail@ponytail'],
    ['npx', 'skills', 'add', 'amElnagdy/review-skills', '--skill', 'babysit-pr', '-g'],
  ]);
  assert.match(text, /failed: claude plugin marketplace add DietrichGebert\/ponytail/);
  assert.match(text, /trust the two ponytail hooks/);
  assert.match(text, /Install check:/);

  const home = path.join(SCRATCH, 'init-installed-home');
  fs.mkdirSync(path.join(home, '.agents', 'skills', 'babysit-pr'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agents', 'skills', 'babysit-pr', 'SKILL.md'), '');
  fs.mkdirSync(path.join(home, '.codex', 'plugins', 'cache', 'ponytail'), { recursive: true });
  const ask = scripted([[/Configure reviewer lanes/, ['n']]]);
  const none = [];
  await init(['claude', 'codex'], ask, { home, runner: (argv) => { none.push(argv); return 0; } });
  assert.deepEqual(none, []);
  assert.equal(ask.asked.some(q => /^Install (ponytail|babysit-pr)/.test(q)), false);
});

test('detectOptional reads plugin manifests, the Codex plugin cache and skill directories', () => {
  const home = fs.mkdtempSync(path.join(SCRATCH, 'optional-'));
  assert.deepEqual(setup.detectOptional({ HOME: home }), { ponytail: null, 'babysit-pr': null });
  const manifest = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ version: 2, plugins: { 'ponytail@ponytail': [] } }));
  assert.equal(setup.detectOptional({ HOME: home }).ponytail, manifest);
  const codex = path.join(home, 'codex');
  fs.mkdirSync(path.join(codex, 'plugins', 'cache', 'ponytail'), { recursive: true });
  assert.equal(setup.detectOptional({ HOME: path.join(home, 'elsewhere'), CODEX_HOME: codex }).ponytail, path.join(codex, 'plugins', 'cache', 'ponytail'));
  const skill = path.join(home, '.claude', 'skills', 'babysit-pr');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '');
  assert.equal(setup.detectOptional({ HOME: home })['babysit-pr'], skill);
});

test('setup init refuses without a terminal and writes nothing; a missing lane points to setup init', async () => {
  const xdg = path.join(SCRATCH, 'init-notty-xdg');
  const r = run(['setup', 'init'], { env: { XDG_CONFIG_HOME: xdg, PATH: binWith(['claude', 'codex']) } });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /interactive terminal/);
  assert.equal(fs.existsSync(xdg), false);
  const { resolveRole } = await import(path.join(SCRIPTS, 'lib', 'dispatch.mjs'));
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(SCRATCH, 'init-empty-xdg');
  try {
    assert.throws(() => resolveRole('main', { lane: 'review-main', cwd: SCRATCH }), /setup init/);
  } finally { process.env.XDG_CONFIG_HOME = saved; }
});

test('scope prints a short summary at a terminal and the full JSON otherwise', async () => {
  const { scopeSummary } = await import(path.join(SCRIPTS, 'debate.mjs'));
  const text = scopeSummary({ identity: { worktreeRoot: '/r' }, enabled: true, effective: true, warnings: [], supersededApprovals: 0, activeCandidates: [] });
  assert.match(text, /^debate is enabled for \/r\nStart a fresh agent session/);
  assert.doesNotMatch(text, /repoKey/);
  assert.match(scopeSummary({ identity: null, enabled: false, effective: false }), /not a Git worktree/);
  const repo = enrolledRepo('scope-json-repo');
  const r = run(['scope', 'status', '--cwd', repo]);
  assert.equal(JSON.parse(r.stdout).enabled, true, 'without a terminal agents still get JSON');
  const here = spawnSync(process.execPath, [CLI, 'scope', 'status'], { cwd: repo, encoding: 'utf8' });
  assert.equal(here.status, 0, here.stderr);
  assert.equal(JSON.parse(here.stdout).identity.worktreeRoot, repo, 'scope defaults to the current project');
});
