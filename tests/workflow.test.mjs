// Offline workflow tests for the plan, code and hook commands. No network, no model CLIs: relays are only reached
// through a PATH that lacks codex/claude, so they fail fast with *_unavailable. Run: node --test tests/*.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const SKILL = path.resolve(HERE, '..', 'skills', 'debate');
const SCRIPTS = path.join(SKILL, 'scripts');
const CLI = path.join(SCRIPTS, 'debate.mjs');
const SCRATCH = fs.mkdtempSync(path.join(process.env.DEBATE_TEST_SCRATCH || os.tmpdir(), 'debate-test-'));
const HOME = path.join(SCRATCH, 'home');
const XDG = path.join(SCRATCH, 'xdg');
const BIN = path.join(SCRATCH, 'bin');

// environment: scratch HOME/DEBATE_HOME, scratch lane config, isolated git config, no codex/claude on PATH,
// and no installed delegate-skills: relays and delegate-setup resolve from the pinned vendor copy.
process.env.HOME = path.join(SCRATCH, 'user-home');
fs.mkdirSync(process.env.HOME, { recursive: true });
for (const name of ['DELEGATE_SKILLS_DIR', 'CODEX_HOME', 'CLAUDE_SESSION_ID', 'CODEX_THREAD_ID']) delete process.env[name];
process.env.DEBATE_HOME = HOME;
process.env.XDG_CONFIG_HOME = XDG;
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_SYSTEM = '/dev/null';
delete process.env.DEBATE_CHILD;
delete process.env.DEBATE;
fs.mkdirSync(path.join(XDG, 'delegate-skills'), { recursive: true });
fs.copyFileSync(path.join(FIX, 'lane-config.json'), path.join(XDG, 'delegate-skills', 'config.json'));
fs.mkdirSync(BIN, { recursive: true });
for (const tool of ['git', 'sh', 'bash', 'zsh', 'env', 'ls']) {
  const r = spawnSync('which', [tool], { encoding: 'utf8' });
  if (r.status === 0) fs.symlinkSync(r.stdout.trim(), path.join(BIN, tool));
}
fs.symlinkSync(process.execPath, path.join(BIN, 'node'));
process.env.PATH = `${BIN}:/usr/bin:/bin`;

const common = await import(path.join(SCRIPTS, 'lib', 'common.mjs'));
const plan = await import(path.join(SCRIPTS, 'plan.mjs'));
const code = await import(path.join(SCRIPTS, 'code.mjs'));
const hooks = await import(path.join(SCRIPTS, 'hooks.mjs'));
const recovery = await import(path.join(SCRIPTS, 'lib', 'recovery.mjs'));

before(() => { common.ensureHome(HOME); });
after(() => { fs.rmSync(SCRATCH, { recursive: true, force: true }); });

// ---------- helpers ----------

function sh(cwd, cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...(opts.env || {}) }, input: opts.input });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
  return r;
}
function gitc(cwd, ...args) { return sh(cwd, 'git', args).stdout.trim(); }
let repoCounter = 0;
function makeRepo(name = `repo${++repoCounter}`, { enrolled = true } = {}) {
  const dir = path.join(SCRATCH, name);
  fs.mkdirSync(dir, { recursive: true });
  gitc(dir, 'init', '-q', '-b', 'main');
  gitc(dir, 'config', 'user.email', 'test@example.com');
  gitc(dir, 'config', 'user.name', 'Test');
  gitc(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'app.py'), 'def avg(items):\n    total = sum(items)\n    return total / len(items)\n');
  gitc(dir, 'add', '-A');
  gitc(dir, 'commit', '-q', '-m', 'chore: init');
  if (enrolled) common.changeRepositoryScope(dir, true, HOME);
  return fs.realpathSync(dir);
}
/** Run `debate.mjs <command> ...args`; opts.cli selects another copy of the entrypoint. */
function cli(command, args, opts = {}) {
  const r = spawnSync(process.execPath, [opts.cli || CLI, command, ...args], { encoding: 'utf8', env: { ...process.env, ...(opts.env || {}) }, input: opts.input, cwd: opts.cwd || SCRATCH });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { json = null; }
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}
function readFix(name) { return JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8')); }
function writeRelayResult(dir, { status = 'completed', doc, readOnlyViolation, extra = {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const finalMessage = doc ? `Here you go\n\`\`\`json\n${JSON.stringify(doc, null, 2)}\n\`\`\`\n` : '';
  const result = { schema: 'delegate-relay.result.v1', status, finalMessage, threadId: 'thread-1', startedAt: '2026-09-10T10:00:00.000Z', finishedAt: '2026-09-10T10:04:00.000Z', ...extra };
  if (readOnlyViolation !== undefined) result.readOnlyViolation = readOnlyViolation;
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 400, cache_write_input_tokens: 0, output_tokens: 50 } })}\n`);
  return dir;
}
const PLAN_BODY = '# Plan\n\nStep 1: load files.\nStep 2: hash them.\n';
const PLAN_REVISED = '# Plan\n\nStep 1: load files.\nStep 2: normalize CRLF, then hash them.\n';
const SEAT = 'claude';
const SESSION = 'sess-plan-1';
function newPlanRun(overrides = {}) {
  const run = plan.newPlanRun({ seat: SEAT, sessionId: SESSION, cwd: SCRATCH, sourcePath: null, origin: 'stdin', timeout: '20m', ...overrides });
  common.createRun(HOME, run);
  return run.runId;
}
const REVIEWER = { implementer: 'codex', lane: 'plan-main-claude', model: 'model-a', effort: 'high', source: 'global' };
const SECOND_REVIEWER = { implementer: 'claude', lane: 'plan-debate', model: 'model-c', effort: 'high', source: 'global', role: 'secondary-1' };
function attemptRelayDir(runId) {
  const run = common.loadRun(HOME, runId);
  const round = run.rounds[run.rounds.length - 1];
  const attempt = round.attempts[round.attempts.length - 1];
  return { relayDir: path.join(common.runDir(HOME, runId), attempt.dir, 'relay'), round: round.round, attempt: attempt.attempt };
}
function runReviewRound(runId, body, doc, ingestOpts = {}) {
  plan.startRound(HOME, runId, body);
  plan.startAttempt(HOME, runId, REVIEWER);
  const { relayDir, round, attempt } = attemptRelayDir(runId);
  writeRelayResult(relayDir, { doc, ...ingestOpts });
  return plan.ingestPlanReview(HOME, runId, round, attempt, relayDir, { exitCode: 0 });
}
function runPairedReviewRound(runId, body, primaryDoc, secondaryDoc) {
  plan.startRound(HOME, runId, body);
  plan.startAttempt(HOME, runId, [REVIEWER, SECOND_REVIEWER]);
  const run = common.loadRun(HOME, runId);
  const round = run.rounds.at(-1);
  const attempt = round.attempts.at(-1);
  const attemptDir = path.join(common.runDir(HOME, runId), attempt.dir);
  const primaryRelay = path.join(attemptDir, 'relay');
  const secondaryRelay = path.join(attemptDir, 'relay-secondary-1');
  writeRelayResult(primaryRelay, { doc: primaryDoc, readOnlyViolation: false });
  writeRelayResult(secondaryRelay, { doc: secondaryDoc, readOnlyViolation: null });
  return plan.ingestPlanReview(HOME, runId, round.round, attempt.attempt, [
    { role: 'primary', reviewer: REVIEWER, relayDir: primaryRelay, exitCode: 0, seconds: 240 },
    { role: 'secondary-1', reviewer: SECOND_REVIEWER, relayDir: secondaryRelay, exitCode: 0, seconds: 240 },
  ]);
}
function installReviewRelay(root, implementer, doc) {
  const scripts = path.join(root, `${implementer}-delegate`, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  const message = ['Here you go', '```json', JSON.stringify(doc, null, 2), '```', ''].join('\n');
  fs.writeFileSync(path.join(scripts, 'relay.mjs'), `import fs from 'node:fs'; import path from 'node:path'; const args = process.argv.slice(2); const out = args[args.indexOf('--out-dir') + 1]; fs.mkdirSync(out, {recursive:true}); fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({status:'completed', finalMessage:${JSON.stringify(message)}, readOnlyViolation:false, threadId:'stub', sessionId:'stub', model:${JSON.stringify(implementer)}}));`);
}
function hookPayload(sessionId, cwd, extra = {}) { return { session_id: sessionId, cwd, transcript_path: path.join(SCRATCH, 'transcript.jsonl'), permission_mode: 'default', hook_event_name: 'Stop', ...extra }; }
function hook(seat, event, payload, opts = {}) { return hooks.handleHook(seat, event, payload, { home: HOME, env: { ...process.env, ...(opts.env || {}) }, now: opts.now }); }

// ---------- entry points ----------

test('failure diagnostics classify and redact results, while served-model identity requires runtime evidence', () => {
  const details = recovery.failureDetails({ status: 'failed', finalMessage: 'Rate limit reached. Resets at 03:00 UTC\napi_key=private-value', stderrTail: 'https://user:password@example.test' });
  assert.equal(details.failureClass, 'rate_limited');
  assert.match(details.resetHint, /03:00 UTC/);
  assert.doesNotMatch(JSON.stringify(details), /private-value|user:password/);
  assert.equal(recovery.failureDetails({ status: 'codex_unavailable' }).failureClass, 'cli_unavailable');
  assert.equal(recovery.failureDetails({ status: 'timeout' }).failureClass, 'timeout');
  for (const stderrTail of ['permission requested: external_directory (/tmp/*); auto-rejecting', 'auto-rejecting']) {
    const denied = recovery.failureDetails({ stderrTail }, 'backend');
    assert.equal(denied.failureClass, 'sandbox_denied');
    assert.match(denied.resetHint, /external_directory can block reads too/);
  }
  assert.equal(recovery.diagnostic('x'.repeat(3000)).length, 2048);
  const dir = path.join(SCRATCH, 'identity');
  writeRelayResult(dir, { extra: { model: 'requested-alias' } });
  assert.deepEqual(recovery.modelIdentity(dir), { requestedModel: 'requested-alias', servedModel: null });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ type: 'system', subtype: 'init', model: 'actual-model' }));
  assert.equal(recovery.modelIdentity(dir).servedModel, 'actual-model');
});

test('resume audits authorization, rejects cross-session and changed input, preserves attempts and spends no new automatic retry', () => {
  const file = path.join(SCRATCH, 'resume-plan.md');
  fs.writeFileSync(file, PLAN_BODY);
  const runId = newPlanRun({ sourcePath: file, origin: 'file' });
  plan.startRound(HOME, runId, PLAN_BODY);
  for (let n = 1; n <= 2; n++) {
    plan.startAttempt(HOME, runId, REVIEWER, { retry: n === 2 });
    const loc = attemptRelayDir(runId);
    writeRelayResult(loc.relayDir, { status: 'failed', extra: { finalMessage: 'Reviewer relay crashed' } });
    plan.ingestPlanReview(HOME, runId, 1, n, loc.relayDir);
  }
  const auth = { seat: SEAT, session: SESSION, reason: 'user authorized: retry now' };
  assert.equal(plan.reviewDoc(common.loadRun(HOME, runId)).needsUserDecision, true);
  assert.throws(() => plan.startAttempt(HOME, runId, REVIEWER, { resume: { ...auth, session: 'different' } }), /original seat\/session/);
  assert.throws(() => plan.startAttempt(HOME, runId, REVIEWER, { resume: { ...auth, reason: 'retry' } }), /actual choice/);
  fs.appendFileSync(file, 'new input');
  assert.throws(() => plan.startAttempt(HOME, runId, REVIEWER, { resume: auth }), /plan file changed/);
  fs.writeFileSync(file, PLAN_BODY);
  plan.startAttempt(HOME, runId, REVIEWER, { resume: auth });
  let loc = attemptRelayDir(runId);
  writeRelayResult(loc.relayDir, { status: 'failed' });
  let run = plan.ingestPlanReview(HOME, runId, 1, 3, loc.relayDir);
  assert.equal(run.status, 'stopped');
  assert.equal(run.rounds.length, 1);
  assert.equal(run.retryUsed, true);
  assert.throws(() => plan.startAttempt(HOME, runId, REVIEWER, { retry: true }), /retry/);
  plan.startAttempt(HOME, runId, { ...REVIEWER, implementer: 'claude', lane: 'selected' }, { resume: { ...auth, reviewerLane: 'selected' } });
  loc = attemptRelayDir(runId);
  writeRelayResult(loc.relayDir, { doc: readFix('plan-review-round1.json'), readOnlyViolation: false });
  run = plan.ingestPlanReview(HOME, runId, 1, 4, loc.relayDir);
  assert.equal(run.status, 'awaiting_verdict');
  assert.equal(run.recoveries.length, 2);
  assert.equal(run.warnings.some(w => (w.match(/Historical failure/g) || []).length > 1), false);
  assert.equal(run.recoveries[1].overrides.reviewer, 'selected');
  assert.equal(run.rounds[0].attempts.length, 4);
  assert.throws(() => plan.startAttempt(HOME, runId, REVIEWER, { resume: auth }), /exhausted failed/);
  plan.applyVerdict(HOME, runId, 1, PLAN_BODY, readFix('verdict-round1-nochange.json'));
  const fin = plan.finishPlan(HOME, runId);
  assert.equal(fin.outcome, 'completed');
  assert.doesNotMatch(fin.reviewSection, /reviewer claude/);
  assert.doesNotMatch(fin.reviewSection, /This round is unreviewed/);
  assert.equal(common.statsRowFromRun(common.loadRun(HOME, runId)).agents.length, 4);
});

test('a finished failure in a later round resumes despite an old completed outcome and expires the old receipt', () => {
  const runId = newPlanRun();
  runReviewRound(runId, PLAN_BODY, readFix('plan-review-round1.json'));
  plan.applyVerdict(HOME, runId, 1, PLAN_REVISED, readFix('verdict-round1.json'));
  plan.startRound(HOME, runId, PLAN_REVISED);
  for (let n = 1; n <= 2; n++) {
    plan.startAttempt(HOME, runId, REVIEWER, { retry: n === 2 });
    const loc = attemptRelayDir(runId);
    writeRelayResult(loc.relayDir, { status: 'failed' });
    plan.ingestPlanReview(HOME, runId, 2, n, loc.relayDir);
  }
  common.updateRun(HOME, runId, r => { r.status = 'finished'; r.outcome = 'completed'; r.finishedAt = '2020-01-01T00:00:00Z'; r.plan.firstFinishedAt = r.finishedAt; r.plan.receipt = { digest: 'legacy' }; return r; });
  const run = plan.startAttempt(HOME, runId, REVIEWER, { resume: { seat: SEAT, session: SESSION, reason: 'user authorized: try again' } });
  assert.equal(run.plan.receipt, null);
  assert.equal(run.plan.firstFinishedAt, null);
  assert.equal(run.finishedAt, null);
  assert.equal(run.outcome, null);
  assert.equal(run.recoveries[0].priorReceipt.digest, 'legacy');
  assert.equal(run.rounds.length, 2);
});

test('later plan recovery validates that round’s file or stdin snapshot, not the original source file', () => {
  for (const origin of ['file', 'stdin']) {
    const original = path.join(SCRATCH, `original-${origin}.md`);
    const revised = path.join(SCRATCH, `revised-${origin}.md`);
    fs.writeFileSync(original, PLAN_BODY);
    fs.writeFileSync(revised, PLAN_REVISED);
    const runId = newPlanRun({ sourcePath: original, origin: 'file' });
    runReviewRound(runId, PLAN_BODY, readFix('plan-review-round1.json'));
    plan.applyVerdict(HOME, runId, 1, PLAN_REVISED, readFix('verdict-round1.json'));
    plan.startRound(HOME, runId, PLAN_REVISED, { sourcePath: origin === 'file' ? revised : null, origin });
    for (let n = 1; n <= 2; n++) {
      plan.startAttempt(HOME, runId, REVIEWER, { retry: n === 2 });
      const loc = attemptRelayDir(runId);
      writeRelayResult(loc.relayDir, { status: 'failed' });
      plan.ingestPlanReview(HOME, runId, 2, n, loc.relayDir);
    }
    const run = common.loadRun(HOME, runId);
    const auth = { seat: SEAT, session: SESSION, reason: 'user authorized: retry the unchanged revised input' };
    fs.unlinkSync(original);
    assert.doesNotThrow(() => recovery.validateResume(run, auth, HOME));
    fs.appendFileSync(revised, 'changed live source');
    if (origin === 'file') assert.throws(() => recovery.validateResume(run, auth, HOME), /plan file changed/);
    else assert.doesNotThrow(() => recovery.validateResume(run, auth, HOME));
  }
});

test('scope transitions support live worktrees backed by bare repositories but still reject missing worktrees', () => {
  const seed = makeRepo();
  const bare = path.join(SCRATCH, 'scope-bare.git');
  const worktree = path.join(SCRATCH, 'scope-bare-worktree');
  gitc(SCRATCH, 'clone', '--quiet', '--bare', seed, bare);
  gitc(SCRATCH, '--git-dir', bare, 'worktree', 'add', '--quiet', worktree, 'main');
  const disabled = common.changeRepositoryScope(worktree, false, HOME);
  assert.deepEqual(disabled.worktrees, [fs.realpathSync(worktree)]);
  assert.equal(common.repositoryScope(worktree).enabled, false);
  assert.equal(common.changeRepositoryScope(worktree, true, HOME).enabled, true);
  const other = path.join(SCRATCH, 'scope-bare-other');
  gitc(worktree, 'worktree', 'add', '--quiet', '-b', 'other', other);
  fs.renameSync(other, `${other}-moved`);
  assert.throws(() => common.changeRepositoryScope(worktree, false, HOME), /cannot inspect linked worktree/);
  assert.equal(common.repositoryScope(worktree).enabled, true);
});

test('scope transitions revoke approvals across worktrees, refuse active or uncheckable worktrees, and preserve disabled target routing', () => {
  const repo = makeRepo();
  const linked = path.join(SCRATCH, 'transition-linked');
  gitc(repo, 'worktree', 'add', '-q', '-b', 'linked', linked);
  const ids = [common.repoIdentity(repo), common.repoIdentity(linked)];
  for (const id of ids) common.updateLedger(HOME, id, l => { l.approvals.push({ approvalId: id.repoKey, consumedAt: null }); return l; });
  const disabled = common.changeRepositoryScope(repo, false, HOME);
  assert.equal(disabled.supersededApprovals, 2);
  for (const id of ids) assert.match(common.loadLedger(HOME, id.repoKey).approvals[0].consumedAt, /scope-disable/);
  common.updateLedger(HOME, ids[1], l => { l.approvals.push({ approvalId: 'while-off', consumedAt: null }); return l; });
  assert.equal(common.changeRepositoryScope(repo, true, HOME).supersededApprovals, 1);
  common.updateLedger(HOME, ids[1], l => { l.active = { runId: 'active' }; return l; });
  assert.throws(() => common.changeRepositoryScope(repo, false, HOME), /active candidates/);
  assert.equal(common.repositoryScope(repo).enabled, true);
  common.updateLedger(HOME, ids[1], l => { l.active = null; return l; });
  fs.renameSync(linked, `${linked}-moved`);
  assert.throws(() => common.changeRepositoryScope(repo, false, HOME), /cannot inspect/);
  fs.renameSync(`${linked}-moved`, linked);
  common.changeRepositoryScope(repo, false, HOME);
  const enabled = makeRepo();
  const decide = (command, cwd = enabled) => common.gitGateDecision({ command, cwd, home: HOME });
  assert.equal(decide(`git -C '${repo}' push origin main`).decision, 'pass');
  assert.equal(decide(`cd '${repo}' && git push origin main`).decision, 'pass');
  assert.equal(decide(`git -C '${enabled}' push origin main`, repo).decision, 'deny');
  for (const cmd of ['env GIT_DIR=.git git push origin main', 'sudo git push origin main', 'git push origin main | tee log', 'git --git-dir=.git push origin main']) assert.equal(decide(cmd, repo).decision, 'deny', cmd);
  assert.equal(decide(`git -C '${repo}' push origin main && git -C '${enabled}' push origin main`).decision, 'deny');
  for (const seat of ['claude', 'codex']) assert.equal(hook(seat, 'PreToolUse', hookPayload('target-test', enabled, { tool_name: 'Bash', tool_input: { command: 'git push origin main', workdir: repo } })).output, null);
});

test('repository scope defaults off, shares enrollment across worktrees, and retains explicit session bookkeeping', () => {
  const repo = makeRepo(undefined, { enrolled: false });
  assert.equal(common.repositoryScope(repo).configured, null);
  assert.equal(common.repositoryScope(repo).enabled, false);
  assert.equal(common.repositoryScope(SCRATCH).enabled, false);
  for (const seat of ['claude', 'codex']) {
    const sid = `scope-${seat}`;
    const payload = hookPayload(sid, repo, { permission_mode: 'plan', last_assistant_message: '<proposed_plan>unreviewed</proposed_plan>' });
    assert.equal(hook(seat, 'SessionStart', payload).output, null);
    assert.equal(hook(seat, 'UserPromptSubmit', payload).output, null);
    assert.equal(hook(seat, 'Stop', payload).output, null);
    assert.equal(hook(seat, 'PreToolUse', { ...payload, tool_name: 'ExitPlanMode', tool_input: {} }).output, null);
    assert.equal(hook(seat, 'PreToolUse', { ...payload, tool_name: 'Bash', tool_input: { command: 'git push origin main' } }).output, null);
    assert.equal(common.loadSession(HOME, seat, sid).generation, 1);
    assert.equal(common.loadLedger(HOME, common.repoIdentity(repo).repoKey), null);
  }
  const linked = path.join(SCRATCH, 'scope-linked');
  gitc(repo, 'worktree', 'add', '-q', '-b', 'linked', linked);
  assert.equal(common.repositoryScope(linked).enabled, false);
  assert.equal(cli('scope', ['enable', '--cwd', linked]).status, 0);
  assert.equal(common.repositoryScope(repo).enabled, true);
  assert.equal(common.repositoryScope(linked).enabled, true);
  assert.equal(cli('scope', ['disable', '--cwd', repo]).status, 0);
  assert.equal(common.repositoryScope(linked).enabled, false);
  gitc(repo, 'config', '--local', 'debate.enabled', 'invalid');
  const invalid = common.repositoryScope(repo);
  assert.equal(invalid.configured, null);
  assert.equal(invalid.enabled, false);
  assert.equal(invalid.effective, false);
  assert.equal(invalid.warnings.length, 1);
  assert.match(invalid.warnings[0], /defaulting to disabled/);
});

test('fresh init and clones of enrolled repositories default off', () => {
  const fresh = path.join(SCRATCH, 'fresh-init');
  fs.mkdirSync(fresh);
  gitc(fresh, 'init', '-q');
  const seed = makeRepo();
  const clone = path.join(SCRATCH, 'fresh-clone');
  gitc(SCRATCH, 'clone', '--quiet', seed, clone);
  for (const repo of [fresh, clone]) {
    const scope = common.repositoryScope(repo);
    assert.notEqual(scope.identity, null);
    assert.equal(scope.configured, null);
    assert.equal(scope.effective, false);
  }
  assert.equal(common.repositoryScope(seed).enabled, true);
});

test('unreadable local config read disables automation with a diagnostic', () => {
  const repo = makeRepo();
  const configPath = path.join(repo, '.git', 'config');
  const before = fs.readFileSync(configPath, 'utf8');
  const shimBin = path.join(SCRATCH, 'config-read-failure-bin');
  fs.mkdirSync(shimBin);
  const realGit = fs.realpathSync(path.join(BIN, 'git'));
  fs.writeFileSync(path.join(shimBin, 'git'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'config' && args.includes('--local') && args.includes('--get-all')) {
  process.stderr.write('fatal: unable to read local config\\n');
  process.exit(128);
}
const r = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
`, { mode: 0o700 });
  const result = cli('scope', ['status', '--cwd', repo], { env: { PATH: `${shimBin}:${process.env.PATH}` } });
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(result.json.identity, null);
  assert.equal(result.json.configured, null);
  assert.equal(result.json.enabled, false);
  assert.equal(result.json.effective, false);
  assert.deepEqual(result.json.warnings, ['invalid or unreadable local debate.enabled; defaulting to disabled']);
  assert.equal(fs.readFileSync(configPath, 'utf8'), before);
});

test('scope status is read-only, ignores global/system/includes, accepts Git booleans and symlinks, and mid-session activation has no invented baseline', () => {
  const repo = makeRepo(undefined, { enrolled: false });
  const isolated = path.join(SCRATCH, 'status-only-home');
  const configPath = path.join(repo, '.git', 'config');
  const before = fs.readFileSync(configPath, 'utf8');
  const result = cli('scope', ['status', '--cwd', repo], { env: { DEBATE_HOME: isolated } });
  assert.equal(result.json.effective, false);
  assert.equal(fs.existsSync(isolated), false);
  assert.equal(fs.readFileSync(configPath, 'utf8'), before);
  const global = path.join(SCRATCH, 'ignored-config');
  fs.writeFileSync(global, '[debate]\n enabled = true\n');
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
    const r = cli('scope', ['status', '--cwd', repo], { env: { [key]: global } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.enabled, false);
  }
  gitc(repo, 'config', 'include.path', global);
  assert.equal(common.repositoryScope(repo).enabled, false);
  gitc(repo, 'config', 'debate.enabled', 'yes');
  assert.equal(common.repositoryScope(repo).enabled, true);
  gitc(repo, 'config', 'debate.enabled', 'no');
  assert.equal(common.repositoryScope(repo).configured, false);
  assert.equal(common.repositoryScope(repo).enabled, false);
  const symlink = path.join(SCRATCH, 'repo-link');
  fs.symlinkSync(repo, symlink);
  assert.equal(common.repositoryScope(symlink).enabled, false);
  const sid = 'mid-session-scope';
  hook('codex', 'SessionStart', hookPayload(sid, repo));
  common.changeRepositoryScope(repo, true, HOME);
  hook('codex', 'UserPromptSubmit', hookPayload(sid, repo, { prompt: 'continue' }));
  assert.equal(common.loadLedger(HOME, common.repoIdentity(repo).repoKey).baselines[common.sessionKey('codex', sid)], undefined);
  assert.equal(hook('codex', 'Stop', hookPayload(sid, repo)).output.decision, 'block');
  const nonrepo = hookPayload('nonrepo-metadata', SCRATCH, { permission_mode: 'plan' });
  for (const seat of ['claude', 'codex']) {
    assert.equal(hook(seat, 'SessionStart', nonrepo).output, null);
    assert.equal(hook(seat, 'UserPromptSubmit', nonrepo).output, null);
    assert.equal(common.loadSession(HOME, seat, 'nonrepo-metadata').generation, 1);
  }
});

test('explicit plan and code workflows remain available without enrollment in both seats', () => {
  for (const seat of ['claude', 'codex']) {
    const repo = makeRepo(undefined, { enrolled: false });
    const sid = `explicit-unenrolled-${seat}`;
    const id = newPlanRun({ seat, sessionId: sid, cwd: repo });
    runReviewRound(id, PLAN_BODY, readFix('plan-review-round1.json'));
    plan.applyVerdict(HOME, id, 1, PLAN_BODY, readFix('verdict-round1-nochange.json'));
    assert.equal(plan.finishPlan(HOME, id).outcome, 'completed');
    const begun = cli('code', ['begin', '--seat', seat, '--session', sid, '--cwd', repo]);
    assert.equal(begun.status, 0, begun.stderr);
    assert.equal(begun.json.ok, true);
    const payload = hookPayload(sid, repo);
    fs.appendFileSync(path.join(repo, 'app.py'), '# unreviewed change\n');
    assert.equal(hook(seat, 'UserPromptSubmit', payload).output, null);
    assert.equal(hook(seat, 'Stop', payload).output, null);
    for (const command of ['git commit --amend --no-edit', 'git push origin main']) {
      assert.equal(hook(seat, 'PreToolUse', { ...payload, tool_name: 'Bash', tool_input: { command } }).output, null);
    }
    assert.equal(common.repositoryScope(repo).configured, null);
  }
});

test('review routing follows lane bindings and code preflight accepts the configured implementer', () => {
  const repo = makeRepo();
  const selected = plan.planPreflight('codex', repo, 'plan-main-claude');
  assert.equal(selected.ok, true, selected.reason);
  assert.equal(selected.reviewer.implementer, 'codex');
  assert.deepEqual(selected.reviewers.map(r => [r.role, r.implementer, r.lane]), [['primary', 'codex', 'plan-main-claude'], ['secondary-1', 'claude', 'plan-debate']]);
  assert.equal(selected.reviewers[1].model, 'model-c');
  assert.equal(selected.reviewers[1].effort, 'high');
  assert.equal(plan.planPreflight('codex', repo).reviewer.lane, 'plan-main');
  assert.equal(plan.planPreflight('codex', repo).reviewer.implementer, 'claude');
  assert.equal(plan.planPreflight('claude', repo).reviewer.lane, 'plan-main-claude');
  assert.equal(plan.planPreflight('codex', repo, 'missing-lane').ok, false);
  assert.match(plan.buildBrief(plan.newPlanRun({ seat: 'codex', sessionId: 'test', cwd: repo }), 1, PLAN_BODY, { implementer: 'opencode' }), /OpenCode plan agent/);
  const laneConfig = common.loadLaneConfig(repo);
  assert.equal(laneConfig.lanes['review-main'].source, 'global');
  assert.equal(recovery.resolveReviewOverride(repo, 'plan-main-claude', { globalOnly: true }).reviewer.source, 'global');

  const fleetFile = path.join(XDG, 'delegate-skills', 'config.json');
  const originalFleet = fs.readFileSync(fleetFile, 'utf8');
  try {
    const fleet = JSON.parse(originalFleet);
    fleet.lanes['plan-main'] = { implementer: 'codex', model: 'model-d', effort: 'medium' };
    fleet.lanes['plan-debate'] = { implementer: 'opencode', model: 'provider/model-e', variant: 'high' };
    fs.writeFileSync(fleetFile, JSON.stringify(fleet));
    const rerouted = plan.planPreflight('codex', repo);
    assert.equal(rerouted.ok, true, rerouted.reason);
    assert.deepEqual(rerouted.reviewers.map(r => [r.lane, r.implementer, r.model, r.effort]), [
      ['plan-main', 'codex', 'model-d', 'medium'],
      ['plan-debate', 'opencode', 'provider/model-e', 'high'],
    ]);
  } finally {
    fs.writeFileSync(fleetFile, originalFleet);
  }

  const codeRepo = makeRepo();
  const begun = cli('code', ['begin', '--seat', 'claude', '--session', 'dynamic-code-lanes', '--cwd', codeRepo]).json;
  fs.writeFileSync(path.join(codeRepo, 'candidate.txt'), 'review me\n');
  commitAll(codeRepo, 'feat: candidate');
  const codePreflight = code.codePreflight(HOME, common.loadRun(HOME, begun.runId));
  assert.equal(codePreflight.ok, true, JSON.stringify(codePreflight));

  fs.mkdirSync(path.join(repo, '.delegate'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.delegate', 'config.json'), JSON.stringify({ version: 'delegate-fleet.v1', lanes: { 'plan-main-claude': { implementer: 'codex', model: 'model-a', effort: 'high' } } }));
  assert.throws(() => recovery.resolveReviewOverride(repo, 'plan-main-claude', { globalOnly: true }), /global binding/);
  assert.throws(() => recovery.resolveReviewOverride(repo, 'plan-main-claude'), /configuration trust/);
  const transcript = path.join(SCRATCH, 'runtime-model.jsonl');
  const run = plan.newPlanRun({ seat: 'claude', sessionId: 'model-observed', cwd: repo });
  fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { model: 'observed-model' } }));
  common.updateSession(HOME, run.seat, run.sessionId, s => { s.transcriptPath = transcript; return s; });
  assert.equal(recovery.orchestratorModel(HOME, run), 'observed-model');
  fs.appendFileSync(transcript, '\n' + JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { model: 'other-model' } }));
  assert.equal(recovery.orchestratorModel(HOME, run), null);
});

test('--help never launches a model and exits 0; helper imports have no CLI side effects', () => {
  const beforeRuns = fs.readdirSync(path.join(HOME, 'runs'));
  const helps = [[], ['plan'], ['code'], ['review'], ['hook'], ['setup']];
  for (const args of helps) {
    const r = spawnSync(process.execPath, [CLI, ...args, '--help'], { encoding: 'utf8', cwd: SCRATCH });
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stdout, /Usage|hook </);
  }
  assert.deepEqual(fs.readdirSync(path.join(HOME, 'runs')), beforeRuns);
  assert.equal(typeof plan.main, 'function');
  assert.equal(typeof code.main, 'function');
  for (const name of ['mergeClaudeSettings', 'mergeCodexHooks', 'mergeTomlWritableRoots']) assert.equal(name in common, false);
  const spaced = path.join(SCRATCH, 'home with spaces', 'debate');
  fs.cpSync(SKILL, spaced, { recursive: true });
  for (const command of ['plan', 'code', 'hook']) {
    const r = spawnSync(process.execPath, [path.join(spaced, 'scripts', 'debate.mjs'), command, '--help'], { encoding: 'utf8', cwd: SCRATCH });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage|hook </);
  }
  const codeSkill = fs.readFileSync(path.join(SKILL, 'references', 'code.md'), 'utf8');
  const resetAt = codeSkill.indexOf('git reset --soft');
  const beginAt = codeSkill.indexOf('debate.mjs" code begin');
  assert.ok(resetAt >= 0 && beginAt >= 0);
  assert.ok(resetAt < beginAt);
  for (const skill of [codeSkill, fs.readFileSync(path.join(SKILL, 'references', 'plan.md'), 'utf8')]) assert.match(skill, /take the result from wait --run "<run>" --max-wait 1s: it prints the recorded/);
  const brief = plan.buildBrief(plan.newPlanRun({ seat: SEAT, sessionId: SESSION, cwd: SCRATCH }), 1, PLAN_BODY, REVIEWER);
  assert.match(brief, /Do not write files anywhere, including temp directories; do not run tests or builds/);
  assert.doesNotMatch(brief, /summary names the finding IDs/);
  const relayRoot = path.join(SCRATCH, 'stub-relays');
  for (const implementer of ['codex', 'opencode', 'claude']) {
    const dir = path.join(relayRoot, `${implementer}-delegate`, 'scripts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'relay.mjs'), `import fs from 'node:fs'; import path from 'node:path'; const args = process.argv.slice(2); const out = args[args.indexOf('--out-dir') + 1]; fs.mkdirSync(out, {recursive:true}); fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({args}));`);
  }
  const oldRoot = process.env.DELEGATE_SKILLS_DIR;
  process.env.DELEGATE_SKILLS_DIR = relayRoot;
  try {
    for (const implementer of ['codex', 'opencode', 'claude']) {
      const relay = common.runRelay({ implementer, lane: 'test', briefPath: plan.TEMPLATE_PATH, cwd: SCRATCH, outDir: path.join(SCRATCH, `args-${implementer}`), timeout: '1s' });
      assert.equal(relay.exitCode, 0);
      assert.equal(relay.result.args.includes('--ignore-user-config'), implementer === 'codex');
      assert.ok(relay.result.args.includes('--read-only'));
    }
  } finally { if (oldRoot === undefined) delete process.env.DELEGATE_SKILLS_DIR; else process.env.DELEGATE_SKILLS_DIR = oldRoot; }

});

test('plan review pairs the seat-specific reviewer with plan-debate and combines both reports', () => {
  const runId = newPlanRun();
  const primary = readFix('plan-review-round1.json');
  const secondary = { ...primary, plan_rating: 9, summary: 'The plan is strong, with the same two actionable observations.' };
  const run = runPairedReviewRound(runId, PLAN_BODY, primary, secondary);
  const round = run.rounds[0];
  const attempt = round.attempts[0];
  assert.equal(attempt.status, 'completed');
  assert.equal(attempt.reviewers.length, 2);
  assert.deepEqual(attempt.agents.map(a => [a.stage, a.lane]), [['primary', 'plan-main-claude'], ['secondary-1', 'plan-debate']]);
  assert.equal(round.review.reviews.length, 2);
  assert.equal(round.review.rating, 6, 'combined rating is conservative');
  assert.deepEqual(round.review.findings.map(f => f.id), ['F1', 'F2', 'S1', 'S2']);
  assert.deepEqual(round.review.assumptions.map(a => a.id), ['A1', 'B1']);
  assert.equal(round.review.reviews[1].findings[0].sourceId, 'F1');
  assert.equal(plan.reviewDoc(run).reviewerCount, 2);
  const verdict = {
    review_rating: 6,
    no_further_review: false,
    verdicts: round.review.findings.map(f => ({ id: f.id, verdict: 'confirm', reason: 'Validated by the orchestrator' })),
    contest_rulings: [],
    assumptions: round.review.assumptions.map(a => ({ id: a.id, resolution: 'kept_default', changed_plan: false })),
    missed: [],
  };
  const stopped = plan.applyVerdict(HOME, runId, 1, PLAN_BODY, verdict);
  assert.equal(stopped.stopReason, 'no_changes');
});

test('runAttempt launches the two configured plan reviewers and records separate artifacts', () => {
  const relayRoot = path.join(SCRATCH, 'paired-relays');
  const primary = readFix('plan-review-round1.json');
  installReviewRelay(relayRoot, 'codex', primary);
  installReviewRelay(relayRoot, 'claude', primary);
  const previousRoot = process.env.DELEGATE_SKILLS_DIR;
  process.env.DELEGATE_SKILLS_DIR = relayRoot;
  try {
    const runId = newPlanRun();
    plan.startRound(HOME, runId, PLAN_BODY);
    plan.startAttempt(HOME, runId, [REVIEWER, SECOND_REVIEWER]);
    const done = plan.runAttempt(HOME, runId, 1, 1);
    const attempt = done.rounds[0].attempts[0];
    const attemptDir = path.join(common.runDir(HOME, runId), attempt.dir);
    assert.equal(attempt.status, 'completed');
    assert.equal(attempt.agents.length, 2);
    assert.equal(attempt.promptSizes.length, 2);
    for (const [i, name] of ['brief.md', 'brief-secondary-1.md'].entries()) {
      const brief = fs.readFileSync(path.join(attemptDir, name), 'utf8');
      assert.equal(attempt.promptSizes[i].briefBytes, Buffer.byteLength(brief));
      assert.equal(attempt.promptSizes[i].planBytes, Buffer.byteLength(PLAN_BODY));
      assert.doesNotMatch(brief, /promptSizes|planBytes|historyBytes|briefBytes/);
    }
    assert.equal(common.statsRowFromRun(done).promptSizes.length, 2);
    assert.equal(done.rounds[0].review.reviews.length, 2);
    assert.equal(fs.existsSync(path.join(attemptDir, 'brief.md')), true);
    assert.equal(fs.existsSync(path.join(attemptDir, 'brief-secondary-1.md')), true);
    assert.equal(fs.existsSync(path.join(attemptDir, 'relay', 'result.json')), true);
    assert.equal(fs.existsSync(path.join(attemptDir, 'relay-secondary-1', 'result.json')), true);
  } finally {
    if (previousRoot === undefined) delete process.env.DELEGATE_SKILLS_DIR;
    else process.env.DELEGATE_SKILLS_DIR = previousRoot;
  }
});

test('a failed secondary plan reviewer fails the paired attempt and remains retryable', () => {
  const runId = newPlanRun();
  plan.startRound(HOME, runId, PLAN_BODY);
  plan.startAttempt(HOME, runId, [REVIEWER, SECOND_REVIEWER]);
  const run = common.loadRun(HOME, runId);
  const attempt = run.rounds[0].attempts[0];
  const attemptDir = path.join(common.runDir(HOME, runId), attempt.dir);
  const primaryRelay = path.join(attemptDir, 'relay');
  const secondaryRelay = path.join(attemptDir, 'relay-secondary-1');
  writeRelayResult(primaryRelay, { doc: readFix('plan-review-round1.json'), readOnlyViolation: false });
  writeRelayResult(secondaryRelay, { status: 'failed', extra: { error: 'OpenCode reviewer unavailable' } });
  const failed = plan.ingestPlanReview(HOME, runId, 1, 1, [
    { role: 'primary', reviewer: REVIEWER, relayDir: primaryRelay, exitCode: 0 },
    { role: 'secondary-1', reviewer: SECOND_REVIEWER, relayDir: secondaryRelay, exitCode: 1 },
  ]);
  assert.equal(failed.status, 'review_failed');
  assert.equal(failed.rounds[0].review, null);
  assert.equal(failed.rounds[0].attempts[0].agents.length, 2);
  assert.equal(failed.rounds[0].attempts[0].failureDetails.stage, 'secondary-1');
  assert.equal(plan.reviewDoc(failed).retryAvailable, true);
});

test('fence-aware markers: examples inside backtick/tilde fences are ignored, duplicates and malformed blocks rejected, content after the block preserved', () => {
  const text = fs.readFileSync(path.join(FIX, 'plan-with-fences.md'), 'utf8');
  const none = common.splitPlan(text);
  assert.equal(none.error, null);
  assert.equal(none.block, null);
  const block = '<!-- debate-plan:begin run=11111111-1111-4111-8111-111111111111 sha=abcdefabcdef -->\ngenerated\n<!-- debate-plan:end -->';
  const withBlock = `${text}\n${block}\n\nStep 3: appended after the generated block.\n`;
  const one = common.splitPlan(withBlock);
  assert.equal(one.error, null);
  assert.equal(one.block.runId, '11111111-1111-4111-8111-111111111111');
  assert.match(one.body, /Step 3: appended after the generated block/);
  assert.doesNotMatch(one.body, /^generated$/m);
  assert.match(common.splitPlan(`${withBlock}\n${block}\n`).error, /duplicate/);
  assert.match(common.splitPlan(`${text}\n<!-- debate-plan:begin run=11111111-1111-4111-8111-111111111111 sha=abcdefabcdef -->\n`).error, /malformed/);
  assert.match(common.splitPlan(`${text}\n<!-- debate-plan:end -->\n`).error, /malformed/);
  const replaced = common.renderWithBlock(withBlock, one.block, '<!-- debate-plan:begin run=11111111-1111-4111-8111-111111111111 sha=abcdefabcdef -->\nnew\n<!-- debate-plan:end -->\n');
  assert.match(replaced, /\nnew\n/);
  assert.match(replaced, /Step 3: appended/);
  assert.doesNotMatch(replaced, /\ngenerated\n/);
});

test('canonicalization ignores CRLF, trailing whitespace and trailing blank lines', () => {
  const a = common.splitPlan('# A\nline  \n\n\n');
  const b = common.splitPlan('# A\r\nline\r\n');
  assert.equal(a.digest, b.digest);
  assert.notEqual(a.digest, common.splitPlan('# A\nline changed\n').digest);
});

test('reviewer output validation: schema, ids, confidence, and contest coverage', () => {
  const ok = common.validatePlanReview(readFix('plan-review-round1.json'), { round: 1 });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.doc.findings.map(f => f.id), ['F1', 'F2']);
  assert.match(ok.warnings[0], /dropped F3/);
  const dup = common.validatePlanReview(readFix('plan-review-round2-contest.json'), { round: 2, usedFindingIds: new Set(['F4']), priorContestIds: ['F2'] });
  assert.equal(dup.ok, false);
  assert.match(dup.errors.join(), /reuses id F4/);
  const missing = common.validatePlanReview(readFix('plan-review-round2.json'), { round: 2, priorContestIds: ['F1', 'F2'] });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join(), /F1 was neither accepted nor contested/);
  // a stance on a confirmed (non-contestable) verdict is noise, not a bad review: dropped with a warning
  const extra = common.validatePlanReview(readFix('plan-review-round2.json'), { round: 2, usedFindingIds: new Set(['F1', 'F2']), priorContestIds: [] });
  assert.equal(extra.ok, true);
  assert.deepEqual(extra.doc.contests, []);
  assert.match(extra.warnings.join(), /contests\[0\] ignored: F2/);
  const badSchema = common.validatePlanReview({ ...readFix('plan-review-round1.json'), schema: 'x', plan_rating: 11 }, { round: 1 });
  assert.equal(badSchema.ok, false);
  assert.match(badSchema.errors.join(), /schema/);
  assert.match(badSchema.errors.join(), /plan_rating/);
});

test('verdict validation requires complete coverage and known ids', () => {
  const doc = readFix('verdict-round1.json');
  assert.equal(common.validateVerdictDoc(doc, { findingIds: ['F1', 'F2'], assumptionIds: new Set(['A1']) }).ok, true);
  const partial = common.validateVerdictDoc({ ...doc, verdicts: doc.verdicts.slice(0, 1) }, { findingIds: ['F1', 'F2'], assumptionIds: new Set(['A1']) });
  assert.match(partial.errors.join(), /F2 has no verdict/);
  const unknown = common.validateVerdictDoc(doc, { findingIds: ['F1', 'F2', 'F9'], contestedIds: ['F0'], assumptionIds: new Set() });
  assert.match(unknown.errors.join(), /F9 has no verdict/);
  assert.match(unknown.errors.join(), /contest on F0 has no ruling/);
  assert.match(unknown.errors.join(), /unknown assumption A1/);
});

// ---------- plan workflow ----------

test('plan workflow: review, verdict with change, second round with contests, rating stop, finish, cheap re-stamp, changed content rejected', () => {
  const planFile = path.join(SCRATCH, 'plan-a.md');
  fs.writeFileSync(planFile, PLAN_BODY);
  const runId = newPlanRun({ sourcePath: planFile, origin: 'file' });
  common.updateSession(HOME, SEAT, SESSION, (s) => { s.generation = 3; s.planRuns.push(runId); return s; });
  let run = runReviewRound(runId, PLAN_BODY, readFix('plan-review-round1.json'));
  assert.equal(run.status, 'awaiting_verdict');
  assert.deepEqual(run.rounds[0].review.findings.map(f => f.id), ['F1', 'F2']);
  assert.equal(run.rounds[0].attempts[0].usage.input, 1000);
  assert.equal(run.rounds[0].attempts[0].coverage, 'sandbox');
  assert.equal(run.rounds[0].attempts[0].warnings.some(w => /coverage unreported/.test(w)), false);
  assert.throws(() => plan.startAttempt(HOME, runId, REVIEWER), /is awaiting_verdict/);
  run = plan.applyVerdict(HOME, runId, 1, PLAN_REVISED, readFix('verdict-round1.json'));
  assert.equal(run.rounds[0].ratingValid, false);
  assert.equal(run.rounds[0].next, 'continue');
  assert.equal(run.status, 'continue');
  assert.throws(() => plan.finishPlan(HOME, runId, { body: PLAN_REVISED }), /is continue/);
  assert.throws(() => plan.applyVerdict(HOME, runId, 1, PLAN_REVISED, readFix('verdict-round1.json')), /is continue/);
  run = runReviewRound(runId, PLAN_REVISED, readFix('plan-review-round2.json'));
  assert.equal(run.status, 'awaiting_verdict');
  assert.equal(run.rounds[1].review.contests[0].stance, 'accept');
  run = plan.applyVerdict(HOME, runId, 2, PLAN_REVISED, readFix('verdict-round2.json'));
  assert.equal(run.rounds[1].ratingValid, true);
  assert.equal(run.stopReason, 'rating');
  assert.equal(run.status, 'stopped');
  fs.writeFileSync(planFile, PLAN_REVISED);
  const finished = plan.finishPlan(HOME, runId);
  assert.equal(finished.outcome, 'completed');
  assert.equal(finished.unratedChanges, false);
  assert.equal(finished.receipt.generation, 3);
  const written = fs.readFileSync(planFile, 'utf8');
  assert.match(written, new RegExp(`<!-- debate-plan:begin run=${runId} sha=${finished.receipt.shortSha} -->`));
  assert.match(written, /<!-- debate-plan:end -->\s*$/);
  assert.match(written, /Applied F1: Added CRLF normalization/);
  assert.match(written, /Missed finding: Missing --help exit code/);
  assert.equal(plan.checkReceipt(common.loadRun(HOME, runId), { seat: SEAT, sessionId: SESSION, generation: 3, planText: written }).ok, true);
  assert.equal(plan.checkReceipt(common.loadRun(HOME, runId), { seat: SEAT, sessionId: SESSION, generation: 4, planText: written }).ok, false);
  // cheap re-stamp after a new prompt generation: no reviewer call, firstFinishedAt retained
  common.updateSession(HOME, SEAT, SESSION, (s) => { s.generation = 4; return s; });
  const first = common.loadRun(HOME, runId).plan.firstFinishedAt;
  const restamp = plan.finishPlan(HOME, runId);
  assert.equal(restamp.restamp, true);
  assert.equal(restamp.receipt.generation, 4);
  assert.equal(restamp.receipt.firstFinishedAt, first);
  assert.equal(common.loadRun(HOME, runId).rounds.length, 2);
  assert.equal(plan.checkReceipt(common.loadRun(HOME, runId), { seat: SEAT, sessionId: SESSION, generation: 4, planText: fs.readFileSync(planFile, 'utf8') }).ok, true);
  // expired receipt
  assert.match(plan.checkReceipt(common.loadRun(HOME, runId), { seat: SEAT, sessionId: SESSION, generation: 4, planText: fs.readFileSync(planFile, 'utf8'), now: Date.now() + 25 * 3600 * 1000 }).reason, /24 hours/);
  // changed content after finish is rejected
  fs.writeFileSync(planFile, fs.readFileSync(planFile, 'utf8').replace('Step 1: load files.', 'Step 1: load ALL files.'));
  assert.throws(() => plan.finishPlan(HOME, runId), /changed after finish/);
  assert.equal(plan.checkReceipt(common.loadRun(HOME, runId), { seat: SEAT, sessionId: SESSION, generation: 4, planText: fs.readFileSync(planFile, 'utf8') }).ok, false);
  const stats = common.readStats(HOME).find(r => r.recordType === 'run' && r.runId === runId);
  assert.equal(stats.claims.confirmed, 1);
  assert.equal(stats.claims.discarded, 1);
  assert.equal(stats.claims.missed, 1);
  assert.equal(stats.assumptions.settledFromRepo, 1);
  assert.deepEqual(stats.ratings.plan.map(p => p.valid), [false, true]);
  const carried = fs.readFileSync(planFile, 'utf8');
  const nextId = newPlanRun({ sourcePath: planFile, origin: 'file' });
  runReviewRound(nextId, carried, readFix('plan-review-round1.json'));
  plan.applyVerdict(HOME, nextId, 1, carried, readFix('verdict-round1-nochange.json'));
  const replaced = plan.finishPlan(HOME, nextId, { body: carried, sourcePath: planFile });
  assert.equal(common.splitPlan(replaced.finishedBody).block.runId, nextId);
  assert.equal((replaced.finishedBody.match(/<!-- debate-plan:begin/g) || []).length, 1);
  assert.equal(plan.checkReceipt(common.loadRun(HOME, nextId), { seat: SEAT, sessionId: SESSION, generation: 4, planText: replaced.finishedBody }).ok, true);
});

test('stop conditions: no changes stops, changed rating is invalid, round three stops even when changed, contests need rulings', () => {
  let runId = newPlanRun();
  runReviewRound(runId, PLAN_BODY, readFix('plan-review-round1.json'));
  let run = plan.applyVerdict(HOME, runId, 1, PLAN_BODY, readFix('verdict-round1-nochange.json'));
  assert.equal(run.stopReason, 'no_changes');
  assert.equal(run.rounds[0].ratingValid, true);
  // acceptance threshold: an unchanged plan rated 8 stops on rating; 7 stops only because nothing changed
  assert.equal(plan.ACCEPT_RATING, 8);
  runId = newPlanRun();
  runReviewRound(runId, PLAN_BODY, { ...readFix('plan-review-round1.json'), plan_rating: 8 });
  assert.equal(plan.applyVerdict(HOME, runId, 1, PLAN_BODY, readFix('verdict-round1-nochange.json')).stopReason, 'rating');
  runId = newPlanRun();
  runReviewRound(runId, PLAN_BODY, { ...readFix('plan-review-round1.json'), plan_rating: 7 });
  assert.equal(plan.applyVerdict(HOME, runId, 1, PLAN_BODY, readFix('verdict-round1-nochange.json')).stopReason, 'no_changes');
  // a declared change over unchanged text is a contradiction: rejected, the run stays awaiting_verdict
  runId = newPlanRun();
  runReviewRound(runId, PLAN_BODY, { ...readFix('plan-review-round1.json'), plan_rating: 9 });
  assert.throws(() => plan.applyVerdict(HOME, runId, 1, PLAN_BODY, readFix('verdict-round1.json')), /plan text is unchanged/);
  const nochange = readFix('verdict-round1-nochange.json');
  // the real-session shape: a discard whose change field reads "None; ..." still declares a change
  assert.throws(() => plan.applyVerdict(HOME, runId, 1, PLAN_BODY, { ...nochange, verdicts: nochange.verdicts.map((v, i) => i === 0 ? { ...v, change: 'None; the loader already normalizes CRLF' } : v) }), /plan text is unchanged/);
  assert.throws(() => plan.applyVerdict(HOME, runId, 1, PLAN_BODY, { ...nochange, assumptions: [{ id: 'A1', resolution: 'kept_default', changed_plan: true }] }), /plan text is unchanged/);
  assert.equal(common.loadRun(HOME, runId).status, 'awaiting_verdict');
  // rating 9 with an applied change invalidates the rating and continues
  run = plan.applyVerdict(HOME, runId, 1, PLAN_REVISED, readFix('verdict-round1.json'));
  assert.equal(run.rounds[0].ratingValid, false);
  assert.equal(run.status, 'continue');
  // contest round: ruling required, reverse counted; then round three stops regardless
  run = runReviewRound(runId, PLAN_REVISED, readFix('plan-review-round2-contest.json'));
  assert.throws(() => plan.applyVerdict(HOME, runId, 2, PLAN_REVISED, readFix('verdict-round2.json')), /invalid verdict/);
  run = plan.applyVerdict(HOME, runId, 2, `${PLAN_REVISED}\nround two: raised the log level\n`, readFix('verdict-round2-contest.json'));
  assert.equal(run.status, 'continue');
  run = runReviewRound(runId, `${PLAN_REVISED}\nround three text\n`, { ...readFix('plan-review-round2.json'), round: 3, contests: [{ id: 'F4', stance: 'accept', reason: 'fixed', evidence: 'x:1' }] });
  run = plan.applyVerdict(HOME, runId, 3, `${PLAN_REVISED}\nround three text, amended\n`, readFix('verdict-round2.json'));
  assert.equal(run.stopReason, 'round_limit');
  assert.equal(run.rounds[2].ratingValid, false);
  assert.throws(() => plan.startRound(HOME, runId, PLAN_BODY), /is stopped/);
  const finished = plan.finishPlan(HOME, runId, { body: `${PLAN_REVISED}\nround three text, amended, and more\n` });
  assert.equal(finished.unratedChanges, true);
  assert.match(finished.reviewSection, /Changes after the last review: yes/);
  assert.doesNotMatch(finished.reviewSection, /Next:|Review rating/);
  const row = common.readStats(HOME).find(r => r.recordType === 'run' && r.runId === runId);
  assert.equal(row.claims.contested, 1);
  assert.equal(row.claims.reversed, 1);
});

test('agreed stop, plan: acceptable rating, no blocking finding and an explicit no_further_review flag stop after applied changes; negatives continue; round three still reports round_limit', () => {
  const round1 = readFix('plan-review-round1.json');
  const review = { ...round1, plan_rating: 8, findings: round1.findings.map(f => ({ ...f, severity: 'non-blocking' })) };
  const verdict = { ...readFix('verdict-round1.json'), missed: [], no_further_review: true };
  assert.equal(plan.stopDecision({ round: 1, rating: 8, ratingValid: false, changed: true, agreed: true }).stopReason, 'agreed');
  let runId = newPlanRun();
  let run = runReviewRound(runId, PLAN_BODY, review);
  run = plan.applyVerdict(HOME, runId, 1, PLAN_REVISED, verdict);
  assert.equal(run.status, 'stopped');
  assert.equal(run.stopReason, 'agreed');
  assert.equal(run.rounds[0].agreed, true);
  assert.equal(run.rounds[0].ratingValid, false);
  assert.equal(run.rounds[0].verdict.no_further_review, true);
  const fin = plan.finishPlan(HOME, runId, { body: PLAN_REVISED });
  assert.equal(fin.outcome, 'completed');
  assert.equal(fin.stopReason, 'agreed');
  assert.equal(fin.unratedChanges, true);
  assert.doesNotMatch(fin.reviewSection, /stop reason:/);
  assert.doesNotMatch(fin.reviewSection, /Next:/);
  assert.match(fin.reviewSection, /Changes after the last review: yes/);
  const negatives = [
    ['blocking finding', { ...round1, plan_rating: 8 }, verdict],
    ['flag absent', review, { ...verdict, no_further_review: undefined }],
    ['missed carries a change', review, { ...verdict, missed: readFix('verdict-round1.json').missed }],
    ['rating 7', { ...review, plan_rating: 7 }, verdict],
  ];
  for (const [label, rv, vd] of negatives) {
    runId = newPlanRun();
    runReviewRound(runId, PLAN_BODY, rv);
    run = plan.applyVerdict(HOME, runId, 1, PLAN_REVISED, vd);
    assert.equal(run.status, 'continue', label);
    assert.equal(run.rounds[0].agreed, false, label);
  }
  // unchanged text with the flag stops on rating, not agreed (run 623eb867 once its bogus change field is dropped)
  runId = newPlanRun();
  runReviewRound(runId, PLAN_BODY, { ...review, plan_rating: 9 });
  assert.equal(plan.applyVerdict(HOME, runId, 1, PLAN_BODY, { ...readFix('verdict-round1-nochange.json'), no_further_review: true }).stopReason, 'rating');
  // round three reports round_limit even when both sides agree
  runId = newPlanRun();
  runReviewRound(runId, PLAN_BODY, round1);
  plan.applyVerdict(HOME, runId, 1, PLAN_REVISED, readFix('verdict-round1.json'));
  runReviewRound(runId, PLAN_REVISED, readFix('plan-review-round2.json'));
  run = plan.applyVerdict(HOME, runId, 2, `${PLAN_REVISED}\nmore\n`, readFix('verdict-round2.json'));
  assert.equal(run.status, 'continue');
  runReviewRound(runId, `${PLAN_REVISED}\nmore\n`, { ...readFix('plan-review-round2.json'), round: 3, contests: [] });
  run = plan.applyVerdict(HOME, runId, 3, `${PLAN_REVISED}\nmore, and more\n`, { ...readFix('verdict-round2.json'), no_further_review: true });
  assert.equal(run.stopReason, 'round_limit');
  assert.equal(run.rounds[2].agreed, true);
  assert.match(common.validateVerdictDoc({ ...readFix('verdict-round2.json'), no_further_review: 'yes' }, { findingIds: [] }).errors.join(), /no_further_review must be a boolean/);
});

test('reviewer failure, single retry, stale attempt rejection, worker conflict, dead worker, failed-review warning receipt', () => {
  for (const status of ['new', 'preflight_failed']) {
    const id = newPlanRun();
    common.updateRun(HOME, id, r => { r.status = status; return r; });
    assert.throws(() => plan.finishPlan(HOME, id, { body: PLAN_BODY }), /finish requires a stopped review/);
    assert.equal(common.loadRun(HOME, id).plan.receipt, null);
  }
  const runId = newPlanRun();
  plan.startRound(HOME, runId, PLAN_BODY);
  plan.startAttempt(HOME, runId, REVIEWER);
  let loc = attemptRelayDir(runId);
  // running attempt blocks a second one
  assert.throws(() => plan.startAttempt(HOME, runId, REVIEWER), /still running/);
  writeRelayResult(loc.relayDir, { status: 'failed', extra: { error: 'boom' } });
  let run = plan.ingestPlanReview(HOME, runId, 1, 1, loc.relayDir, { exitCode: 1 });
  assert.equal(run.status, 'review_failed');
  assert.equal(run.rounds[0].attempts[0].failure, 'relay');
  assert.throws(() => plan.ingestPlanReview(HOME, runId, 1, 1, loc.relayDir), /already failed/);
  plan.startAttempt(HOME, runId, REVIEWER, { retry: true });
  assert.throws(() => plan.ingestPlanReview(HOME, runId, 1, 1, loc.relayDir), /stale update/);
  loc = attemptRelayDir(runId);
  assert.equal(loc.attempt, 2);
  // dead worker becomes failed through wait
  plan.setAttemptPid(HOME, runId, 1, 2, 2147483000);
  run = plan.waitForRun(HOME, runId, 100);
  assert.equal(run.rounds[0].attempts[1].failure, 'worker_died');
  assert.equal(run.status, 'stopped');
  assert.equal(run.stopReason, 'reviewer_failed');
  assert.throws(() => plan.startAttempt(HOME, runId, REVIEWER, { retry: true }), /already used its single retry|no failed attempt/);
  assert.throws(() => plan.finishPlan(HOME, runId, { body: PLAN_BODY }), /stop and ask the user/);
  const report = path.join(SCRATCH, 'self-review.md');
  fs.writeFileSync(report, 'Inspected the snapshot; independent review unavailable.');
  const finished = plan.finishPlan(HOME, runId, { body: PLAN_BODY, selfReview: report, reason: 'user authorized: do the review yourself' });
  assert.equal(finished.outcome, 'failed');
  assert.match(finished.reviewSection, /WARNING: this plan did not receive a successful review/);
  const generation = common.loadSession(HOME, SEAT, SESSION) ? common.loadSession(HOME, SEAT, SESSION).generation : 0;
  const check = plan.checkReceipt(common.loadRun(HOME, runId), { seat: SEAT, sessionId: SESSION, generation, planText: finished.finishedBody });
  assert.equal(check.ok, true);
  assert.match(check.warning, /outcome failed/);
  const legacy = common.loadRun(HOME, runId);
  delete legacy.selfReview;
  assert.equal(plan.checkReceipt(legacy, { seat: SEAT, sessionId: SESSION, generation, planText: finished.finishedBody }).ok, false);
  assert.equal(plan.finishPlan(HOME, runId).restamp, true);
});

test('self-review recording is idempotent: a finish that fails after recording is re-run without a duplicate recovery', () => {
  const runId = newPlanRun();
  plan.startRound(HOME, runId, PLAN_BODY);
  for (let n = 1; n <= 2; n++) {
    plan.startAttempt(HOME, runId, REVIEWER, { retry: n === 2 });
    const loc = attemptRelayDir(runId);
    writeRelayResult(loc.relayDir, { status: 'failed' });
    plan.ingestPlanReview(HOME, runId, 1, n, loc.relayDir);
  }
  const report = path.join(SCRATCH, 'idempotent-self-review.md');
  fs.writeFileSync(report, 'Inspected the snapshot; independent review unavailable.');
  const opts = { selfReview: report, reason: 'user authorized: review it yourself' };
  assert.throws(() => plan.finishPlan(HOME, runId, { body: PLAN_REVISED, ...opts }), /snapshot differs/);
  assert.equal(common.loadRun(HOME, runId).recoveries.length, 1);
  const fin = plan.finishPlan(HOME, runId, { body: PLAN_BODY, ...opts });
  assert.equal(fin.outcome, 'failed');
  assert.equal(common.loadRun(HOME, runId).recoveries.length, 1);
  assert.match(fin.reviewSection, /Self-review report:/);
});

test('rate-limited reviewer spends the automatic retry immediately: stopped, retry refused, warning names the reset hint, authorized resume allowed', () => {
  const runId = newPlanRun();
  plan.startRound(HOME, runId, PLAN_BODY);
  plan.startAttempt(HOME, runId, REVIEWER);
  const loc = attemptRelayDir(runId);
  writeRelayResult(loc.relayDir, { status: 'failed', extra: { finalMessage: "You've hit your usage limit. Resets at 3pm (UTC)" } });
  const run = plan.ingestPlanReview(HOME, runId, 1, 1, loc.relayDir);
  assert.equal(run.status, 'stopped');
  assert.equal(run.stopReason, 'reviewer_failed');
  assert.equal(run.retryUsed, true);
  assert.equal(run.rounds[0].attempts.length, 1);
  assert.match(run.warnings.join(' '), /automatic retry skipped: reviewer is rate limited \([^)]*3pm/);
  assert.equal(plan.reviewDoc(run).retryAvailable, false);
  assert.equal(plan.reviewDoc(run).needsUserDecision, true);
  assert.throws(() => plan.startAttempt(HOME, runId, REVIEWER, { retry: true }), /no failed attempt to retry/);
  assert.equal(cli('plan', ['review', '--run', runId, '--retry']).status, 2);
  plan.startAttempt(HOME, runId, REVIEWER, { resume: { seat: SEAT, session: SESSION, reason: 'user authorized: try again after the reset' } });
  assert.equal(common.loadRun(HOME, runId).rounds[0].attempts.length, 2);
  // the code side shares the policy
  const repo = makeRepo();
  const b = cli('code', ['begin', '--seat', 'codex', '--session', 'rate-code', '--cwd', repo]).json;
  fs.writeFileSync(path.join(repo, 'c.txt'), 'c\n');
  commitAll(repo, 'feat: c');
  startCodeRoundAndAttempt(b.runId);
  const at = common.loadRun(HOME, b.runId).rounds[0].attempts[0];
  const dir = path.join(common.runDir(HOME, b.runId), at.dir, 'backend');
  writeRelayResult(path.join(dir, 'debate'), { status: 'failed', extra: { finalMessage: 'Rate limit exceeded; resets tomorrow' } });
  const failed = code.ingestCodeReview(HOME, b.runId, 1, 1, dir, { exitCode: 0 });
  assert.equal(failed.status, 'stopped');
  assert.equal(failed.retryUsed, true);
  assert.match(failed.warnings.join(' '), /rate limited \([^)]*tomorrow/);
  assert.throws(() => code.startCodeAttempt(HOME, b.runId, { retry: true }), /retry|no failed attempt/);
});

test('tripwire coverage: violations reject, Codex uses sandbox, other missing reports warn; bad JSON and nonzero exits fail', () => {
  const cases = [[true, 'failed', /read-only violation/], [false, 'completed', null], [null, 'completed', null], [undefined, 'completed', null]];
  for (const [violation, expected, note] of cases) {
    const runId = newPlanRun();
    const run = runReviewRound(runId, PLAN_BODY, readFix('plan-review-round1.json'), { readOnlyViolation: violation });
    const attempt = run.rounds[0].attempts[0];
    assert.equal(attempt.status, expected, String(violation));
    if (note) assert.match([attempt.error, ...attempt.warnings].join(' '), note);
    if (violation == null) {
      assert.equal(attempt.coverage, 'sandbox');
      assert.equal(attempt.warnings.some(w => /coverage/.test(w)), false);
      for (const implementer of ['claude', 'opencode']) {
        const other = newPlanRun();
        plan.startRound(HOME, other, PLAN_BODY);
        plan.startAttempt(HOME, other, { ...REVIEWER, implementer });
        const loc = attemptRelayDir(other);
        writeRelayResult(loc.relayDir, { doc: readFix('plan-review-round1.json'), readOnlyViolation: violation });
        const at = plan.ingestPlanReview(HOME, other, 1, 1, loc.relayDir, { exitCode: 0 }).rounds[0].attempts[0];
        assert.equal(at.status, 'completed');
        assert.match(at.warnings.join(' '), violation === null ? /incomplete/ : /unreported/);
      }
    }
  }
  const runId = newPlanRun();
  plan.startRound(HOME, runId, PLAN_BODY);
  plan.startAttempt(HOME, runId, REVIEWER);
  const { relayDir } = attemptRelayDir(runId);
  fs.mkdirSync(relayDir, { recursive: true });
  fs.writeFileSync(path.join(relayDir, 'result.json'), JSON.stringify({ status: 'completed', finalMessage: 'no json here' }));
  const run = plan.ingestPlanReview(HOME, runId, 1, 1, relayDir, { exitCode: 0 });
  assert.equal(run.rounds[0].attempts[0].failure, 'bad_output');
  assert.equal(run.rounds[0].attempts[0].failureDetails.finalMessage, 'no json here');
  const nonzero = newPlanRun();
  plan.startRound(HOME, nonzero, PLAN_BODY);
  plan.startAttempt(HOME, nonzero, REVIEWER);
  const loc = attemptRelayDir(nonzero);
  writeRelayResult(loc.relayDir, { doc: readFix('plan-review-round1.json') });
  const failed = plan.ingestPlanReview(HOME, nonzero, 1, 1, loc.relayDir, { exitCode: 7 });
  assert.equal(failed.status, 'review_failed');
  assert.equal(failed.rounds[0].review, null);
  assert.match(failed.rounds[0].attempts[0].error, /exited 7/);
});

test('CLI: detached review persists stdin input before the worker starts, wait observes the unavailable relay, retry is allowed once', () => {
  const started = cli('plan', ['review', '--new', '--seat', 'claude', '--session', 'sess-cli-1', '--cwd', SCRATCH, '--plan', '-', '--detach', '--timeout', '1m'], { input: PLAN_BODY });
  assert.equal(started.status, 0, started.stderr);
  assert.equal(started.json.status, 'running', JSON.stringify(started.json));
  const runId = started.json.runId;
  assert.equal(fs.readFileSync(path.join(HOME, 'runs', runId, 'plan-input.md'), 'utf8'), PLAN_BODY);
  assert.equal(fs.readFileSync(path.join(HOME, 'runs', runId, 'round-1', 'plan.md'), 'utf8'), PLAN_BODY);
  let waited;
  for (let i = 0; i < 20; i++) { waited = cli('plan', ['wait', '--run', runId, '--max-wait', '3s']); if (waited.json.status !== 'running') break; }
  assert.equal(waited.json.status, 'failed', JSON.stringify(waited.json));
  assert.match(waited.json.error, /unavailable|relay/);
  assert.equal(waited.json.retryAvailable, true);
  const conflict = cli('plan', ['review', '--run', runId, '--plan', '-'], { input: PLAN_BODY });
  assert.equal(conflict.status, 2);
  const retry = cli('plan', ['review', '--run', runId, '--retry']);
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(retry.json.attempt, 2);
  assert.equal(retry.json.status, 'failed');
  assert.equal(retry.json.runStatus, 'stopped');
  const again = cli('plan', ['review', '--run', runId, '--retry']);
  const unauthorized = cli('plan', ['resume', '--run', runId, '--seat', 'claude', '--session', 'sess-cli-1']);
  assert.equal(unauthorized.status, 2);
  const resumed = cli('plan', ['resume', '--run', runId, '--seat', 'claude', '--session', 'sess-cli-1', '--reason', 'user authorized: retry the original reviewer']);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(resumed.json.attempt, 3);
  assert.equal(resumed.json.needsUserDecision, true);
  assert.equal(resumed.json.retryAvailable, false);
  assert.equal(resumed.json.failureDetails.failureClass, 'cli_unavailable');
  assert.equal(again.status, 2);
  const stats = cli('plan', ['stats', '--kind', 'plan']);
  assert.equal(stats.status, 0);
  assert.equal(typeof stats.json.summary.runs, 'number');
});

test('CLI: usage errors exit 2 with JSON; unknown run rejected; path traversal rejected', () => {
  assert.equal(cli('plan', ['review', '--new']).status, 2);
  assert.equal(cli('plan', ['wait', '--run', '../../etc']).status, 2);
  assert.equal(cli('code', ['finish', '--run', '11111111-1111-4111-8111-111111111111']).status, 2);
  const bad = cli('code', ['begin', '--seat', 'other', '--session', 's', '--cwd', SCRATCH]);
  assert.equal(bad.status, 2);
  assert.equal(bad.json.error.code, 'usage');
});

// ---------- hooks: plan side ----------

test('hooks bypass: child, subagent, DEBATE=off, off file, invalid session', () => {
  const repo = makeRepo();
  const p = hookPayload('sess-h0', repo);
  assert.equal(hook('claude', 'Stop', p, { env: { DEBATE_CHILD: '1' } }).note, 'child session');
  assert.equal(hook('claude', 'Stop', p, { env: { DEBATE: 'off' } }).note, 'automation off');
  assert.equal(hook('claude', 'Stop', { ...p, agent_id: 'a1' }).note, 'subagent');
  assert.equal(hook('codex', 'Stop', { ...p, subagent: { id: 'x' } }).note, 'subagent');
  assert.match(hook('claude', 'Stop', { ...p, session_id: '../x' }).note, /session_id/);
  fs.writeFileSync(path.join(HOME, 'off'), '');
  assert.equal(hook('claude', 'Stop', p).note, 'automation off');
  fs.unlinkSync(path.join(HOME, 'off'));
});

test('Claude UserPromptSubmit reminders: plan mode, owned active candidate, unrelated prompt; Codex always injects', () => {
  const repo = makeRepo();
  const sid = 'sess-prompt-1';
  const r1 = hook('claude', 'UserPromptSubmit', hookPayload(sid, repo, { permission_mode: 'plan', prompt: 'x' }));
  assert.match(r1.output.hookSpecificOutput.additionalContext, /debate-plan:/);
  assert.match(r1.output.hookSpecificOutput.additionalContext, new RegExp(sid));
  assert.equal(hook('claude', 'UserPromptSubmit', hookPayload(sid, repo, { permission_mode: 'default', prompt: 'x' })).output, null);
  const begun = cli('code', ['begin', '--seat', 'claude', '--session', sid, '--cwd', repo]);
  assert.equal(begun.json.ok, true, begun.stdout);
  const r3 = hook('claude', 'UserPromptSubmit', hookPayload(sid, repo, { permission_mode: 'default', prompt: 'x' }));
  assert.match(r3.output.hookSpecificOutput.additionalContext, /debate-code:/);
  assert.match(r3.output.hookSpecificOutput.additionalContext, new RegExp(begun.json.runId));
  assert.equal(hook('claude', 'UserPromptSubmit', hookPayload('sess-prompt-other', repo, { permission_mode: 'default', prompt: 'x' })).output, null);
  assert.match(hook('codex', 'UserPromptSubmit', hookPayload('sess-prompt-c', repo, { permission_mode: 'default', prompt: 'x' })).output.hookSpecificOutput.additionalContext, /debate-code:/);
  assert.match(hook('codex', 'UserPromptSubmit', hookPayload('sess-prompt-c', repo, { permission_mode: 'plan', prompt: 'x' })).output.hookSpecificOutput.additionalContext, /debate-plan:/);
  assert.equal(common.loadSession(HOME, 'codex', 'sess-prompt-c').generation, 2);
});

test('ExitPlanMode gate: deny without run, pass after finish, deny after a new prompt with re-stamp hint, pass after re-stamp, deny on change, third denial stays denied', () => {
  const sid = 'sess-exit-1';
  const repo = makeRepo();
  let planFile = path.join(SCRATCH, 'plan-exit.md');
  fs.writeFileSync(planFile, PLAN_BODY);
  const transcript = path.join(SCRATCH, 'transcript-exit.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'attachment', attachment: { type: 'plan_mode', planFilePath: planFile } })}\n`);
  const payload = (extra = {}) => ({ session_id: sid, cwd: repo, transcript_path: transcript, permission_mode: 'plan', tool_name: 'ExitPlanMode', tool_input: {}, ...extra });
  hook('claude', 'UserPromptSubmit', payload({ prompt: 'plan it' }));
  let r = hook('claude', 'PreToolUse', payload());
  assert.equal(r.output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.output.hookSpecificOutput.permissionDecisionReason, /no debate-plan run/);
  const runId = newPlanRun({ sessionId: sid, sourcePath: planFile, origin: 'file' });
  common.updateSession(HOME, SEAT, sid, (s) => { s.planRuns.push(runId); return s; });
  runReviewRound(runId, PLAN_BODY, readFix('plan-review-round1.json'));
  plan.applyVerdict(HOME, runId, 1, PLAN_BODY, readFix('verdict-round1-nochange.json'));
  r = hook('claude', 'PreToolUse', payload());
  assert.match(r.output.hookSpecificOutput.permissionDecisionReason, /finish it first/);
  planFile = path.join(SCRATCH, 'plan-exit-relocated.md');
  plan.finishPlan(HOME, runId, { body: PLAN_BODY, sourcePath: planFile });
  assert.equal(common.loadRun(HOME, runId).plan.sourcePath, planFile);
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'attachment', attachment: { type: 'plan_mode', planFilePath: planFile } })}\n`);
  assert.equal(hook('claude', 'PreToolUse', payload()).output, null);
  hook('claude', 'UserPromptSubmit', payload({ prompt: 'unrelated' }));
  r = hook('claude', 'PreToolUse', payload());
  assert.equal(r.output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.output.hookSpecificOutput.permissionDecisionReason, /generation/);
  assert.match(r.output.hookSpecificOutput.permissionDecisionReason, new RegExp(`finish --run`));
  assert.equal(cli('plan', ['finish', '--run', runId]).json.restamp, true);
  assert.equal(hook('claude', 'PreToolUse', payload()).output, null);
  fs.appendFileSync(planFile, '\nlate edit\n');
  r = hook('claude', 'PreToolUse', payload());
  assert.match(r.output.hookSpecificOutput.permissionDecisionReason, /differs from the finished receipt/);
  const third = hook('claude', 'PreToolUse', payload());
  assert.equal(third.output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(third.output.hookSpecificOutput.permissionDecisionReason, /DEBATE=off/);
  // a transcript naming a different plan file denies
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'attachment', attachment: { type: 'plan_mode', planFilePath: path.join(SCRATCH, 'other-plan.md') } })}\n`);
  hook('claude', 'UserPromptSubmit', payload({ prompt: 'again' }));
  cli('plan', ['finish', '--run', runId, '--plan', planFile]);
  assert.match(hook('claude', 'PreToolUse', payload()).output.hookSpecificOutput.permissionDecisionReason, /current plan file/);
});

test('Codex Stop plan gate: no proposed_plan passes, missing block blocks once, valid finished block passes, code route otherwise', () => {
  const sid = 'sess-codex-plan';
  const repo = makeRepo();
  hook('codex', 'UserPromptSubmit', hookPayload(sid, repo, { permission_mode: 'plan', prompt: 'p' }));
  const base = hookPayload(sid, repo, { permission_mode: 'plan', stop_hook_active: false });
  assert.equal(hook('codex', 'Stop', { ...base, last_assistant_message: 'just research, no plan' }).output, null);
  let r = hook('codex', 'Stop', { ...base, last_assistant_message: `<proposed_plan>\n${PLAN_BODY}</proposed_plan>` });
  assert.equal(r.output.decision, 'block');
  assert.match(r.output.reason, /review block/);
  assert.equal(hook('codex', 'Stop', { ...base, stop_hook_active: true, last_assistant_message: `<proposed_plan>\n${PLAN_BODY}</proposed_plan>` }).output, null);
  const twice = `<proposed_plan>\na\n</proposed_plan>\n<proposed_plan>\nb\n</proposed_plan>`;
  assert.match(hook('codex', 'Stop', { ...base, last_assistant_message: twice }).output.reason, /exactly one proposed_plan/);
  const runId = newPlanRun({ seat: 'codex', sessionId: sid, cwd: repo });
  runReviewRound(runId, PLAN_BODY, readFix('plan-review-round1.json'));
  plan.applyVerdict(HOME, runId, 1, PLAN_BODY, readFix('verdict-round1-nochange.json'));
  const finished = cli('plan', ['finish', '--run', runId, '--plan', '-'], { input: PLAN_BODY }).json;
  const message = `Here is the plan.\n<proposed_plan>\n${finished.finishedBody}\n</proposed_plan>\n`;
  assert.equal(hook('codex', 'Stop', { ...base, last_assistant_message: message }).output, null);
  assert.match(hook('codex', 'Stop', { ...base, last_assistant_message: message.replace('Step 1', 'Step X') }).output.reason, /differs/);
  // Claude plan-mode Stop is not a gate; non-plan Stop routes to code
  assert.match(hook('claude', 'Stop', hookPayload(sid, repo, { permission_mode: 'plan' })).note, /ExitPlanMode/);
  assert.equal(hook('claude', 'Stop', hookPayload(sid, repo, { permission_mode: 'default' })).output.decision, 'block');
});

// ---------- hooks: code side ----------

test('code Stop: no baseline blocks (dirty and clean) without registering; explicit baseline audited; dirty-at-start passes until an edit', () => {
  const repo = makeRepo();
  const sid = 'sess-stop-1';
  const p = hookPayload(sid, repo);
  let r = hook('claude', 'Stop', p);
  assert.equal(r.output.decision, 'block');
  assert.match(r.output.reason, /no session baseline/);
  const baselineOf = () => { const l = common.loadLedger(HOME, common.repoIdentity(repo).repoKey); return l ? l.baselines[common.sessionKey('claude', sid)] : undefined; };
  assert.equal(baselineOf(), undefined);
  fs.writeFileSync(path.join(repo, 'dirty.txt'), 'x');
  r = hook('claude', 'Stop', p);
  assert.match(r.output.reason, /no session baseline/);
  assert.equal(baselineOf(), undefined);
  // explicit baseline at HEAD while the worktree is dirty: audited, and nothing changes afterwards → pass
  const head = gitc(repo, 'rev-parse', 'HEAD');
  const bl = cli('code', ['baseline', '--seat', 'claude', '--session', sid, '--cwd', repo, '--base', head, '--reason', 'dirty.txt predates this session']);
  assert.equal(bl.json.ok, true, bl.stdout);
  assert.ok(common.readStats(HOME).some(row => row.recordType === 'audit' && row.type === 'baseline_registered' && row.eventId === bl.json.baseline.eventId));
  assert.equal(hook('claude', 'Stop', p).output, null);
  const before = fs.statSync(path.join(repo, 'dirty.txt'));
  fs.writeFileSync(path.join(repo, 'dirty.txt'), 'changed');
  assert.match(hook('claude', 'Stop', p).output.reason, /work changed since the session baseline/);
  // an untracked file counts by size and mtime, so a true revert restores both
  fs.writeFileSync(path.join(repo, 'dirty.txt'), 'x');
  fs.utimesSync(path.join(repo, 'dirty.txt'), before.atimeMs / 1000, before.mtimeMs / 1000);
  assert.equal(hook('claude', 'Stop', p).output, null);
  // SessionStart records a baseline once for a fresh session even when the tree is dirty
  const sid2 = 'sess-stop-2';
  hook('claude', 'SessionStart', hookPayload(sid2, repo, { source: 'startup' }));
  assert.equal(hook('claude', 'Stop', hookPayload(sid2, repo)).output, null);
  fs.writeFileSync(path.join(repo, 'app.py'), 'edited\n');
  assert.equal(hook('claude', 'Stop', hookPayload(sid2, repo)).output.decision, 'block');
  gitc(repo, 'checkout', '--', 'app.py');
  assert.equal(hook('claude', 'Stop', hookPayload(sid2, repo)).output, null);
  hook('claude', 'SessionStart', hookPayload(sid2, repo, { source: 'resume' }));
  assert.equal(common.loadLedger(HOME, common.repoIdentity(repo).repoKey).baselines[common.sessionKey('claude', sid2)].source, 'session_start');
  // outside a repository the Stop passes
  assert.equal(hook('claude', 'Stop', hookPayload(sid2, SCRATCH)).output, null);
});

test('code Stop reports an active review instead of suggesting a duplicate candidate or deferral', () => {
  const repo = makeRepo();
  const sid = 'sess-active-review';
  hook('claude', 'SessionStart', hookPayload(sid, repo));
  const begun = cli('code', ['begin', '--seat', 'claude', '--session', sid, '--cwd', repo]).json;
  fs.writeFileSync(path.join(repo, 'active.txt'), 'review me\n');
  commitAll(repo, 'feat: active review');
  startCodeRoundAndAttempt(begun.runId);
  common.updateRun(HOME, begun.runId, (run) => { run.rounds[0].attempts[0].pid = process.pid; return run; });
  let result = hook('claude', 'Stop', hookPayload(sid, repo));
  assert.equal(result.output.decision, 'block');
  assert.equal(result.note, 'blocked: review running');
  assert.match(result.output.reason, /review attempt running in the background/);
  assert.doesNotMatch(result.output.reason, /begin/);
  assert.match(result.output.reason, /do not .*defer/);

  common.updateRun(HOME, begun.runId, (run) => {
    run.status = 'awaiting_verdict';
    run.rounds[0].attempts[0].status = 'completed';
    return run;
  });
  result = hook('claude', 'Stop', hookPayload(sid, repo));
  assert.equal(result.note, 'blocked: verdict required');
  assert.match(result.output.reason, /awaiting a verdict/);
});

test('deferral sequence: block, defer, stop_hook_active consumes, next prompt, unreviewed Stop blocks again', () => {
  const repo = makeRepo();
  const sid = 'sess-defer';
  hook('claude', 'SessionStart', hookPayload(sid, repo));
  hook('claude', 'UserPromptSubmit', hookPayload(sid, repo, { prompt: 'do it' }));
  fs.writeFileSync(path.join(repo, 'new.txt'), 'work');
  assert.equal(hook('claude', 'Stop', hookPayload(sid, repo)).output.decision, 'block');
  const d = cli('code', ['defer', '--seat', 'claude', '--session', sid, '--cwd', repo, '--reason', 'need an answer']);
  assert.equal(d.json.ok, true, d.stdout);
  const consumed = hook('claude', 'Stop', hookPayload(sid, repo, { stop_hook_active: true }));
  assert.equal(consumed.output, null);
  assert.equal(consumed.note, 'deferral consumed');
  assert.equal(hook('claude', 'Stop', hookPayload(sid, repo, { stop_hook_active: true })).note, 'stop_hook_active: already blocked this turn');
  hook('claude', 'UserPromptSubmit', hookPayload(sid, repo, { prompt: 'answer' }));
  assert.equal(hook('claude', 'Stop', hookPayload(sid, repo)).output.decision, 'block');
  // a stale deferral from an older generation is never consumed
  cli('code', ['defer', '--seat', 'claude', '--session', sid, '--cwd', repo, '--reason', 'again']);
  hook('claude', 'UserPromptSubmit', hookPayload(sid, repo, { prompt: 'next' }));
  assert.equal(hook('claude', 'Stop', hookPayload(sid, repo)).output.decision, 'block');
});

test('git gate: silent without candidate, first commit allowed, second denied, amend allowed, composed cd/-C, unsupported forms, harmless commands, competing session and separate worktree', () => {
  const repo = makeRepo();
  const other = makeRepo();
  const sid = 'sess-gate';
  const decide = (command, cwd = repo) => common.gitGateDecision({ command, cwd, home: HOME });
  assert.equal(decide('git commit -m "feat: x"').decision, 'pass');
  assert.equal(decide('git commit --amend --no-edit').decision, 'pass');
  assert.equal(decide('git push origin main').decision, 'deny');
  const commitForms = ['git commit -m "$(cat <<\'EOF\'\nfeat: x\nEOF\n)"', '(cd . && git commit -m "feat: x")', 'git commit -m "feat: $(date +%F)"', 'git commit -m "feat: retry push on 429 $(date +%F)"'];
  const optedOut = makeRepo();
  gitc(optedOut, 'config', 'debate.enabled', 'false');
  const unenrolled = makeRepo(undefined, { enrolled: false });
  for (const cwd of [repo, optedOut, unenrolled, SCRATCH]) {
    for (const command of commitForms) assert.equal(decide(command, cwd).decision, 'pass', command);
    for (const command of ['(git push origin main)', 'echo $(git push origin main)', 'echo "$(git push origin main)"', 'git push "unterminated']) assert.equal(decide(command, cwd).decision, 'deny', command);
    for (const command of ['git commit -m x && git push', '(git push origin main)']) {
      const denied = decide(command, cwd);
      assert.equal(denied.decision, 'deny');
      assert.match(denied.reason, /plain literal Git push/);
      assert.match(denied.reason, /when guards are active/i);
    }
    assert.equal(decide('echo "github pushed $(date)"', cwd).decision, 'pass');
  }
  const begun = cli('code', ['begin', '--seat', 'claude', '--session', sid, '--cwd', repo]).json;
  assert.equal(begun.ok, true);
  assert.equal(decide('git commit -m "feat: x"').decision, 'pass');
  for (const command of commitForms) assert.equal(decide(command).decision, 'deny', command);
  assert.equal(decide('echo "github pushed $(date)"').decision, 'pass');
  for (const flag of ['--no-verify', '-n']) assert.match(decide(`git commit ${flag} -m x`).reason, /bypasses project checks/);
  for (const form of ['(git push origin main)', 'echo $(git push origin main)', 'echo "$(git push origin main)"', '(git commit -m x)', 'echo $(git commit -m x)', 'git push "unterminated']) assert.equal(decide(form).decision, 'deny', form);
  assert.match(decide('git commit --amend --no-edit').reason, /must never be amended/);
  assert.equal(cli('code', ['begin', '--seat', 'codex', '--session', 'sess-other', '--cwd', repo]).json.status, 'candidate_busy');
  assert.equal(cli('code', ['begin', '--seat', 'claude', '--session', sid, '--cwd', repo]).json.status, 'candidate_busy');
  fs.writeFileSync(path.join(repo, 'feature.py'), 'x = 1\n');
  gitc(repo, 'add', '-A');
  gitc(repo, 'commit', '-q', '-m', 'feat: x');
  assert.match(decide('git commit -m "feat: y"').reason, /already has candidate/);
  assert.equal(decide('git commit --amend --no-edit').decision, 'pass');
  assert.equal(decide(`cd ${repo} && git commit --amend --no-edit`, SCRATCH).decision, 'pass');
  assert.equal(decide(`git -C ${path.basename(repo)} commit --amend --no-edit`, SCRATCH).decision, 'pass');
  assert.equal(decide(`cd ${path.dirname(repo)} && git -C ${path.basename(repo)} commit --amend --no-edit`, '/').decision, 'pass');
  assert.match(decide('git commit --amend -m "$(cat msg)"').reason, /unsupported commit form/);
  assert.match(decide('echo msg | git commit --amend -F -').reason, /pipeline/);
  assert.match(decide('GIT_DIR=/tmp/x git commit --amend --no-edit').reason, /GIT_\*/);
  assert.match(decide('git --git-dir=/tmp/x commit --amend --no-edit').reason, /--git-dir/);
  assert.match(decide('sudo git commit --amend --no-edit').reason, /wrapper/);
  for (const wrapped of [`bash -c 'git commit --amend --no-edit'`, `sh -lc "git push origin main"`, `env bash -c 'git push origin main'`, `eval "git commit --amend --no-edit"`, `sudo sh -c 'cd /tmp && git push'`]) assert.match(decide(wrapped).reason ?? '', /wrapper/, wrapped);
  assert.equal(decide(`timeout 5 grep "git push" README.md`).decision, 'pass');
  for (const flag of ['--no-verify', '-n']) assert.equal(decide(`git commit --amend ${flag} --no-edit`).decision, 'deny');
  for (const flag of ['-c core.hooksPath=/tmp', '--config-env=core.hooksPath=HOOKS', '--namespace=other', '--exec-path=/tmp']) assert.equal(decide(`git ${flag} commit --amend --no-edit`).decision, 'deny');
  assert.match(decide('git commit --amend --no-edit && git commit -m "b"').reason, /only one Git commit/);
  assert.match(decide('git commit --amend --no-edit; git push origin main').reason, /only Git mutation/);
  assert.equal(decide('echo git commit').decision, 'pass');
  assert.equal(decide('git log --grep=commit').decision, 'pass');
  assert.equal(decide('git status && ls').decision, 'pass');
  assert.equal(decide('git commit -m "feat: elsewhere"', other).decision, 'pass');
  assert.equal(decide(`cd - && git commit -m x`).decision, 'deny');
  // hook wrapper output shape (Claude and Codex argv form)
  const claudeDeny = hook('claude', 'PreToolUse', hookPayload(sid, repo, { tool_name: 'Bash', tool_input: { command: 'git commit -m "feat: again"' } }));
  assert.equal(claudeDeny.output.hookSpecificOutput.permissionDecision, 'deny');
  const codexDeny = hook('codex', 'PreToolUse', hookPayload(sid, repo, { tool_name: 'Bash', tool_input: { command: ['bash', '-lc', 'git commit -m "feat: again"'] } }));
  assert.equal(codexDeny.output.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(hook('claude', 'PreToolUse', hookPayload(sid, repo, { tool_name: 'Read', tool_input: {} })).output, null);
  // ordinary commit without begin: passes the gate, then Stop blocks it and explicit adoption enables review
  const sid3 = 'sess-adopt';
  hook('claude', 'SessionStart', hookPayload(sid3, other));
  fs.writeFileSync(path.join(other, 'b.txt'), 'b');
  gitc(other, 'add', '-A');
  gitc(other, 'commit', '-q', '-m', 'feat: b');
  assert.equal(hook('claude', 'Stop', hookPayload(sid3, other)).output.decision, 'block');
  const noEvidence = cli('code', ['begin', '--seat', 'claude', '--session', sid3, '--cwd', other, '--adopt']).json;
  assert.equal(noEvidence.status, 'missing_evidence');
  const adopted = cli('code', ['begin', '--seat', 'claude', '--session', sid3, '--cwd', other, '--adopt', '--base', gitc(other, 'rev-parse', 'HEAD~1'), '--reason', 'committed locally this session, never pushed']).json;
  assert.equal(adopted.ok, true, JSON.stringify(adopted));
  assert.equal(adopted.adopted, true);
  assert.equal(common.readStats(HOME).find(r => r.recordType === 'run' && r.runId === adopted.runId).adopted, true);
  assert.ok(common.readStats(HOME).some(r => r.recordType === 'audit' && r.type === 'candidate_adopted' && r.runId === adopted.runId));
  const run = common.loadRun(HOME, adopted.runId);
  const pre = code.codePreflight(HOME, run, { skipLanes: true });
  assert.equal(pre.ok, true, JSON.stringify(pre));
});

test('git gate heredocs: prose bodies with apostrophes and push: pass in both seats, a heredoc commit message is one commit mutation, a body fed to a shell is still parsed', () => {
  const repo = makeRepo();
  const decide = (command, cwd = repo) => common.gitGateDecision({ command, cwd, home: HOME });
  const python = "python3 - <<'PY'\nimport yaml\nprint(\"don't\")\nworkflow = '''on:\n  push:\n    branches: [main]\n'''\nPY\n";
  const verdict = "node debate-plan.mjs verdict --run x --round 1 --plan - <<'EOF'\n# Plan\nDon't git push origin main until the review passes.\nEOF\n";
  for (const cwd of [repo, SCRATCH]) for (const command of [python, verdict]) assert.equal(decide(command, cwd).decision, 'pass', command);
  assert.equal(hook('claude', 'PreToolUse', hookPayload('sess-heredoc', repo, { tool_name: 'Bash', tool_input: { command: python } })).output, null);
  assert.equal(hook('codex', 'PreToolUse', hookPayload('sess-heredoc', repo, { tool_name: 'Bash', tool_input: { command: ['bash', '-lc', verdict], workdir: repo } })).output, null);
  const commit = 'git commit -m "$(cat <<\'EOF\'\nfeat: heredoc message\n\nIt doesn\'t mention a push; well, it does now.\nEOF\n)"';
  const analysis = common.analyzeCommand(commit);
  assert.equal(analysis.error, null);
  assert.deepEqual(analysis.mutations.map(m => m.kind), ['commit']);
  assert.equal(decide(commit).decision, 'pass');
  assert.equal(common.analyzeCommand("cat <<EOF\nno terminator, with push and don't\n").error, null);
  assert.equal(common.analyzeCommand("cat <<-EOF\n\tbody's\n\tEOF\necho done").error, null);
  assert.equal(common.analyzeCommand('cat <<< "here string" && git status').mutations.length, 0);
  for (const command of ["bash <<'EOF'\ngit push origin main\nEOF\n", 'sh <<-EOF\n\tgit push origin main\n\tEOF\n', "sudo bash -s <<EOF\ngit push origin main\nEOF\n"]) assert.equal(decide(command).decision, 'deny', command);
});

test('adoption: parent mismatch, merge and root commits, multi-commit ancestor range, known publication', () => {
  const repo = makeRepo();
  const first = gitc(repo, 'rev-parse', 'HEAD');
  // root commit
  assert.equal(code.adoptionCheck(repo, { baseArg: null, reason: 'evidence' }).status, 'parent_mismatch');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a'); gitc(repo, 'add', '-A'); gitc(repo, 'commit', '-q', '-m', 'feat: a');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b'); gitc(repo, 'add', '-A'); gitc(repo, 'commit', '-q', '-m', 'feat: b');
  assert.equal(code.adoptionCheck(repo, { baseArg: null, reason: 'e' }).commitsInRange, 1);
  const range = code.adoptionCheck(repo, { baseArg: first, reason: 'e' });
  assert.equal(range.ok, false);
  assert.match(range.reason, /squash.*before begin/);
  const rejected = cli('code', ['begin', '--seat', 'claude', '--session', 'range-adopt', '--cwd', repo, '--adopt', '--base', first, '--reason', 'observed local commits']).json;
  assert.equal(rejected.status, 'unsupported_state');
  assert.equal(common.loadLedger(HOME, common.repoIdentity(repo).repoKey)?.active ?? null, null);
  gitc(repo, 'reset', '--soft', first);
  commitAll(repo, 'feat: squashed');
  const adopted = cli('code', ['begin', '--seat', 'claude', '--session', 'range-adopt', '--cwd', repo, '--adopt', '--base', first, '--reason', 'observed local commits']).json;
  assert.equal(adopted.ok, true);
  fs.appendFileSync(path.join(repo, 'a.txt'), ' fixed');
  assert.equal(common.gitGateDecision({ command: 'git commit --amend --no-edit', cwd: repo, home: HOME }).decision, 'pass');
  amendAll(repo);
  assert.equal(code.codePreflight(HOME, common.loadRun(HOME, adopted.runId), { skipLanes: true }).ok, true);
  assert.equal(cli('code', ['waive', '--run', adopted.runId, '--reason', 'user approved: test waiver']).json.outcome, 'waived');
  assert.equal(code.adoptionCheck(repo, { baseArg: 'HEAD', reason: 'e' }).status, 'parent_mismatch');
  gitc(repo, 'checkout', '-q', '-b', 'side', first);
  fs.writeFileSync(path.join(repo, 'c.txt'), 'c'); gitc(repo, 'add', '-A'); gitc(repo, 'commit', '-q', '-m', 'feat: c');
  gitc(repo, 'checkout', '-q', 'main');
  gitc(repo, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  assert.equal(code.adoptionCheck(repo, { baseArg: null, reason: 'e' }).status, 'parent_mismatch');
  assert.equal(code.adoptionCheck(repo, { baseArg: first, reason: 'e' }).status, 'unsupported_state');
  // publication: a commit reachable from a remote-tracking ref is refused (linear history)
  const linear = makeRepo();
  const root = gitc(linear, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(linear, 'a.txt'), 'a'); gitc(linear, 'add', '-A'); gitc(linear, 'commit', '-q', '-m', 'feat: a');
  const bare = path.join(SCRATCH, 'bare-pub.git');
  gitc(SCRATCH, 'init', '-q', '--bare', '-b', 'main', bare);
  gitc(linear, 'remote', 'add', 'origin', bare);
  gitc(linear, 'push', '-q', 'origin', 'main');
  fs.writeFileSync(path.join(linear, 'd.txt'), 'd'); gitc(linear, 'add', '-A'); gitc(linear, 'commit', '-q', '-m', 'feat: d');
  assert.equal(code.adoptionCheck(linear, { baseArg: null, reason: 'e' }).ok, true);
  assert.equal(code.adoptionCheck(linear, { baseArg: root, reason: 'e' }).status, 'unsupported_state');
  gitc(linear, 'push', '-q', 'origin', 'main');
  assert.equal(code.adoptionCheck(linear, { baseArg: null, reason: 'e' }).status, 'published');
});

// ---------- code workflow with backend fixtures ----------

function ingestFixture(runId, fixture, { exitCode = 0, mutate } = {}) {
  const run = common.loadRun(HOME, runId);
  const round = run.rounds[run.rounds.length - 1];
  const attempt = round.attempts[round.attempts.length - 1];
  const backendDir = path.join(common.runDir(HOME, runId), attempt.dir, 'backend');
  let doc = JSON.parse(JSON.stringify(readFix(fixture)));
  doc.base.sha = run.code.baseSha;
  doc.snapshotCommit = round.candidateCommit;
  if (mutate) doc = mutate(doc) || doc;
  fs.mkdirSync(backendDir, { recursive: true });
  fs.writeFileSync(path.join(backendDir, 'run.json'), JSON.stringify(doc));
  for (const stage of ['main', 'debate', 'final']) {
    if (!doc.stages[stage]) continue;
    const dir = path.join(backendDir, stage);
    fs.mkdirSync(dir, { recursive: true });
    const isMain = stage !== 'debate';
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(isMain ? { status: 'completed', threadId: `t-${stage}`, model: 'model-a', effort: 'medium', eventsPath: path.join(dir, 'events.jsonl') } : { status: 'completed', sessionId: 's-debate', cost: 0.5, readOnlyViolation: null }));
    if (isMain) fs.writeFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 500, cached_input_tokens: 100, cache_write_input_tokens: 0, output_tokens: 20 } })}\n`);
  }
  return code.ingestCodeReview(HOME, runId, round.round, attempt.attempt, backendDir, { exitCode, seconds: 12 });
}
function startCodeRoundAndAttempt(runId, opts = {}) {
  const run = common.loadRun(HOME, runId);
  const pre = code.codePreflight(HOME, run, { skipLanes: true });
  assert.equal(pre.ok, true, JSON.stringify(pre));
  if (!opts.retry) code.startCodeRound(HOME, runId, pre);
  code.startCodeAttempt(HOME, runId, { retry: opts.retry === true });
  return pre;
}
let fakeCli = null;
/** A copy of the skill whose `review` command writes a fixture backend run instead of calling models. */
function fakeBackendCli() {
  if (fakeCli) return fakeCli;
  const copy = path.join(SCRATCH, 'fake-backend', 'debate');
  fs.cpSync(SKILL, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'scripts', 'review.mjs'), `
    import fs from 'node:fs';
    import path from 'node:path';
    export async function main(argv) {
      const run = JSON.parse(fs.readFileSync(process.env.TEST_RUN_FILE, 'utf8'));
      const doc = JSON.parse(fs.readFileSync(process.env.TEST_BACKEND_FIXTURE, 'utf8'));
      doc.base.sha = run.code.baseSha;
      doc.snapshotCommit = run.rounds.at(-1).candidateCommit;
      const out = argv[argv.indexOf('--out-dir') + 1];
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'run.json'), JSON.stringify(doc));
    }
  `);
  fakeCli = path.join(copy, 'scripts', 'debate.mjs');
  return fakeCli;
}
function commitAll(repo, message) { gitc(repo, 'add', '-A'); gitc(repo, 'commit', '-q', '-m', message); return gitc(repo, 'rev-parse', 'HEAD'); }
function amendAll(repo) { gitc(repo, 'add', '-A'); gitc(repo, 'commit', '-q', '--amend', '--no-edit'); return gitc(repo, 'rev-parse', 'HEAD'); }
const CODE_SID = 'sess-code-1';

test('completed relay with no parsed debate stage is a diagnosed bad-output failure, not successful coverage', () => {
  const repo = makeRepo();
  const runId = cli('code', ['begin', '--seat', 'codex', '--session', 'parse-failure', '--cwd', repo]).json.runId;
  fs.writeFileSync(path.join(repo, 'change.txt'), 'candidate\n');
  commitAll(repo, 'feat: candidate');
  startCodeRoundAndAttempt(runId);
  const run = common.loadRun(HOME, runId);
  const attempt = run.rounds[0].attempts[0];
  const dir = path.join(common.runDir(HOME, runId), attempt.dir, 'backend');
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ stages: { main: { doc: { findings: [] } } } }));
  writeRelayResult(path.join(dir, 'main'), { status: 'completed' });
  writeRelayResult(path.join(dir, 'debate'), { status: 'completed', extra: { finalMessage: 'Let me inspect that in a scratch directory.' } });
  const failed = code.ingestCodeReview(HOME, runId, 1, 1, dir, { exitCode: 1, stderrTail: 'external_directory permission denied; implementer returned no parseable JSON block' });
  assert.equal(failed.rounds[0].review, null);
  assert.equal(failed.rounds[0].attempts[0].failure, 'bad_output');
  const details = code.codeDoc(failed).failureDetails;
  assert.equal(details.stage, 'debate');
  assert.equal(details.failureClass, 'bad_output');
  assert.match(details.finalMessage, /scratch directory/);
  assert.match(details.stderrTail, /permission denied/);
});

test('code recovery reports the failed stage, refuses changed candidates, and resumes without clearing history or minting a pass', () => {
  const repo = makeRepo();
  const sid = 'code-recovery';
  const runId = cli('code', ['begin', '--seat', 'codex', '--session', sid, '--cwd', repo]).json.runId;
  fs.writeFileSync(path.join(repo, 'change.txt'), 'candidate\n');
  commitAll(repo, 'feat: candidate');
  startCodeRoundAndAttempt(runId);
  const failBackend = () => {
    const r = common.loadRun(HOME, runId);
    const rd = r.rounds.at(-1), at = rd.attempts.at(-1);
    const dir = path.join(common.runDir(HOME, runId), at.dir, 'backend');
    writeRelayResult(path.join(dir, 'debate'), { status: 'failed', extra: { finalMessage: 'Service overloaded; try later', error: 'service busy' } });
    return code.ingestCodeReview(HOME, runId, rd.round, at.attempt, dir, { exitCode: 0 });
  };
  let run = failBackend();
  assert.equal(code.codeDoc(run).failureDetails.stage, 'debate');
  assert.equal(code.codeDoc(run).failureDetails.failureClass, 'service_error');
  assert.equal(run.rounds[0].review, null);
  code.startCodeAttempt(HOME, runId, { retry: true });
  common.updateRun(HOME, runId, r => { r.rounds[0].attempts.at(-1).pid = 2147483000; return r; });
  assert.equal(cli('code', ['wait', '--run', runId, '--max-wait', '1s']).json.status, 'failed');
  run = common.loadRun(HOME, runId);
  assert.equal(run.rounds[0].attempts.at(-1).failure, 'worker_died');
  assert.equal(code.codeDoc(run).needsUserDecision, true);
  assert.equal(cli('code', ['finish', '--run', runId]).status, 2);
  const auth = { seat: 'codex', session: sid, reason: 'user authorized: try the original reviewer again' };
  fs.writeFileSync(path.join(repo, 'junk'), 'dirty\n');
  assert.throws(() => code.startCodeAttempt(HOME, runId, { resume: auth }), /dirty/);
  fs.unlinkSync(path.join(repo, 'junk'));
  const report = path.join(SCRATCH, 'code-recovery-self.md');
  fs.writeFileSync(report, 'Checked exact candidate; no independent review was available.');
  const self = cli('code', ['finish', '--run', runId, '--self-review', report, '--reason', 'user authorized: inspect it yourself']).json;
  assert.equal(self.outcome, 'failed');
  assert.equal(self.candidateClosed, false);
  code.startCodeAttempt(HOME, runId, { resume: auth });
  run = ingestFixture(runId, 'backend-clean.json');
  assert.equal(run.status, 'awaiting_verdict');
  assert.equal(run.selfReview, undefined);
  assert.equal(run.rounds.length, 1);
  assert.equal(run.rounds[0].attempts.length, 3);
  assert.equal(run.retryUsed, true);
  assert.equal(run.recoveries.length, 2);
});

test('code workflow: begin, commit, review with findings (withdrawn retained), fix + amend, second round clean (omitted final), finish passed, baseline advances, next task begins', () => {
  const repo = makeRepo();
  hook('claude', 'SessionStart', hookPayload(CODE_SID, repo));
  hook('claude', 'UserPromptSubmit', hookPayload(CODE_SID, repo, { prompt: 'implement' }));
  const begun = cli('code', ['begin', '--seat', 'claude', '--session', CODE_SID, '--cwd', repo]).json;
  assert.equal(begun.ok, true);
  const runId = begun.runId;
  // review before any commit is a preflight rejection that consumes nothing
  let pre = code.codePreflight(HOME, common.loadRun(HOME, runId), { skipLanes: true });
  assert.equal(pre.status, 'unsupported_state');
  assert.match(pre.reason, /no candidate commit/);
  fs.writeFileSync(path.join(repo, 'app.py'), 'def avg(items):\n    total = sum(items)\n    return total / len(items)\n\ndef neg(x):\n    return -x\n');
  const c1 = commitAll(repo, 'feat: neg');
  fs.writeFileSync(path.join(repo, 'scratch.txt'), 'dirty');
  pre = code.codePreflight(HOME, common.loadRun(HOME, runId), { skipLanes: true });
  assert.match(pre.reason, /not clean/);
  fs.unlinkSync(path.join(repo, 'scratch.txt'));
  startCodeRoundAndAttempt(runId);
  let run = ingestFixture(runId, 'backend-findings.json');
  assert.equal(run.status, 'awaiting_verdict', JSON.stringify(run.rounds[0].attempts[0]));
  assert.deepEqual(run.rounds[0].review.findings.map(f => [f.id, f.status, f.lane]), [['R1:F1', 'agreed', 'review-main'], ['R1:F2', 'withdrawn', 'review-main'], ['R1:D1', 'withdrawn', 'review-debate']]);
  assert.equal(run.rounds[0].attempts[0].agents.length, 3);
  assert.equal(run.rounds[0].attempts[0].agents[1].coverage, 'incomplete');
  assert.equal(run.rounds[0].attempts[0].agents[0].usage.input, 500);
  assert.equal(run.rounds[0].attempts[0].agents[0].coverage, 'sandbox');
  assert.equal(run.rounds[0].attempts[0].warnings.some(w => /unreported/.test(w)), false);
  for (const declaration of [{ fixed: true }, { change: 'guarded' }]) {
    const fake = { review_rating: 8, verdicts: run.rounds[0].review.findings.map(f => ({ id: f.id, verdict: f.id === 'R1:F1' ? 'confirm' : 'discard', reason: 'checked', evidence: 'app.py:3', ...(f.id === 'R1:F1' ? declaration : {}) })), contest_rulings: [], assumptions: [], missed: [], checks: [] };
    assert.throws(() => code.applyCodeVerdict(HOME, runId, 1, fake), /candidate tree is unchanged/);
    assert.equal(common.loadRun(HOME, runId).status, 'awaiting_verdict');
  }
  // verdict must cover withdrawn findings too
  const verdictFile = path.join(common.runDir(HOME, runId), 'verdict-1.json');
  fs.writeFileSync(verdictFile, JSON.stringify({ review_rating: 8, verdicts: [{ id: 'R1:F1', verdict: 'confirm', reason: 'real', evidence: 'app.py:3', fixed: true }], contest_rulings: [], assumptions: [], missed: [], checks: [{ command: 'pytest', result: 'passed' }] }));
  assert.equal(cli('code', ['verdict', '--run', runId, '--round', '1', '--verdicts', verdictFile]).status, 2);
  fs.writeFileSync(path.join(repo, 'app.py'), 'def avg(items):\n    total = sum(items)\n    return total / len(items) if items else 0\n\ndef neg(x):\n    return -x\n');
  const c2 = amendAll(repo);
  assert.notEqual(c1, c2);
  fs.writeFileSync(verdictFile, JSON.stringify({ review_rating: 8, verdicts: [
    { id: 'R1:F1', verdict: 'confirm', reason: 'real', evidence: 'app.py:3', change: 'guarded', fixed: true },
    { id: 'R1:F2', verdict: 'discard', reason: 'not required', evidence: 'CLAUDE.md:1' },
    { id: 'R1:D1', verdict: 'discard', reason: 'callers validate', evidence: 'app.py:2' },
  ], contest_rulings: [], assumptions: [], missed: [], checks: [{ command: 'pytest', result: 'passed' }] }));
  let v = cli('code', ['verdict', '--run', runId, '--round', '1', '--verdicts', verdictFile]).json;
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.next, 'continue');
  assert.equal(v.changed, true);
  assert.deepEqual(v.unfixedBlockers, []);
  assert.equal(cli('code', ['finish', '--run', runId]).status, 2);
  assert.equal(cli('code', ['waive', '--run', runId, '--reason', 'whatever']).status, 2);
  // finishing now would be changed_after_review, not passed
  assert.equal(code.computeOutcome(common.loadRun(HOME, runId), gitc(repo, 'rev-parse', 'HEAD^{tree}')), 'changed_after_review');
  startCodeRoundAndAttempt(runId);
  run = ingestFixture(runId, 'backend-clean.json');
  assert.equal(run.status, 'awaiting_verdict');
  assert.deepEqual(run.rounds[1].review.findings, []);
  fs.writeFileSync(verdictFile, JSON.stringify({ review_rating: 9, verdicts: [], contest_rulings: [], assumptions: [], missed: [], checks: [] }));
  v = cli('code', ['verdict', '--run', runId, '--round', '2', '--verdicts', verdictFile]).json;
  assert.equal(v.next, 'stop');
  assert.equal(v.stopReason, 'no_changes');
  assert.equal(hook('claude', 'Stop', hookPayload(CODE_SID, repo)).output.decision, 'block');
  const fin = cli('code', ['finish', '--run', runId]).json;
  assert.equal(fin.outcome, 'passed', JSON.stringify(fin));
  assert.equal(fin.candidateCommit, c2);
  assert.equal(fin.checks.length, 1);
  const ledger = common.loadLedger(HOME, common.repoIdentity(repo).repoKey);
  assert.equal(ledger.active, null);
  assert.equal(ledger.baselines[common.sessionKey('claude', CODE_SID)].headSha, c2);
  assert.equal(ledger.receipts.at(-1).outcome, 'passed');
  assert.equal(hook('claude', 'Stop', hookPayload(CODE_SID, repo)).output, null);
  // generated junk over a receipted HEAD names the receipt and the junk instead of demanding a re-review
  fs.mkdirSync(path.join(repo, '__pycache__'));
  fs.writeFileSync(path.join(repo, '__pycache__', 'a.pyc'), 'x');
  const junk = hook('claude', 'Stop', hookPayload(CODE_SID, repo)).output;
  assert.equal(junk.decision, 'block');
  assert.match(junk.reason, /already has a passed\/waived receipt; only the worktree is dirty \(1 entry: \?\? __pycache__\/a\.pyc\)/);
  fs.rmSync(path.join(repo, '__pycache__'), { recursive: true });
  assert.equal(hook('claude', 'Stop', hookPayload(CODE_SID, repo)).output, null);
  // repeated finish is idempotent; stats row exists once with 2 rounds
  assert.equal(cli('code', ['finish', '--run', runId]).json.repeated, true);
  const rows = common.readStats(HOME).filter(r => r.recordType === 'run' && r.runId === runId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rounds, 2);
  assert.equal(rows[0].outcome, 'passed');
  assert.equal(rows[0].tokens.complete, false);
  // a second fresh task in the same session starts at the new HEAD
  const begun2 = cli('code', ['begin', '--seat', 'claude', '--session', CODE_SID, '--cwd', repo]).json;
  assert.equal(begun2.ok, true, JSON.stringify(begun2));
  assert.equal(begun2.baseSha, c2);
  fs.writeFileSync(path.join(repo, 'two.txt'), '2');
  commitAll(repo, 'feat: two');
  assert.equal(hook('claude', 'Stop', hookPayload(CODE_SID, repo)).output.decision, 'block');
  assert.equal(cli('code', ['waive', '--run', begun2.runId, '--reason', 'whatever']).status, 2);
  const waived = cli('code', ['waive', '--run', begun2.runId, '--reason', 'comment-only change, user approved']).json;
  assert.equal(waived.outcome, 'waived');
  assert.equal(hook('claude', 'Stop', hookPayload(CODE_SID, repo)).output, null);
  assert.ok(common.readStats(HOME).some(r => r.recordType === 'audit' && r.type === 'waiver' && r.runId === begun2.runId));
});

test('blocked finish keeps ownership and receipts, requires an amended tree to re-review, and permits passing or waiving', () => {
  const repo = makeRepo();
  const sid = 'sess-blocked-finish';
  hook('claude', 'SessionStart', hookPayload(sid, repo));
  const runId = cli('code', ['begin', '--seat', 'claude', '--session', sid, '--cwd', repo]).json.runId;
  fs.writeFileSync(path.join(repo, 'change.txt'), 'candidate\n');
  commitAll(repo, 'feat: candidate');
  // Substitute only the model backend in a copy of the skill; exercise code review's real CLI, preflight, round and ingestion path.
  const fakeCli = fakeBackendCli();
  const review = (id, fixture) => cli('code', ['review', '--run', id], { cli: fakeCli, env: { TEST_RUN_FILE: path.join(common.runDir(HOME, id), 'run.json'), TEST_BACKEND_FIXTURE: path.join(FIX, fixture) } });
  const verdict = (id, round, findings) => {
    const file = path.join(common.runDir(HOME, id), `verdict-${round}.json`);
    fs.writeFileSync(file, JSON.stringify({ review_rating: 8, verdicts: findings.map(f => ({ id: f.id, verdict: f.id.endsWith(':F1') ? 'confirm' : 'discard', reason: 'checked', evidence: 'app.py:3', fixed: false })), contest_rulings: [], assumptions: [], missed: [], checks: [] }));
    const result = cli('code', ['verdict', '--run', id, '--round', String(round), '--verdicts', file]);
    assert.equal(result.status, 0, result.stderr);
    return result.json;
  };
  const reviewed = review(runId, 'backend-findings.json');
  assert.equal(reviewed.status, 0, reviewed.stderr);
  assert.equal(reviewed.json.runStatus, 'awaiting_verdict');
  assert.equal(verdict(runId, 1, reviewed.json.findings).stopReason, 'no_changes');
  const blocked = cli('code', ['finish', '--run', runId]).json;
  assert.equal(blocked.outcome, 'blocked');
  assert.equal(blocked.candidateClosed, false);
  assert.deepEqual(blocked.unresolvedFindings, ['R1:F1']);
  const ledger = () => common.loadLedger(HOME, common.repoIdentity(repo).repoKey);
  assert.equal(common.loadRun(HOME, runId).status, 'continue');
  assert.equal(ledger().active.runId, runId);
  const stats = () => common.readStats(HOME).filter(r => r.recordType === 'run' && r.runId === runId);
  assert.equal(stats().length, 1);
  assert.equal(stats()[0].outcome, 'blocked');
  assert.equal(cli('code', ['finish', '--run', runId]).json.repeated, true);
  assert.equal(stats().length, 1);
  assert.deepEqual(ledger().receipts.map(r => r.outcome), ['blocked']);
  assert.equal(hook('claude', 'Stop', hookPayload(sid, repo)).output.decision, 'block');
  assert.ok(hook('claude', 'UserPromptSubmit', hookPayload(sid, repo, { prompt: 'fix it' })).output.hookSpecificOutput.additionalContext.includes(runId));
  const runsBefore = fs.readdirSync(path.join(HOME, 'runs')).sort();
  const busy = cli('code', ['begin', '--adopt', '--seat', 'codex', '--session', 'other-blocked-seat', '--cwd', repo, '--reason', 'observed local creation without push']).json;
  assert.equal(busy.status, 'candidate_busy');
  assert.deepEqual(fs.readdirSync(path.join(HOME, 'runs')).sort(), runsBefore, 'a refused begin leaves no run behind');
  assert.equal(busy.runId, runId);
  assert.deepEqual(busy.owner, { seat: 'claude', sessionId: sid });
  const unchanged = review(runId, 'backend-findings.json');
  assert.equal(unchanged.status, 2);
  assert.match(unchanged.json.error.message, /unchanged candidate tree; amend/);
  assert.equal(common.loadRun(HOME, runId).rounds.length, 1);
  assert.equal(cli('code', ['approve-push', '--run', runId]).status, 2);
  fs.writeFileSync(path.join(repo, 'app.py'), 'def avg(items):\n    return sum(items) / len(items) if items else 0\n');
  const amended = amendAll(repo);
  assert.equal(gitc(repo, 'rev-parse', 'HEAD^'), blocked.baseSha);
  assert.equal(cli('code', ['finish', '--run', runId]).json.repeated, true);
  const clean = review(runId, 'backend-clean.json');
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.json.round, 2);
  assert.equal(clean.json.runStatus, 'awaiting_verdict');
  assert.equal(clean.json.outcome, null);
  assert.equal(common.loadRun(HOME, runId).finishedAt, null);
  verdict(runId, 2, clean.json.findings);
  const activeBefore = ledger().active;
  const passed = cli('code', ['finish', '--run', runId]).json;
  assert.equal(passed.outcome, 'passed');
  assert.equal(passed.candidateCommit, amended);
  assert.equal(passed.candidateClosed, true);
  assert.equal(ledger().active, null);
  assert.deepEqual(ledger().receipts.map(r => [r.runId, r.outcome]), [[runId, 'blocked'], [runId, 'passed']]);
  // A finish interrupted after saving the run but before the ledger is repaired by repeating finish, once.
  common.updateLedger(HOME, common.repoIdentity(repo), (l) => { l.active = activeBefore; l.receipts.pop(); return l; });
  assert.equal(cli('code', ['finish', '--run', runId]).json.repeated, true);
  assert.equal(ledger().active, null);
  assert.equal(cli('code', ['finish', '--run', runId]).json.repeated, true);
  assert.deepEqual(ledger().receipts.map(r => [r.runId, r.outcome]), [[runId, 'blocked'], [runId, 'passed']]);
  assert.equal(stats().length, 1);
  assert.equal(stats()[0].outcome, 'passed');
  assert.equal(hook('claude', 'Stop', hookPayload(sid, repo)).output, null);
  assert.equal(cli('code', ['waive', '--run', runId, '--reason', 'user approved: test waiver']).status, 2);
  const next = cli('code', ['begin', '--seat', 'claude', '--session', sid, '--cwd', repo]).json;
  assert.equal(next.ok, true);
  fs.writeFileSync(path.join(repo, 'change.txt'), 'next candidate\n');
  commitAll(repo, 'feat: next');
  const nextReview = review(next.runId, 'backend-findings.json').json;
  verdict(next.runId, 1, nextReview.findings);
  assert.equal(cli('code', ['finish', '--run', next.runId]).json.outcome, 'blocked');
  assert.equal(common.loadRun(HOME, next.runId).status, 'continue');
  const waived = cli('code', ['waive', '--run', next.runId, '--reason', 'user approved: waive blocker']).json;
  assert.equal(waived.outcome, 'waived');
  assert.equal(waived.waivedFrom, 'blocked');
  assert.equal(ledger().active, null);
  assert.equal(cli('code', ['waive', '--run', next.runId, '--reason', 'user approved: repeat']).status, 2);
});

test('agreed stop, code: a non-blocking finding fixed by amendment with no_further_review stops and finishes passed with the amendment disclosed; blockers and unfixed withdrawn blockers continue', () => {
  const repo = makeRepo();
  const sid = 'sess-agreed-code';
  const bare = path.join(SCRATCH, 'bare-agreed.git');
  gitc(SCRATCH, 'init', '-q', '--bare', '-b', 'main', bare);
  gitc(repo, 'remote', 'add', 'origin', bare);
  hook('claude', 'SessionStart', hookPayload(sid, repo));
  const softenF1 = (d) => { for (const f of [...d.stages.main.doc.findings, ...d.stages.final.doc.findings]) if (f.id === 'F1') f.severity = 'non-blocking'; return d; };
  const verdictDoc = (over = {}) => ({ review_rating: 8, verdicts: [
    { id: 'R1:F1', verdict: 'confirm', reason: 'real', evidence: 'app.py:3', change: 'guarded', fixed: true },
    { id: 'R1:F2', verdict: 'discard', reason: 'not required', evidence: 'CLAUDE.md:1' },
    { id: 'R1:D1', verdict: 'discard', reason: 'callers validate', evidence: 'app.py:2' },
  ], contest_rulings: [], assumptions: [], missed: [], checks: [{ command: 'pytest', result: 'passed' }], no_further_review: true, ...over });
  const cycle = (label, mutate, over) => {
    const b = cli('code', ['begin', '--seat', 'claude', '--session', sid, '--cwd', repo]).json;
    assert.equal(b.ok, true, JSON.stringify(b));
    fs.appendFileSync(path.join(repo, 'app.py'), `# ${label}\n`);
    commitAll(repo, `feat: ${label}`);
    startCodeRoundAndAttempt(b.runId);
    ingestFixture(b.runId, 'backend-findings.json', { mutate });
    fs.appendFileSync(path.join(repo, 'app.py'), `# fix ${label}\n`);
    const amended = amendAll(repo);
    const file = path.join(common.runDir(HOME, b.runId), 'v.json');
    fs.writeFileSync(file, JSON.stringify(verdictDoc(over)));
    const v = cli('code', ['verdict', '--run', b.runId, '--round', '1', '--verdicts', file]).json;
    assert.equal(v.ok, true, JSON.stringify(v));
    return { runId: b.runId, amended, v };
  };
  const agreed = cycle('agreed', softenF1, {});
  assert.deepEqual(common.loadRun(HOME, agreed.runId).rounds[0].review.findings.map(f => [f.id, f.severity, f.status]), [['R1:F1', 'non-blocking', 'agreed'], ['R1:F2', 'non-blocking', 'withdrawn'], ['R1:D1', 'blocking', 'withdrawn']]);
  assert.equal(agreed.v.next, 'stop');
  assert.equal(agreed.v.stopReason, 'agreed');
  assert.equal(agreed.v.agreed, true);
  assert.equal(agreed.v.changedAfterReview, true);
  assert.equal(code.computeOutcome(common.loadRun(HOME, agreed.runId), gitc(repo, 'rev-parse', 'HEAD^{tree}')), 'passed');
  // a further amendment after the agreed stop is unreviewed again
  fs.appendFileSync(path.join(repo, 'app.py'), '# late\n');
  amendAll(repo);
  assert.equal(code.computeOutcome(common.loadRun(HOME, agreed.runId), gitc(repo, 'rev-parse', 'HEAD^{tree}')), 'changed_after_review');
  gitc(repo, 'reset', '-q', '--hard', agreed.amended);
  assert.equal(hook('claude', 'Stop', hookPayload(sid, repo)).output.decision, 'block');
  const fin = cli('code', ['finish', '--run', agreed.runId]).json;
  assert.equal(fin.outcome, 'passed', JSON.stringify(fin));
  assert.equal(fin.unreviewedAmendment, true);
  assert.equal(fin.candidateCommit, agreed.amended);
  assert.match(fin.warnings.join(' '), /agreed stop: finished tree .* amends the reviewed tree/);
  const receipt = common.loadLedger(HOME, common.repoIdentity(repo).repoKey).receipts.at(-1);
  assert.equal(receipt.commitSha, agreed.amended);
  assert.equal(receipt.unreviewedAmendment, true);
  assert.equal(receipt.reviewedCommit, common.loadRun(HOME, agreed.runId).code.reviewedCommit);
  assert.equal(hook('claude', 'Stop', hookPayload(sid, repo)).output, null);
  assert.equal(cli('code', ['finish', '--run', agreed.runId]).json.unreviewedAmendment, true);
  const approved = cli('code', ['approve-push', '--run', agreed.runId, '--remote', 'origin', '--ref', 'refs/heads/main', '--reason', 'user approved: push the agreed candidate to origin main']).json;
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(approved.unreviewedAmendment, true);
  assert.ok(approved.command.startsWith(`cd '${repo}' && git push`));
  // negatives: a live blocking finding, even when fixed, and a withdrawn blocker confirmed but left unfixed
  const blocker = cycle('blocker', null, {});
  assert.equal(blocker.v.next, 'continue');
  assert.equal(blocker.v.agreed, false);
  cli('code', ['waive', '--run', blocker.runId, '--reason', 'user approved: waive the negative case']);
  const unfixed = cycle('unfixed', softenF1, { verdicts: verdictDoc().verdicts.map(v => v.id === 'R1:D1' ? { ...v, verdict: 'confirm', fixed: false } : v) });
  assert.deepEqual(unfixed.v.unfixedBlockers, ['R1:D1']);
  assert.equal(unfixed.v.next, 'continue');
  assert.equal(unfixed.v.agreed, false);
  cli('code', ['waive', '--run', unfixed.runId, '--reason', 'user approved: waive the negative case']);
});

test('code Stop promotion: receipted commits from a linked worktree, published commits and merge commits pass; a rebase with new trees blocks with the promotion hint until baseline; plain commits still block', () => {
  const repo = makeRepo();
  const sid = 'sess-promote';
  const bare = path.join(SCRATCH, 'bare-promote.git');
  gitc(SCRATCH, 'init', '-q', '--bare', '-b', 'main', bare);
  gitc(repo, 'remote', 'add', 'origin', bare);
  gitc(repo, 'push', '-q', 'origin', 'main');
  hook('claude', 'SessionStart', hookPayload(sid, repo));
  const stop = () => hook('claude', 'Stop', hookPayload(sid, repo));
  assert.equal(stop().output, null);
  // 1. a candidate reviewed (waived) in a linked worktree, approved for push there, then fast-forwarded into the root checkout
  const linked = path.join(SCRATCH, 'promote-linked');
  gitc(repo, 'worktree', 'add', '-q', '-b', 'feature', linked);
  const linkedReal = fs.realpathSync(linked);
  const lsid = 'sess-promote-linked';
  const reviewedInLinked = (label) => {
    const b = cli('code', ['begin', '--seat', 'codex', '--session', lsid, '--cwd', linkedReal]).json;
    fs.writeFileSync(path.join(linkedReal, `${label}.py`), `${label} = 1\n`);
    const sha = commitAll(linkedReal, `feat: ${label}`);
    assert.equal(cli('code', ['waive', '--run', b.runId, '--reason', `user approved: waive ${label}`]).json.outcome, 'waived');
    return { runId: b.runId, sha };
  };
  const c1 = reviewedInLinked('feature1');
  const approved = cli('code', ['approve-push', '--run', c1.runId, '--remote', 'origin', '--ref', 'refs/heads/feature', '--reason', 'user approved: push the feature branch to origin']).json;
  assert.equal(approved.ok, true, JSON.stringify(approved));
  const bareForm = approved.command.replace(/^cd '[^']*' && /, '');
  const codexPush = (command) => hook('codex', 'PreToolUse', hookPayload(lsid, repo, { tool_name: 'Bash', tool_input: { command: ['bash', '-lc', command] } }));
  assert.match(codexPush(bareForm).output.hookSpecificOutput.permissionDecisionReason, /no unconsumed approval/);
  assert.equal(codexPush(approved.command).output, null);
  assert.notEqual(common.loadLedger(HOME, common.repoIdentity(linkedReal).repoKey).approvals[0].consumedAt, null);
  gitc(repo, 'merge', '-q', '--ff-only', 'feature');
  assert.equal(gitc(repo, 'rev-parse', 'HEAD'), c1.sha);
  let r = stop();
  assert.equal(r.output, null, JSON.stringify(r));
  assert.match(r.note, /receipt/);
  // 2. a squash merge of a second reviewed candidate: new commit, receipted tree
  const c2 = reviewedInLinked('feature2');
  gitc(repo, 'merge', '-q', '--squash', 'feature');
  gitc(repo, 'commit', '-q', '-m', 'feat: feature2 (squash)');
  assert.notEqual(gitc(repo, 'rev-parse', 'HEAD'), c2.sha);
  assert.equal(gitc(repo, 'rev-parse', 'HEAD^{tree}'), gitc(repo, 'rev-parse', `${c2.sha}^{tree}`));
  r = stop();
  assert.equal(r.output, null, JSON.stringify(r));
  // 3. a pull of commits someone else published
  gitc(repo, 'push', '-q', 'origin', 'main');
  const clone = path.join(SCRATCH, 'promote-clone');
  gitc(SCRATCH, 'clone', '-q', bare, clone);
  gitc(clone, 'config', 'user.email', 'other@example.com');
  gitc(clone, 'config', 'user.name', 'Other');
  fs.writeFileSync(path.join(clone, 'other.py'), 'o = 1\n');
  commitAll(clone, 'feat: other');
  gitc(clone, 'push', '-q', 'origin', 'main');
  gitc(repo, 'pull', '-q', '--ff-only', 'origin', 'main');
  r = stop();
  assert.equal(r.output, null, JSON.stringify(r));
  assert.match(r.note, /published, receipted, or merge commits/);
  // 4. a reviewed commit in the root, then a rebase onto a moved origin/main: new tree, blocked with the promotion hint
  const b = cli('code', ['begin', '--seat', 'claude', '--session', sid, '--cwd', repo]).json;
  fs.writeFileSync(path.join(repo, 'topic.py'), 't = 1\n');
  const t = commitAll(repo, 'feat: topic');
  cli('code', ['waive', '--run', b.runId, '--reason', 'user approved: waive topic']);
  assert.equal(stop().output, null);
  fs.writeFileSync(path.join(clone, 'p.py'), 'p = 1\n');
  commitAll(clone, 'feat: p');
  gitc(clone, 'push', '-q', 'origin', 'main');
  gitc(repo, 'fetch', '-q', 'origin');
  gitc(repo, 'rebase', '-q', 'origin/main');
  const rebased = gitc(repo, 'rev-parse', 'HEAD');
  assert.notEqual(rebased, t);
  r = stop();
  assert.equal(r.output.decision, 'block');
  assert.match(r.output.reason, new RegExp(`promotion, not new work.*--base ${rebased} --reason "promotion:`));
  const bl = cli('code', ['baseline', '--seat', 'claude', '--session', sid, '--cwd', repo, '--base', rebased, '--reason', 'promotion: topic rebased onto origin/main; reviewed as ' + t.slice(0, 12)]);
  assert.equal(bl.json.ok, true, bl.stdout);
  assert.equal(stop().output, null);
  // 5. a --no-ff merge of a published branch: the merge commit is trusted structurally
  fs.writeFileSync(path.join(linkedReal, 'feature3.py'), 'f3 = 1\n');
  commitAll(linkedReal, 'feat: feature3');
  gitc(linkedReal, 'push', '-q', 'origin', 'feature');
  gitc(repo, 'merge', '-q', '--no-ff', '-m', 'merge feature', 'feature');
  assert.equal(gitc(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);
  r = stop();
  assert.equal(r.output, null, JSON.stringify(r));
  // 6. a plain unreviewed commit still blocks
  fs.writeFileSync(path.join(repo, 'u.py'), 'u = 1\n');
  commitAll(repo, 'feat: unreviewed');
  r = stop();
  assert.equal(r.output.decision, 'block');
  assert.equal(r.note, 'blocked: unreviewed changes');
  // 7. a repository without remotes does not negate everything away
  const lone = makeRepo();
  hook('claude', 'SessionStart', hookPayload('sess-lone', lone));
  fs.writeFileSync(path.join(lone, 'l.py'), 'l = 1\n');
  commitAll(lone, 'feat: lone');
  r = hook('claude', 'Stop', hookPayload('sess-lone', lone));
  assert.equal(r.output.decision, 'block');
  assert.equal(r.note, 'blocked: unreviewed changes');
});

test('code Stop with only untracked files hints at excluding them, and passes once they are excluded at the baseline HEAD', () => {
  const repo = makeRepo();
  const sid = 'sess-local-only';
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# local\n');
  hook('claude', 'SessionStart', hookPayload(sid, repo));
  const stop = () => hook('claude', 'Stop', hookPayload(sid, repo));
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# local, edited\n');
  let r = stop();
  assert.equal(r.output.decision, 'block');
  assert.equal(r.note, 'blocked: unreviewed changes');
  assert.match(r.output.reason, /\.git\/info\/exclude/);
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), 'CLAUDE.md\n');
  r = stop();
  assert.equal(r.output, null, JSON.stringify(r));
  // a tracked edit still blocks, without the untracked-only hint
  fs.appendFileSync(path.join(repo, 'app.py'), '# edit\n');
  r = stop();
  assert.equal(r.output.decision, 'block');
  assert.doesNotMatch(r.output.reason, /\.git\/info\/exclude/);
});

test('code backend results: malformed output, base/snapshot mismatch, non-zero exit, retry once, round-three blockers exhaust, post-review mutation warning', () => {
  const repo = makeRepo();
  const sid = 'sess-code-2';
  const begun = cli('code', ['begin', '--seat', 'claude', '--session', sid, '--cwd', repo]).json;
  const runId = begun.runId;
  fs.writeFileSync(path.join(repo, 'x.py'), 'x = 1\n');
  commitAll(repo, 'feat: x');
  startCodeRoundAndAttempt(runId);
  let run = ingestFixture(runId, 'backend-malformed.json');
  assert.equal(run.rounds[0].attempts[0].failure, 'bad_output');
  assert.match(run.rounds[0].attempts[0].error, /final stage/);
  assert.equal(run.status, 'review_failed');
  startCodeRoundAndAttempt(runId, { retry: true });
  run = ingestFixture(runId, 'backend-clean.json', { mutate: (d) => { d.base.sha = 'f'.repeat(40); return d; } });
  assert.match(run.rounds[0].attempts[1].error, /base .* does not match/);
  assert.equal(run.status, 'stopped');
  assert.equal(run.stopReason, 'reviewer_failed');
  assert.throws(() => code.startCodeAttempt(HOME, runId, { retry: true }), /retry|no failed attempt/);
  assert.equal(cli('code', ['finish', '--run', runId]).status, 2);
  const report = path.join(SCRATCH, 'code-self-review.md');
  fs.writeFileSync(report, 'Reviewed the candidate; independent backend failed.');
  const fin = cli('code', ['finish', '--run', runId, '--self-review', report, '--reason', 'user authorized: review it yourself']).json;
  assert.equal(fin.outcome, 'bad_output');
  assert.equal(fin.candidateClosed, false);
  assert.equal(common.loadLedger(HOME, common.repoIdentity(repo).repoKey).active.runId, runId);
  // waive closes it and the same session can start again
  cli('code', ['waive', '--run', runId, '--reason', 'user approved waiver after backend failure']);
  const second = cli('code', ['begin', '--seat', 'claude', '--session', sid, '--cwd', repo]).json;
  assert.equal(second.ok, true);
  fs.writeFileSync(path.join(repo, 'y.py'), 'y = 1\n');
  commitAll(repo, 'feat: y');
  startCodeRoundAndAttempt(second.runId);
  run = ingestFixture(second.runId, 'backend-clean.json', { exitCode: 1 });
  assert.equal(run.rounds[0].attempts[0].failure, 'backend');
  startCodeRoundAndAttempt(second.runId, { retry: true });
  run = ingestFixture(second.runId, 'backend-clean.json', { mutate: (d) => { d.snapshotCommit = 'e'.repeat(40); return d; } });
  assert.match(run.rounds[0].attempts[1].error, /snapshot/);
  cli('code', ['waive', '--run', second.runId, '--reason', 'user approved waiver']);
  // three rounds with an unfixed blocker → exhausted_with_blockers; post-review HEAD move warns
  const third = cli('code', ['begin', '--seat', 'claude', '--session', sid, '--cwd', repo]).json;
  fs.writeFileSync(path.join(repo, 'z.py'), 'z = 1\n');
  commitAll(repo, 'feat: z');
  const verdictFile = path.join(common.runDir(HOME, third.runId), 'v.json');
  for (let round = 1; round <= 3; round++) {
    startCodeRoundAndAttempt(third.runId);
    if (round === 1) { fs.writeFileSync(path.join(repo, 'z.py'), 'z = 2\n'); amendAll(repo); }
    run = ingestFixture(third.runId, 'backend-findings.json');
    fs.writeFileSync(verdictFile, JSON.stringify({ review_rating: 5, verdicts: [
      { id: `R${round}:F1`, verdict: 'confirm', reason: 'still broken', evidence: 'app.py:3', fixed: false },
      { id: `R${round}:F2`, verdict: 'discard', reason: 'n/a', evidence: 'x' },
      { id: `R${round}:D1`, verdict: 'discard', reason: 'n/a', evidence: 'x' },
    ], contest_rulings: [], assumptions: [], missed: [], checks: [] }));
    const v = cli('code', ['verdict', '--run', third.runId, '--round', String(round), '--verdicts', verdictFile]).json;
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.deepEqual(v.unfixedBlockers, [`R${round}:F1`]);
    if (round === 1) { assert.equal(v.next, 'continue'); assert.match(run.rounds[0].attempts[0].warnings.join(' '), /HEAD moved/); }
    if (round === 2) { assert.equal(v.next, 'stop'); assert.equal(v.stopReason, 'no_changes'); assert.equal(cli('code', ['finish', '--run', third.runId]).json.outcome, 'blocked'); fs.writeFileSync(path.join(repo, 'z.py'), 'z = 3\n'); amendAll(repo); }
    if (round === 3) { assert.equal(v.stopReason, 'round_limit'); }
  }
  assert.throws(() => code.startCodeRound(HOME, third.runId, {}), /already used 3 rounds|is stopped/);
  const fin3 = cli('code', ['finish', '--run', third.runId]).json;
  assert.equal(fin3.outcome, 'exhausted_with_blockers');
  assert.deepEqual(fin3.unresolvedFindings, ['R3:F1']);
  assert.equal(common.loadRun(HOME, third.runId).status, 'finished');
  assert.equal(cli('code', ['review', '--run', third.runId]).status, 2);
  assert.equal(cli('code', ['waive', '--run', third.runId, '--reason', 'user approved: waive exhausted blockers']).json.outcome, 'waived');
});

test('code preflight: nothing_to_review, secrets (each pattern, redacted, including an amendment), conflicts, hidden index flags, CRLF and symlinks, submodules', () => {
  const repo = makeRepo();
  const sid = 'sess-pre';
  const begin = () => cli('code', ['begin', '--seat', 'claude', '--session', sid, '--cwd', repo]).json;
  const waive = (runId) => cli('code', ['waive', '--run', runId, '--reason', 'user approved test waiver']).json;
  let b = begin();
  gitc(repo, 'commit', '-q', '--allow-empty', '-m', 'chore: empty');
  let r = cli('code', ['review', '--run', b.runId]).json;
  assert.equal(r.status, 'nothing_to_review', JSON.stringify(r));
  assert.equal(r.roundConsumed, false);
  assert.equal(cli('code', ['finish', '--run', b.runId]).json.outcome, 'nothing_to_review');
  waive(b.runId);
  // secrets assembled from fragments so this file never contains a credential-shaped literal
  const secrets = [['sk-', 'a'.repeat(24)], ['ghp_', 'b'.repeat(36)], ['AKIA', 'C'.repeat(16)], ['api_' + 'key = ', '"top"'], ['sk-ant-', 'a'.repeat(40)], ['AIza', 'b'.repeat(35)], ['-----BEGIN ', 'RSA PRIVATE KEY-----'], ['github_pat_', 'c'.repeat(82)]].map(([p, s]) => p + s);
  for (const [i, secret] of secrets.entries()) {
    b = begin();
    fs.writeFileSync(path.join(repo, `s${i}.txt`), `token: ${secret}\n`);
    commitAll(repo, `feat: s${i}`);
    r = cli('code', ['review', '--run', b.runId]);
    assert.equal(r.json.status, 'secrets_detected', r.stdout);
    assert.equal(r.json.secretHits.length, 1);
    assert.equal(r.json.secretHits[0].file, `s${i}.txt`);
    assert.ok(!r.stdout.includes(secret), 'secret value must not be printed');
    assert.ok(!JSON.stringify(common.loadRun(HOME, b.runId)).includes(secret), 'secret value must not be stored');
    assert.equal(common.loadRun(HOME, b.runId).rounds.length, 0);
    assert.equal(fs.existsSync(path.join(common.runDir(HOME, b.runId), 'round-1')), false, 'no reviewer attempt directory');
    fs.writeFileSync(path.join(repo, `s${i}.txt`), 'token: redacted\n');
    amendAll(repo);
    const pre = code.codePreflight(HOME, common.loadRun(HOME, b.runId), { skipLanes: true });
    assert.equal(pre.ok, true, JSON.stringify(pre));
    assert.equal(cli('code', ['finish', '--run', b.runId]).json.outcome, 'secrets_detected');
    waive(b.runId);
  }
  for (const secret of secrets.slice(4)) {
    assert.equal(common.scanDiffForSecrets(`--- a/removed.txt\n+++ b/removed.txt\n-${secret}\n`).length, 1);
    assert.equal(common.scanDiffForSecrets(`--- a/context.txt\n+++ b/context.txt\n ${secret}\n`).length, 1);
  }
  // an amendment that introduces a secret is caught on the next review
  b = begin();
  fs.writeFileSync(path.join(repo, 'clean.txt'), 'ok\n');
  commitAll(repo, 'feat: clean');
  assert.equal(code.codePreflight(HOME, common.loadRun(HOME, b.runId), { skipLanes: true }).ok, true);
  fs.writeFileSync(path.join(repo, 'clean.txt'), `ok ${secrets[1]}\n`);
  amendAll(repo);
  assert.equal(code.codePreflight(HOME, common.loadRun(HOME, b.runId), { skipLanes: true }).status, 'secrets_detected');
  fs.writeFileSync(path.join(repo, 'clean.txt'), 'ok\n');
  amendAll(repo);
  // CRLF content and a symlink are fine
  fs.writeFileSync(path.join(repo, 'crlf.txt'), 'a\r\nb\r\n');
  fs.symlinkSync('clean.txt', path.join(repo, 'link.txt'));
  amendAll(repo);
  assert.equal(code.codePreflight(HOME, common.loadRun(HOME, b.runId), { skipLanes: true }).ok, true);
  // hidden index flag
  gitc(repo, 'update-index', '--skip-worktree', 'crlf.txt');
  assert.match(code.codePreflight(HOME, common.loadRun(HOME, b.runId), { skipLanes: true }).reason, /skip-worktree/);
  gitc(repo, 'update-index', '--no-skip-worktree', 'crlf.txt');
  // branch change
  gitc(repo, 'checkout', '-q', '-b', 'other');
  assert.match(code.codePreflight(HOME, common.loadRun(HOME, b.runId), { skipLanes: true }).reason, /branch changed/);
  gitc(repo, 'checkout', '-q', 'main');
  waive(b.runId);
  // conflict
  b = begin();
  const base = gitc(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'conf.txt'), 'main\n'); commitAll(repo, 'feat: conf');
  gitc(repo, 'checkout', '-q', '-b', 'feature2', base);
  fs.writeFileSync(path.join(repo, 'conf.txt'), 'feature\n'); commitAll(repo, 'feat: conf2');
  gitc(repo, 'checkout', '-q', 'main');
  sh(repo, 'git', ['merge', 'feature2'], { allowFail: true });
  assert.match(code.codePreflight(HOME, common.loadRun(HOME, b.runId), { skipLanes: true }).reason, /unmerged|not clean/);
  gitc(repo, 'merge', '--abort');
  waive(b.runId);
  // submodule: clean is fine, dirty inside the submodule is a warning only
  const sub = makeRepo('submodule-src');
  b = begin();
  sh(repo, 'git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub']);
  commitAll(repo, 'feat: add submodule');
  let pre = code.codePreflight(HOME, common.loadRun(HOME, b.runId), { skipLanes: true });
  assert.equal(pre.ok, true, JSON.stringify(pre));
  assert.deepEqual(pre.warnings, []);
  fs.writeFileSync(path.join(repo, 'vendor', 'sub', 'app.py'), 'dirty submodule\n');
  pre = code.codePreflight(HOME, common.loadRun(HOME, b.runId), { skipLanes: true });
  assert.equal(pre.ok, true, JSON.stringify(pre));
  assert.match(pre.warnings.join(' '), /dirty submodule/);
});

test('push approval: exact command binding, consumption, replay, force/tags/mirror/extra refs, changed URL, same-tree different commit, late projection', () => {
  const repo = makeRepo();
  const sid = 'sess-push';
  const bare = path.join(SCRATCH, 'bare-push.git');
  gitc(SCRATCH, 'init', '-q', '--bare', '-b', 'main', bare);
  gitc(repo, 'remote', 'add', 'origin', bare);
  const begun = cli('code', ['begin', '--seat', 'claude', '--session', sid, '--cwd', repo]).json;
  fs.writeFileSync(path.join(repo, 'p.txt'), 'p\n');
  const sha = commitAll(repo, 'feat: p');
  const early = cli('code', ['approve-push', '--run', begun.runId, '--remote', 'origin', '--ref', 'refs/heads/main', '--reason', 'user approved: push it']);
  assert.equal(early.status, 2);
  cli('code', ['waive', '--run', begun.runId, '--reason', 'user approved trivial change']);
  assert.equal(cli('code', ['approve-push', '--run', begun.runId, '--remote', 'origin', '--ref', 'main', '--reason', 'user approved: push it']).status, 2);
  assert.equal(cli('code', ['approve-push', '--run', begun.runId, '--remote', 'origin', '--ref', 'refs/heads/main', '--reason', 'ok']).status, 2);
  const approved = cli('code', ['approve-push', '--run', begun.runId, '--remote', 'origin', '--ref', 'refs/heads/main', '--reason', 'user approved: push this candidate to origin main']).json;
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(approved.command, `cd '${repo}' && git push --no-follow-tags --recurse-submodules=no 'origin' '${sha}:refs/heads/main'`);
  assert.equal(approved.unreviewedAmendment, false);
  assert.equal(approved.publicationScope.commitsNotOnAnyRemote, 2);
  const decide = (command) => common.gitGateDecision({ command, cwd: repo, home: HOME });
  for (const flag of ['-c remote.origin.pushurl=/other', '-cremote.origin.pushurl=/other', '--config-env remote.origin.pushurl=OTHER', '--config-env=remote.origin.pushurl=OTHER', '--exec-path /tmp', '--exec-path=/tmp', '--namespace other', '--namespace=other']) {
    assert.equal(decide(approved.command.replace('git push', `git ${flag} push`)).decision, 'deny', flag);
    assert.equal(common.loadLedger(HOME, common.repoIdentity(repo).repoKey).approvals[0].consumedAt, null);
  }
  for (const command of [`echo before && ${approved.command} && echo after`, `${approved.command} && echo after`, `echo before && ${approved.command}`, `cd ${repo} && echo before && ${approved.command}`, `cd ${repo}; ${approved.command}`, `(${approved.command})`, `echo $(${approved.command})`]) {
    assert.equal(decide(command).decision, 'deny', command);
    assert.equal(common.loadLedger(HOME, common.repoIdentity(repo).repoKey).approvals[0].consumedAt, null);
  }
  assert.match(decide(`git push --force --no-follow-tags --recurse-submodules=no origin ${sha}:refs/heads/main`).reason, /unexpected arguments/);
  assert.match(decide(`git push --no-follow-tags --recurse-submodules=no origin ${sha}:refs/heads/main refs/tags/v1`).reason, /unexpected arguments/);
  assert.match(decide(`git push --mirror origin`).reason, /unexpected arguments/);
  assert.match(decide(`git push --no-follow-tags --recurse-submodules=no origin ${sha}:refs/heads/other`).reason, /no unconsumed approval/);
  assert.match(decide(`git push --no-follow-tags --recurse-submodules=no upstream ${sha}:refs/heads/main`).reason, /no unconsumed approval/);
  gitc(repo, 'remote', 'set-url', '--push', 'origin', `${bare}-moved`);
  assert.match(decide(approved.command).reason, /approved URL/);
  gitc(repo, 'remote', 'set-url', '--push', 'origin', bare);
  // same tree, different commit: not approved
  gitc(repo, 'commit', '-q', '--amend', '-m', 'feat: p (reworded)');
  const sha2 = gitc(repo, 'rev-parse', 'HEAD');
  assert.equal(gitc(repo, 'rev-parse', 'HEAD^{tree}'), gitc(repo, 'rev-parse', `${sha}^{tree}`));
  assert.match(decide(approved.command).reason, /HEAD is not the approved commit/);
  assert.match(decide(`git push --no-follow-tags --recurse-submodules=no origin ${sha2}:refs/heads/main`).reason, /no unconsumed approval/);
  gitc(repo, 'reset', '-q', '--hard', sha);
  fs.writeFileSync(path.join(repo, 'untracked.tmp'), 'artifact\n');
  assert.match(decide(approved.command).reason, /not clean/);
  assert.equal(common.loadLedger(HOME, common.repoIdentity(repo).repoKey).approvals[0].consumedAt, null);
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '\nuntracked.tmp\n');
  const pass = decide(approved.command);
  assert.equal(pass.decision, 'pass');
  assert.equal(pass.approvalId, approved.approval.approvalId);
  assert.match(decide(approved.command).reason, /no unconsumed approval|already consumed/);
  const ledger = common.loadLedger(HOME, common.repoIdentity(repo).repoKey);
  assert.equal(ledger.approvals[0].consumedAt !== null, true);
  assert.equal(ledger.pushAttempts.length, 1);
  const row = common.readStats(HOME).find(r => r.recordType === 'run' && r.runId === begun.runId);
  assert.equal(row.operations.pushApprovals.length, 1);
  assert.ok(common.readStats(HOME).some(r => r.recordType === 'audit' && r.type === 'push_approved' && r.runId === begun.runId));
  const again = cli('code', ['approve-push', '--run', begun.runId, '--remote', 'origin', '--ref', 'refs/heads/main', '--reason', 'user approved: retry']).json;
  // the returned command names its worktree, so it works from any tool working directory
  assert.equal(common.gitGateDecision({ command: again.command, cwd: SCRATCH, home: HOME }).decision, 'pass');
  // hook-level: the exact approved command is required, and DEBATE=off bypasses the gate entirely
  assert.equal(hook('claude', 'PreToolUse', hookPayload(sid, repo, { tool_name: 'Bash', tool_input: { command: 'git push origin main' } })).output.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(hook('claude', 'PreToolUse', hookPayload(sid, repo, { tool_name: 'Bash', tool_input: { command: 'git push origin main' } }), { env: { DEBATE: 'off' } }).output, null);
});

test('githubRepoFromUrl accepts only GitHub hosts and local github.com/<owner>/<repo>.git paths', () => {
  for (const [url, want] of [
    ['https://github.com/o/r.git', 'o/r'], ['https://github.com/o/r', 'o/r'], ['git@github.com:o/r.git', 'o/r'],
    ['ssh://git@github.com/o/r.git', 'o/r'], ['/tmp/x/github.com/o/r.git', 'o/r'], ['file:///tmp/x/github.com/o/r.git', 'o/r'],
    ['https://notgithub.com/o/r.git', null], ['https://example.org/github.com/o/r.git', null], ['https://github.com/o/r/pulls', null],
    ['/tmp/x/github.com/o/r', null], ['/tmp/upstream.git', null], ['git@example.com:o/r.git', null],
  ]) assert.equal(common.githubRepoFromUrl(url), want, url);
});

test('delete approval: merged PR at the push destination, exact lease command, consumption, refusals, stale lease, scope supersede', () => {
  fs.writeFileSync(path.join(BIN, 'gh'), '#!/bin/sh\nif [ -n "$FAKE_GH_FAIL" ]; then echo "$FAKE_GH_FAIL" >&2; exit 1; fi\nprintf "%s" "$FAKE_GH_JSON"\n', { mode: 0o755 });
  const repo = makeRepo();
  const fork = path.join(SCRATCH, 'gh-remotes', 'github.com', 'o', 'r.git');
  const upstream = path.join(SCRATCH, 'gh-upstream.git');
  fs.mkdirSync(path.dirname(fork), { recursive: true });
  gitc(SCRATCH, 'init', '-q', '--bare', '-b', 'main', fork);
  gitc(SCRATCH, 'init', '-q', '--bare', '-b', 'develop', upstream);
  gitc(repo, 'remote', 'add', 'origin', upstream);
  gitc(repo, 'remote', 'set-url', '--push', 'origin', fork);
  gitc(repo, 'push', '-q', upstream, 'HEAD:refs/heads/develop');
  gitc(repo, 'push', '-q', fork, 'HEAD:refs/heads/main');
  fs.writeFileSync(path.join(repo, 'f.txt'), 'f\n');
  const tip = commitAll(repo, 'feat: f');
  gitc(repo, 'push', '-q', fork, 'HEAD:refs/heads/feature');
  const prJson = (over = {}) => JSON.stringify({ state: 'MERGED', headRefName: 'feature', headRefOid: tip, headRepository: { id: 'R_1', name: 'r', nameWithOwner: 'o/r' }, headRepositoryOwner: { id: 'O_1', login: 'o' }, ...over });
  const PR = 'https://github.com/up/r/pull/7';
  const approveDelete = (over = {}, env = {}, cwd = repo) => {
    const flags = { '--cwd': cwd, '--remote': 'origin', '--ref': 'refs/heads/feature', '--pr': PR, '--reason': 'user approved: delete the merged feature branch', ...over };
    return cli('code', ['approve-delete', ...Object.entries(flags).flat()], { env: { FAKE_GH_JSON: prJson(), ...env } });
  };
  const approvals = () => common.loadLedger(HOME, common.repoIdentity(repo).repoKey)?.approvals || [];
  const decide = (command) => common.gitGateDecision({ command, cwd: repo, home: HOME });

  // refusals record nothing
  for (const [over, env, reason] of [
    [{}, { FAKE_GH_JSON: prJson({ state: 'OPEN' }) }, /not MERGED/],
    [{}, { FAKE_GH_JSON: prJson({ headRefName: 'other' }) }, /head branch is other/],
    [{}, { FAKE_GH_JSON: prJson({ headRefOid: '1'.repeat(40) }) }, /changed after the merge/],
    [{}, { FAKE_GH_JSON: prJson({ headRepositoryOwner: { id: 'O_2', login: 'someone' } }) }, /head repository is someone\/r/],
    [{}, { FAKE_GH_FAIL: 'HTTP 404' }, /gh pr view .* failed: HTTP 404/],
    [{}, { FAKE_GH_JSON: 'not json' }, /invalid JSON/],
    [{ '--ref': 'refs/heads/main' }, { FAKE_GH_JSON: prJson({ headRefName: 'main' }) }, /default branch/],
    [{ '--ref': 'refs/heads/nope' }, {}, /does not exist/],
    [{ '--ref': 'refs/heads/a;b' }, {}, /--ref must be/],
    [{ '--reason': 'ok' }, {}, /--reason must/],
    [{ '--pr': 'https://github.com/up/r/issues/7' }, {}, /--pr must be/],
  ]) {
    const r = approveDelete(over, env);
    assert.equal(r.status, 2, `${JSON.stringify([over, env])} ${r.stdout}`);
    assert.match(r.json?.error?.message ?? '', reason);
  }
  gitc(repo, 'remote', 'set-url', '--push', 'origin', upstream);
  assert.match(approveDelete().json.error.message, /not a GitHub repository URL/);
  gitc(repo, 'remote', 'set-url', '--push', 'origin', path.join(SCRATCH, 'missing', 'github.com', 'o', 'r.git'));
  assert.match(approveDelete().json.error.message, /cannot read/);
  const headless = path.join(SCRATCH, 'gh-remotes', 'github.com', 'o', 'r2.git');
  gitc(SCRATCH, 'init', '-q', '--bare', '-b', 'trunk', headless);
  gitc(repo, 'push', '-q', headless, 'HEAD:refs/heads/feature');
  gitc(repo, 'remote', 'set-url', '--push', 'origin', headless);
  assert.match(approveDelete({}, { FAKE_GH_JSON: prJson({ headRepository: { id: 'R_2', name: 'r2', nameWithOwner: 'o/r2' } }) }).json.error.message, /cannot determine the default branch/);
  gitc(repo, 'remote', 'set-url', '--push', 'origin', fork);
  assert.equal(approvals().length, 0);

  // the tip and default branch come from the push URL: feature exists only in the fork, upstream's default differs
  const approved = approveDelete().json;
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(approved.approval.kind, 'delete');
  assert.equal(approved.approval.commitSha, tip);
  assert.equal(approved.approval.pushUrl, fork);
  assert.equal(approved.command, `cd '${repo}' && git push --no-follow-tags --recurse-submodules=no '--force-with-lease=refs/heads/feature:${tip}' 'origin' ':refs/heads/feature'`);
  assert.ok(common.readStats(HOME).some(r => r.recordType === 'audit' && r.type === 'delete_approved' && r.eventId === approved.approval.approvalId));

  // gate: only the exact approved delete passes, once
  assert.match(decide('git push origin --delete feature').reason, /unexpected arguments/);
  assert.match(decide(`git push --no-follow-tags --recurse-submodules=no origin ${tip}:refs/heads/feature`).reason, /no unconsumed approval/);
  assert.match(decide(approved.command.replace(`:${tip}'`, `:${'2'.repeat(40)}'`)).reason, /no unconsumed delete approval/);
  assert.match(decide(approved.command.replaceAll('refs/heads/feature', 'refs/heads/other')).reason, /no unconsumed delete approval/);
  assert.match(decide(approved.command.replace("':refs/heads/feature'", "':refs/heads/other'")).reason, /a branch delete must be/);
  assert.match(decide(approved.command.replace('--recurse-submodules=no', '--recurse-submodules=no --force')).reason, /unexpected arguments/);
  assert.match(decide(`bash -c "${approved.command}"`).reason, /mutation wrapper "bash"/);
  gitc(repo, 'remote', 'set-url', '--push', 'origin', `${fork}-moved`);
  assert.match(decide(approved.command).reason, /approved URL/);
  gitc(repo, 'remote', 'set-url', '--push', 'origin', fork);
  assert.equal(approvals()[0].consumedAt, null);
  const pass = common.gitGateDecision({ command: approved.command, cwd: SCRATCH, home: HOME });
  assert.equal(pass.decision, 'pass');
  assert.equal(pass.approvalId, approved.approval.approvalId);
  assert.match(decide(approved.command).reason, /no unconsumed delete approval/);
  assert.ok(common.loadLedger(HOME, common.repoIdentity(repo).repoKey).audit.some(e => e.type === 'delete_permitted'));

  // end to end, outside the gate: the lease deletes an unchanged branch and refuses a moved one
  const run = (command) => spawnSync('sh', ['-c', command], { encoding: 'utf8' });
  assert.equal(run(approved.command).status, 0);
  assert.equal(gitc(repo, 'ls-remote', fork, 'refs/heads/feature'), '');
  gitc(repo, 'push', '-q', fork, `${tip}:refs/heads/feature`);
  const again = approveDelete().json;
  assert.equal(again.ok, true, JSON.stringify(again));
  fs.writeFileSync(path.join(repo, 'g.txt'), 'g\n');
  const moved = commitAll(repo, 'feat: g');
  gitc(repo, 'push', '-q', fork, 'HEAD:refs/heads/feature');
  const stale = run(again.command);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /stale info/);
  assert.match(gitc(repo, 'ls-remote', fork, 'refs/heads/feature'), new RegExp(`^${moved}`));

  // a new approval for the same ref supersedes the old one, and a scope change supersedes delete approvals too
  const third = approveDelete({}, { FAKE_GH_JSON: prJson({ headRefOid: moved }) }).json;
  assert.match(approvals().find(a => a.approvalId === again.approval.approvalId).consumedAt, /^superseded:/);
  common.changeRepositoryScope(repo, false, HOME);
  assert.match(approvals().find(a => a.approvalId === third.approval.approvalId).consumedAt, /^superseded:scope-disable/);
  common.changeRepositoryScope(repo, true, HOME);

  // a literal $ in the worktree path survives quoting and the gate
  const dollar = makeRepo('dollar$repo');
  gitc(dollar, 'remote', 'add', 'origin', fork);
  const fromDollar = approveDelete({}, { FAKE_GH_JSON: prJson({ headRefOid: moved }) }, dollar).json;
  assert.equal(fromDollar.ok, true, JSON.stringify(fromDollar));
  assert.equal(common.gitGateDecision({ command: fromDollar.command, cwd: SCRATCH, home: HOME }).decision, 'pass');

  // unenrolled repos still record the approval, with the scope warning
  const plain = makeRepo(undefined, { enrolled: false });
  gitc(plain, 'remote', 'add', 'origin', fork);
  const unenrolled = approveDelete({}, { FAKE_GH_JSON: prJson({ headRefOid: moved }) }, plain).json;
  assert.equal(unenrolled.ok, true, JSON.stringify(unenrolled));
  assert.ok(unenrolled.warnings.length > 0);
});

// ---------- locking and concurrency ----------

test('locks: concurrent ledger and stats updates are serialized; stale locks are reclaimed; release is ownership-aware', async () => {
  const repo = makeRepo();
  const identity = common.repoIdentity(repo);
  const script = `
    import { updateLedger, upsertStatsRow } from ${JSON.stringify(path.join(SCRIPTS, 'lib', 'common.mjs'))};
    import fs from 'node:fs';
    const identity = ${JSON.stringify(identity)};
    while (!fs.existsSync(${JSON.stringify(path.join(SCRATCH, 'lock-go'))})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    for (let i = 0; i < 5; i++) {
      updateLedger(${JSON.stringify(HOME)}, identity, (l) => { l.counter = (l.counter || 0) + 1; return l; });
      upsertStatsRow(${JSON.stringify(HOME)}, { schema: 'debate.stats.v1', recordType: 'run', runId: process.argv[2] + '-' + i, kind: 'plan', claims: {}, tokens: {}, perRound: [], ratings: { plan: [], review: [] }, startedAt: new Date().toISOString() });
    }
  `;
  const file = path.join(SCRATCH, 'lock-worker.mjs');
  fs.writeFileSync(file, script);
  // all workers start together behind a barrier file, so their updates overlap
  const workers = [];
  for (let i = 0; i < 6; i++) {
    const child = spawn(process.execPath, [file, `w${i}`], { env: process.env });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    workers.push(new Promise((resolve) => child.on('close', (status) => resolve({ status, stderr }))));
  }
  fs.writeFileSync(path.join(SCRATCH, 'lock-go'), '');
  for (const w of await Promise.all(workers)) assert.equal(w.status, 0, w.stderr);
  assert.equal(common.loadLedger(HOME, identity.repoKey).counter, 30);
  assert.equal(common.readStats(HOME).filter(r => /^w\d-\d$/.test(r.runId)).length, 30);
  // stale lock (dead pid, old timestamp) is reclaimed
  const lockPath = path.join(SCRATCH, 'stale.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483000, token: 'dead', at: Date.now() - 120_000 }));
  assert.equal(common.withLock(lockPath, () => 'ok'), 'ok');
  assert.equal(fs.existsSync(lockPath), false);
  for (const owner of [{ pid: process.pid, at: Date.now() - 120_000 }, { pid: process.pid }]) {
    fs.writeFileSync(lockPath, JSON.stringify(owner));
    assert.throws(() => common.withLock(lockPath, () => assert.fail('stole live lock'), { waitMs: 50 }), /lock busy/);
    assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')), owner);
    fs.unlinkSync(lockPath);
  }
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() - 11 * 60_000 }));
  assert.equal(common.withLock(lockPath, () => 'recycled pid'), 'recycled pid');
  fs.writeFileSync(lockPath, JSON.stringify({ at: Date.now() - 120_000 }));
  assert.equal(common.withLock(lockPath, () => 'unknown stale owner'), 'unknown stale owner');
  fs.writeFileSync(lockPath, JSON.stringify({ at: Date.now() }));
  assert.throws(() => common.withLock(lockPath, () => {}, { waitMs: 50 }), /lock busy/);
  fs.unlinkSync(lockPath);
  // a live lock owned by another token is not released by a holder whose lock was stolen
  const stolen = path.join(SCRATCH, 'stolen.lock');
  common.withLock(stolen, () => { fs.writeFileSync(stolen, JSON.stringify({ pid: process.pid, token: 'someone-else', at: Date.now() })); });
  assert.equal(fs.existsSync(stolen), true);
  assert.equal(JSON.parse(fs.readFileSync(stolen, 'utf8')).token, 'someone-else');
  fs.unlinkSync(stolen);
  // a live lock held by this process makes a second acquisition wait and fail
  common.withLock(stolen, () => { assert.throws(() => common.withLock(stolen, () => {}, { waitMs: 150 }), /lock busy/); });
});

test('statistics: audit rows excluded from run averages, filters, null denominators', () => {
  const rows = common.readStats(HOME);
  const summary = common.computeStats(rows, { kind: 'plan' });
  assert.ok(summary.runs > 0);
  assert.ok(summary.audits >= 0);
  assert.equal(common.computeStats([], {}).claims.precision, null);
  assert.equal(common.computeStats([], {}).reviewer.failureRate, null);
  const codeSummary = common.computeStats(rows, { kind: 'code', seat: 'claude' });
  assert.ok(codeSummary.outcomes.passed >= 1);
  assert.ok(codeSummary.byLane['review-main'].agents >= 1);
});


test('compact history and handoff retain actions while local artifacts retain complete review data', () => {
  const runId = newPlanRun();
  runReviewRound(runId, PLAN_BODY, readFix('plan-review-round1.json'));
  const run = plan.applyVerdict(HOME, runId, 1, PLAN_REVISED, readFix('verdict-round1.json'));
  run.rounds[0].review.summary = 'DUPLICATE_SUMMARY_SENTINEL';
  run.rounds[0].review.reviews = [{ reviewer: 'IDENTITY_SENTINEL', summary: 'RAW_REPORT_SENTINEL' }];
  run.rounds[0].review.findings[0].reviewer = 'IDENTITY_SENTINEL';
  run.rounds[0].verdict.assumptions[0].resolution = 'open';
  const history = plan.renderHistory(run, 2);
  assert.doesNotMatch(history, /DUPLICATE_SUMMARY_SENTINEL|RAW_REPORT_SENTINEL|IDENTITY_SENTINEL|rating|usage|seconds|reviews/);
  const normalized = JSON.parse(history)[0];
  assert.equal(normalized.findings[0].claim, run.rounds[0].review.findings[0].claim);
  assert.equal(normalized.verdicts[0].change, 'Added CRLF normalization to step 2');
  assert.equal(normalized.resolutions[0].resolution, 'open');
  assert.equal(normalized.missed[0].change, 'Documented exit codes');
  const section = plan.renderReviewSection({ ...run, outcome: 'completed' }, { shortSha: '0123456789ab', unratedChanges: true });
  assert.match(section, /Added CRLF normalization|Documented exit codes/);
  assert.match(section, /Open decisions: A1:/);
  assert.match(section, /finished text differs/);
  assert.doesNotMatch(section, /rating|tokens|seconds|stop reason|DUPLICATE_SUMMARY_SENTINEL|IDENTITY_SENTINEL/);
  // A later resolution closes an older assumption in the handoff.
  run.rounds.push({ review: null, verdict: { assumptions: [{ id: 'A1', resolution: 'settled_from_repo' }] }, attempts: [] });
  assert.match(plan.renderReviewSection({ ...run, outcome: 'completed' }, { shortSha: '0123456789ab' }), /Open decisions: none/);
  const stored = common.loadRun(HOME, runId);
  assert.equal(stored.rounds[0].review.rating, 6);
  assert.equal(stored.rounds[0].attempts[0].usage.input, 1000);
  assert.equal(stored.rounds[0].verdict.review_rating, 8);
});


test('handoff retains accepted unapplied findings and fixed-only missed changes', () => {
  const runId = newPlanRun();
  runReviewRound(runId, PLAN_BODY, readFix('plan-review-round1.json'));
  const verdict = readFix('verdict-round1-nochange.json');
  verdict.verdicts[0].verdict = 'confirm';
  const run = plan.applyVerdict(HOME, runId, 1, PLAN_BODY, verdict);
  run.rounds[0].verdict.missed.push({ claim: 'Applied independent fix', evidence: 'source:1', fixed: true });
  const history = JSON.parse(plan.renderHistory(run, 2));
  assert.equal(history[0].missed.at(-1).fixed, true);
  const section = plan.renderReviewSection({ ...run, outcome: 'completed' }, { shortSha: '0123456789ab' });
  assert.match(section, /Unresolved F1:/);
  assert.match(section, /Applied independent fix.*fixed/);
  assert.doesNotMatch(section, /change: undefined/);
});


test('handoff suppresses overturned changes and does not call no-op text applied', () => {
  const run = { runId: '00000000-0000-0000-0000-000000000000', outcome: 'completed', rounds: [
    { attempts: [], review: { findings: [{ id: 'F1', claim: 'Validation is needed', recommendation: 'Keep validation' }, { id: 'F2', claim: 'Handle errors', recommendation: 'Add handling' }] }, verdict: { verdicts: [{ id: 'F1', verdict: 'modify', change: 'Remove validation' }, { id: 'F2', verdict: 'confirm', change: 'None' }] } },
    { attempts: [], verdict: { contest_rulings: [{ id: 'F1', ruling: 'reverse', reason: 'Restore validation to prevent data loss' }] } },
  ] };
  const section = plan.renderReviewSection(run, { shortSha: '0123456789ab' });
  assert.doesNotMatch(section, /Applied F1: Remove validation|Applied F2: None/);
  assert.match(section, /Reversed F1: Restore validation to prevent data loss/);
  run.rounds[0].verdict.verdicts[0] = { id: 'F1', verdict: 'discard' };
  run.rounds[1].verdict.contest_rulings[0].reason = 'Evidence confirms finding';
  const reversedDiscard = plan.renderReviewSection(run, { shortSha: '0123456789ab' });
  assert.match(reversedDiscard, /Evidence confirms finding.*Validation is needed; recommendation: Keep validation/);
  assert.match(section, /Unresolved F2: Handle errors/);
});

test('begin clears a ledger entry whose run was never saved instead of reporting the worktree busy forever', () => {
  const repo = makeRepo();
  const sid = 'sess-orphan';
  hook('claude', 'SessionStart', hookPayload(sid, repo));
  const orphan = '00000000-0000-4000-8000-00000000abcd';
  common.updateLedger(HOME, common.repoIdentity(repo), (l) => { l.active = { runId: orphan, seat: 'claude', sessionId: 'gone', sessionKey: 'claude:gone', baseSha: gitc(repo, 'rev-parse', 'HEAD'), branch: 'main', phase: 'awaiting', candidateCommit: null, candidateTree: null, commitsInRange: null, adopted: false, createdAt: new Date().toISOString() }; return l; });
  const begun = cli('code', ['begin', '--seat', 'claude', '--session', sid, '--cwd', repo]).json;
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const ledger = common.loadLedger(HOME, common.repoIdentity(repo).repoKey);
  assert.equal(ledger.active.runId, begun.runId);
  assert.ok(ledger.audit.some(e => e.type === 'orphan_candidate_cleared' && e.runId === orphan));
});
