// code.mjs — `debate.mjs code`: review a local candidate commit with the `review --local` backend before completion reporting.
// Candidate lifecycle: begin (or adopt) → commit/amend → review → verdict → finish; waive, defer, baseline and
// approve-push/approve-delete are audited bookkeeping. Commands print one JSON document; diagnostics go to stderr.
// Exit 0: structured result (including preflight/backend failures); 2: usage/config error; 1: internal failure.
// Importing this module has no side effects.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  RUN_SCHEMA, MAX_ROUNDS, CODE_REVIEW_LANES, SHA_RE, usage, nowIso, log, printJson, isPidAlive, sleepMs, newEventId,
  debateHome, ensureHome, requireWritableHome, readJsonIfExists, createRun, loadRun, updateRun, runDir,
  loadSession, updateSession, loadLedger, updateLedger, auditEvent, validateSeat, sessionIdFor, sessionKey, validateRunId,
  resolveCwdArg, parseDuration, git, gitText, repoIdentity, headSha, resolveCommit, treeOf, parentsOf, branchOf, isAncestor,
  commitsInRange as listCommits, startFingerprint, porcelainStatus, hasUnmerged, hasHiddenIndexBits, dirtySubmodules,
  remoteContains, remotePushUrls, remoteIsMirror, pushCommand, deleteCommand, githubRepoFromUrl, candidateStateFor, scanDiffForSecrets, SEATS, CLI, cliCommand,
  loadLaneConfig, childEnv, spawnDetached, usageFromRelayDir, addUsage, emptyUsage, validateVerdictDoc, verdictDeclaresChange, missedDeclaresChange,
  orchestratorUsageFromTranscript, upsertStatsRow, appendAuditRow, statsRowFromRun, statsCommand, parseArgs,
  scopeWarning, withRepositoryScopeLock,
} from './lib/common.mjs';
import { failReviewAttempt, failureDetails, needsUserDecision, validateResume, authorizeResume, recordSelfReview, requireFinishDecision, resolveReviewOverride, modelIdentity, orchestratorModel } from './lib/recovery.mjs';

const DEFAULT_TIMEOUT = '30m';
export const TERMINAL_OUTCOMES = new Set(['passed', 'waived']);

const HELP = `debate.mjs code — review a local candidate commit with the review backend before completion reporting

Usage:
  baseline --cwd <dir> --seat <seat> --session <id> --base <commit> --reason <text>
  begin --cwd <dir> --seat <seat> --session <id> [--base <commit>]
  begin --cwd <dir> --seat <seat> --session <id> --adopt [--base <commit>] --reason <unpublished-evidence>
  review --run <id> [--detach] [--timeout 30m] [--retry]
  resume --run <id> --seat <seat> --session <id> --reason "user authorized: <quote>" [--main-lane <lane>] [--debate-lane <lane>] [--detach]
  wait --run <id> [--max-wait 60s]
  verdict --run <id> --round <n> --verdicts <file>
  finish --run <id> [--self-review <report> --reason "user authorized: <quote>"]
  defer --cwd <dir> --seat <seat> --session <id> --reason <text>
  waive --run <id> --reason <text>
  approve-push --run <id> --remote <name> --ref <refs/heads/name> --reason <user-approval-quote>
  approve-delete --cwd <dir> --remote <name> --ref <refs/heads/name> --pr <github-pr-url> --reason <user-approval-quote>
  stats [--kind plan|code] [--seat <seat>] [--since 30d] [--json]

Seats: ${SEATS.join('|')}.

Environment: DEBATE_HOME (default ~/.local/share/debate). --help never launches a model.
`;

// ---------- run model ----------

export function newCodeRun({ seat, sessionId, cwd, identity, baseSha, branch, adopted, adoptionEvidence, commitsInRange, candidateCommit, candidateTree, timeout }) {
  const now = nowIso();
  return {
    schema: RUN_SCHEMA, kind: 'code', runId: crypto.randomUUID(), seat, sessionId, sessionKey: sessionKey(seat, sessionId), cwd,
    createdAt: now, updatedAt: now, finishedAt: null, status: 'new', stopReason: null, outcome: null, retryUsed: false,
    timeout, rounds: [], warnings: [], preflight: null,
    code: { repoKey: identity.repoKey, worktreeRoot: identity.worktreeRoot, gitDir: identity.gitDir, baseSha, branch, phase: adopted ? 'candidate' : 'awaiting_commit', candidateCommit, candidateTree, adopted, adoptionEvidence, commitsInRange, reviewedTree: null, reviewedCommit: null, checks: [], secretScan: null, nothingToReview: false },
    approvals: [], waiver: null, operations: { baselineEvents: [], deferrals: [] },
  };
}
function currentRound(run) { return run.rounds[run.rounds.length - 1] || null; }
function currentAttempt(round) { return round ? round.attempts[round.attempts.length - 1] || null : null; }
function sumAgents(agents) {
  let usage = null;
  let cost = null;
  let complete = true;
  for (const a of agents || []) {
    if (a.usage) usage = addUsage(usage || emptyUsage(), a.usage); else complete = false;
    if (typeof a.cost === 'number') cost = (cost ?? 0) + a.cost;
  }
  return { usage, cost, complete };
}
export function codeDoc(run, extra = {}) {
  const round = currentRound(run);
  const attempt = currentAttempt(round);
  const sums = sumAgents(attempt ? attempt.agents : []);
  return {
    ok: true, runId: run.runId, kind: 'code', seat: run.seat, round: round ? round.round : 0, attempt: attempt ? attempt.attempt : 0,
    status: attempt ? attempt.status : run.preflight ? run.preflight.status : run.status,
    runStatus: run.status, stopReason: run.stopReason, outcome: run.outcome, retryUsed: run.retryUsed,
    retryAvailable: run.status === 'review_failed' && !run.retryUsed,
    needsUserDecision: needsUserDecision(run), failureDetails: attempt?.failureDetails ?? null,
    baseSha: run.code.baseSha, branch: run.code.branch, candidateCommit: run.code.candidateCommit, candidateTree: run.code.candidateTree,
    adopted: run.code.adopted, commitsInRange: run.code.commitsInRange, phase: run.code.phase,
    summary: round && round.review ? round.review.summary : null,
    findings: round && round.review ? round.review.findings : [],
    assumptions: [], contests: [],
    usage: sums.usage, cost: sums.cost, tokensComplete: sums.complete, seconds: attempt ? attempt.seconds : null,
    agents: attempt ? attempt.agents : [],
    orchestratorModel: run.orchestratorModel ?? null,
    secretScan: run.code.secretScan, nothingToReview: run.code.nothingToReview,
    error: attempt && attempt.error ? attempt.error : run.preflight ? run.preflight.reason : null,
    artifacts: { runDir: runDir(debateHome(), run.runId), attemptDir: attempt ? path.join(runDir(debateHome(), run.runId), attempt.dir) : null },
    warnings: [...run.warnings, ...(round ? round.warnings : []), ...((attempt && attempt.warnings) || [])],
    ...extra,
  };
}

// ---------- identity helpers ----------

function identityFor(cwd) {
  const identity = repoIdentity(cwd);
  if (!identity) throw usage(`${cwd} is not inside a Git work tree`);
  return identity;
}
function requireRunIdentity(run) {
  const identity = identityFor(run.cwd);
  if (identity.repoKey !== run.code.repoKey) throw usage(`run ${run.runId} belongs to a different worktree (${run.code.worktreeRoot})`);
  return identity;
}
function requireActive(home, run) {
  const ledger = loadLedger(home, run.code.repoKey);
  if (!ledger || !ledger.active || ledger.active.runId !== run.runId) throw usage(`run ${run.runId} is not the active candidate of ${run.code.worktreeRoot}${ledger && ledger.active ? ` (active: ${ledger.active.runId})` : ''}`);
  return ledger;
}
function baselineFor(ledger, key) { return ledger && ledger.baselines ? ledger.baselines[key] || null : null; }
function baselineRecord({ seat, sessionId, root, headSha: sha, source, reason, runId }) {
  return { seat, sessionId, headSha: sha, branch: branchOf(root), startFingerprint: startFingerprint(root), at: nowIso(), source, reason: reason ?? null, runId: runId ?? null, eventId: newEventId() };
}

// ---------- baseline / begin / adoption ----------

function baselineCommand(flags) {
  const home = debateHome();
  requireWritableHome(home);
  const seat = validateSeat(flags.seat);
  const sessionId = sessionIdFor(seat, flags.session);
  const cwd = resolveCwdArg(flags.cwd);
  if (!flags.base) throw usage('--base <commit> is required');
  if (!flags.reason || !flags.reason.trim()) throw usage('--reason <text> is required');
  const identity = identityFor(cwd);
  const root = identity.worktreeRoot;
  const base = resolveCommit(root, flags.base);
  if (!base) throw usage(`--base ${flags.base} is not a commit`);
  const key = sessionKey(seat, sessionId);
  const head = headSha(root);
  const record = baselineRecord({ seat, sessionId, root, headSha: base, source: 'explicit', reason: flags.reason });
  let event;
  updateLedger(home, identity, (l) => {
    l.baselines[key] = record;
    event = auditEvent(l, { type: 'baseline_registered', seat, sessionId, headSha: base, currentHead: head, reason: flags.reason, eventId: record.eventId });
    return l;
  });
  const session = updateSession(home, seat, sessionId, (s) => { s.cwd = s.cwd || cwd; return s; });
  appendAuditRow(home, { type: 'baseline_registered', eventId: record.eventId, kind: 'code', seat, sessionId, generation: session.generation, repoKey: identity.repoKey, headSha: base, currentHead: head, reason: flags.reason, at: record.at });
  printJson({ ok: true, baseline: record, currentHead: head, headMatchesBase: head === base, repoKey: identity.repoKey, worktreeRoot: root, audit: event });
  return 0;
}

export function adoptionCheck(root, { baseArg, reason }) {
  const head = headSha(root);
  if (!head) return { ok: false, status: 'unsupported_state', reason: 'unborn HEAD: nothing to adopt' };
  if (!reason || !reason.trim()) return { ok: false, status: 'missing_evidence', reason: 'adoption requires --reason with evidence that the candidate is unpublished (observed local creation without push, or explicit user confirmation)' };
  const parents = parentsOf(root, head);
  let baseSha;
  let range;
  if (!baseArg) {
    if (parents.length !== 1) return { ok: false, status: 'parent_mismatch', reason: `HEAD ${head.slice(0, 12)} has ${parents.length} parents; adoption needs a sole-parent candidate (root and merge commits are unsupported)`, expectedParents: 1, actualParents: parents };
    baseSha = parents[0];
    range = [{ sha: head, parents }];
  } else {
    baseSha = resolveCommit(root, baseArg);
    if (!baseSha) return { ok: false, status: 'unsupported_state', reason: `--base ${baseArg} is not a commit` };
    if (parents.length === 1 && parents[0] === baseSha) range = [{ sha: head, parents }];
    else {
      if (baseSha === head) return { ok: false, status: 'parent_mismatch', reason: 'base equals HEAD: nothing to adopt', expectedParents: [baseSha], actualParents: parents };
      if (!isAncestor(root, baseSha, head)) return { ok: false, status: 'parent_mismatch', reason: `base ${baseSha.slice(0, 12)} is not an ancestor of HEAD ${head.slice(0, 12)}`, expectedParents: [baseSha], actualParents: parents };
      range = listCommits(root, baseSha, head);
      const merge = range.find(c => c.parents.length !== 1);
      if (merge) return { ok: false, status: 'unsupported_state', reason: `commit ${merge.sha.slice(0, 12)} in ${baseSha.slice(0, 7)}..HEAD has ${merge.parents.length} parents; only non-merge ranges can be adopted` };
    }
  }
  if (range.length !== 1) return { ok: false, status: 'unsupported_state', reason: 'squash the unpublished range to one commit before begin --adopt; base must be its sole parent' };
  for (const c of range) {
    const refs = remoteContains(root, c.sha);
    if (refs.length) return { ok: false, status: 'published', reason: `commit ${c.sha.slice(0, 12)} is already on remote-tracking ref ${refs[0]}; published history is never adopted or amended` };
  }
  return { ok: true, head, baseSha, commits: range.map(c => c.sha), commitsInRange: range.length };
}

const runSaved = (home, runId) => fs.existsSync(path.join(runDir(home, runId), 'run.json'));
function beginCommand(flags) {
  const home = debateHome();
  requireWritableHome(home);
  const seat = validateSeat(flags.seat);
  const sessionId = sessionIdFor(seat, flags.session);
  const cwd = resolveCwdArg(flags.cwd);
  const timeout = flags.timeout || DEFAULT_TIMEOUT;
  if (!parseDuration(timeout)) throw usage('--timeout must be a duration like 30m');
  const identity = identityFor(cwd);
  const root = identity.worktreeRoot;
  const existing = loadLedger(home, identity.repoKey);
  if (existing && existing.active && runSaved(home, existing.active.runId)) {
    printJson({ ok: false, status: 'candidate_busy', runId: existing.active.runId, owner: { seat: existing.active.seat, sessionId: existing.active.sessionId }, baseSha: existing.active.baseSha, candidateCommit: existing.active.candidateCommit, reason: `worktree ${root} already has an active candidate owned by run ${existing.active.runId} (session ${existing.active.sessionId}); finish or waive it first` });
    return 0;
  }
  const head = headSha(root);
  if (!head) throw usage('unborn HEAD: create the first commit before using debate-code');
  const branch = branchOf(root);
  let run;
  let adoption = null;
  if (flags.adopt) {
    adoption = adoptionCheck(root, { baseArg: flags.base, reason: flags.reason });
    if (!adoption.ok) { printJson({ ok: false, status: adoption.status, reason: adoption.reason, expectedParents: adoption.expectedParents ?? null, actualParents: adoption.actualParents ?? null, head }); return 0; }
    if (existing && existing.publications.some(p => adoption.commits.includes(p.commitSha))) { printJson({ ok: false, status: 'published', reason: 'a commit in the range is recorded as published in this worktree ledger', head }); return 0; }
    run = newCodeRun({ seat, sessionId, cwd, identity, baseSha: adoption.baseSha, branch, adopted: true, adoptionEvidence: flags.reason, commitsInRange: adoption.commitsInRange, candidateCommit: head, candidateTree: treeOf(root, head), timeout });
    run.warnings.push(...(adoption.commitsInRange > 1 ? [`adopted ${adoption.commitsInRange} commits (${adoption.baseSha.slice(0, 7)}..HEAD); the whole range is reviewed`] : []));
  } else {
    if (flags.reason) throw usage('--reason is only used with --adopt');
    if (flags.base) {
      const base = resolveCommit(root, flags.base);
      if (base !== head) { printJson({ ok: false, status: 'base_mismatch', reason: `--base ${flags.base} must equal current HEAD ${head.slice(0, 12)} for a fresh candidate; use --adopt for an existing commit`, head }); return 0; }
    }
    run = newCodeRun({ seat, sessionId, cwd, identity, baseSha: head, branch, adopted: false, adoptionEvidence: null, commitsInRange: null, candidateCommit: null, candidateTree: null, timeout });
  }
  const key = sessionKey(seat, sessionId);
  let busy = null;
  // The run is saved before the ledger names it, so an active entry always has a run that finish or waive can load.
  run.warnings.push(...scopeWarning(cwd, home));
  createRun(home, run);
  updateLedger(home, identity, (l) => {
    if (l.active && !runSaved(home, l.active.runId)) {
      auditEvent(l, { type: 'orphan_candidate_cleared', runId: l.active.runId, seat: l.active.seat, sessionId: l.active.sessionId });
      l.active = null;
    }
    if (l.active) { busy = l.active; return l; }
    l.active = { runId: run.runId, seat, sessionId, sessionKey: key, baseSha: run.code.baseSha, branch, phase: run.code.phase, candidateCommit: run.code.candidateCommit, candidateTree: run.code.candidateTree, commitsInRange: run.code.commitsInRange, adopted: run.code.adopted, createdAt: run.createdAt };
    auditEvent(l, { type: run.code.adopted ? 'candidate_adopted' : 'candidate_begun', runId: run.runId, seat, sessionId, baseSha: run.code.baseSha, candidateCommit: run.code.candidateCommit, reason: flags.reason ?? null, commitsInRange: run.code.commitsInRange });
    return l;
  });
  if (busy) fs.rmSync(runDir(home, run.runId), { recursive: true, force: true });
  if (busy) { printJson({ ok: false, status: 'candidate_busy', runId: busy.runId, owner: { seat: busy.seat, sessionId: busy.sessionId }, reason: `worktree ${root} already has an active candidate owned by run ${busy.runId}` }); return 0; }
  const session = updateSession(home, seat, sessionId, (s) => { s.codeRuns.push(run.runId); s.cwd = s.cwd || cwd; return s; });
  if (run.code.adopted) appendAuditRow(home, { type: 'candidate_adopted', eventId: newEventId(), kind: 'code', runId: run.runId, seat, sessionId, generation: session.generation, repoKey: identity.repoKey, baseSha: run.code.baseSha, candidateCommit: head, commitsInRange: run.code.commitsInRange, reason: flags.reason, at: nowIso() });
  upsertStatsRow(home, statsRowFromRun(run));
  printJson({ ok: true, runId: run.runId, status: run.code.phase, baseSha: run.code.baseSha, branch, candidateCommit: run.code.candidateCommit, adopted: run.code.adopted, commitsInRange: run.code.commitsInRange, worktreeRoot: root, repoKey: identity.repoKey, baselineForSession: baselineFor(existing, key) ? baselineFor(existing, key).headSha : null, warnings: run.warnings, next: run.code.adopted ? 'review --run <id>' : 'git add -A; git commit -m "<type>: <description>" (separate tool calls), then review --run <id>' });
  return 0;
}

// ---------- preflight ----------

export function codePreflight(home, run, { skipLanes = false } = {}) {
  const warnings = [];
  let identity;
  try { identity = requireRunIdentity(run); } catch (e) { return { ok: false, status: 'unsupported_state', reason: e.message, warnings }; }
  const root = identity.worktreeRoot;
  const ledger = loadLedger(home, run.code.repoKey);
  if (!ledger || !ledger.active || ledger.active.runId !== run.runId) return { ok: false, status: 'unsupported_state', reason: `run ${run.runId} is not the active candidate of ${root}`, warnings };
  const state = candidateStateFor(root, ledger.active);
  if (state.state === 'unborn') return { ok: false, status: 'unsupported_state', reason: 'unborn HEAD', warnings };
  if (state.state === 'awaiting') return { ok: false, status: 'unsupported_state', reason: `no candidate commit yet: HEAD is still the base ${run.code.baseSha.slice(0, 12)}; stage and commit first`, warnings };
  if (state.state === 'unrelated') return { ok: false, status: 'unsupported_state', reason: `HEAD ${state.head.slice(0, 12)} is not a sole-parent child of base ${run.code.baseSha.slice(0, 12)} (parents: ${(state.parents || []).map(p => p.slice(0, 12)).join(', ') || 'none'})`, warnings };
  const branch = branchOf(root);
  if (branch !== run.code.branch) return { ok: false, status: 'unsupported_state', reason: `branch changed from ${run.code.branch} to ${branch}`, warnings };
  try {
    if (hasUnmerged(root)) return { ok: false, status: 'unsupported_state', reason: 'unmerged index entries', warnings };
    if (hasHiddenIndexBits(root)) return { ok: false, status: 'unsupported_state', reason: 'skip-worktree or assume-unchanged index flags; unset them before review', warnings };
    const entries = porcelainStatus(root);
    if (entries.length) return { ok: false, status: 'unsupported_state', reason: `worktree is not clean (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}: ${entries.slice(0, 5).map(e => `${e.code.trim() || '??'} ${e.path}`).join(', ')}); stage and commit or amend every intended change`, warnings };
    const dirty = dirtySubmodules(root);
    if (dirty.length) warnings.push(`dirty submodule worktree state is not part of the candidate identity: ${dirty.join(', ')}`);
  } catch (e) {
    return { ok: false, status: 'unsupported_state', reason: e.message, warnings };
  }
  const candidateCommit = state.head;
  const candidateTree = treeOf(root, candidateCommit);
  const baseTree = treeOf(root, run.code.baseSha);
  if (candidateTree === baseTree) return { ok: false, status: 'nothing_to_review', reason: 'candidate tree equals the base tree', candidateCommit, candidateTree, warnings };
  let diff;
  try { diff = git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', `${run.code.baseSha}..${candidateCommit}`, '--']).stdout; } catch (e) { return { ok: false, status: 'unsupported_state', reason: `secret scan failed: ${e.message}`, warnings }; }
  const hits = scanDiffForSecrets(diff);
  if (hits.length) return { ok: false, status: 'secrets_detected', reason: `${hits.length} potential secret(s) in the outgoing diff; inspect the locations, correct the candidate, amend, and review again`, hits, candidateCommit, candidateTree, warnings };
  if (!skipLanes) {
    for (const lane of CODE_REVIEW_LANES) {
      const stage = lane === 'review-main' ? 'main' : 'debate';
      try { resolveReviewOverride(root, run.laneOverrides?.[stage] || lane, { globalOnly: true }); }
      catch (e) { return { ok: false, status: 'lane_config', reason: e.message, warnings }; }
    }
  }
  return { ok: true, candidateCommit, candidateTree, root, warnings, hits: [] };
}

// ---------- rounds, backend, ingest ----------

export function startCodeRound(home, runId, pre) {
  return updateRun(home, runId, (run) => {
    if (!['new', 'continue'].includes(run.status)) throw usage(`run ${runId} is ${run.status}; a new round needs status new or continue`);
    if (run.rounds.length >= MAX_ROUNDS) throw usage(`run ${runId} already used ${MAX_ROUNDS} rounds`);
    // A blocked finish keeps its outcome until review; an identical tree would waste a round on the same blockers.
    if (run.outcome === 'blocked') {
      if (pre.candidateTree === run.code.reviewedTree) throw usage(`run ${runId} is blocked on an unchanged candidate tree; amend the blocker fix before review --run ${runId}`);
      run.outcome = null;
      run.finishedAt = null;
      run.stopReason = null;
    }
    const roundNo = run.rounds.length + 1;
    fs.mkdirSync(path.join(runDir(home, runId), `round-${roundNo}`), { recursive: true, mode: 0o700 });
    run.rounds.push({ round: roundNo, candidateCommit: pre.candidateCommit, candidateTree: pre.candidateTree, attempts: [], review: null, verdict: null, changed: null, next: null, stopReason: null, warnings: [...pre.warnings] });
    run.code.candidateCommit = pre.candidateCommit;
    run.code.candidateTree = pre.candidateTree;
    run.code.phase = 'candidate';
    run.preflight = null;
    run.status = 'round_open';
    return run;
  });
}
export function startCodeAttempt(home, runId, { retry = false, resume = null } = {}) {
  return updateRun(home, runId, (run) => {
    if (resume) {
      authorizeResume(run, resume, home);
      run.laneOverrides = { ...run.laneOverrides, ...resume.overrides };
    }
    run.orchestratorModel = orchestratorModel(home, run);
    const round = currentRound(run);
    if (!round) throw usage('no open round');
    const last = currentAttempt(round);
    if (retry) {
      if (run.status !== 'review_failed' || !last || last.status !== 'failed') throw usage(`run ${runId} has no failed attempt to retry`);
      if (run.retryUsed) throw usage(`run ${runId} already used its single retry`);
      run.retryUsed = true;
    } else if (last && last.status === 'running') {
      throw usage(`attempt ${last.attempt} of round ${round.round} is still running (pid ${last.pid})`);
    } else if (run.status !== 'round_open') {
      throw usage(`run ${runId} is ${run.status}`);
    }
    const attemptNo = round.attempts.length + 1;
    const lanes = loadLaneConfig(run.cwd).lanes;
    const reviewers = Object.fromEntries(['main', 'debate'].map(stage => {
      const lane = run.laneOverrides?.[stage] || `review-${stage}`;
      const entry = lanes[lane];
      return [stage, { lane, implementer: entry?.implementer ?? null, model: entry?.model ?? entry?.dials?.model ?? null }];
    }));
    const dir = path.join(`round-${round.round}`, `attempt-${attemptNo}`);
    fs.mkdirSync(path.join(runDir(home, runId), dir, 'backend'), { recursive: true, mode: 0o700 });
    round.attempts.push({ attempt: attemptNo, resumed: Boolean(resume), laneOverrides: run.laneOverrides ?? null, reviewers, status: 'running', startedAt: nowIso(), finishedAt: null, pid: null, dir, agents: [], seconds: null, error: null, failure: null, warnings: [], backend: null });
    run.status = 'running';
    return run;
  });
}
function setAttemptPid(home, runId, roundNo, attemptNo, pid) {
  updateRun(home, runId, (run) => { const a = run.rounds[roundNo - 1] && run.rounds[roundNo - 1].attempts[attemptNo - 1]; if (a && a.status === 'running') a.pid = pid; return run; });
}
const failAttempt = failReviewAttempt;
/** Join main findings and debate new_findings with final dispositions; withdrawn entries are retained. */
export function joinBackendFindings(backendRun, roundNo) {
  const main = backendRun.stages && backendRun.stages.main && backendRun.stages.main.doc;
  const debate = backendRun.stages && backendRun.stages.debate && backendRun.stages.debate.doc;
  const finalStage = backendRun.stages && backendRun.stages.final && backendRun.stages.final.doc;
  if (!main || !Array.isArray(main.findings) || !debate || !Array.isArray(debate.new_findings)) return { error: 'main/debate stage documents are missing or malformed' };
  let finalDoc = finalStage;
  if (!finalDoc) {
    if (main.findings.length === 0 && debate.new_findings.length === 0) finalDoc = { summary: main.summary || 'No material findings from either reviewer.', findings: [] };
    else return { error: 'final stage document is missing although findings exist' };
  }
  if (!Array.isArray(finalDoc.findings)) return { error: 'final stage findings are not an array' };
  const dispositions = new Map(finalDoc.findings.map(f => [f.id, f]));
  const verdicts = new Map((debate.verdicts || []).map(v => [v.id, v]));
  const all = [...main.findings.map(f => ({ ...f, lane: 'review-main' })), ...debate.new_findings.map(f => ({ ...f, lane: 'review-debate' }))];
  const findings = [];
  for (const f of all) {
    const d = dispositions.get(f.id);
    if (!d) return { error: `finding ${f.id} has no final disposition` };
    if (!['agreed', 'contested', 'withdrawn'].includes(d.status)) return { error: `finding ${f.id} has status ${d.status}` };
    const v = verdicts.get(f.id);
    findings.push({ id: `R${roundNo}:${f.id}`, backendId: f.id, lane: f.lane, status: d.status, severity: d.severity || f.severity, axis: f.axis ?? d.axis ?? null, file: f.file, line_start: f.line_start, line_end: f.line_end, claim: f.claim, evidence: f.evidence ?? '', recommendation: f.recommendation ?? d.recommendation ?? '', confidence: typeof f.confidence === 'number' ? f.confidence : null, debateVerdict: v ? v.verdict : null, debateReason: v ? v.reason : null, debateNote: d.debate_note ?? null, finalClaim: d.claim ?? null });
  }
  for (const id of dispositions.keys()) if (!all.some(f => f.id === id)) return { error: `final disposition ${id} has no source finding` };
  return { findings, summary: finalDoc.summary || main.summary || '' };
}
function agentsFromBackend(backendDir, backendRun, attempt) {
  const who = (backendRun && backendRun.who) || attempt.reviewers || {};
  const stages = [['main', who.main], ['debate', who.debate], ['final', who.main]];
  const agents = [];
  for (const [stage, role] of stages) {
    const dir = path.join(backendDir, stage);
    if (!fs.existsSync(path.join(dir, 'result.json'))) continue;
    const implementer = role ? role.implementer : null;
    const info = usageFromRelayDir(implementer, dir);
    const result = readJsonIfExists(path.join(dir, 'result.json')) || {};
    const seconds = backendRun && backendRun.stages && backendRun.stages[stage] ? backendRun.stages[stage].seconds ?? null : (result.startedAt && result.finishedAt ? Math.round((Date.parse(result.finishedAt) - Date.parse(result.startedAt)) / 1000) : null);
    agents.push({ stage, lane: role ? role.lane : null, implementer, model: result.model ?? role?.model ?? null, ...modelIdentity(dir, role?.model ?? null), failureDetails: result.status !== 'completed' ? failureDetails(result, 'backend', '', stage) : null, dials: { effort: result.effort ?? null, variant: result.variant ?? null }, sessionId: info.sessionId, seconds, usage: info.usage, cost: info.cost, coverage: info.coverage, status: info.status });
  }
  return agents;
}
export function ingestCodeReview(home, runId, roundNo, attemptNo, backendDir, { exitCode = null, seconds = null, stderrTail = '' } = {}) {
  return updateRun(home, runId, (run) => {
    const round = run.rounds[roundNo - 1];
    const attempt = round && round.attempts[attemptNo - 1];
    if (!round || !attempt) throw usage(`unknown round ${roundNo} attempt ${attemptNo}`);
    if (roundNo !== run.rounds.length || attemptNo !== round.attempts.length) throw usage(`stale update: round ${roundNo} attempt ${attemptNo} is not current`);
    if (attempt.status !== 'running') throw usage(`attempt ${attemptNo} of round ${roundNo} is already ${attempt.status}`);
    const backendRun = readJsonIfExists(path.join(backendDir, 'run.json'));
    attempt.agents = agentsFromBackend(backendDir, backendRun, attempt).map(a => ({ ...a, sameModelAsOrchestrator: run.orchestratorModel && a.servedModel ? run.orchestratorModel === a.servedModel : null }));
    attempt.seconds = seconds;
    attempt.backend = { dir: backendDir, exitCode, baseSha: backendRun && backendRun.base ? backendRun.base.sha : null, snapshotCommit: backendRun ? backendRun.snapshotCommit ?? null : null, finishedAt: backendRun ? backendRun.finishedAt ?? null : null };
    if (attempt.agents.some(a => a.coverage === 'violation')) { failAttempt(run, round, attempt, 'read_only_violation', 'a reviewer relay reported a read-only violation; output rejected'); return run; }
    for (const a of attempt.agents) {
      if (a.coverage === 'incomplete') attempt.warnings.push(`${a.stage}: read-only tripwire coverage incomplete (readOnlyViolation null)`);
      if (a.coverage === 'unreported') attempt.warnings.push(`${a.stage}: read-only tripwire coverage unreported`);
    }
    const failedAgent = attempt.agents.find(a => a.failureDetails);
    if (failedAgent) attempt.failureDetails = failedAgent.failureDetails;
    // A completed relay can still fail the backend's JSON/output contract.
    const unparsed = !failedAgent && exitCode !== 0 && attempt.agents.find(a => !backendRun?.stages?.[a.stage]?.doc);
    if (unparsed) {
      const result = readJsonIfExists(path.join(backendDir, unparsed.stage, 'result.json')) || {};
      attempt.failureDetails = failureDetails({ ...result, stderrTail }, 'bad_output', 'reviewer output did not produce a parsed stage', unparsed.stage);
    }
    if (exitCode !== 0 || failedAgent) { failAttempt(run, round, attempt, unparsed ? 'bad_output' : 'backend', `review backend exited ${exitCode}${failedAgent ? `; ${failedAgent.stage}: ${failedAgent.failureDetails.failureClass}` : ''}${stderrTail ? `: ${stderrTail.split('\n').filter(Boolean).slice(-3).join(' | ')}` : ''}`); return run; }
    if (!backendRun || backendRun.schema !== 'debate-review.run.v1') { failAttempt(run, round, attempt, 'bad_output', 'backend wrote no debate-review.run.v1 run.json'); return run; }
    if (!backendRun.base || backendRun.base.sha !== run.code.baseSha) { failAttempt(run, round, attempt, 'bad_output', `backend base ${backendRun.base ? backendRun.base.sha : 'missing'} does not match candidate base ${run.code.baseSha}`); return run; }
    if (backendRun.snapshotCommit !== round.candidateCommit) { failAttempt(run, round, attempt, 'bad_output', `backend snapshot ${backendRun.snapshotCommit} does not match candidate ${round.candidateCommit}`); return run; }
    const joined = joinBackendFindings(backendRun, roundNo);
    if (joined.error) { failAttempt(run, round, attempt, 'bad_output', joined.error); return run; }
    attempt.status = 'completed';
    attempt.finishedAt = nowIso();
    round.review = { findings: joined.findings, summary: joined.summary, attempt: attemptNo };
    run.code.reviewedTree = round.candidateTree;
    run.code.reviewedCommit = round.candidateCommit;
    if (run.code.commitsInRange > 1) attempt.warnings.push(`candidate spans ${run.code.commitsInRange} commits; the whole ${run.code.baseSha.slice(0, 7)}..HEAD range was reviewed`);
    try { const head = headSha(run.code.worktreeRoot); if (head && head !== round.candidateCommit) attempt.warnings.push(`HEAD moved to ${head.slice(0, 12)} during review; the reviewed candidate is ${round.candidateCommit.slice(0, 12)}`); } catch { /* observational */ }
    run.status = 'awaiting_verdict';
    return run;
  });
}
export function runCodeAttempt(home, runId, roundNo, attemptNo) {
  const run = loadRun(home, runId);
  const round = run.rounds[roundNo - 1];
  const attempt = round && round.attempts[attemptNo - 1];
  if (!round || !attempt || attempt.status !== 'running') throw usage(`round ${roundNo} attempt ${attemptNo} is not running`);
  const attemptDir = path.join(runDir(home, runId), attempt.dir);
  const backendDir = path.join(attemptDir, 'backend');
  try {
    const args = [CLI, 'review', '--local', '--repo-dir', run.code.worktreeRoot, '--base', run.code.baseSha, '--main-lane', run.laneOverrides?.main || 'review-main', '--debate-lane', run.laneOverrides?.debate || 'review-debate', '--out-dir', backendDir, '--timeout', run.timeout];
    const started = Date.now();
    const proc = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
    const seconds = Math.round((Date.now() - started) / 1000);
    fs.writeFileSync(path.join(attemptDir, 'backend-stdout.txt'), proc.stdout || '', { mode: 0o600 });
    fs.writeFileSync(path.join(attemptDir, 'backend-stderr.txt'), proc.stderr || '', { mode: 0o600 });
    return ingestCodeReview(home, runId, roundNo, attemptNo, backendDir, { exitCode: proc.status, seconds, stderrTail: String(proc.stderr || '').split('\n').slice(-20).join('\n') });
  } catch (e) {
    return updateRun(home, runId, (cur) => {
      const rd = cur.rounds[roundNo - 1];
      const at = rd && rd.attempts[attemptNo - 1];
      if (at && at.status === 'running') failAttempt(cur, rd, at, 'internal', e.message);
      return cur;
    });
  }
}
export function waitForCodeRun(home, runId, maxWaitMs) {
  const end = Date.now() + maxWaitMs;
  for (;;) {
    let run = loadRun(home, runId);
    const round = currentRound(run);
    const attempt = currentAttempt(round);
    if (!attempt || attempt.status !== 'running') return run;
    if (Number.isInteger(attempt.pid) && !isPidAlive(attempt.pid)) {
      run = updateRun(home, runId, (cur) => {
        const rd = currentRound(cur);
        const at = currentAttempt(rd);
        if (at && at.status === 'running' && at.attempt === attempt.attempt && rd.round === round.round) failAttempt(cur, rd, at, 'worker_died', `worker pid ${attempt.pid} exited without recording a result`);
        return cur;
      });
      return run;
    }
    if (Date.now() >= end) return run;
    sleepMs(1000);
  }
}

function reviewCommand(flags) {
  if ((flags.mainLane || flags.debateLane) && !flags.resume) throw usage('lane overrides require a user-authorized resume');
  const home = debateHome();
  requireWritableHome(home);
  const run = loadRun(home, validateRunId(flags.run));
  if (run.kind !== 'code') throw usage(`run ${run.runId} is a ${run.kind} run`);
  if (flags.resume) {
    validateResume(run, flags, home);
    flags.overrides = {};
    if (flags.mainLane) flags.overrides.main = flags.mainLane;
    if (flags.debateLane) flags.overrides.debate = flags.debateLane;
    run.laneOverrides = { ...run.laneOverrides, ...flags.overrides };
  }
  if (flags.timeout) { if (!parseDuration(flags.timeout)) throw usage('--timeout must be a duration like 30m'); updateRun(home, run.runId, (r) => { r.timeout = flags.timeout; return r; }); }
  requireActive(home, run);
  const pre = codePreflight(home, run);
  if (!pre.ok) {
    const cur = updateRun(home, run.runId, (r) => {
      r.preflight = { status: pre.status, reason: pre.reason, at: nowIso() };
      if (pre.status === 'secrets_detected') r.code.secretScan = { at: nowIso(), clean: false, hits: pre.hits, candidateCommit: pre.candidateCommit };
      if (pre.status === 'nothing_to_review') { r.code.nothingToReview = true; r.code.candidateCommit = pre.candidateCommit; r.code.candidateTree = pre.candidateTree; }
      if (pre.candidateCommit) { r.code.candidateCommit = pre.candidateCommit; r.code.candidateTree = pre.candidateTree; r.code.phase = 'candidate'; }
      return r;
    });
    if (pre.candidateCommit) updateLedger(home, { repoKey: run.code.repoKey, worktreeRoot: run.code.worktreeRoot, gitDir: run.code.gitDir }, (l) => { if (l.active && l.active.runId === run.runId) { l.active.candidateCommit = pre.candidateCommit; l.active.candidateTree = pre.candidateTree; l.active.phase = 'candidate'; } return l; });
    printJson(codeDoc(cur, { status: pre.status, error: pre.reason, secretHits: pre.hits ?? [], roundConsumed: false }));
    return 0;
  }
  updateRun(home, run.runId, (r) => { r.code.secretScan = { at: nowIso(), clean: true, hits: [], candidateCommit: pre.candidateCommit }; return r; });
  if (!flags.retry && !flags.resume) startCodeRound(home, run.runId, pre);
  else updateRun(home, run.runId, (r) => { const rd = currentRound(r); if (rd && rd.candidateCommit !== pre.candidateCommit) throw usage(`candidate moved to ${pre.candidateCommit.slice(0, 12)} since round ${rd.round} started; the retry must review the same commit`); return r; });
  updateLedger(home, { repoKey: run.code.repoKey, worktreeRoot: run.code.worktreeRoot, gitDir: run.code.gitDir }, (l) => { if (l.active && l.active.runId === run.runId) { l.active.candidateCommit = pre.candidateCommit; l.active.candidateTree = pre.candidateTree; l.active.phase = 'candidate'; } return l; });
  const started = startCodeAttempt(home, run.runId, { retry: flags.retry === true, resume: flags.resume ? flags : null });
  const round = currentRound(started);
  const attempt = currentAttempt(round);
  if (flags.detach) {
    const logPath = path.join(runDir(home, run.runId), attempt.dir, 'worker.log');
    const pid = spawnDetached(CLI, ['code', '_worker', '--run', run.runId, '--round', String(round.round), '--attempt', String(attempt.attempt)], logPath);
    setAttemptPid(home, run.runId, round.round, attempt.attempt, pid);
    printJson(codeDoc(loadRun(home, run.runId), { status: 'running', pid, wait: cliCommand(`code wait --run ${run.runId} --max-wait 60s`) }));
    return 0;
  }
  setAttemptPid(home, run.runId, round.round, attempt.attempt, process.pid);
  printJson(codeDoc(runCodeAttempt(home, run.runId, round.round, attempt.attempt)));
  return 0;
}
function waitCommand(flags) {
  const maxWait = parseDuration(flags.maxWait || '60s');
  if (!maxWait) throw usage('--max-wait must be a duration like 60s');
  printJson(codeDoc(waitForCodeRun(debateHome(), validateRunId(flags.run), maxWait)));
  return 0;
}

// ---------- verdict ----------

export function unfixedBlockers(round) {
  if (!round.review || !round.verdict) return [];
  const verdictOf = new Map(round.verdict.verdicts.map(v => [v.id, v]));
  return round.review.findings.filter(f => { const v = verdictOf.get(f.id); return f.severity === 'blocking' && v && (v.verdict === 'confirm' || v.verdict === 'modify') && v.fixed !== true; }).map(f => f.id);
}
export function applyCodeVerdict(home, runId, roundNo, doc) {
  const run = loadRun(home, runId);
  const identity = requireRunIdentity(run);
  const ledger = requireActive(home, run);
  const state = candidateStateFor(identity.worktreeRoot, ledger.active);
  if (state.state !== 'candidate') throw usage(`HEAD ${String(state.head).slice(0, 12)} is not on the candidate lineage of base ${run.code.baseSha.slice(0, 12)}; restore the candidate before recording a verdict`);
  if (branchOf(identity.worktreeRoot) !== run.code.branch) throw usage(`branch changed from ${run.code.branch}`);
  const headTree = treeOf(identity.worktreeRoot, state.head);
  const updated = updateRun(home, runId, (cur) => {
    if (cur.status !== 'awaiting_verdict') throw usage(`run ${runId} is ${cur.status}; verdict needs a completed review awaiting a verdict`);
    const round = cur.rounds[roundNo - 1];
    if (!round || roundNo !== cur.rounds.length) throw usage(`round ${roundNo} is not the current round (${cur.rounds.length})`);
    if (!round.review || round.verdict) throw usage(`round ${roundNo} ${round.verdict ? 'already has a verdict' : 'has no completed review'}`);
    const validation = validateVerdictDoc(doc, { findingIds: round.review.findings.map(f => f.id), contestedIds: [], assumptionIds: new Set(), code: true });
    if (!validation.ok) throw usage('invalid verdict file', validation.errors);
    if (headTree === round.candidateTree && verdictDeclaresChange(doc)) throw usage('verdict declares a correction but the candidate tree is unchanged; amend the actual fix first');
    const changed = headTree !== round.candidateTree;
    round.verdict = { review_rating: doc.review_rating, verdicts: doc.verdicts, contest_rulings: doc.contest_rulings, assumptions: doc.assumptions, missed: doc.missed, checks: doc.checks || [], no_further_review: doc.no_further_review === true, at: nowIso() };
    round.changed = changed;
    round.headAfter = { commit: state.head, tree: headTree };
    round.unfixedBlockers = unfixedBlockers(round);
    // Agreed: no live blocking finding, nothing unfixed, no correction the reviewer never saw, and the orchestrator says so.
    round.agreed = changed && !round.review.findings.some(f => f.severity === 'blocking' && f.status !== 'withdrawn') && round.unfixedBlockers.length === 0 && doc.no_further_review === true && !missedDeclaresChange(doc);
    cur.code.checks.push(...(doc.checks || []).map(c => ({ ...c, round: roundNo })));
    const decision = roundNo >= MAX_ROUNDS ? { next: 'stop', stopReason: 'round_limit' } : !changed ? { next: 'stop', stopReason: 'no_changes' } : round.agreed ? { next: 'stop', stopReason: 'agreed' } : { next: 'continue', stopReason: null };
    round.next = decision.next;
    round.stopReason = decision.stopReason;
    cur.status = decision.next === 'continue' ? 'continue' : 'stopped';
    cur.stopReason = decision.stopReason;
    cur.code.candidateCommit = state.head;
    cur.code.candidateTree = headTree;
    return cur;
  });
  updateLedger(home, identity, (l) => { if (l.active && l.active.runId === runId) { l.active.candidateCommit = state.head; l.active.candidateTree = headTree; } return l; });
  return updated;
}
function verdictCommand(flags) {
  const home = debateHome();
  requireWritableHome(home);
  const runId = validateRunId(flags.run);
  const roundNo = Number(flags.round);
  if (!Number.isInteger(roundNo) || roundNo < 1) throw usage('--round <n> is required');
  if (!flags.verdicts) throw usage('--verdicts <file> is required');
  let doc;
  try { doc = JSON.parse(fs.readFileSync(path.resolve(flags.verdicts), 'utf8')); } catch (e) { throw usage(`cannot read verdict file: ${e.message}`); }
  const run = applyCodeVerdict(home, runId, roundNo, doc);
  const round = run.rounds[roundNo - 1];
  printJson({ ok: true, runId, round: roundNo, next: round.next, stopReason: round.stopReason, changed: round.changed, agreed: round.agreed, unfixedBlockers: round.unfixedBlockers, candidateCommit: run.code.candidateCommit, reviewedCommit: run.code.reviewedCommit, changedAfterReview: run.code.candidateTree !== run.code.reviewedTree, runStatus: run.status, roundsUsed: run.rounds.length, maxRounds: MAX_ROUNDS });
  return 0;
}

// ---------- finish / waive / defer / approve-push ----------

export function computeOutcome(run, currentTree) {
  const last = currentRound(run);
  if (!last) {
    if (run.code.nothingToReview) return 'nothing_to_review';
    if (run.preflight && run.preflight.status === 'secrets_detected') return 'secrets_detected';
    if (run.preflight) return 'unsupported_state';
    return null;
  }
  const attempt = currentAttempt(last);
  if (attempt && attempt.status === 'failed') return attempt.failure === 'bad_output' ? 'bad_output' : 'failed';
  if (!last.verdict) return null;
  // an agreed stop passes the amended tree the verdict recorded; any later amendment is unreviewed
  const agreedTree = last.stopReason === 'agreed' && last.headAfter ? last.headAfter.tree : null;
  if (currentTree !== run.code.reviewedTree && currentTree !== agreedTree) return 'changed_after_review';
  if (last.unfixedBlockers.length) return last.round >= MAX_ROUNDS ? 'exhausted_with_blockers' : 'blocked';
  return 'passed';
}
function closeCandidate(home, run, identity, outcome, extra = {}) {
  const key = run.sessionKey;
  updateLedger(home, identity, (l) => {
    // A repeated finish reconciles a ledger left behind by an interrupted one without duplicating its receipt.
    const recorded = TERMINAL_OUTCOMES.has(outcome) && l.receipts.some(r => r.runId === run.runId && r.outcome === outcome);
    const owns = l.active && l.active.runId === run.runId;
    if (recorded && !owns) return l;
    if (!recorded) l.receipts.push({ runId: run.runId, sessionKey: key, seat: run.seat, sessionId: run.sessionId, commitSha: run.code.candidateCommit, treeId: run.code.candidateTree, baseSha: run.code.baseSha, outcome, finishedAt: run.finishedAt, ...extra });
    if (TERMINAL_OUTCOMES.has(outcome) && owns) {
      l.active = null;
      l.baselines[key] = baselineRecord({ seat: run.seat, sessionId: run.sessionId, root: identity.worktreeRoot, headSha: run.code.candidateCommit, source: outcome === 'waived' ? 'waive' : 'finish', runId: run.runId });
    }
    auditEvent(l, { type: outcome === 'waived' ? 'candidate_waived' : 'candidate_finished', runId: run.runId, seat: run.seat, sessionId: run.sessionId, outcome, commitSha: run.code.candidateCommit });
    return l;
  });
}
function finishCommand(flags) {
  const home = debateHome();
  requireWritableHome(home);
  const runId = validateRunId(flags.run);
  if (flags.selfReview) updateRun(home, runId, r => { recordSelfReview(r, { report: flags.selfReview, reason: flags.reason }); return r; });
  const run = loadRun(home, runId);
  requireFinishDecision(run);
  if (run.kind !== 'code') throw usage(`run ${run.runId} is a ${run.kind} run`);
  if (run.status === 'finished' || (run.status === 'continue' && run.outcome === 'blocked')) {
    const identity = TERMINAL_OUTCOMES.has(run.outcome) ? repoIdentity(run.cwd) : null;
    if (identity && identity.repoKey === run.code.repoKey) closeCandidate(home, run, identity, run.outcome, run.code.unreviewedAmendment ? { unreviewedAmendment: true, reviewedCommit: run.code.reviewedCommit } : {});
    printJson({ ok: true, runId: run.runId, outcome: run.outcome, candidateCommit: run.code.candidateCommit, unreviewedAmendment: run.code.unreviewedAmendment === true, repeated: true, warnings: run.warnings }); upsertStatsRow(home, statsRowFromRun(run)); return 0; }
  if (['running', 'awaiting_verdict', 'round_open', 'continue'].includes(run.status)) throw usage(`run ${run.runId} is ${run.status}; ${run.status === 'awaiting_verdict' ? 'record the verdict first' : 'a review attempt is open'}`);
  const identity = requireRunIdentity(run);
  const ledger = requireActive(home, run);
  const root = identity.worktreeRoot;
  const state = candidateStateFor(root, ledger.active);
  if (state.state !== 'candidate') throw usage(`HEAD ${String(state.head).slice(0, 12)} is not the candidate lineage of base ${run.code.baseSha.slice(0, 12)}`);
  if (branchOf(root) !== run.code.branch) throw usage(`branch changed from ${run.code.branch}`);
  const entries = porcelainStatus(root);
  if (entries.length) throw usage(`worktree is not clean (${entries.length} entries); stage and amend before finishing`);
  const tree = treeOf(root, state.head);
  if (run.selfReview && run.selfReview.snapshot !== state.head) throw usage('self-review snapshot differs from HEAD; review the changed candidate separately');
  const outcome = computeOutcome(run, tree);
  if (!outcome) throw usage(`run ${run.runId} has no completed review and verdict; run review first`);
  // an agreed stop passes a tree the reviewer never saw; the receipt, report and push request all say so
  const unreviewedAmendment = outcome === 'passed' && tree !== run.code.reviewedTree;
  const session = loadSession(home, run.seat, run.sessionId);
  const now = nowIso();
  const finished = updateRun(home, run.runId, (cur) => {
    cur.status = outcome === 'blocked' ? 'continue' : 'finished';
    cur.outcome = outcome;
    cur.finishedAt = now;
    cur.code.candidateCommit = state.head;
    cur.code.candidateTree = tree;
    cur.code.unreviewedAmendment = unreviewedAmendment;
    if (unreviewedAmendment) cur.warnings.push(`agreed stop: finished tree ${tree.slice(0, 12)} amends the reviewed tree ${cur.code.reviewedTree.slice(0, 12)} (commit ${cur.code.reviewedCommit.slice(0, 12)}) without a further review round`);
    cur.orchestratorUsage = orchestratorUsageFromTranscript(session ? session.transcriptPath : null, cur.createdAt, now);
    return cur;
  });
  closeCandidate(home, finished, identity, outcome, unreviewedAmendment ? { unreviewedAmendment: true, reviewedCommit: finished.code.reviewedCommit } : {});
  upsertStatsRow(home, statsRowFromRun(finished));
  const last = currentRound(finished);
  printJson({ ok: true, runId: run.runId, outcome, candidateCommit: state.head, candidateTree: tree, baseSha: run.code.baseSha, branch: run.code.branch, adopted: run.code.adopted, commitsInRange: run.code.commitsInRange, rounds: finished.rounds.length, unresolvedFindings: last && last.unfixedBlockers ? last.unfixedBlockers : [], checks: finished.code.checks, unreviewedAmendment, candidateClosed: TERMINAL_OUTCOMES.has(outcome), baselineAdvanced: TERMINAL_OUTCOMES.has(outcome), warnings: [...finished.warnings, ...(last ? last.warnings : [])], note: 'the candidate commit remains local; pushing requires approve-push after explicit user approval' });
  return 0;
}
function waiveCommand(flags) {
  const home = debateHome();
  requireWritableHome(home);
  const run = loadRun(home, validateRunId(flags.run));
  if (run.kind !== 'code') throw usage(`run ${run.runId} is a ${run.kind} run`);
  if (!flags.reason || !flags.reason.trim()) throw usage('--reason <text> is required');
  if (!/user (approved|authorized)/i.test(flags.reason)) throw usage('--reason must quote explicit user approval as "user approved: <instruction>"');
  if (run.outcome && TERMINAL_OUTCOMES.has(run.outcome)) throw usage(`run ${run.runId} already finished with outcome ${run.outcome}`);
  if (['running', 'awaiting_verdict'].includes(run.status)) throw usage(`run ${run.runId} is ${run.status}; wait for the review or record the verdict before waiving`);
  const identity = requireRunIdentity(run);
  const ledger = requireActive(home, run);
  const root = identity.worktreeRoot;
  const state = candidateStateFor(root, ledger.active);
  const abandoned = state.state === 'awaiting';
  if (state.state !== 'candidate' && !abandoned) throw usage(`HEAD ${String(state.head).slice(0, 12)} is not a candidate commit of base ${run.code.baseSha.slice(0, 12)}; restore the candidate or its unchanged base before waiving`);
  if (porcelainStatus(root).length) throw usage('worktree is not clean; stage and commit or amend before waiving');
  const tree = treeOf(root, state.head);
  const session = loadSession(home, run.seat, run.sessionId);
  const now = nowIso();
  const waiver = { eventId: newEventId(), reason: flags.reason, at: now, seat: run.seat, sessionId: run.sessionId, generation: session ? session.generation : 0, waivedFrom: run.outcome || run.status, commitSha: state.head };
  const finished = updateRun(home, run.runId, (cur) => {
    cur.status = 'finished';
    cur.outcome = abandoned ? 'abandoned' : 'waived';
    cur.finishedAt = cur.finishedAt || now;
    cur.waiver = waiver;
    cur.code.candidateCommit = abandoned ? null : state.head;
    cur.code.candidateTree = abandoned ? null : tree;
    if (abandoned) cur.code.phase = 'abandoned';
    return cur;
  });
  if (!abandoned) closeCandidate(home, finished, identity, 'waived', { waiverEventId: waiver.eventId });
  updateLedger(home, identity, (l) => {
    if (abandoned && l.active?.runId === run.runId) {
      l.active = null;
      auditEvent(l, { type: 'candidate_abandoned', runId: run.runId, reason: flags.reason, baseSha: state.head });
    }
    l.waivers.push({ ...waiver, runId: run.runId });
    return l;
  });
  appendAuditRow(home, { type: 'waiver', eventId: waiver.eventId, kind: 'code', runId: run.runId, seat: run.seat, sessionId: run.sessionId, generation: waiver.generation, repoKey: identity.repoKey, commitSha: state.head, waivedFrom: waiver.waivedFrom, reason: flags.reason, at: now });
  upsertStatsRow(home, statsRowFromRun(finished));
  printJson({ ok: true, runId: run.runId, outcome: finished.outcome, waivedFrom: waiver.waivedFrom, candidateCommit: finished.code.candidateCommit, waiver, candidateClosed: true, baselineAdvanced: !abandoned, note: abandoned ? 'unchanged candidate abandoned; no review receipt or publication approval was created' : 'a waiver never authorizes a push' });
  return 0;
}
function deferCommand(flags) {
  const home = debateHome();
  requireWritableHome(home);
  const seat = validateSeat(flags.seat);
  const sessionId = sessionIdFor(seat, flags.session);
  const cwd = resolveCwdArg(flags.cwd);
  if (!flags.reason || !flags.reason.trim()) throw usage('--reason <text> is required');
  const identity = identityFor(cwd);
  const session = loadSession(home, seat, sessionId);
  const generation = session ? session.generation : 0;
  const key = sessionKey(seat, sessionId);
  const deferral = { eventId: newEventId(), sessionKey: key, seat, sessionId, generation, reason: flags.reason, at: nowIso(), consumed: false, consumedAt: null };
  let activeRun = null;
  updateLedger(home, identity, (l) => {
    l.deferrals = l.deferrals.filter(d => !(d.sessionKey === key && !d.consumed));
    l.deferrals.push(deferral);
    auditEvent(l, { type: 'deferral', seat, sessionId, generation, reason: flags.reason, eventId: deferral.eventId });
    if (l.active && l.active.sessionKey === key) activeRun = l.active.runId;
    return l;
  });
  if (activeRun) { try { const run = updateRun(home, activeRun, (r) => { r.operations.deferrals.push({ eventId: deferral.eventId, generation, reason: flags.reason, at: deferral.at }); return r; }); upsertStatsRow(home, statsRowFromRun(run)); } catch (e) { log(`could not record deferral on run ${activeRun}: ${e.message}`); } }
  appendAuditRow(home, { type: 'deferral', eventId: deferral.eventId, kind: 'code', runId: activeRun, seat, sessionId, generation, repoKey: identity.repoKey, reason: flags.reason, at: deferral.at });
  printJson({ ok: true, deferral, scope: 'this prompt generation only; consumed by the next Stop', note: 'a deferral cannot accompany a completion claim and never permits a push' });
  return 0;
}
function approvePushCommand(flags) {
  const home = debateHome();
  requireWritableHome(home);
  const run = loadRun(home, validateRunId(flags.run));
  if (run.kind !== 'code') throw usage(`run ${run.runId} is a ${run.kind} run`);
  if (run.status !== 'finished' || !TERMINAL_OUTCOMES.has(run.outcome)) throw usage(`run ${run.runId} is ${run.status}/${run.outcome}; approve-push needs a finished run with outcome passed or waived`);
  if (!flags.remote || flags.remote.startsWith('-') || /[\s:]/.test(flags.remote)) throw usage('--remote <name> is required');
  const ref = flags.ref || '';
  const branchMatch = /^refs\/heads\/([^\s:+~^?*[\\]+)$/.exec(ref);
  if (!branchMatch || ref.endsWith('/') || ref.includes('..') || ref.endsWith('.lock')) throw usage('--ref must be a single refs/heads/<branch> destination');
  const branch = branchMatch[1];
  if (!flags.reason || !/user approved/i.test(flags.reason) || flags.reason.trim().length < 20) throw usage('--reason must quote the explicit user approval, e.g. "user approved: push it to origin main"');
  const identity = requireRunIdentity(run);
  const root = identity.worktreeRoot;
  const head = headSha(root);
  if (head !== run.code.candidateCommit) throw usage(`HEAD ${String(head).slice(0, 12)} is not the finished candidate ${run.code.candidateCommit.slice(0, 12)}; a different commit needs its own review and approval`);
  if (porcelainStatus(root).length) throw usage('worktree is not clean');
  if (treeOf(root, head) !== run.code.candidateTree) throw usage('HEAD tree differs from the finished candidate tree');
  const urls = remotePushUrls(root, flags.remote);
  if (!urls || urls.length === 0) throw usage(`remote ${flags.remote} has no push URL`);
  if (urls.length !== 1) throw usage(`remote ${flags.remote} has ${urls.length} push URLs; approve-push requires exactly one destination`);
  if (remoteIsMirror(root, flags.remote)) throw usage(`remote ${flags.remote} is configured as a mirror; refusing`);
  const session = loadSession(home, run.seat, run.sessionId);
  const approval = { approvalId: crypto.randomUUID(), runId: run.runId, sessionId: run.sessionId, seat: run.seat, generation: session ? session.generation : 0, commitSha: head, treeId: run.code.candidateTree, remote: flags.remote, pushUrl: urls[0], destinationRef: ref, reason: flags.reason, at: nowIso(), consumedAt: null };
  const pending = gitText(root, ['log', '--format=%H%x00%s', head, '--not', '--remotes']).split('\n').filter(Boolean).map(l => { const [sha, subject] = l.split('\0'); return { sha, subject }; });
  updateLedger(home, identity, (l) => {
    for (const a of l.approvals) if (a.consumedAt === null && a.runId === run.runId) a.consumedAt = `superseded:${approval.at}`;
    l.approvals.push(approval);
    auditEvent(l, { type: 'push_approved', approvalId: approval.approvalId, runId: run.runId, seat: run.seat, sessionId: run.sessionId, commitSha: head, remote: flags.remote, pushUrl: urls[0], destinationRef: ref, reason: flags.reason });
    return l;
  });
  const updated = updateRun(home, run.runId, (cur) => { cur.approvals.push(approval); return cur; });
  appendAuditRow(home, { type: 'push_approved', eventId: approval.approvalId, kind: 'code', runId: run.runId, seat: run.seat, sessionId: run.sessionId, generation: approval.generation, repoKey: identity.repoKey, commitSha: head, remote: flags.remote, destinationRef: ref, reason: flags.reason, at: approval.at });
  upsertStatsRow(home, statsRowFromRun(updated));
  printJson({ ok: true, approval, command: pushCommand(flags.remote, head, branch, root), unreviewedAmendment: run.code.unreviewedAmendment === true, warnings: scopeWarning(root, home), publicationScope: { commitsNotOnAnyRemote: pending.length, commits: pending.slice(0, 50) }, note: 'execute exactly the returned command; when guards are active the approval is consumed by that single attempt and a failed or ambiguous attempt needs a new approval. Never amend the candidate after this approval.' });
  return 0;
}
const NETWORK_TIMEOUT_MS = 30_000;
const PR_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/;
function singlePushUrl(root, remote) {
  const urls = remotePushUrls(root, remote);
  if (!urls || urls.length === 0) throw usage(`remote ${remote} has no push URL`);
  if (urls.length !== 1) throw usage(`remote ${remote} has ${urls.length} push URLs; approve-delete requires exactly one destination`);
  if (remoteIsMirror(root, remote)) throw usage(`remote ${remote} is configured as a mirror; refusing`);
  return urls[0];
}
/** Branch tip and default branch as the push destination reports them (not the fetch URL). */
function readPushDestination(root, url, ref) {
  let r;
  try { r = git(root, ['ls-remote', '--symref', url, 'HEAD', ref], { allowFail: true, timeout: NETWORK_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: '0' } }); }
  catch (e) { throw usage(`cannot read ${url}: ${e.message}`); }
  if (r.status !== 0) throw usage(`cannot read ${url}: ${String(r.stderr || '').trim() || `exit ${r.status}`}`);
  const rows = r.stdout.split('\n').map(l => l.split('\t'));
  const symref = rows.find(([left, name]) => name === 'HEAD' && left.startsWith('ref: '));
  const tip = rows.find(([sha, name]) => name === ref && SHA_RE.test(sha));
  return { defaultRef: symref ? symref[0].slice('ref: '.length) : null, tip: tip ? tip[0] : null };
}
function readPullRequest(url) {
  const r = spawnSync('gh', ['pr', 'view', url, '--json', 'state,headRefName,headRefOid,headRepository,headRepositoryOwner'], { encoding: 'utf8', timeout: NETWORK_TIMEOUT_MS });
  if (r.error || r.status !== 0) throw usage(`gh pr view ${url} failed: ${r.error ? r.error.message : String(r.stderr || '').trim() || `exit ${r.status}`}`);
  try { return JSON.parse(r.stdout); } catch { throw usage(`gh pr view ${url} returned invalid JSON`); }
}
function approveDeleteCommand(flags) {
  const home = debateHome();
  requireWritableHome(home);
  const remote = flags.remote;
  if (!remote || remote.startsWith('-') || /[\s:]/.test(remote)) throw usage('--remote <name> is required');
  const ref = flags.ref || '';
  if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(ref) || ref.endsWith('/') || ref.includes('..') || ref.endsWith('.lock')) throw usage('--ref must be a single refs/heads/<branch> using only letters, digits, ".", "_", "/" and "-"');
  const branch = ref.slice('refs/heads/'.length);
  if (!flags.reason || !/user approved/i.test(flags.reason) || flags.reason.trim().length < 20) throw usage('--reason must quote the explicit user approval, e.g. "user approved: delete the merged branch"');
  if (!PR_URL_RE.test(flags.pr || '')) throw usage('--pr must be a https://github.com/<owner>/<repo>/pull/<n> URL');
  const identity = repoIdentity(resolveCwdArg(flags.cwd));
  if (!identity) throw usage(`${flags.cwd} is not inside a Git work tree`);
  const root = identity.worktreeRoot;
  // Network lookups run before the scope lock: the gate takes that lock for every push decision.
  const pushUrl = singlePushUrl(root, remote);
  const headRepo = githubRepoFromUrl(pushUrl);
  if (!headRepo) throw usage(`push URL ${pushUrl} of ${remote} is not a GitHub repository URL`);
  const dest = readPushDestination(root, pushUrl, ref);
  if (!dest.tip) throw usage(`${ref} does not exist on ${pushUrl}`);
  if (!dest.defaultRef) throw usage(`cannot determine the default branch of ${pushUrl}; refusing`);
  if (dest.defaultRef === ref) throw usage(`${ref} is the default branch of ${pushUrl}; refusing`);
  const pr = readPullRequest(flags.pr);
  if (pr.state !== 'MERGED') throw usage(`${flags.pr} is ${pr.state}, not MERGED`);
  if (pr.headRefName !== branch) throw usage(`${flags.pr} head branch is ${pr.headRefName}, not ${branch}`);
  if (pr.headRefOid !== dest.tip) throw usage(`${ref} on ${pushUrl} is at ${dest.tip.slice(0, 12)} but ${flags.pr} merged ${String(pr.headRefOid).slice(0, 12)}; the branch changed after the merge`);
  const prRepo = `${pr.headRepositoryOwner?.login}/${pr.headRepository?.name}`;
  if (prRepo.toLowerCase() !== headRepo.toLowerCase()) throw usage(`${flags.pr} head repository is ${prRepo}, but ${remote} pushes to ${headRepo}; update the remote URL if the repository was renamed`);
  return withRepositoryScopeLock(root, () => {
    if (singlePushUrl(root, remote) !== pushUrl) throw usage(`remote ${remote} push URL changed during approval`);
    const approval = { approvalId: crypto.randomUUID(), kind: 'delete', runId: null, sessionId: null, seat: null, commitSha: dest.tip, remote, pushUrl, destinationRef: ref, prUrl: flags.pr, reason: flags.reason, at: nowIso(), consumedAt: null };
    updateLedger(home, identity, (l) => {
      for (const a of l.approvals) if (a.consumedAt === null && a.kind === 'delete' && a.remote === remote && a.destinationRef === ref) a.consumedAt = `superseded:${approval.at}`;
      l.approvals.push(approval);
      auditEvent(l, { type: 'delete_approved', approvalId: approval.approvalId, commitSha: dest.tip, remote, pushUrl, destinationRef: ref, prUrl: flags.pr, reason: flags.reason });
      return l;
    });
    appendAuditRow(home, { type: 'delete_approved', eventId: approval.approvalId, kind: 'code', runId: null, seat: null, sessionId: null, repoKey: identity.repoKey, commitSha: dest.tip, remote, destinationRef: ref, prUrl: flags.pr, reason: flags.reason, at: approval.at });
    printJson({ ok: true, approval, command: deleteCommand(remote, dest.tip, ref, root), warnings: scopeWarning(root, home), note: 'execute exactly the returned command; when guards are active the approval is consumed by that single attempt, and git refuses the delete if the branch moved after approval' });
    return 0;
  }, home);
}
function workerCommand(flags) {
  runCodeAttempt(debateHome(), validateRunId(flags.run), Number(flags.round), Number(flags.attempt));
  return 0;
}

export function main(argv) {
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h') { process.stdout.write(HELP); return cmd ? 0 : 2; }
  const { flags } = parseArgs(argv.slice(1), {
    booleans: ['adopt', 'detach', 'retry', 'json'],
    values: ['cwd', 'seat', 'session', 'base', 'reason', 'run', 'timeout', 'maxWait', 'round', 'verdicts', 'remote', 'ref', 'kind', 'since', 'attempt', 'mainLane', 'debateLane', 'selfReview', 'pr'],
  });
  if (flags.help) { process.stdout.write(HELP); return 0; }
  ensureHome(debateHome());
  switch (cmd) {
    case 'baseline': return baselineCommand(flags);
    case 'begin': return withRepositoryScopeLock(resolveCwdArg(flags.cwd), () => beginCommand(flags));
    case 'review': return reviewCommand(flags);
    case 'resume': return reviewCommand({ ...flags, resume: true });
    case 'wait': return waitCommand(flags);
    case 'verdict': return verdictCommand(flags);
    case 'finish': return finishCommand(flags);
    case 'defer': return deferCommand(flags);
    case 'waive': return waiveCommand(flags);
    case 'approve-push': return withRepositoryScopeLock(loadRun(debateHome(), validateRunId(flags.run)).cwd, () => approvePushCommand(flags));
    case 'approve-delete': return approveDeleteCommand(flags);
    case 'stats': return statsCommand(flags, debateHome());
    case '_worker': return workerCommand(flags);
    default: throw usage(`unknown command ${cmd}`);
  }
}
