// Recovery policy shared by both wrappers. No model calls and no implicit fallback.
import fs from 'node:fs';
import path from 'node:path';
import {
  SECRET_PATTERNS, usage, nowIso, newEventId, readJsonIfExists, loadLaneConfig,
  findScript, relaySupportsReadOnly, loadSession, splitPlan, runDir, headSha, porcelainStatus,
} from './common.mjs';

export function diagnostic(text) {
  return String(text ?? '').split('\n').map(line => {
    if (SECRET_PATTERNS.some(({ pattern }) => pattern.test(line)) || /(?:password|token|secret|api[_-]?key|authorization)\s*["']?\s*[:=]/i.test(line) || /\bBearer\s+\S+/i.test(line)) return '[redacted sensitive diagnostic]';
    return line.replace(/((?:password|token|secret|api[_-]?key|authorization)\s*[:=]\s*)\S+/gi, '$1[redacted]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@');
  }).join('\n').slice(0, 2048);
}
export function failureDetails(result = {}, failure = 'internal', error = '', stage = null) {
  const raw = `${result.status || ''}\n${result.error || ''}\n${result.finalMessage || ''}\n${result.stderrTail || ''}\n${error}`;
  let failureClass = failure;
  if (failure !== 'read_only_violation') {
    if (/permission requested: external_directory|auto-rejecting/i.test(raw)) failureClass = 'sandbox_denied';
    else if (/rate.?limit|hit your .*limit|quota|too many requests|\b429\b/i.test(raw)) failureClass = 'rate_limited';
    else if (/\w+_unavailable|ENOENT|command not found/i.test(raw)) failureClass = 'cli_unavailable';
    else if (/timeout|timed out/i.test(raw)) failureClass = 'timeout';
    else if (['relay', 'backend'].includes(failure)) failureClass = 'service_error';
  }
  const resetLine = raw.split('\n').find(line => /\bresets?\b|retry.after/i.test(line));
  return { failureClass, stage, status: result.status ?? null, error: diagnostic(result.error || error),
    finalMessage: diagnostic(result.finalMessage), stderrTail: diagnostic(result.stderrTail), resetHint: failureClass === 'sandbox_denied' ? 'reviewer permission was denied; external_directory can block reads too; allow only the required trusted paths while preserving read-only permissions' : resetLine ? diagnostic(resetLine) : null };
}
export function failReviewAttempt(run, round, attempt, failure, error, result = null) {
  attempt.status = 'failed';
  attempt.failure = failure;
  attempt.error = diagnostic(error);
  if (result || !attempt.failureDetails) attempt.failureDetails = failureDetails(result || {}, failure, error);
  if (run.kind === 'plan') attempt.failureDetails.stage = 'review';
  attempt.finishedAt = nowIso();
  // A rate-limited reviewer will not recover within the retry window; spend the retry and ask the user instead.
  const rateLimited = !run.retryUsed && attempt.failureDetails.failureClass === 'rate_limited';
  if (rateLimited) run.retryUsed = true;
  if (run.retryUsed) {
    run.status = 'stopped';
    run.stopReason = 'reviewer_failed';
    round.next = 'stop';
    round.stopReason = 'reviewer_failed';
    const why = rateLimited ? `automatic retry skipped: reviewer is rate limited (${attempt.failureDetails.resetHint || 'no reset hint reported'})` : attempt.resumed ? 'resumed attempt failed' : 'reviewer failed twice';
    run.warnings.push(`round ${round.round}: ${why} (${attempt.error}); user decision required`);
  } else run.status = 'review_failed';
}
export function needsUserDecision(run) {
  const round = run.rounds.at(-1);
  return Boolean(round && !round.review && round.attempts.at(-1)?.status === 'failed' && run.retryUsed);
}
export function requireAuthorization(reason) {
  if (typeof reason !== 'string' || !/^user authorized:\s*\S[\s\S]*$/i.test(reason)) throw usage('--reason must quote the actual choice as "user authorized: <instruction>"');
}
export function validateResume(run, flags, home) {
  requireAuthorization(flags.reason);
  if (flags.seat !== run.seat || flags.session !== run.sessionId) throw usage('resume requires the original seat/session; reopen the originating thread (cross-session transfer is unsupported)');
  const round = run.rounds.at(-1);
  if (!needsUserDecision(run) || !['stopped', 'finished'].includes(run.status) || (run.stopReason !== 'reviewer_failed' && round.stopReason !== 'reviewer_failed')) throw usage('resume requires an exhausted failed current round; running or reviewed rounds cannot resume');
  if (round.attempts.at(-1).failure === 'read_only_violation' && !/remediat|investigat/i.test(flags.reason)) throw usage('investigate and remediate the read-only violation first; include the resolution in --reason');
  if (run.kind === 'plan') {
    const snapshot = fs.readFileSync(path.join(runDir(home, run.runId), round.planPath), 'utf8');
    if (splitPlan(snapshot).digest !== round.planDigest) throw usage('stored plan snapshot changed; cannot resume');
    const sourcePath = round.inputSource?.sourcePath ?? null;
    if (sourcePath && splitPlan(fs.readFileSync(sourcePath, 'utf8')).digest !== round.planDigest) throw usage('plan file changed since the failed attempt; resume must review the same input');
  } else if (headSha(run.cwd) !== round.candidateCommit || porcelainStatus(run.cwd).length) {
    throw usage('candidate changed or worktree is dirty; resume must review the same clean commit');
  }
}
export function authorizeResume(run, flags, home) {
  validateResume(run, flags, home);
  const round = run.rounds.at(-1);
  const at = nowIso();
  run.recoveries ??= [];
  run.recoveries.push({ eventId: newEventId(), at, choice: 'resume', reason: flags.reason, round: round.round,
    priorReceipt: run.plan?.receipt ?? null, priorOutcome: run.outcome, priorFinishedAt: run.finishedAt,
    overrides: flags.overrides || (flags.reviewerLane ? { reviewer: flags.reviewerLane } : null) });
  run.warnings = run.warnings.map(w => !w.startsWith('Historical failure') && /reviewer failed twice|resumed attempt failed|unreviewed for this round|user decision required/.test(w)
    ? `Historical failure before user-authorized resume at ${at}: ${w.replace(/; (?:the plan is unreviewed for this round|user decision required)$/, '')}` : w);
  run.status = 'round_open';
  run.stopReason = null;
  run.outcome = null;
  run.finishedAt = null;
  round.next = null;
  round.stopReason = null;
  delete run.selfReview;
  if (run.plan) { run.plan.receipt = null; run.plan.firstFinishedAt = null; run.plan.finalBody = null; }
}
export function recordSelfReview(run, { report, reason }) {
  requireAuthorization(reason);
  const round = run.rounds.at(-1);
  // a finish that failed after recording (snapshot mismatch) is re-run with the same choice; record it once
  if (run.selfReview && run.selfReview.report === path.resolve(report) && (run.recoveries || []).some(r => r.choice === 'self-review' && r.reason === reason && r.round === (round?.round ?? null))) return;
  if (!needsUserDecision(run) || !['stopped', 'finished'].includes(run.status)) throw usage('self-review requires an exhausted failed current round and explicit user choice');
  const body = fs.readFileSync(path.resolve(report), 'utf8');
  if (!body.trim() || Buffer.byteLength(body) > 256 * 1024) throw usage('self-review report must be nonempty and at most 256 KiB');
  run.selfReview = { at: nowIso(), reason, report: path.resolve(report), body, round: round?.round ?? null,
    snapshot: round?.planDigest ?? round?.candidateCommit ?? null, independent: false };
  run.recoveries ??= [];
  run.recoveries.push({ eventId: newEventId(), at: nowIso(), choice: 'self-review', reason, round: round?.round ?? null });
}
export function requireFinishDecision(run) {
  const round = run.rounds.at(-1);
  if (round && !round.review && round.attempts.at(-1)?.status === 'failed' && !run.selfReview) {
    throw usage('reviewer failed: retry once if available, then stop and ask the user; resume after authorization or supply --self-review <report> --reason "user authorized: ..." after that choice');
  }
}

export const REVIEW_TOOLING = {
  claude: 'Read, Glob, Grep (plan mode, no shell)',
  codex: 'Codex read-only sandbox: shell commands that only read (cat, sed -n, rg, git log/diff/show)',
  opencode: 'OpenCode plan agent in read-only mode: inspect files with the available read/search tools; do not request edit or execution permissions',
};
// Other delegate-skills implementers are accepted when their relay offers --read-only; that probe is the real guard.
export function reviewTooling(implementer) {
  return REVIEW_TOOLING[implementer] ?? 'the read-only tools your relay provides: read and search files only; do not request edit or execution permissions';
}
export function resolveReviewOverride(cwd, laneName, { globalOnly = false, config = loadLaneConfig(cwd) } = {}) {
  const entry = config.lanes[laneName];
  if (!entry) throw usage(`reviewer lane ${laneName} is not configured`);
  if (globalOnly && entry.source !== 'global') throw usage(`reviewer lane ${laneName} must use a global binding`);
  if (entry.source === 'project' && !config.projectTrusted) throw usage(`reviewer lane ${laneName} requires explicit project configuration trust`);
  const relay = findScript(`${entry.implementer}-delegate`, 'relay.mjs');
  if (!relaySupportsReadOnly(relay)) throw usage(`reviewer ${entry.implementer} lacks a read-only relay`);
  const dials = entry.dials || entry;
  return { reviewer: { implementer: entry.implementer, lane: laneName, model: dials.model ?? null,
    effort: dials.effort ?? dials.variant ?? null, source: entry.source }, relay };
}
function runtimeModels(file, { from = null, to = null, transcript = false } = {}) {
  let contents;
  try {
    if (!file || fs.statSync(file).size > 256 * 1024 * 1024) return [];
    contents = fs.readFileSync(file, 'utf8');
  } catch { return []; }
  const models = new Set();
  for (const line of contents.split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(e.timestamp);
    if (from && !(ts >= Date.parse(from) && ts <= Date.parse(to))) continue;
    const model = transcript ? (e.type === 'assistant' ? e.message?.model : e.servedModel ?? e.payload?.served_model)
      : (e.type === 'system' && e.subtype === 'init' ? e.model : e.servedModel ?? e.payload?.served_model);
    if (typeof model === 'string' && model) models.add(model);
  }
  return [...models];
}
export function modelIdentity(dir, requestedModel = null) {
  const result = readJsonIfExists(path.join(dir, 'result.json')) || {};
  const models = runtimeModels(path.join(dir, 'events.jsonl'));
  return { requestedModel: result.model ?? requestedModel, servedModel: models.length === 1 ? models[0] : null };
}
export function orchestratorModel(home, run) {
  const session = loadSession(home, run.seat, run.sessionId);
  const models = runtimeModels(session?.transcriptPath, { from: run.createdAt, to: nowIso(), transcript: true });
  return models.length === 1 ? models[0] : null;
}
export function reviewerLabel(reviewer) {
  if (!reviewer) return 'unknown';
  return `${reviewer.implementer ?? 'unknown'} (${reviewer.lane ?? 'unknown'}; requested ${reviewer.requestedModel ?? reviewer.model ?? 'default'}, served ${reviewer.servedModel ?? 'unknown'})`;
}
