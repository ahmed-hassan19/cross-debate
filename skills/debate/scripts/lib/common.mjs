// common.mjs — shared helpers for the plan, code, review and hook commands.
// DEBATE_HOME state and locks, Git observation, fence-aware plan markers, secret scanning,
// shell-command analysis for the Git gate, relay dispatch, usage extraction, and statistics.
// Node built-ins only. Importing this module has no side effects.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { diffEntries } from './diff.mjs';

export const RUN_SCHEMA = 'debate.run.v1';
export const STATS_SCHEMA = 'debate.stats.v1';
export const LEDGER_SCHEMA = 'debate.ledger.v1';
export const SESSION_SCHEMA = 'debate.session.v1';
export const REVIEW_SCHEMA = 'debate-plan.review.v1';
export const SEATS = ['claude', 'codex', 'cursor', 'opencode'];
export const MAX_ROUNDS = 3;
export const RECEIPT_TTL_MS = 24 * 3600 * 1000;
export const LOCK_STALE_MS = 60_000;
export const LOCK_MAX_AGE_MS = 10 * 60_000;
export const PLAN_LANES = { main: 'plan-main', debate: 'plan-debate' };
export const CODE_REVIEW_LANES = ['review-main', 'review-debate'];
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const SHA_RE = /^[0-9a-f]{40}$/;

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLI = path.join(SKILL_DIR, 'scripts', 'debate.mjs');
/** A copy-pasteable command line for the single entrypoint. */
export function cliCommand(args) { return `node ${JSON.stringify(CLI)} ${args}`; }

export class UsageError extends Error {
  constructor(message, details) { super(message); this.usage = true; this.details = details; }
}
export function usage(message, details) { return new UsageError(message, details); }
export function nowIso() { return new Date().toISOString(); }
export function newEventId() { return crypto.randomUUID(); }
export function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms)); }
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
export function sha256(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex');
}
export function printJson(doc) { process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`); }
export function log(message) { process.stderr.write(`[debate] ${message}\n`); }
export function readStdin() { return fs.readFileSync(0, 'utf8'); }

// ---------- home, files, locks ----------

export function debateHome() {
  return process.env.DEBATE_HOME ? path.resolve(process.env.DEBATE_HOME) : path.join(os.homedir(), '.local', 'share', 'debate');
}
export function automationOff(home) {
  return process.env.DEBATE === 'off' || fs.existsSync(path.join(home, 'off'));
}
export function ensureHome(home) {
  for (const sub of ['', 'runs', 'sessions', 'ledger']) fs.mkdirSync(path.join(home, sub), { recursive: true, mode: 0o700 });
}
/** Actual write probe; returns null when writable, else the failure message. */
export function probeWritable(home) {
  try {
    ensureHome(home);
    const probe = path.join(home, `.probe-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
    fs.writeFileSync(probe, '', { mode: 0o600 });
    fs.unlinkSync(probe);
    return null;
  } catch (e) { return `${home} is not writable: ${e.message}`; }
}
export function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
export function readJsonIfExists(file) {
  try { return readJson(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export function writeJson(file, doc) { writeAtomic(file, `${JSON.stringify(doc, null, 2)}\n`); }

/**
 * Remove a stale lock only while it is still the exact file that was judged stale. Reclaimers serialize on a
 * sibling O_EXCL file, so none can remove a lock a successor acquired after the inspection.
 * ponytail: a reclaim file older than 30s is treated as abandoned; the reclaim itself takes microseconds.
 */
export function reclaimStaleLock(lockPath, inspected) {
  const reclaim = `${lockPath}.reclaim`;
  let fd;
  try { fd = fs.openSync(reclaim, 'wx', 0o600); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try { if (Date.now() - fs.statSync(reclaim).mtimeMs > 30_000) fs.unlinkSync(reclaim); } catch { /* gone or raced */ }
    sleepMs(5);
    return;
  }
  try {
    fs.closeSync(fd);
    let current = null;
    try { current = fs.readFileSync(lockPath, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (current === inspected) fs.unlinkSync(lockPath);
  } finally {
    try { fs.unlinkSync(reclaim); } catch { /* already gone */ }
  }
}
/** O_EXCL lock with PID, ownership token and timestamp. Stale: dead owner, unknown owner older than 60s, or any owner older than 10m. Released only by its owner. */
export function withLock(lockPath, fn, { waitMs = 10_000 } = {}) {
  const token = crypto.randomBytes(8).toString('hex');
  const started = Date.now();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  for (;;) {
    let fd = null;
    try { fd = fs.openSync(lockPath, 'wx', 0o600); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (fd !== null) {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, at: Date.now() }));
      fs.closeSync(fd);
      break;
    }
    let inspected = null;
    try { inspected = fs.readFileSync(lockPath, 'utf8'); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    let owner = null;
    try { owner = JSON.parse(inspected); } catch { owner = null; }
    let stale = false;
    if (owner && Number.isInteger(owner.pid) && owner.pid > 0) stale = !isPidAlive(owner.pid) || (Number.isInteger(owner.at) && Date.now() - owner.at > LOCK_MAX_AGE_MS);
    else if (owner && Number.isInteger(owner.at)) stale = Date.now() - owner.at > LOCK_STALE_MS;
    else { try { stale = Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS; } catch (e) { if (e.code !== 'ENOENT') throw e; } }
    if (Date.now() - started > waitMs) throw new Error(`lock busy: ${lockPath}`);
    if (stale) reclaimStaleLock(lockPath, inspected);
    else sleepMs(40);
  }
  try {
    return fn();
  } finally {
    try { if (readJson(lockPath).token === token) fs.unlinkSync(lockPath); } catch { /* stolen or gone */ }
  }
}

// ---------- identity ----------

export function validateSeat(seat) {
  if (!SEATS.includes(seat)) throw usage(`--seat must be one of ${SEATS.join('|')}`);
  return seat;
}
export function validateSessionId(id) {
  if (typeof id !== 'string' || !SESSION_RE.test(id)) throw usage('invalid --session id');
  return id;
}
const SESSION_ENV = { claude: 'CLAUDE_SESSION_ID', codex: 'CODEX_THREAD_ID' };
/** Explicit --session wins; a validated seat-specific environment variable is the only fallback. */
export function sessionIdFor(seat, explicit) {
  if (explicit) return validateSessionId(explicit);
  const fromEnv = SESSION_ENV[seat] ? process.env[SESSION_ENV[seat]] : undefined;
  if (fromEnv && SESSION_RE.test(fromEnv)) return fromEnv;
  throw usage('--session is required (no validated session id in the environment)');
}
export function sessionKey(seat, sessionId) { return `${seat}-${sha256(seat, '\0', sessionId).slice(0, 32)}`; }
export function validateRunId(runId) {
  if (typeof runId !== 'string' || !UUID_RE.test(runId)) throw usage('invalid --run id');
  return runId;
}
export function runDir(home, runId) { return path.join(home, 'runs', validateRunId(runId)); }
export function createRun(home, run) {
  const dir = runDir(home, run.runId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeJson(path.join(dir, 'run.json'), run);
  return run;
}
export function loadRun(home, runId) {
  const run = readJsonIfExists(path.join(runDir(home, runId), 'run.json'));
  if (!run) throw usage(`unknown run ${runId}`);
  if (run.schema !== RUN_SCHEMA) throw usage(`run ${runId} has schema ${run.schema}, expected ${RUN_SCHEMA}`);
  return run;
}
export function updateRun(home, runId, fn) {
  const dir = runDir(home, runId);
  return withLock(path.join(dir, 'run.lock'), () => {
    const run = loadRun(home, runId);
    const next = fn(run) || run;
    next.updatedAt = nowIso();
    writeJson(path.join(dir, 'run.json'), next);
    return next;
  });
}

export function sessionPath(home, seat, sessionId) { return path.join(home, 'sessions', `${sessionKey(seat, sessionId)}.json`); }
export function newSession(seat, sessionId) {
  return { schema: SESSION_SCHEMA, seat, sessionId, transcriptPath: null, cwd: null, generation: 0, planRuns: [], codeRuns: [], startedAt: nowIso(), updatedAt: nowIso() };
}
export function loadSession(home, seat, sessionId) { return readJsonIfExists(sessionPath(home, seat, sessionId)); }
export function updateSession(home, seat, sessionId, fn) {
  const file = sessionPath(home, seat, sessionId);
  return withLock(`${file}.lock`, () => {
    const cur = readJsonIfExists(file) || newSession(seat, sessionId);
    const next = fn(cur) || cur;
    next.updatedAt = nowIso();
    writeJson(file, next);
    return next;
  });
}

export function ledgerPath(home, repoKey) {
  if (!/^[0-9a-f]{64}$/.test(repoKey)) throw usage('invalid repository key');
  return path.join(home, 'ledger', `${repoKey}.json`);
}
export function newLedger(identity) {
  return { schema: LEDGER_SCHEMA, repoKey: identity.repoKey, worktreeRoot: identity.worktreeRoot, gitDir: identity.gitDir, baselines: {}, active: null, receipts: [], deferrals: [], waivers: [], approvals: [], pushAttempts: [], publications: [], audit: [], updatedAt: nowIso() };
}
export function loadLedger(home, repoKey) { return readJsonIfExists(ledgerPath(home, repoKey)); }
export function updateLedger(home, identity, fn) {
  const file = ledgerPath(home, identity.repoKey);
  return withLock(`${file}.lock`, () => {
    const cur = readJsonIfExists(file) || newLedger(identity);
    const next = fn(cur) || cur;
    next.updatedAt = nowIso();
    writeJson(file, next);
    return next;
  });
}
export function auditEvent(ledger, event) {
  const row = { eventId: newEventId(), at: nowIso(), ...event };
  ledger.audit.push(row);
  return row;
}

// ---------- git observation ----------

const GIT_BIG = 256 * 1024 * 1024;
export function git(cwd, args, { env, allowFail = false, timeout, encoding = 'utf8' } = {}) {
  const r = spawnSync('git', args, { cwd, encoding, maxBuffer: GIT_BIG, timeout, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...(env || {}) } });
  if (r.error) throw new Error(`git ${args[0]}: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${String(r.stderr || '').trim()}`);
  return r;
}
export function gitText(cwd, args, opts) { return git(cwd, args, opts).stdout.trim(); }
/** { worktreeRoot, gitDir, repoKey } or null outside a work tree. repoKey = SHA-256(real root + NUL + absolute git dir). */
export function repoIdentity(cwd, opts = {}) {
  let r;
  try { r = git(cwd, ['rev-parse', '--show-toplevel', '--absolute-git-dir'], { allowFail: true, ...opts }); } catch { return null; }
  if (r.status !== 0) return null;
  const [top, gitDir] = r.stdout.split('\n').map(s => s.trim());
  if (!top || !gitDir) return null;
  let worktreeRoot;
  try { worktreeRoot = fs.realpathSync(top); } catch { return null; }
  return { worktreeRoot, gitDir, repoKey: sha256(worktreeRoot, '\0', gitDir) };
}

/** Only direct repository-local config controls automatic review. Git's local config is shared by worktrees. */
export function repositoryScope(cwd, { home = debateHome(), ...gitOpts } = {}) {
  const identity = repoIdentity(cwd, gitOpts);
  const warnings = [];
  if (!identity) return { identity: null, configured: null, enabled: false, effective: false, warnings };
  const r = git(identity.worktreeRoot, ['config', '--local', '--no-includes', '--type=bool', '--get-all', 'debate.enabled'], { ...gitOpts, allowFail: true });
  let configured = null;
  if (r.status === 0) configured = r.stdout.trim().split('\n').at(-1) === 'true';
  else if (r.status !== 1) { warnings.push('invalid or unreadable local debate.enabled; defaulting to disabled'); log(warnings[0]); }
  const enabled = configured === true;
  return { identity, configured, enabled, effective: enabled && !automationOff(home), warnings };
}
export function withRepositoryScopeLock(cwd, fn, home = debateHome()) {
  if (!repoIdentity(cwd)) throw usage(`${cwd} is not inside a Git work tree`);
  const commonDir = fs.realpathSync(gitText(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  return withLock(path.join(home, 'scope-locks', `${sha256(commonDir)}.lock`), fn);
}
export function scopeWarning(cwd, home = debateHome()) {
  return repositoryScope(cwd, { home }).effective ? [] : ['automatic debate guards are inactive: candidate lineage, push approval enforcement and permit consumption are not enforced; explicit user approval is still required'];
}
/** Roots of every non-bare worktree of the repository that owns `root`, as Git lists them. */
export function worktreeRoots(root, opts) {
  const records = gitText(root, ['worktree', 'list', '--porcelain', '-z'], opts).split('\0\0').filter(Boolean).map(record => record.split('\0'));
  // A bare common repository is listed by Git, but it has no worktree ledger.
  return records.filter(fields => !fields.includes('bare')).map(fields => {
    const field = fields.find(s => s.startsWith('worktree '));
    if (!field) throw usage('malformed Git worktree listing');
    return field.slice(9);
  });
}
export function changeRepositoryScope(cwd, enabled, home = debateHome()) {
  const initial = repositoryScope(cwd, { home });
  if (!initial.identity) throw usage('scope enable/disable requires a Git worktree');
  const root = initial.identity.worktreeRoot;
  return withRepositoryScopeLock(root, () => {
    const roots = worktreeRoots(root);
    const identities = roots.map(p => {
      const id = repoIdentity(p);
      if (!id) throw usage(`cannot inspect linked worktree ${p}; repair or prune the stale entry explicitly before changing scope`);
      return id;
    }).sort((a, b) => a.repoKey.localeCompare(b.repoKey));
    // Acquire all ledger locks before validation: a partial check must not change config or abandon a candidate.
    const locked = (i, fn) => i === identities.length ? fn() : withLock(`${ledgerPath(home, identities[i].repoKey)}.lock`, () => locked(i + 1, fn));
    return locked(0, () => {
      const ledgers = identities.map(id => ({ id, ledger: loadLedger(home, id.repoKey) }));
      const active = ledgers.filter(x => x.ledger?.active);
      if (!enabled && active.length) throw usage(`cannot disable with active candidates: ${active.map(x => `${x.ledger.active.runId} in ${x.id.worktreeRoot}`).join(', ')}; finish or explicitly waive them first`);
      const at = nowIso();
      let superseded = 0;
      for (const { ledger } of ledgers) {
        if (!ledger) continue;
        const pending = ledger.approvals.filter(a => a.consumedAt === null);
        for (const a of pending) {
          a.consumedAt = `superseded:scope-${enabled ? 'enable' : 'disable'}:${at}`;
          auditEvent(ledger, { type: 'push_approval_superseded', approvalId: a.approvalId, reason: 'scope_transition', enabled });
        }
        superseded += pending.length;
        // Revocation is safe even if a later write fails: config changes only after all ledgers were saved.
        if (pending.length) { ledger.updatedAt = at; writeJson(ledgerPath(home, ledger.repoKey), ledger); }
      }
      git(root, ['config', '--local', '--replace-all', 'debate.enabled', String(enabled)]);
      return { ok: true, ...repositoryScope(root, { home }), supersededApprovals: superseded, worktrees: roots, activeCandidates: active.map(x => ({ runId: x.ledger.active.runId, worktree: x.id.worktreeRoot })) };
    });
  }, home);
}
export function headSha(cwd, opts) {
  const r = git(cwd, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { allowFail: true, ...opts });
  return r.status === 0 ? r.stdout.trim() : null;
}
export function resolveCommit(cwd, ref, opts) {
  const r = git(cwd, ['rev-parse', '--verify', '-q', `${ref}^{commit}`], { allowFail: true, ...opts });
  return r.status === 0 ? r.stdout.trim() : null;
}
export function treeOf(cwd, commit, opts) { return gitText(cwd, ['rev-parse', `${commit}^{tree}`], opts); }
export function parentsOf(cwd, commit, opts) {
  return gitText(cwd, ['rev-list', '--parents', '-n', '1', commit], opts).split(/\s+/).slice(1).filter(Boolean);
}
export function branchOf(cwd, opts) {
  const r = git(cwd, ['symbolic-ref', '-q', '--short', 'HEAD'], { allowFail: true, ...opts });
  return r.status === 0 ? r.stdout.trim() : null;
}
export function isAncestor(cwd, ancestor, descendant, opts) {
  return git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant], { allowFail: true, ...opts }).status === 0;
}
/** Commits in base..head, oldest first, each with its parents. */
export function commitsInRange(cwd, base, head, opts) {
  const out = gitText(cwd, ['rev-list', '--parents', '--reverse', `${base}..${head}`], opts);
  return out ? out.split('\n').map(line => { const [sha, ...parents] = line.split(/\s+/); return { sha, parents }; }) : [];
}
/** SHA-256 of `git diff HEAD` plus the sorted untracked list with sizes and mtimes. Change detector only, never a content identity. */
export function startFingerprint(root, opts) {
  const diff = git(root, ['diff', 'HEAD', '--no-ext-diff', '--no-color', '--'], opts).stdout;
  const raw = git(root, ['ls-files', '-o', '--exclude-standard', '-z'], opts).stdout;
  const entries = raw.split('\0').filter(Boolean).sort().map(rel => {
    try { const st = fs.lstatSync(path.join(root, rel)); return `${rel}\0${st.size}\0${Math.floor(st.mtimeMs)}`; } catch { return `${rel}\0missing`; }
  });
  return sha256(diff, '\0', entries.join('\n'));
}
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });
/** Porcelain v1 entries; throws on non-UTF-8 paths. */
export function porcelainStatus(root, { ignoreSubmodules = 'dirty', ...opts } = {}) {
  const r = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', `--ignore-submodules=${ignoreSubmodules}`], { ...opts, encoding: 'buffer' });
  let text;
  try { text = STRICT_UTF8.decode(r.stdout); } catch { throw new Error('unsupported path encoding: non-UTF-8 paths in git status'); }
  const tokens = text.split('\0');
  const entries = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t || t.length < 4) continue;
    const entry = { code: t.slice(0, 2), path: t.slice(3) };
    if (entry.code.includes('R') || entry.code.includes('C')) entry.from = tokens[++i];
    entries.push(entry);
  }
  return entries;
}
export function hasUnmerged(root, opts) { return gitText(root, ['ls-files', '-u'], opts) !== ''; }
export function hasHiddenIndexBits(root, opts) {
  const raw = git(root, ['ls-files', '-v', '-z'], opts).stdout;
  for (const entry of raw.split('\0')) {
    if (!entry) continue;
    const tag = entry[0];
    if (tag === 'S' || tag === 's' || (tag >= 'a' && tag <= 'z')) return true;
  }
  return false;
}
/** Gitlink paths whose submodule worktree is dirty or checked out at a different commit (warning only). */
export function dirtySubmodules(root, opts) {
  if (!fs.existsSync(path.join(root, '.gitmodules'))) return [];
  const strict = new Set(porcelainStatus(root, { ignoreSubmodules: 'none', ...opts }).map(e => e.path));
  const lenient = new Set(porcelainStatus(root, { ignoreSubmodules: 'dirty', ...opts }).map(e => e.path));
  return [...strict].filter(p => !lenient.has(p));
}
export function remoteContains(root, sha, opts) {
  return gitText(root, ['branch', '-r', '--contains', sha], opts).split('\n').map(s => s.trim()).filter(Boolean);
}

// ---------- durations ----------

export function parseDuration(value) {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(String(value ?? '').trim());
  if (!m || !(m[1] || m[2] || m[3])) return null;
  const ms = ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000;
  return ms > 0 && ms <= 2_147_483_647 ? ms : null;
}

// ---------- plan markers and canonical text ----------

export const BEGIN_RE = /^<!-- debate-plan:begin run=([0-9a-f-]{36}) sha=([0-9a-f]{12}) -->[ \t]*\r?$/;
export const END_RE = /^<!-- debate-plan:end -->[ \t]*\r?$/;

/** CommonMark fences: backtick or tilde runs of length >= 3, up to three leading spaces, closing run at least as long. */
/** Code-fence state per line: mask[i] is true inside a fence; openAt is the 0-based line of a fence left open at the end. */
export function fenceState(lines) {
  const mask = new Array(lines.length).fill(false);
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!open) {
      if (m && !(m[1][0] === '`' && m[2].includes('`'))) { open = { ch: m[1][0], len: m[1].length, at: i }; mask[i] = true; }
      continue;
    }
    mask[i] = true;
    if (m && m[1][0] === open.ch && m[1].length >= open.len && m[2].trim() === '') open = null;
  }
  return { mask, openAt: open ? open.at : null };
}
export function fenceMask(lines) { return fenceState(lines).mask; }
export function findGeneratedBlocks(text) {
  const lines = text.split('\n');
  const mask = fenceMask(lines);
  const blocks = [];
  const malformed = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const b = BEGIN_RE.exec(lines[i]);
    if (b) {
      if (cur) malformed.push({ line: cur.start + 1, reason: 'begin marker without end' });
      cur = { start: i, runId: b[1], sha: b[2] };
      continue;
    }
    if (END_RE.test(lines[i])) {
      if (!cur) { malformed.push({ line: i + 1, reason: 'end marker without begin' }); continue; }
      blocks.push({ ...cur, end: i });
      cur = null;
    }
  }
  if (cur) malformed.push({ line: cur.start + 1, reason: 'begin marker without end' });
  return { lines, blocks, malformed };
}
export function canonicalText(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/[ \t]+$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}
export function digestOf(text) { return sha256(text); }
/**
 * Split a plan into its body and its single generated block. Returns { body, block, canonical, digest, error }.
 * error is set for malformed or duplicate outside-fence blocks; a missing block yields block null.
 */
export function splitPlan(text) {
  const { lines, blocks, malformed } = findGeneratedBlocks(text);
  // An appended review block would land inside an unclosed fence, where the plan gate cannot see it.
  const { openAt } = fenceState(lines);
  if (openAt !== null) return { error: `unclosed code fence opened at line ${openAt + 1}; close it before reviewing or finishing the plan` };
  if (malformed.length) return { error: `malformed debate-plan marker at line ${malformed[0].line}: ${malformed[0].reason}` };
  if (blocks.length > 1) return { error: `duplicate debate-plan blocks (lines ${blocks.map(b => b.start + 1).join(', ')})` };
  const block = blocks[0] || null;
  const kept = block ? lines.filter((_, i) => i < block.start || i > block.end) : lines;
  const body = kept.join('\n');
  const canonical = canonicalText(body);
  return { body, block, canonical, digest: digestOf(canonical), error: null };
}
export function renderWithBlock(text, block, section) {
  const { lines } = findGeneratedBlocks(text);
  const sectionLines = section.replace(/\n$/, '').split('\n');
  if (block) return [...lines.slice(0, block.start), ...sectionLines, ...lines.slice(block.end + 1)].join('\n');
  const base = text.replace(/\s+$/, '');
  return `${base}\n\n${sectionLines.join('\n')}\n`;
}

// ---------- secret scanning ----------

// Review preflight closes the amend/heredoc exemption with the same patterns.
export const SECRET_PATTERNS = [
  { pattern: /sk-[a-zA-Z0-9]{20,}/, name: 'OpenAI API key' },
  { pattern: /ghp_[a-zA-Z0-9]{36}/, name: 'GitHub PAT' },
  { pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/, name: 'Anthropic API key' },
  { pattern: /AIza[a-zA-Z0-9_-]{35}/, name: 'Google API key' },
  { pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/, name: 'Private key' },
  { pattern: /github_pat_[a-zA-Z0-9_]{20,}/, name: 'GitHub fine-grained PAT' },
  { pattern: /AKIA[A-Z0-9]{16}/, name: 'AWS Access Key' },
  { pattern: /api[_-]?key\s*[=:]\s*['"][^'"]+['"]/i, name: 'API key' },
];
/** Scan a unified diff (added, removed and context lines). Returns redacted hits only: pattern, file, diff line. */
export function scanDiffForSecrets(diffText) {
  const hits = [];
  for (const e of diffEntries(diffText)) {
    if (e.kind === 'diff' || e.kind === 'header' || e.kind === 'hunk') continue;
    for (const { pattern, name } of SECRET_PATTERNS) if (pattern.test(e.raw)) hits.push({ pattern: name, file: e.file, diffLine: e.index + 1 });
  }
  return hits;
}

// ---------- shell command analysis (Git gate) ----------

const WRAPPERS = new Set(['env', 'sudo', 'xargs', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'eval', 'exec', 'nohup', 'time', 'command', 'nice', 'ionice', 'timeout', 'caffeinate', 'script', 'watch', 'doas', 'su', 'flock', 'setsid', 'stdbuf', 'chronic', 'node', 'python', 'python3', 'perl', 'ruby']);
export const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--namespace', '--exec-path', '--super-prefix', '--config-env', '--list-cmds', '--attr-source']);

const RESERVED = new Set(['{', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until']);
const nonLiteral = (w) => /[$`]/.test(w);

/**
 * Read a heredoc delimiter (bare, quoted, or backslash-escaped) starting at `j`; returns { delim, end, quoted } or
 * { error }. Any quoting makes the body literal; a bare delimiter's body undergoes command substitution.
 */
function heredocDelimiter(cmd, j) {
  while (j < cmd.length && (cmd[j] === ' ' || cmd[j] === '\t')) j++;
  if (cmd[j] === "'" || cmd[j] === '"') {
    const k = cmd.indexOf(cmd[j], j + 1);
    if (k < 0) return { error: 'unterminated heredoc delimiter' };
    return { delim: cmd.slice(j + 1, k), end: k + 1, quoted: true };
  }
  let delim = '';
  let quoted = false;
  while (j < cmd.length && !/[\s;&|<>()]/.test(cmd[j])) {
    if (cmd[j] === '"' || cmd[j] === "'") { quoted = true; j++; continue; }
    if (cmd[j] === '\\' && j + 1 < cmd.length) { quoted = true; j++; }
    delim += cmd[j]; j++;
  }
  return { delim, end: j, quoted };
}

/** A command substitution starting at `i` ($(...) or `...`): { tokens, end }, { error }, or null when none starts there. */
function commandSubstitution(cmd, i) {
  if (cmd[i] === '$' && cmd[i + 1] === '(') {
    const inner = tokenizeShell(cmd.slice(i + 2), true);
    return inner.error ? inner : { tokens: inner.tokens, end: i + 2 + inner.consumed };
  }
  if (cmd[i] !== '`') return null;
  let body = '';
  for (let k = i + 1; k < cmd.length; k++) {
    if (cmd[k] === '\\' && k + 1 < cmd.length) { body += '$`\\'.includes(cmd[k + 1]) ? cmd[k + 1] : cmd[k] + cmd[k + 1]; k++; continue; }
    if (cmd[k] === '`') { const inner = tokenizeShell(body); return inner.error ? inner : { tokens: inner.tokens, end: k + 1 }; }
    body += cmd[k];
  }
  return { error: 'unterminated backquote' };
}

export function tokenizeShell(cmd, stopAtParen = false) {
  const tokens = [];
  const nested = [];
  const heredocs = [];
  let depth = 0;
  let cur = '';
  let has = false;
  let substitution = false;
  let segStart = 0;
  let i = 0;
  const push = () => { if (has) { tokens.push({ word: cur }); cur = ''; has = false; } };
  const op = (s) => { push(); tokens.push({ op: s }); segStart = tokens.length; };
  // Heredoc bodies start after the newline that ends the command line. A body fed to a shell is tokenized as
  // commands; a bare-delimited prose body contributes only its command substitutions; a quoted one is skipped.
  const skipHeredocBodies = () => {
    for (const h of heredocs.splice(0)) {
      const start = i;
      let bodyEnd = cmd.length;
      let next = cmd.length;
      for (let k = i; k < cmd.length;) {
        const nl = cmd.indexOf('\n', k);
        const line = cmd.slice(k, nl < 0 ? cmd.length : nl);
        if ((h.stripTabs ? line.replace(/^\t+/, '') : line) === h.delim) { bodyEnd = k; next = nl < 0 ? cmd.length : nl + 1; break; }
        if (nl < 0) break;
        k = nl + 1;
      }
      if (h.shell) {
        const inner = tokenizeShell(cmd.slice(start, bodyEnd));
        if (inner.error) return inner;
        tokens.push(...inner.tokens);
        op(';');
        if (inner.substitution) substitution = true;
      } else if (!h.quoted) {
        const body = cmd.slice(start, bodyEnd);
        for (let k = 0; k < body.length; k++) {
          if (body[k] === '\\') { k++; continue; }
          const sub = commandSubstitution(body, k);
          if (!sub) continue;
          if (sub.error) return sub;
          nested.push({ op: ';' }, ...sub.tokens);
          k = sub.end - 1;
        }
      }
      i = next;
    }
    return null;
  };
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === ')' && stopAtParen && depth === 0) { push(); return { tokens: [...tokens, ...nested], substitution, consumed: i + 1 }; }
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      if (j < 0) return { error: 'unterminated single quote' };
      cur += cmd.slice(i + 1, j); has = true; i = j + 1; continue;
    }
    if (c === '"') {
      i++;
      let s = '';
      while (i < cmd.length && cmd[i] !== '"') {
        if (cmd[i] === '\\' && cmd[i + 1] === '\n') { i += 2; continue; } // line continuation
        if (cmd[i] === '\\' && i + 1 < cmd.length && '"\\$`'.includes(cmd[i + 1])) { s += cmd[i + 1]; i += 2; continue; }
        const sub = commandSubstitution(cmd, i);
        if (sub) {
          if (sub.error) return sub;
          nested.push({ op: ';' }, ...sub.tokens);
          substitution = true; s += cmd.slice(i, sub.end); i = sub.end; continue;
        }
        if (cmd[i] === '$') substitution = true;
        s += cmd[i]; i++;
      }
      if (i >= cmd.length) return { error: 'unterminated double quote' };
      i++; cur += s; has = true; continue;
    }
    if (c === '\\') { if (cmd[i + 1] === '\n') i += 2; else if (i + 1 < cmd.length) { cur += cmd[i + 1]; has = true; i += 2; } else i++; continue; }
    if (c === '(' || c === ')') { substitution = true; depth += c === '(' ? 1 : -1; op(';'); i++; continue; }
    // The substitution's commands are analyzed separately; its output leaves a non-literal marker in this word.
    if (c === '`' || (c === '$' && cmd[i + 1] === '(')) {
      const sub = commandSubstitution(cmd, i);
      if (sub.error) return sub;
      nested.push({ op: ';' }, ...sub.tokens);
      substitution = true; cur += c; has = true; i = sub.end; continue;
    }
    if (c === '$') { substitution = true; cur += c; has = true; i++; continue; }
    if ((c === '<' || c === '>') && cmd[i + 1] === '(') { substitution = true; depth++; op(';'); i += 2; continue; }
    if (c === '<' && cmd[i + 1] === '<') {
      substitution = true;
      if (cmd[i + 2] === '<') { i += 3; continue; } // here-string: its operand is an ordinary word
      push();
      const stripTabs = cmd[i + 2] === '-';
      const d = heredocDelimiter(cmd, i + 2 + (stripTabs ? 1 : 0));
      if (d.error) return d;
      heredocs.push({ delim: d.delim, quoted: d.quoted, stripTabs, shell: tokens.slice(segStart).some(t => t.word && SHELLS.has(path.basename(t.word))) });
      i = d.end; continue;
    }
    if (c === '&' && cmd[i + 1] === '&') { op('&&'); i += 2; continue; }
    if (c === '|' && cmd[i + 1] === '|') { op('||'); i += 2; continue; }
    if (c === '|') { op('|'); i++; continue; }
    if (c === '\n') { op(';'); i++; if (heredocs.length) { const err = skipHeredocBodies(); if (err) return err; } continue; }
    if (c === ';' || c === '&') { op(';'); i++; continue; }
    if (c === '#' && !has) { const j = cmd.indexOf('\n', i); i = j < 0 ? cmd.length : j; continue; }
    if (/\s/.test(c)) { push(); i++; continue; }
    cur += c; has = true; i++;
  }
  if (stopAtParen) return { error: 'unterminated command substitution' };
  push();
  return { tokens: [...tokens, ...nested], substitution };
}

function parseGitWords(words) {
  const C = [];
  let gitDirOverride = false;
  let configOverride = false;
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (!w.startsWith('-')) return { C, gitDirOverride, configOverride, sub: w, args: words.slice(i + 1) };
    if (w === '-C') { C.push(words[i + 1] ?? null); i += 2; continue; }
    if (/^--(git-dir|work-tree)(=|$)/.test(w)) { gitDirOverride = true; i += /=/.test(w) ? 1 : 2; continue; }
    if (/^-c|^--(config-env|exec-path|namespace)(=|$)/.test(w)) configOverride = true;
    if (GIT_GLOBAL_WITH_VALUE.has(w)) { i += 2; continue; }
    i += 1;
  }
  return { C, gitDirOverride, configOverride, sub: null, args: [] };
}

/** Recognize git commit/push mutations in a shell command, with their cd/-C context and unsupported forms. */
export function analyzeCommand(command) {
  const tk = tokenizeShell(String(command ?? ''));
  if (tk.error) return { mutations: [], error: tk.error };
  const segments = [];
  let seg = { words: [], piped: false };
  for (const t of tk.tokens) {
    if (t.op) { segments.push(seg); if (t.op === '|') seg.piped = true; seg = { words: [], piped: t.op === '|' }; }
    else seg.words.push(t.word);
  }
  segments.push(seg);
  const mutations = [];
  const cdChain = [];
  for (const s of segments) {
    let words = s.words;
    if (!words.length) continue;
    let envOverride = false;
    for (;;) {
      if (RESERVED.has(words[0])) words = words.slice(1);
      else if (words[0] === 'function') words = words.slice(2);
      else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '')) { if (/^GIT_/.test(words[0])) envOverride = true; words = words.slice(1); }
      else break;
    }
    if (!words.length) continue;
    const base = { wrapper: null, amend: false, args: [], C: [], cd: [...cdChain], piped: s.piped, envOverride, gitDirOverride: false, configOverride: false, substitution: tk.substitution };
    // A command word or Git subcommand produced by expansion cannot be classified, so it is treated as an opaque mutation.
    const opaque = (w, ws) => {
      const k = ws.findIndex(nonLiteral);
      if (k < 0) return null;
      const later = ws.slice(k + 1).find(x => x === 'push' || x === 'commit');
      return later ? { ...base, kind: later, wrapper: w, opaque: true } : null;
    };
    const w0 = path.basename(words[0]);
    if (w0 === 'cd') { cdChain.push(words[1] === undefined ? os.homedir() : words[1] === '-' ? null : words[1]); continue; }
    if (WRAPPERS.has(w0)) {
      const rest = words.slice(1);
      const gitAt = rest.findIndex(w => path.basename(w) === 'git');
      if (gitAt >= 0) {
        const g = parseGitWords(rest.slice(gitAt + 1));
        if (g.sub && nonLiteral(g.sub)) mutations.push({ ...base, kind: 'push', wrapper: w0, opaque: true });
        if (g.sub === 'commit' || g.sub === 'push') mutations.push({ kind: g.sub, wrapper: w0, amend: g.args.includes('--amend'), args: g.args, C: g.C, cd: [...cdChain], piped: s.piped, envOverride, gitDirOverride: g.gitDirOverride, configOverride: g.configOverride, substitution: tk.substitution });
      }
      // A quoted command string (sh -c '...', bash -lc "...", eval "...") is one word; parse it so wrapped mutations are seen and denied.
      rest.forEach((w, i) => {
        const isScript = (w0 === 'eval' || w0 === 'watch' || /^-[A-Za-z]*c$/.test(rest[i - 1] ?? '')) && /\s/.test(w);
        if (!isScript) return;
        const inner = analyzeCommand(w);
        for (const m of inner.mutations) mutations.push({ ...m, wrapper: w0, cd: [...cdChain, ...m.cd], piped: m.piped || s.piped, envOverride: m.envOverride || envOverride });
        if (inner.error && /\bgit\b[\s\S]*\b(push|commit)\b/.test(w)) mutations.push({ ...base, kind: /\bpush\b/.test(w) ? 'push' : 'commit', wrapper: w0 });
      });
      if (gitAt < 0) { const m = opaque(w0, rest); if (m) mutations.push(m); }
      continue;
    }
    if (nonLiteral(words[0])) { const m = opaque(null, words); if (m) mutations.push(m); continue; }
    if (w0 !== 'git') continue;
    const g = parseGitWords(words.slice(1));
    if (g.sub && nonLiteral(g.sub)) mutations.push({ ...base, kind: 'push', opaque: true });
    if (g.sub === 'commit' || g.sub === 'push') {
      mutations.push({ kind: g.sub, wrapper: null, amend: g.sub === 'commit' && g.args.includes('--amend'), args: g.args, C: g.C, cd: [...cdChain], piped: s.piped, envOverride, gitDirOverride: g.gitDirOverride, configOverride: g.configOverride, substitution: tk.substitution });
    }
  }
  const nonempty = segments.filter(s => s.words.length);
  const pushOnly = nonempty.length === 1 || (nonempty.length === 2 && nonempty[0].words.length === 2 && nonempty[0].words[0] === 'cd' && tk.tokens.find(t => t.op)?.op === '&&');
  return { mutations, error: null, substitution: tk.substitution, pushOnly };
}
function expandTilde(p) { return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p; }
/** Compose literal cd ... && git -C ... directories from the hook cwd; null when a directory is not literal. */
export function resolveMutationDir(mutation, baseCwd) {
  let dir = baseCwd;
  for (const cd of mutation.cd) { if (cd === null) return null; dir = path.resolve(dir, expandTilde(cd)); }
  for (const c of mutation.C) { if (c === null) return null; dir = path.resolve(dir, expandTilde(c)); }
  return dir;
}
function unsupportedForm(m) {
  if (m.opaque) return 'non-literal command word or Git subcommand';
  if (m.wrapper) return `mutation wrapper "${m.wrapper}"`;
  if (m.substitution) return 'command substitution, variable expansion, or heredoc';
  if (m.piped) return 'pipeline';
  if (m.envOverride) return 'GIT_* environment override';
  if (m.gitDirOverride) return '--git-dir/--work-tree';
  if (m.configOverride) return '-c/--config-env/--exec-path/--namespace';
  return null;
}
export const PUSH_FIXED_ARGS = ['--no-follow-tags', '--recurse-submodules=no'];
/** The only push form the gate permits; names its worktree so the command works from any tool working directory. */
export function pushCommand(remote, sha, branch, root) {
  return `cd ${shellQuote(root)} && git push ${PUSH_FIXED_ARGS.join(' ')} ${shellQuote(remote)} ${shellQuote(`${sha}:refs/heads/${branch}`)}`;
}
/** Single-quote for the shell; the gate's tokenizer reads single quotes literally, unlike $ and ` inside double quotes. */
export function shellQuote(s) { return `'${String(s).replace(/'/g, "'\\''")}'`; }
/** The only branch-delete form the gate permits; the lease makes git refuse if the branch moved after approval. */
export function deleteCommand(remote, sha, ref, root) {
  return `cd ${shellQuote(root)} && git push ${PUSH_FIXED_ARGS.join(' ')} ${shellQuote(`--force-with-lease=${ref}:${sha}`)} ${shellQuote(remote)} ${shellQuote(`:${ref}`)}`;
}
/** owner/repo for a GitHub push URL (https, ssh, SCP) or a local path ending in github.com/<owner>/<repo>.git; else null. */
export function githubRepoFromUrl(url) {
  const s = String(url || '');
  const scp = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(s);
  if (scp) return `${scp[1]}/${scp[2]}`;
  const local = (p) => { const m = /\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git$/.exec(p); return m ? `${m[1]}/${m[2]}` : null; };
  if (s.startsWith('/')) return local(s);
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol === 'file:') return local(u.pathname);
  if ((u.protocol !== 'https:' && u.protocol !== 'ssh:') || u.hostname.toLowerCase() !== 'github.com') return null;
  const m = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(u.pathname);
  return m ? `${m[1]}/${m[2]}` : null;
}
export function remotePushUrls(root, remote, opts) {
  const r = git(root, ['remote', 'get-url', '--push', '--all', remote], { allowFail: true, ...opts });
  if (r.status !== 0) return null;
  return r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
}
export function remoteIsMirror(root, remote, opts) {
  const r = git(root, ['config', '--get', `remote.${remote}.mirror`], { allowFail: true, ...opts });
  return r.status === 0 && r.stdout.trim() === 'true';
}
/** Recognize the active candidate for a ledger: HEAD == base (awaiting) or HEAD is a sole-parent child of base. */
export function candidateStateFor(root, active, opts) {
  const head = headSha(root, opts);
  if (!head) return { state: 'unborn', head };
  if (head === active.baseSha) return { state: 'awaiting', head };
  const parents = parentsOf(root, head, opts);
  if (active.commitsInRange > 1 && active.candidateCommit === head) return { state: 'candidate', head };
  if (parents.length === 1 && parents[0] === active.baseSha) return { state: 'candidate', head };
  return { state: 'unrelated', head, parents };
}

/**
 * PreToolUse Git gate. Returns { decision: 'pass' } or { decision: 'deny', reason }.
 * Commit forms pass silently unless the resolved worktree owns an active candidate; push allows only the approved form.
 */
export function gitGateDecision({ command, cwd, home, gitOpts = {} }) {
  const analysis = analyzeCommand(command);
  if (analysis.error && /(?:^|[\s"'();|&])push(?=$|[\s"'();|&])/.test(command)) return { decision: 'deny', reason: 'debate-code: unsupported push command (invalid shell syntax); use a literal Git command.' };
  const muts = analysis.mutations;
  if (!muts.length) return { decision: 'pass' };
  const pushes = muts.filter(m => m.kind === 'push');
  if (pushes.length) {
    if (muts.length !== 1 || !analysis.pushOnly) return { decision: 'deny', reason: 'debate-code: a git push must be the only Git mutation and the whole command (optionally after one literal cd <dir> &&); Use a plain literal Git push as the whole command in a resolved unenrolled worktree; when guards are active, run the exact approved command. Resolve unknown targets to a literal Git worktree first.' };
    return pushGate(pushes[0], cwd, home, gitOpts);
  }
  const contexts = muts.map(m => {
    const dir = resolveMutationDir(m, cwd);
    const identity = dir && fs.existsSync(dir) ? repoIdentity(dir, gitOpts) : null;
    return { m, dir, identity, ledger: identity && repositoryScope(dir, { home, ...gitOpts }).effective ? loadLedger(home, identity.repoKey) : null };
  });
  const unknown = contexts.filter(c => !c.identity);
  const ownersActive = contexts.filter(c => c.ledger && c.ledger.active);
  if (!ownersActive.length) {
    if (!unknown.length) return { decision: 'pass' };
    const base = repoIdentity(cwd, gitOpts);
    const baseLedger = base && repositoryScope(cwd, { home, ...gitOpts }).effective ? loadLedger(home, base.repoKey) : null;
    if (!baseLedger || !baseLedger.active) return { decision: 'pass' };
    return { decision: 'deny', reason: `debate-code: run ${baseLedger.active.runId} owns the active candidate in ${base.worktreeRoot}; a commit whose target directory cannot be resolved literally is not allowed. Use a plain "git commit" or "git commit --amend --no-edit" in that worktree.` };
  }
  if (muts.length > 1) return { decision: 'deny', reason: `debate-code: run ${ownersActive[0].ledger.active.runId} owns the active candidate; only one Git commit per command is allowed while a candidate is active.` };
  const { m, identity, ledger } = ownersActive[0];
  const active = ledger.active;
  const form = unsupportedForm(m);
  if (form) return { decision: 'deny', reason: `debate-code: run ${active.runId} owns the active candidate in ${identity.worktreeRoot}; unsupported commit form (${form}). Use a literal "git commit -m ..." or "git commit --amend --no-edit".` };
  if (m.args.some(a => a === '--no-verify' || a === '-n')) return { decision: 'deny', reason: 'debate-code: --no-verify/-n bypasses project checks and is not allowed for an active candidate.' };
  const state = candidateStateFor(identity.worktreeRoot, active, gitOpts);
  if (state.state === 'awaiting') {
    if (m.amend) return { decision: 'deny', reason: `debate-code: run ${active.runId} is awaiting its first candidate commit; the base commit ${active.baseSha.slice(0, 12)} must never be amended. Create a new commit instead.` };
    return { decision: 'pass' };
  }
  if (state.state === 'candidate') {
    if (m.amend) return { decision: 'pass' };
    return { decision: 'deny', reason: `debate-code: run ${active.runId} (session ${active.sessionId}) already has candidate ${state.head.slice(0, 12)}; corrections must amend it: git add -A && git commit --amend --no-edit (separate tool calls). Finish or waive the run before starting another candidate.` };
  }
  return { decision: 'deny', reason: `debate-code: HEAD ${String(state.head).slice(0, 12)} is not run ${active.runId}'s candidate lineage (base ${active.baseSha.slice(0, 12)}); refusing ${m.amend ? 'an unrelated amendment' : 'a new commit'} until the run is finished, waived, or the worktree is restored.` };
}

function pushGate(m, cwd, home, gitOpts) {
  const denyDefault = (why) => ({ decision: 'deny', reason: `debate-code: unsupported push command (${why}). Resolve unknown targets to a literal Git worktree first. In a resolved unenrolled worktree, use a plain literal Git push as the whole command. When guards are active, run ${cliCommand('code approve-push')} --run <id> --remote <name> --ref refs/heads/<branch> --reason "user approved: ..." and execute the returned command verbatim; to delete a merged PR's branch, run ${cliCommand('code approve-delete')} --cwd <dir> --remote <name> --ref refs/heads/<branch> --pr <url> --reason "user approved: ..." and execute its command verbatim. Set DEBATE=off only when the user explicitly opts out of the gate.` });
  const form = unsupportedForm(m);
  if (form) return denyDefault(form);
  const dir = resolveMutationDir(m, cwd);
  if (!dir || !fs.existsSync(dir)) return denyDefault('target directory is not literal');
  const identity = repoIdentity(dir, gitOpts);
  if (!identity) return denyDefault('not a Git worktree');
  return withRepositoryScopeLock(dir, () => pushGateScoped(m, identity, home, gitOpts, denyDefault), home);
}
function pushGateScoped(m, identity, home, gitOpts, denyDefault) {
  if (!repositoryScope(identity.worktreeRoot, { home, ...gitOpts }).effective) return { decision: 'pass' };
  const args = m.args;
  if (args[0] !== PUSH_FIXED_ARGS[0] || args[1] !== PUSH_FIXED_ARGS[1]) return denyDefault('unexpected arguments');
  if (args.length === 5 && args[2].startsWith('--force-with-lease=')) return deleteGateScoped(args, identity, home, gitOpts, denyDefault);
  if (args.length !== 4) return denyDefault('unexpected arguments');
  const [, , remote, refspec] = args;
  const rm = /^([0-9a-f]{40}):(refs\/heads\/[^\s:+~^?*[\\]+)$/.exec(refspec);
  if (!rm || remote.startsWith('-')) return denyDefault('refspec must be <full-sha>:refs/heads/<branch>');
  const [, sha, destinationRef] = rm;
  const ledger = loadLedger(home, identity.repoKey);
  const approval = ledger && ledger.approvals.find(a => a.kind !== 'delete' && a.consumedAt === null && a.commitSha === sha && a.remote === remote && a.destinationRef === destinationRef);
  if (!approval) return denyDefault(`no unconsumed approval for ${sha.slice(0, 12)} → ${remote} ${destinationRef}`);
  const urls = remotePushUrls(identity.worktreeRoot, remote, gitOpts);
  if (!urls || urls.length !== 1 || urls[0] !== approval.pushUrl) return denyDefault(`remote ${remote} no longer resolves to the approved URL`);
  if (headSha(identity.worktreeRoot, gitOpts) !== sha) return denyDefault('HEAD is not the approved commit');
  if (porcelainStatus(identity.worktreeRoot, gitOpts).length) return denyDefault('worktree is not clean');
  return consumeApproval(home, identity, approval, 'push_permitted', denyDefault);
}
function deleteGateScoped(args, identity, home, gitOpts, denyDefault) {
  const [, , lease, remote, refspec] = args;
  const lm = /^--force-with-lease=(refs\/heads\/[A-Za-z0-9._/-]+):([0-9a-f]{40})$/.exec(lease);
  if (!lm || refspec !== `:${lm[1]}` || remote.startsWith('-')) return denyDefault('a branch delete must be --force-with-lease=refs/heads/<branch>:<full-sha> <remote> :refs/heads/<branch>');
  const [, destinationRef, sha] = lm;
  const ledger = loadLedger(home, identity.repoKey);
  const approval = ledger && ledger.approvals.find(a => a.kind === 'delete' && a.consumedAt === null && a.commitSha === sha && a.remote === remote && a.destinationRef === destinationRef);
  if (!approval) return denyDefault(`no unconsumed delete approval for ${destinationRef} at ${sha.slice(0, 12)} on ${remote}`);
  const urls = remotePushUrls(identity.worktreeRoot, remote, gitOpts);
  if (!urls || urls.length !== 1 || urls[0] !== approval.pushUrl) return denyDefault(`remote ${remote} no longer resolves to the approved URL`);
  return consumeApproval(home, identity, approval, 'delete_permitted', denyDefault);
}
function consumeApproval(home, identity, approval, eventType, denyDefault) {
  const { commitSha, remote, destinationRef } = approval;
  let consumed = false;
  updateLedger(home, identity, (l) => {
    const a = l.approvals.find(x => x.approvalId === approval.approvalId);
    if (!a || a.consumedAt !== null) return l;
    a.consumedAt = nowIso();
    consumed = true;
    l.pushAttempts.push({ approvalId: a.approvalId, runId: a.runId, commitSha, remote, destinationRef, at: a.consumedAt, result: 'permitted' });
    auditEvent(l, { type: eventType, approvalId: a.approvalId, runId: a.runId, sessionId: a.sessionId, commitSha, remote, destinationRef });
    return l;
  });
  if (!consumed) return denyDefault('approval was already consumed');
  return { decision: 'pass', approvalId: approval.approvalId };
}

// ---------- relays and lanes ----------

// Installed delegate-skills win so a relay pairs with its own delegate-setup; the pinned vendor copy is the fallback.
export const VENDOR_SKILLS_DIR = path.join(SKILL_DIR, 'vendor', 'delegate-skills');
/**
 * The bundled, pinned delegate-skills copy always serves the relays and lane validator, so an installed
 * delegate-skills update never changes this skill's behavior. DELEGATE_SKILLS_DIR is an explicit override.
 */
export function skillRoots() {
  return [process.env.DELEGATE_SKILLS_DIR, VENDOR_SKILLS_DIR].filter(Boolean).filter(dir => fs.existsSync(dir));
}
export function findScript(skill, script) {
  for (const root of skillRoots()) {
    const candidate = path.join(root, skill, 'scripts', script);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot find ${skill}/scripts/${script} (looked in: ${skillRoots().join(', ') || 'no skills dir'})`);
}
/**
 * Pull the JSON document out of a reviewer's final message; the last ```json block that parses wins. A block can
 * contain ``` inside a JSON string, so each opening fence is tried against every later fence, longest span first.
 * Returns null when none parses.
 */
export function extractJson(message) {
  const text = String(message || '');
  const fences = [...text.matchAll(/```/g)].map(m => m.index);
  const openings = [...text.matchAll(/```json/g)].map(m => m.index).reverse();
  for (const open of openings) {
    const start = open + '```json'.length;
    for (const close of fences.filter(f => f >= start).reverse()) {
      try { return JSON.parse(text.slice(start, close)); } catch { /* shorter span */ }
    }
  }
  if (openings.length) return null;
  try { return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { return null; }
}
export function childEnv(extra = {}) { return { ...process.env, DEBATE_CHILD: '1', ...extra }; }
export function loadLaneConfig(cwd) {
  const r = spawnSync(process.execPath, [findScript('delegate-setup', 'config.mjs'), 'load', '--cwd', cwd], { encoding: 'utf8', env: childEnv() });
  if (r.error || r.status !== 0) throw new Error((r.stderr || 'lane config load failed').trim());
  return JSON.parse(r.stdout);
}
const readOnlyProbe = new Map();
export function relaySupportsReadOnly(relayPath) {
  if (!readOnlyProbe.has(relayPath)) {
    const help = spawnSync(process.execPath, [relayPath, '--help'], { encoding: 'utf8', env: childEnv() });
    readOnlyProbe.set(relayPath, /--read-only/.test(`${help.stdout || ''}${help.stderr || ''}`));
  }
  return readOnlyProbe.get(relayPath);
}
/** Run one relay read-only. Returns { status, result, seconds, exitCode } where result is result.json or null. */
export function runRelay({ implementer, lane, briefPath, cwd, outDir, timeout, extraArgs = [], env }) {
  const relay = findScript(`${implementer}-delegate`, 'relay.mjs');
  const args = [relay, '--brief', briefPath, '--cd', cwd, '--lane', lane, '--read-only', '--out-dir', outDir, '--timeout', timeout, ...(implementer === 'codex' ? ['--ignore-user-config'] : []), ...extraArgs];
  const started = Date.now();
  const proc = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(env) });
  const seconds = Math.round((Date.now() - started) / 1000);
  const result = readJsonIfExists(path.join(outDir, 'result.json'));
  return { exitCode: proc.status, signal: proc.signal, stderrTail: String(proc.stderr || '').split('\n').slice(-20).join('\n'), result, seconds };
}
export function spawnDetached(script, args, logPath, env) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(logPath, 'a', 0o600);
  const child = spawn(process.execPath, [script, ...args], { detached: true, stdio: ['ignore', fd, fd], env: childEnv(env) });
  child.unref();
  fs.closeSync(fd);
  return child.pid;
}

// ---------- usage ----------

export function emptyUsage() { return { input: null, cacheRead: null, cacheWrite: null, output: null }; }
export function addUsage(a, b) {
  if (!b) return a;
  const out = { ...a };
  for (const k of ['input', 'cacheRead', 'cacheWrite', 'output']) {
    if (typeof b[k] === 'number') out[k] = (out[k] ?? 0) + b[k];
  }
  return out;
}
function codexUsageFromEvents(eventsPath) {
  if (!eventsPath || !fs.existsSync(eventsPath)) return null;
  let usage = null;
  for (const line of fs.readFileSync(eventsPath, 'utf8').split('\n')) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev && ev.type === 'turn.completed' && ev.usage && typeof ev.usage.input_tokens === 'number') {
      usage = addUsage(usage || emptyUsage(), {
        input: ev.usage.input_tokens,
        cacheRead: typeof ev.usage.cached_input_tokens === 'number' ? ev.usage.cached_input_tokens : undefined,
        cacheWrite: typeof ev.usage.cache_write_input_tokens === 'number' ? ev.usage.cache_write_input_tokens : undefined,
        output: typeof ev.usage.output_tokens === 'number' ? ev.usage.output_tokens : undefined,
      });
    }
  }
  return usage;
}
/** Usage, cost, reviewer session id and tripwire coverage from a relay artifact directory. */
export function usageFromRelayDir(implementer, dir) {
  const result = readJsonIfExists(path.join(dir, 'result.json'));
  const out = { usage: null, cost: null, sessionId: null, coverage: 'unreported', status: result ? result.status : 'missing' };
  if (!result) return out;
  if (implementer === 'claude') {
    const u = result.usage;
    if (u && typeof u.input_tokens === 'number') {
      const cr = u.cache_read_input_tokens ?? 0;
      const cw = u.cache_creation_input_tokens ?? 0;
      out.usage = { input: u.input_tokens + cr + cw, cacheRead: cr, cacheWrite: cw, output: u.output_tokens ?? null };
    }
    out.cost = typeof result.totalCostUsd === 'number' ? result.totalCostUsd : null;
    out.sessionId = result.sessionId || null;
  } else if (implementer === 'codex') {
    const eventsPath = result.eventsPath && !path.isAbsolute(result.eventsPath)
      ? path.join(dir, result.eventsPath)
      : (result.eventsPath || path.join(dir, 'events.jsonl'));
    out.usage = codexUsageFromEvents(eventsPath);
    out.sessionId = result.threadId || null;
  } else if (implementer === 'opencode') {
    out.cost = typeof result.cost === 'number' ? result.cost : null;
    out.sessionId = result.sessionId || null;
  }
  if (result.readOnlyViolation === true) out.coverage = 'violation';
  else if (result.readOnlyViolation === false) out.coverage = 'complete';
  else if (implementer === 'codex') out.coverage = 'sandbox';
  else if (result.readOnlyViolation === null) out.coverage = 'incomplete';
  else out.coverage = 'unreported';
  return out;
}
/**
 * Best-effort orchestrator usage inside [from, to] from the hook transcript. Claude: deduplicated assistant message
 * usage. Codex: cumulative token_count deltas; a reset yields null. Never counts reviewer sessions.
 */
export function orchestratorUsageFromTranscript(transcriptPath, from, to) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  let size;
  try { size = fs.statSync(transcriptPath).size; } catch { return null; }
  if (size > 256 * 1024 * 1024) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  const seen = new Set();
  let claude = null;
  let codexBefore = null;
  let codexLast = null;
  let sawCodex = false;
  let reset = false;
  for (const line of fs.readFileSync(transcriptPath, 'utf8').split('\n')) {
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(ev.timestamp || '');
    if (ev.type === 'assistant' && ev.message && ev.message.usage) {
      if (!(ts >= start && ts <= end)) continue;
      const key = ev.requestId || ev.message.id || ev.uuid;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      const u = ev.message.usage;
      const cr = u.cache_read_input_tokens ?? 0;
      const cw = u.cache_creation_input_tokens ?? 0;
      claude = addUsage(claude || emptyUsage(), { input: (u.input_tokens ?? 0) + cr + cw, cacheRead: cr, cacheWrite: cw, output: u.output_tokens ?? 0 });
      continue;
    }
    const payload = ev.payload || ev;
    const info = payload && payload.type === 'token_count' ? payload.info : null;
    const total = info && info.total_token_usage;
    if (total && typeof total.input_tokens === 'number') {
      sawCodex = true;
      const cur = { input: total.input_tokens, cacheRead: total.cached_input_tokens ?? null, cacheWrite: null, output: total.output_tokens ?? null };
      if (codexLast && cur.input < codexLast.input) reset = true;
      if (Number.isFinite(ts) && ts < start) codexBefore = cur;
      else if (!Number.isFinite(ts) || ts <= end) codexLast = cur;
    }
  }
  if (claude) return { ...claude, method: 'claude-transcript-window', nonAdditive: true };
  if (sawCodex) {
    if (reset || !codexLast) return null;
    const base = codexBefore || { input: 0, cacheRead: 0, output: 0 };
    return { input: codexLast.input - base.input, cacheRead: codexLast.cacheRead === null ? null : codexLast.cacheRead - (base.cacheRead ?? 0), cacheWrite: null, output: codexLast.output === null ? null : codexLast.output - (base.output ?? 0), method: 'codex-token-count-delta', nonAdditive: true };
  }
  return null;
}

// ---------- statistics ----------

export function statsPath(home) { return path.join(home, 'stats.jsonl'); }
export function readStats(home) {
  const file = statsPath(home);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
export function upsertStatsRow(home, row) {
  const file = statsPath(home);
  withLock(path.join(home, 'stats.lock'), () => {
    const rows = readStats(home).filter(r => !(r.recordType === 'run' && r.runId === row.runId));
    rows.push(row);
    writeAtomic(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  });
}
export function appendAuditRow(home, row) {
  withLock(path.join(home, 'stats.lock'), () => {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.appendFileSync(statsPath(home), `${JSON.stringify({ schema: STATS_SCHEMA, recordType: 'audit', ...row })}\n`, { mode: 0o600 });
  });
}
function tally(run) {
  const claims = { total: 0, confirmed: 0, modified: 0, discarded: 0, contested: 0, reversed: 0, missed: 0 };
  const assumptions = { raised: 0, answeredByUser: 0, settledFromRepo: 0, keptDefault: 0, open: 0 };
  const perRound = [];
  for (const round of run.rounds || []) {
    const review = round.review;
    const verdict = round.verdict;
    const findings = review ? review.findings.length : 0;
    claims.total += findings;
    if (review) assumptions.raised += (review.assumptions || []).length;
    const row = { round: round.round, attempts: round.attempts.length, findings, planRating: review ? review.rating ?? review.plan_rating ?? null : null, ratingValid: round.ratingValid, reviewRating: verdict ? verdict.review_rating : null, next: round.next, seconds: round.attempts.reduce((s, a) => s + (a.seconds || 0), 0) };
    if (verdict) {
      for (const v of verdict.verdicts) { if (v.verdict === 'confirm') claims.confirmed++; else if (v.verdict === 'modify') claims.modified++; else if (v.verdict === 'discard') claims.discarded++; }
      claims.missed += (verdict.missed || []).length;
      for (const r of verdict.contest_rulings || []) { claims.contested++; if (r.ruling === 'reverse') claims.reversed++; }
      for (const a of verdict.assumptions || []) {
        if (a.resolution === 'answered_by_user') assumptions.answeredByUser++;
        else if (a.resolution === 'settled_from_repo') assumptions.settledFromRepo++;
        else if (a.resolution === 'kept_default') assumptions.keptDefault++;
        else if (a.resolution === 'open') assumptions.open++;
      }
    }
    perRound.push(row);
  }
  return { claims, assumptions, perRound };
}
/** Project a run into its debate.stats.v1 row. */
export function statsRowFromRun(run) {
  const { claims, assumptions, perRound } = tally(run);
  const agents = [];
  let known = null;
  let complete = true;
  let anyAgent = false;
  for (const round of run.rounds || []) {
    for (const attempt of round.attempts) {
      const list = attempt.agents || (attempt.reviewer ? [{ stage: 'review', ...attempt.reviewer, usage: attempt.usage, cost: attempt.cost, seconds: attempt.seconds, sessionId: attempt.reviewerSessionId, coverage: attempt.coverage }] : []);
      for (const a of list) {
        anyAgent = true;
        agents.push({ round: round.round, attempt: attempt.attempt, stage: a.stage, lane: a.lane, implementer: a.implementer, model: a.model ?? null, requestedModel: a.requestedModel ?? a.model ?? null, servedModel: a.servedModel ?? null, sameModelAsOrchestrator: run.orchestratorModel && a.servedModel ? run.orchestratorModel === a.servedModel : null, dials: a.dials ?? null, sessionId: a.sessionId ?? null, seconds: a.seconds ?? null, usage: a.usage ?? null, cost: a.cost ?? null, coverage: a.coverage ?? 'unreported', status: a.status ?? attempt.status });
        if (a.usage) { known = addUsage(known || emptyUsage(), a.usage); } else complete = false;
      }
    }
  }
  const ratingsPlan = (run.rounds || []).filter(r => r.review).map(r => ({ round: r.round, value: r.review.rating, valid: r.ratingValid === true }));
  const ratingsReview = (run.rounds || []).filter(r => r.verdict).map(r => r.verdict.review_rating);
  const failedAttempts = (run.rounds || []).flatMap(r => r.attempts).filter(a => a.status === 'failed').length;
  const startedAt = run.createdAt;
  const finishedAt = run.finishedAt || null;
  const durationSec = finishedAt ? Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000) : null;
  const code = run.code || {};
  return {
    schema: STATS_SCHEMA, recordType: 'run', kind: run.kind, runId: run.runId, seat: run.seat, sessionId: run.sessionId, cwd: run.cwd,
    planPath: run.plan ? run.plan.sourcePath : null, repoKey: code.repoKey ?? null, baseSha: code.baseSha ?? null, candidateCommit: code.candidateCommit ?? null,
    candidateTree: code.candidateTree ?? null, adopted: code.adopted === true, commitsInRange: code.commitsInRange ?? null,
    startedAt, finishedAt, durationSec, status: run.status, outcome: run.outcome, stopReason: run.stopReason ?? null,
    rounds: (run.rounds || []).length, ratings: { plan: ratingsPlan, review: ratingsReview },
    claims, assumptions, perRound, agents,
    ...((run.rounds || []).some(r => r.attempts.some(a => a.promptSizes?.length)) ? { promptSizes: run.rounds.flatMap(r => r.attempts.flatMap(a => (a.promptSizes || []).map(size => ({ round: r.round, attempt: a.attempt, ...size })))) } : {}),
    reviewerFailures: failedAttempts, retryUsed: run.retryUsed === true,
    orchestratorModel: run.orchestratorModel ?? null, recoveries: run.recoveries ?? [], selfReview: run.selfReview ? { report: run.selfReview.report, snapshot: run.selfReview.snapshot, independent: false } : null,
    tokens: { reviewerKnown: known || {}, complete: anyAgent && complete, orchestrator: run.orchestratorUsage ?? null },
    operations: { baselineEvents: run.operations?.baselineEvents || [], deferrals: run.operations?.deferrals || [], waivers: run.waiver ? [run.waiver] : [], pushApprovals: (run.approvals || []).map(a => ({ approvalId: a.approvalId, remote: a.remote, destinationRef: a.destinationRef, at: a.at, consumedAt: a.consumedAt })) },
    warnings: run.warnings || [],
  };
}
function ratio(n, d) { return d > 0 ? Number((n / d).toFixed(4)) : null; }
export function computeStats(rows, { kind, seat, since } = {}) {
  const sinceMs = since ? Date.now() - since : null;
  const runs = rows.filter(r => r.recordType === 'run' && (!kind || r.kind === kind) && (!seat || r.seat === seat) && (!sinceMs || Date.parse(r.startedAt) >= sinceMs));
  const audits = rows.filter(r => r.recordType === 'audit' && (!seat || r.seat === seat) && (!sinceMs || Date.parse(r.at) >= sinceMs));
  const sum = (f) => runs.reduce((s, r) => s + (f(r) || 0), 0);
  const claims = { total: sum(r => r.claims.total), confirmed: sum(r => r.claims.confirmed), modified: sum(r => r.claims.modified), discarded: sum(r => r.claims.discarded), contested: sum(r => r.claims.contested), reversed: sum(r => r.claims.reversed), missed: sum(r => r.claims.missed) };
  const validatedCorrect = claims.confirmed + claims.modified;
  const attempts = runs.reduce((s, r) => s + r.perRound.reduce((x, p) => x + (p.attempts || 0), 0), 0);
  const failures = sum(r => r.reviewerFailures);
  const tokensKnown = runs.reduce((acc, r) => addUsage(acc, r.tokens.reviewerKnown && typeof r.tokens.reviewerKnown.input === 'number' ? r.tokens.reviewerKnown : null), emptyUsage());
  const outcomes = {};
  for (const r of runs) outcomes[r.outcome || r.status] = (outcomes[r.outcome || r.status] || 0) + 1;
  const planMovement = runs.map(r => { const valid = r.ratings.plan.filter(p => p.valid); return valid.length ? { runId: r.runId, first: r.ratings.plan[0].value, lastValid: valid[valid.length - 1].value } : null; }).filter(Boolean);
  const reviewRatings = runs.flatMap(r => r.ratings.review);
  const durations = runs.map(r => r.durationSec).filter(d => typeof d === 'number');
  return {
    runs: runs.length, audits: audits.length, outcomes,
    rounds: { total: sum(r => r.rounds), averagePerRun: ratio(sum(r => r.rounds), runs.length) },
    elapsed: { totalSec: durations.reduce((a, b) => a + b, 0), averageSec: ratio(durations.reduce((a, b) => a + b, 0), durations.length) },
    claims: { ...claims, validatedCorrect, validatedWrong: claims.discarded, precision: ratio(validatedCorrect, claims.total), discardRate: ratio(claims.discarded, claims.total), contestReversalRate: ratio(claims.reversed, claims.contested) },
    reviewer: { attempts, failures, failureRate: ratio(failures, attempts) },
    ratings: { planMovement, reviewAverage: ratio(reviewRatings.reduce((a, b) => a + b, 0), reviewRatings.length) },
    tokens: { reviewerKnown: tokensKnown, complete: runs.length > 0 && runs.every(r => r.tokens.complete), perAcceptedClaim: typeof tokensKnown.input === 'number' ? ratio(tokensKnown.input, validatedCorrect) : null, orchestratorNonAdditive: true },
    byLane: laneBreakdown(runs),
  };
}
function laneBreakdown(runs) {
  const out = {};
  for (const r of runs) for (const a of r.agents || []) {
    const key = a.lane || 'unknown';
    out[key] = out[key] || { agents: 0, seconds: 0, usage: emptyUsage(), cost: 0 };
    out[key].agents++;
    out[key].seconds += a.seconds || 0;
    out[key].usage = addUsage(out[key].usage, a.usage);
    out[key].cost += a.cost || 0;
  }
  return out;
}

// ---------- reviewer output and verdict validation ----------

const AXES = new Set(['correctness', 'completeness', 'risk', 'scope', 'feasibility', 'verification', 'assumptions']);
const SEVERITIES = new Set(['blocking', 'non-blocking']);
function isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }

/** Validate debate-plan.review.v1. Returns { ok, errors, warnings, doc } with sub-0.5 findings dropped. */
export function validatePlanReview(doc, { round, usedFindingIds = new Set(), usedAssumptionIds = new Set(), priorContestIds = [] }) {
  const errors = [];
  const warnings = [];
  if (!doc || typeof doc !== 'object') return { ok: false, errors: ['review is not a JSON object'], warnings };
  if (doc.schema !== REVIEW_SCHEMA) errors.push(`schema must be ${REVIEW_SCHEMA}`);
  if (doc.round !== round) errors.push(`round must be ${round}`);
  if (!Number.isInteger(doc.plan_rating) || doc.plan_rating < 1 || doc.plan_rating > 10) errors.push('plan_rating must be an integer 1..10');
  if (!isNonEmptyString(doc.summary)) errors.push('summary must be a non-empty string');
  const findings = Array.isArray(doc.findings) ? doc.findings : (errors.push('findings must be an array'), []);
  const seen = new Set();
  const kept = [];
  findings.forEach((f, i) => {
    const where = `findings[${i}]`;
    if (!f || typeof f !== 'object') { errors.push(`${where} is not an object`); return; }
    if (!/^F\d+$/.test(String(f.id))) errors.push(`${where} id must look like F<n>`);
    else if (seen.has(f.id) || usedFindingIds.has(f.id)) errors.push(`${where} reuses id ${f.id}`);
    seen.add(f.id);
    if (!SEVERITIES.has(f.severity)) errors.push(`${where} severity must be blocking|non-blocking`);
    if (!AXES.has(f.axis)) errors.push(`${where} axis is not one of ${[...AXES].join('|')}`);
    if (typeof f.confidence !== 'number' || !(f.confidence >= 0 && f.confidence <= 1)) errors.push(`${where} confidence must be a number in 0..1`);
    for (const k of ['where', 'claim', 'evidence', 'recommendation']) if (!isNonEmptyString(f[k])) errors.push(`${where} ${k} must be a non-empty string`);
    if (typeof f.confidence === 'number' && f.confidence < 0.5) { warnings.push(`dropped ${f.id}: confidence ${f.confidence} below 0.5`); return; }
    kept.push(f);
  });
  const assumptions = Array.isArray(doc.assumptions) ? doc.assumptions : (errors.push('assumptions must be an array'), []);
  const seenA = new Set();
  assumptions.forEach((a, i) => {
    const where = `assumptions[${i}]`;
    if (!a || typeof a !== 'object') { errors.push(`${where} is not an object`); return; }
    if (!/^A\d+$/.test(String(a.id))) errors.push(`${where} id must look like A<n>`);
    else if (seenA.has(a.id) || usedAssumptionIds.has(a.id)) errors.push(`${where} reuses id ${a.id}`);
    seenA.add(a.id);
    if (!isNonEmptyString(a.decision) || !isNonEmptyString(a.recommended)) errors.push(`${where} needs decision and recommended`);
    if (!Array.isArray(a.options) || !a.options.every(isNonEmptyString)) errors.push(`${where} options must be strings`);
  });
  const rawContests = Array.isArray(doc.contests) ? doc.contests : (errors.push('contests must be an array'), []);
  const answered = new Set();
  const expected = new Set(priorContestIds);
  const contests = [];
  rawContests.forEach((c, i) => {
    const where = `contests[${i}]`;
    if (!c || typeof c !== 'object') { errors.push(`${where} is not an object`); return; }
    // reviewers often re-affirm confirmed verdicts too; only modify/discard verdicts are contestable, the rest is noise, not a bad review
    if (!expected.has(c.id)) { warnings.push(`${where} ignored: ${c.id} is not a prior modify/discard verdict (stance ${c.stance})`); return; }
    if (answered.has(c.id)) errors.push(`${where} duplicates ${c.id}`);
    answered.add(c.id);
    if (!['accept', 'contest'].includes(c.stance)) errors.push(`${where} stance must be accept|contest`);
    if (c.stance === 'contest' && !isNonEmptyString(c.evidence)) errors.push(`${where} contest requires evidence`);
    if (!isNonEmptyString(c.reason)) errors.push(`${where} needs a reason`);
    contests.push(c);
  });
  for (const id of expected) if (!answered.has(id)) errors.push(`prior verdict ${id} was neither accepted nor contested`);
  return { ok: errors.length === 0, errors, warnings, doc: errors.length ? null : { rating: doc.plan_rating, summary: doc.summary, findings: kept, assumptions, contests } };
}

const VERDICTS = new Set(['confirm', 'modify', 'discard']);
const RULINGS = new Set(['uphold', 'reverse']);
const RESOLUTIONS = new Set(['answered_by_user', 'settled_from_repo', 'kept_default', 'open']);
/** Validate an orchestrator verdict file against the round's findings, contests and known assumptions. */
export function validateVerdictDoc(doc, { findingIds, contestedIds = [], assumptionIds = new Set(), code = false }) {
  const errors = [];
  if (!doc || typeof doc !== 'object') return { ok: false, errors: ['verdict file is not a JSON object'] };
  if (!Number.isInteger(doc.review_rating) || doc.review_rating < 1 || doc.review_rating > 10) errors.push('review_rating must be an integer 1..10');
  if (doc.no_further_review !== undefined && typeof doc.no_further_review !== 'boolean') errors.push('no_further_review must be a boolean');
  const verdicts = Array.isArray(doc.verdicts) ? doc.verdicts : (errors.push('verdicts must be an array'), []);
  const seen = new Set();
  const expected = new Set(findingIds);
  verdicts.forEach((v, i) => {
    const where = `verdicts[${i}]`;
    if (!v || typeof v !== 'object') { errors.push(`${where} is not an object`); return; }
    if (!expected.has(v.id)) errors.push(`${where} covers unknown finding ${v.id}`);
    if (seen.has(v.id)) errors.push(`${where} duplicates ${v.id}`);
    seen.add(v.id);
    if (!VERDICTS.has(v.verdict)) errors.push(`${where} verdict must be confirm|modify|discard`);
    if (!isNonEmptyString(v.reason)) errors.push(`${where} needs a reason`);
    if (v.evidence !== undefined && typeof v.evidence !== 'string') errors.push(`${where} evidence must be a string`);
    if (v.change !== undefined && typeof v.change !== 'string') errors.push(`${where} change must be a string`);
    if (code && v.fixed !== undefined && typeof v.fixed !== 'boolean') errors.push(`${where} fixed must be a boolean`);
  });
  for (const id of expected) if (!seen.has(id)) errors.push(`finding ${id} has no verdict`);
  const rulings = Array.isArray(doc.contest_rulings) ? doc.contest_rulings : (errors.push('contest_rulings must be an array'), []);
  const seenR = new Set();
  const expectedR = new Set(contestedIds);
  rulings.forEach((r, i) => {
    const where = `contest_rulings[${i}]`;
    if (!r || typeof r !== 'object') { errors.push(`${where} is not an object`); return; }
    if (!expectedR.has(r.id)) errors.push(`${where} rules on ${r.id}, which was not contested this round`);
    if (seenR.has(r.id)) errors.push(`${where} duplicates ${r.id}`);
    seenR.add(r.id);
    if (!RULINGS.has(r.ruling)) errors.push(`${where} ruling must be uphold|reverse`);
    if (!isNonEmptyString(r.reason)) errors.push(`${where} needs a reason`);
  });
  for (const id of expectedR) if (!seenR.has(id)) errors.push(`contest on ${id} has no ruling`);
  const assumptions = Array.isArray(doc.assumptions) ? doc.assumptions : (errors.push('assumptions must be an array'), []);
  assumptions.forEach((a, i) => {
    const where = `assumptions[${i}]`;
    if (!a || typeof a !== 'object') { errors.push(`${where} is not an object`); return; }
    if (!assumptionIds.has(a.id)) errors.push(`${where} resolves unknown assumption ${a.id}`);
    if (!RESOLUTIONS.has(a.resolution)) errors.push(`${where} resolution must be answered_by_user|settled_from_repo|kept_default|open`);
    if (a.changed_plan !== undefined && typeof a.changed_plan !== 'boolean') errors.push(`${where} changed_plan must be a boolean`);
  });
  const missed = Array.isArray(doc.missed) ? doc.missed : (errors.push('missed must be an array'), []);
  missed.forEach((m, i) => { if (!m || !isNonEmptyString(m.claim)) errors.push(`missed[${i}] needs a claim`); });
  if (code) {
    const checks = doc.checks === undefined ? [] : doc.checks;
    if (!Array.isArray(checks)) errors.push('checks must be an array');
    else checks.forEach((c, i) => { if (!c || !isNonEmptyString(c.command) || !isNonEmptyString(c.result)) errors.push(`checks[${i}] needs command and result`); });
  }
  return { ok: errors.length === 0, errors };
}
/** A missed entry with a change or fix is content the reviewer never saw, so the round cannot end as agreed. */
export function missedDeclaresChange(doc) { return (doc.missed || []).some(m => isNonEmptyString(m.change) || m.fixed === true); }
/** A verdict declares a change when any verdict/missed carries a change, a verdict is fixed, or an assumption changed the plan. */
export function verdictDeclaresChange(doc) {
  return (doc.verdicts || []).some(v => isNonEmptyString(v.change) || v.fixed === true)
    || missedDeclaresChange(doc)
    || (doc.assumptions || []).some(a => a.changed_plan === true);
}

// ---------- transcript helpers for hooks ----------

/** Last plan file path mentioned in a Claude transcript (tail scan; bounded work for hooks). */
export function planPathFromTranscript(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const want = Math.min(size, 8 * 1024 * 1024);
    const buf = Buffer.alloc(want);
    fs.readSync(fd, buf, 0, want, size - want);
    const text = buf.toString('utf8');
    const matches = [...text.matchAll(/"planFilePath":"((?:[^"\\]|\\.)*)"/g)];
    if (matches.length) return JSON.parse(`"${matches[matches.length - 1][1]}"`);
    const fallback = [...text.matchAll(/create your plan at (\/[^\s"\\]+\.md)/g)];
    if (fallback.length) return fallback[fallback.length - 1][1];
    return null;
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
/** Exactly one top-level <proposed_plan> block outside fences; returns { body } or { error }. */
export function extractProposedPlan(message) {
  const lines = String(message || '').split('\n');
  const mask = fenceMask(lines);
  const opens = [];
  const closes = [];
  lines.forEach((line, i) => {
    if (mask[i]) return;
    if (/<proposed_plan>/.test(line)) opens.push(i);
    if (/<\/proposed_plan>/.test(line)) closes.push(i);
  });
  if (opens.length === 0 && closes.length === 0) return { body: null, error: null };
  if (opens.length !== 1 || closes.length !== 1 || closes[0] < opens[0]) return { body: null, error: `expected exactly one proposed_plan block, found ${opens.length} opening and ${closes.length} closing tags` };
  const inner = lines.slice(opens[0], closes[0] + 1).join('\n');
  const start = inner.indexOf('<proposed_plan>') + '<proposed_plan>'.length;
  const end = inner.lastIndexOf('</proposed_plan>');
  return { body: inner.slice(start, end).replace(/^\n/, ''), error: null };
}

// ---------- CLI plumbing shared by both entry points ----------

export function parseArgs(argv, { booleans = [], values = [] } = {}) {
  const flags = {};
  const positional = [];
  const bool = new Set(booleans);
  const val = new Set(values);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { flags.help = true; continue; }
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const eq = arg.indexOf('=');
    const name = (eq > 0 ? arg.slice(2, eq) : arg.slice(2)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (bool.has(name)) { flags[name] = true; continue; }
    if (!val.has(name)) throw usage(`unknown option ${arg}`);
    const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined) throw usage(`${arg} requires a value`);
    flags[name] = value;
  }
  return { flags, positional };
}
export async function runCli(main, argv = process.argv.slice(2)) {
  try {
    const code = await main(argv);
    process.exitCode = Number.isInteger(code) ? code : 0;
  } catch (e) {
    if (e && e.usage) {
      printJson({ ok: false, error: { code: 'usage', message: e.message, details: e.details ?? null } });
      process.exitCode = 2;
      return;
    }
    log(`internal failure: ${e && e.stack ? e.stack : e}`);
    printJson({ ok: false, error: { code: 'internal', message: e && e.message ? e.message : String(e) } });
    process.exitCode = 1;
  }
}
export function requireWritableHome(home) {
  const problem = probeWritable(home);
  if (problem) throw usage(`DEBATE_HOME check failed: ${problem}`);
}
export function readPlanArg(value) {
  if (value === undefined) throw usage('--plan <file|-> is required');
  if (value === '-') return { body: readStdin(), sourcePath: null, origin: 'stdin' };
  const file = path.resolve(value);
  let body;
  try { body = fs.readFileSync(file, 'utf8'); } catch (e) { throw usage(`cannot read plan ${file}: ${e.message}`); }
  return { body, sourcePath: file, origin: 'file' };
}
export function resolveCwdArg(value) {
  if (!value) throw usage('--cwd <dir> is required');
  const dir = path.resolve(value);
  let st;
  try { st = fs.statSync(dir); } catch { throw usage(`--cwd ${dir} does not exist`); }
  if (!st.isDirectory()) throw usage(`--cwd ${dir} is not a directory`);
  return fs.realpathSync(dir);
}
export function statsCommand(flags, home) {
  if (flags.kind && !['plan', 'code'].includes(flags.kind)) throw usage('--kind must be plan|code');
  if (flags.seat) validateSeat(flags.seat);
  let since = null;
  if (flags.since) {
    const m = /^(\d+)([dhm])$/.exec(flags.since);
    if (!m) throw usage('--since must look like 30d, 12h, or 90m');
    since = Number(m[1]) * ({ d: 86_400_000, h: 3_600_000, m: 60_000 })[m[2]];
  }
  const rows = readStats(home);
  const summary = computeStats(rows, { kind: flags.kind, seat: flags.seat, since });
  const doc = { ok: true, home, filters: { kind: flags.kind || null, seat: flags.seat || null, since: flags.since || null }, summary };
  if (flags.json) doc.rows = rows.filter(r => (!flags.kind || r.kind === flags.kind) && (!flags.seat || r.seat === flags.seat));
  printJson(doc);
  return 0;
}
export function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  const toReal = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return toReal(process.argv[1]) === toReal(fileURLToPath(metaUrl));
}
