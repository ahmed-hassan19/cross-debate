// plan.mjs — `debate.mjs plan`: cross-review a final plan with two reviewer lanes, record orchestrator verdicts, and
// finish with a fence-aware review block whose digest the hooks verify. Commands print one JSON document; diagnostics
// go to stderr. Exit 0: structured result (including reviewer/preflight failures); 2: usage/config error; 1: internal.
// Importing this module has no side effects.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  RUN_SCHEMA, MAX_ROUNDS, PLAN_LANES, SEATS, CLI, SKILL_DIR, cliCommand, RECEIPT_TTL_MS, usage, nowIso, log, printJson, isPidAlive, sleepMs,
  debateHome, ensureHome, requireWritableHome, readJsonIfExists, writeJson, createRun, loadRun, updateRun, runDir,
  loadSession, updateSession, validateSeat, sessionIdFor, sessionKey, validateRunId, resolveCwdArg, readPlanArg,
  parseDuration, splitPlan, renderWithBlock, runRelay, spawnDetached,
  addUsage, emptyUsage,
  repoIdentity, usageFromRelayDir, extractJson, validatePlanReview, validateVerdictDoc, verdictDeclaresChange, missedDeclaresChange,
  orchestratorUsageFromTranscript, upsertStatsRow, statsRowFromRun, statsCommand, parseArgs, loadLaneConfig,
} from './lib/common.mjs';
import { failReviewAttempt, needsUserDecision, validateResume, authorizeResume, recordSelfReview, requireFinishDecision, resolveReviewOverride, reviewTooling, modelIdentity, orchestratorModel, reviewerLabel } from './lib/recovery.mjs';
export const TEMPLATE_PATH = path.join(SKILL_DIR, 'assets', 'review-brief.md');
const DEFAULT_TIMEOUT = '20m';
export const ACCEPT_RATING = 8; // acceptance threshold for a valid plan rating

const HELP = `debate.mjs plan — cross-review a final plan with the plan-main and plan-debate lanes

Usage:
  review --new --plan <file|-> --cwd <dir> --seat ${SEATS.join('|')} --session <id> [--detach] [--timeout 20m]
  review --run <id> --plan <file|-> [--detach]
  review --run <id> --retry [--detach]
  resume --run <id> --seat <seat> --session <id> --reason "user authorized: <quote>" [--reviewer-lane <lane>] [--detach]
  wait --run <id> [--max-wait 60s]
  verdict --run <id> --round <n> --plan <file|-> --verdicts <file>
  finish --run <id> [--plan <file|->] [--self-review <report> --reason "user authorized: <quote>"]
  stats [--kind plan|code] [--seat <seat>] [--since 30d] [--json]

The primary reviewer is lane plan-main-<seat> when configured, else plan-main; the second is plan-debate.

Environment: DEBATE_HOME (default ~/.local/share/debate). --help never launches a model.
`;

// ---------- run model ----------

export function newPlanRun({ seat, sessionId, cwd, sourcePath, origin, timeout }) {
  const now = nowIso();
  return {
    schema: RUN_SCHEMA, kind: 'plan', runId: crypto.randomUUID(), seat, sessionId, sessionKey: sessionKey(seat, sessionId), cwd,
    createdAt: now, updatedAt: now, finishedAt: null, status: 'new', stopReason: null, outcome: null, retryUsed: false,
    timeout, rounds: [], warnings: [], preflight: null,
    plan: { sourcePath, origin, firstFinishedAt: null, receipt: null, finalBody: null },
  };
}
function currentRound(run) { return run.rounds[run.rounds.length - 1] || null; }
function currentAttempt(round) { return round ? round.attempts[round.attempts.length - 1] || null : null; }
function relativeAttemptDir(roundNo, attemptNo) { return path.join(`round-${roundNo}`, `attempt-${attemptNo}`); }

/** Public view of a run's current round/attempt. */
export function reviewDoc(run, extra = {}) {
  const round = currentRound(run);
  const attempt = currentAttempt(round);
  const reviewers = attempt ? (attempt.reviewers || (attempt.reviewer ? [attempt.reviewer] : [])) : [];
  const doc = {
    ok: true, runId: run.runId, kind: 'plan', seat: run.seat, round: round ? round.round : 0, attempt: attempt ? attempt.attempt : 0,
    status: attempt ? attempt.status : run.status === 'preflight_failed' ? 'preflight_failed' : run.status,
    runStatus: run.status, stopReason: run.stopReason, retryUsed: run.retryUsed,
    retryAvailable: run.status === 'review_failed' && !run.retryUsed,
    needsUserDecision: needsUserDecision(run), failureDetails: attempt?.failureDetails ?? null,
    reviewer: attempt ? attempt.reviewer : null,
    reviewers,
    reviewerCount: reviewers.length,
    rating: round && round.review ? round.review.rating : null,
    summary: round && round.review ? round.review.summary : null,
    findings: round && round.review ? round.review.findings : [],
    assumptions: round && round.review ? round.review.assumptions : [],
    contests: round && round.review ? round.review.contests : [],
    reviews: round && round.review ? round.review.reviews || [] : [],
    usage: attempt ? attempt.usage ?? null : null, cost: attempt ? attempt.cost ?? null : null,
    seconds: attempt ? attempt.seconds ?? null : null, coverage: attempt ? attempt.coverage ?? null : null,
    error: attempt && attempt.error ? attempt.error : run.preflight && run.preflight.status === 'failed' ? run.preflight.reason : null,
    artifacts: { runDir: runDir(debateHome(), run.runId), attemptDir: attempt ? path.join(runDir(debateHome(), run.runId), attempt.dir) : null },
    warnings: [...(run.warnings || []), ...((attempt && attempt.warnings) || [])],
    ...extra,
  };
  return doc;
}

// ---------- preflight ----------

/** plan-main-<seat> when that lane exists, else plan-main; the chosen lane then resolves strictly. */
export function planLanes(seat, cwd) {
  const seatLane = `${PLAN_LANES.main}-${seat}`;
  return [Object.hasOwn(loadLaneConfig(cwd).lanes, seatLane) ? seatLane : PLAN_LANES.main, PLAN_LANES.debate];
}
export function planPreflight(seat, cwd, override = null) {
  if (!SEATS.includes(seat)) return { ok: false, reason: `unsupported seat ${seat}` };
  if (!fs.existsSync(TEMPLATE_PATH)) return { ok: false, reason: `missing brief template ${TEMPLATE_PATH}` };
  let lanes;
  try { lanes = planLanes(seat, cwd); } catch (e) { return { ok: false, reason: `lane configuration: ${e.message}` }; }
  const reviewers = [];
  for (let i = 0; i < lanes.length; i++) {
    const role = i === 0 ? 'primary' : `secondary-${i}`;
    try {
      const lane = i === 0 && override ? override : lanes[i];
      const selected = resolveReviewOverride(cwd, lane);
      reviewers.push({ ...selected.reviewer, role });
    } catch (e) {
      return { ok: false, reason: `${role} reviewer preflight: ${e.message}` };
    }
  }
  return { ok: true, reviewer: reviewers[0], reviewers };
}

// ---------- brief ----------

function allFindingIds(run) { return new Set(run.rounds.flatMap(r => r.review ? r.review.findings.map(f => f.id) : [])); }
function allAssumptionIds(run) { return new Set(run.rounds.flatMap(r => r.review ? r.review.assumptions.map(a => a.id) : [])); }
function nextId(prefix, ids) { let max = 0; for (const id of ids) { if (!String(id).startsWith(prefix)) continue; const n = Number(String(id).slice(prefix.length)); if (n > max) max = n; } return `${prefix}${max + 1}`; }
function priorContestIds(run, roundNo) {
  const prev = run.rounds[roundNo - 2];
  if (!prev || !prev.verdict) return [];
  return prev.verdict.verdicts.filter(v => v.verdict === 'modify' || v.verdict === 'discard').map(v => v.id);
}
// Explicit projections keep operational metadata and raw reports in local artifacts only.
function project(rows, fields) {
  return (rows || []).map(row => Object.fromEntries(fields.filter(key => row[key] !== undefined).map(key => [key, row[key]])));
}
export function renderHistory(run, roundNo) {
  const history = run.rounds.slice(0, roundNo - 1).map(round => ({
    round: round.round,
    findings: project(round.review?.findings, ['id', 'where', 'claim', 'evidence', 'severity', 'recommendation']),
    verdicts: project(round.verdict?.verdicts, ['id', 'verdict', 'reason', 'evidence', 'change']),
    contests: project(round.review?.contests, ['id', 'stance', 'reason', 'evidence']),
    contest_rulings: project(round.verdict?.contest_rulings, ['id', 'ruling', 'reason', 'evidence']),
    assumptions: project(round.review?.assumptions, ['id', 'decision', 'recommended', 'options']),
    resolutions: project(round.verdict?.assumptions, ['id', 'resolution', 'answer', 'changed_plan']),
    missed: project((round.verdict?.missed || []).filter(m => missedDeclaresChange({ missed: [m] })), ['claim', 'evidence', 'change', 'fixed']),
    ...(!round.review ? { unresolved: 'Review failed; no findings recorded.' } : !round.verdict ? { unresolved: 'Findings await verdicts.' } : {}),
  }));
  return history.length ? JSON.stringify(history) : '(none: this is the first round)';
}
export function buildBrief(run, roundNo, planBody, reviewer, role = reviewer?.role || 'primary') {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const tooling = reviewTooling(reviewer.implementer);
  const vars = {
    ROUND: String(roundNo), CWD: run.cwd, TOOLING: tooling, PLAN: planBody, HISTORY: renderHistory(run, roundNo),
    NEXT_FINDING_ID: nextId('F', allFindingIds(run)), NEXT_ASSUMPTION_ID: nextId('A', allAssumptionIds(run)),
    REVIEWER_ROLE: role,
  };
  // One pass over the template: placeholders inside inserted values (the plan, the history) stay literal.
  return template.replace(/{{([A-Z_]+)}}/g, (match, key) => (Object.hasOwn(vars, key) ? vars[key] : match));
}

// ---------- rounds and attempts ----------

const STARTABLE = new Set(['new', 'preflight_failed', 'continue']);
export function startRound(home, runId, planBody, inputSource = null) {
  return updateRun(home, runId, (run) => {
    if (!STARTABLE.has(run.status)) throw usage(`run ${runId} is ${run.status}; a new round needs status new, preflight_failed, or continue`);
    if (run.rounds.length >= MAX_ROUNDS) throw usage(`run ${runId} already used ${MAX_ROUNDS} rounds`);
    const split = splitPlan(planBody);
    if (split.error) throw usage(split.error);
    const roundNo = run.rounds.length + 1;
    const dir = runDir(home, runId);
    fs.mkdirSync(path.join(dir, `round-${roundNo}`), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, `round-${roundNo}`, 'plan.md'), split.body, { mode: 0o600 });
    const prev = run.rounds[roundNo - 2];
    const warnings = [];
    if (prev && prev.revisedDigest && prev.revisedDigest !== split.digest) warnings.push(`round ${roundNo} plan differs from the round ${prev.round} verdict snapshot`);
    run.rounds.push({ round: roundNo, planDigest: split.digest, planPath: path.join(`round-${roundNo}`, 'plan.md'), attempts: [], review: null, verdict: null, revisedDigest: null, revisedPath: null, ratingValid: null, next: null, stopReason: null, warnings });
    run.rounds.at(-1).inputSource = inputSource ?? (roundNo === 1 ? { sourcePath: run.plan.sourcePath, origin: run.plan.origin } : { sourcePath: null, origin: 'stdin' });
    run.preflight = null;
    run.status = 'round_open';
    return run;
  });
}
export function startAttempt(home, runId, reviewerInput, { retry = false, resume = null } = {}) {
  const reviewers = (Array.isArray(reviewerInput) ? reviewerInput : [reviewerInput]).filter(Boolean).map((reviewer, i) => ({
    ...reviewer, role: reviewer.role || (i === 0 ? 'primary' : `secondary-${i}`),
  }));
  if (!reviewers.length) throw usage('at least one reviewer is required');
  return updateRun(home, runId, (run) => {
    if (resume) {
      authorizeResume(run, resume, home);
      if (resume.reviewerLane) run.reviewerLane = resume.reviewerLane;
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
      throw usage(`run ${runId} is ${run.status}; use --retry for a failed attempt or --plan for a new round`);
    }
    const attemptNo = round.attempts.length + 1;
    const dir = relativeAttemptDir(round.round, attemptNo);
    fs.mkdirSync(path.join(runDir(home, runId), dir), { recursive: true, mode: 0o700 });
    round.attempts.push({ attempt: attemptNo, resumed: Boolean(resume), status: 'running', startedAt: nowIso(), finishedAt: null, pid: null, dir, reviewer: reviewers[0], reviewers, agents: [], coverage: null, usage: null, cost: null, seconds: null, reviewerSessionId: null, error: null, failure: null, warnings: [] });
    run.status = 'running';
    return run;
  });
}
export function setAttemptPid(home, runId, roundNo, attemptNo, pid) {
  updateRun(home, runId, (run) => {
    const attempt = run.rounds[roundNo - 1] && run.rounds[roundNo - 1].attempts[attemptNo - 1];
    if (attempt && attempt.status === 'running') attempt.pid = pid;
    return run;
  });
}
const failAttempt = failReviewAttempt;
function reviewersForAttempt(attempt) {
  return attempt.reviewers && attempt.reviewers.length ? attempt.reviewers : attempt.reviewer ? [attempt.reviewer] : [];
}
function secondsFromResult(result, fallback = null) {
  if (fallback !== null && fallback !== undefined) return fallback;
  if (result && result.startedAt && result.finishedAt) return Math.round((Date.parse(result.finishedAt) - Date.parse(result.startedAt)) / 1000);
  return null;
}
function coverageForAgents(agents) {
  const coverage = agents.map(a => a.coverage);
  if (coverage.includes('violation')) return 'violation';
  if (coverage.includes('incomplete')) return 'incomplete';
  if (coverage.includes('unreported')) return 'unreported';
  if (coverage.includes('sandbox')) return 'sandbox';
  return coverage.length && coverage.every(c => c === 'complete') ? 'complete' : 'unreported';
}
function namespaceReview(review, role, findingIds, assumptionIds) {
  const secondary = role !== 'primary';
  const findings = review.findings.map((finding) => {
    const sourceId = finding.id;
    const id = secondary ? nextId('S', findingIds) : sourceId;
    findingIds.add(id);
    return { ...finding, id, sourceId, reviewer: role };
  });
  const assumptions = review.assumptions.map((assumption) => {
    const sourceId = assumption.id;
    const id = secondary ? nextId('B', assumptionIds) : sourceId;
    assumptionIds.add(id);
    return { ...assumption, id, sourceId, reviewer: role };
  });
  return { ...review, findings, assumptions, reviewer: role };
}
function mergeContests(reports) {
  const merged = new Map();
  for (const report of reports) for (const contest of report.review.contests) {
    const prior = merged.get(contest.id);
    if (!prior) {
      merged.set(contest.id, { ...contest, reviewerRoles: [report.role] });
      continue;
    }
    const reasons = [prior.reason, contest.reason].filter(Boolean);
    const evidence = [prior.evidence, contest.evidence].filter(Boolean);
    merged.set(contest.id, {
      ...prior,
      stance: prior.stance === 'contest' || contest.stance === 'contest' ? 'contest' : 'accept',
      reason: [...new Set(reasons)].join(' | '),
      ...(evidence.length ? { evidence: [...new Set(evidence)].join(' | ') } : {}),
      reviewerRoles: [...new Set([...(prior.reviewerRoles || []), report.role])],
    });
  }
  return [...merged.values()];
}
/** Combine independent reviewer reports, namespacing the second reviewer's new IDs. */
export function mergePlanReviews(run, reports) {
  const findingIds = allFindingIds(run);
  const assumptionIds = allAssumptionIds(run);
  const normalized = reports.map((report) => ({
    ...report,
    review: namespaceReview(report.review, report.role, findingIds, assumptionIds),
  }));
  const reviews = normalized.map(({ role, reviewer, review }) => ({
    role, reviewer, rating: review.rating, summary: review.summary, findings: review.findings,
    assumptions: review.assumptions, contests: review.contests,
  }));
  return {
    rating: Math.min(...normalized.map(r => r.review.rating)),
    summary: normalized.map(r => `${r.role} reviewer: ${r.review.summary}`).join('\n\n'),
    findings: normalized.flatMap(r => r.review.findings),
    assumptions: normalized.flatMap(r => r.review.assumptions),
    contests: mergeContests(normalized),
    reviews,
    ratings: normalized.map(r => ({ role: r.role, rating: r.review.rating })),
  };
}
/** Read one or more relay artifact directories into the run. Rejects stale round/attempt references. */
export function ingestPlanReview(home, runId, roundNo, attemptNo, relayInput, options = {}) {
  return updateRun(home, runId, (run) => {
    const round = run.rounds[roundNo - 1];
    const attempt = round && round.attempts[attemptNo - 1];
    if (!round || !attempt) throw usage(`unknown round ${roundNo} attempt ${attemptNo}`);
    if (roundNo !== run.rounds.length || attemptNo !== round.attempts.length) throw usage(`stale update: round ${roundNo} attempt ${attemptNo} is not current`);
    if (attempt.status !== 'running') throw usage(`attempt ${attemptNo} of round ${roundNo} is already ${attempt.status}`);
    const reviewers = reviewersForAttempt(attempt);
    const inputs = Array.isArray(relayInput)
      ? relayInput
      : [{ relayDir: relayInput, exitCode: options.exitCode ?? null, seconds: options.seconds ?? null, stderrTail: options.stderrTail ?? '' }];
    const entries = inputs.map((input, i) => ({
      ...input,
      reviewer: input.reviewer || reviewers[i],
      role: input.role || input.reviewer?.role || reviewers[i]?.role || (i === 0 ? 'primary' : `secondary-${i}`),
    }));
    if (!entries.length || entries.some(entry => !entry.reviewer)) {
      failAttempt(run, round, attempt, 'internal', 'no reviewer configuration was available');
      return run;
    }
    const reports = [];
    const agents = [];
    let combinedUsage = null;
    let combinedCost = 0;
    let costKnown = false;
    let combinedSeconds = 0;
    const saveMetrics = () => {
      attempt.agents = agents;
      attempt.usage = combinedUsage;
      attempt.cost = costKnown ? combinedCost : null;
      attempt.seconds = combinedSeconds || null;
      attempt.reviewerSessionId = agents[0]?.sessionId ?? null;
      attempt.coverage = coverageForAgents(agents);
      attempt.reviewers = reviewers;
      attempt.reviewer = reviewers[0] || attempt.reviewer;
    };
    const failReviewer = (entry, failure, message, result) => {
      saveMetrics();
      failAttempt(run, round, attempt, failure, `${entry.role} reviewer: ${message}`, result ? { ...result, stderrTail: entry.stderrTail || result.stderrTail } : null);
      if (attempt.failureDetails) attempt.failureDetails.stage = entry.role;
      return run;
    };
    for (const entry of entries) {
      const reviewer = entry.reviewer;
      const relayDir = entry.relayDir;
      const info = usageFromRelayDir(reviewer.implementer, relayDir);
      Object.assign(reviewer, modelIdentity(relayDir, reviewer.model));
      const result = readJsonIfExists(path.join(relayDir, 'result.json'));
      const seconds = secondsFromResult(result, entry.seconds);
      const agent = { ...reviewer, stage: entry.role, ...info, status: result?.status || 'missing', seconds, usage: info.usage, cost: info.cost, coverage: info.coverage };
      agents.push(agent);
      if (info.usage) combinedUsage = addUsage(combinedUsage || emptyUsage(), info.usage);
      if (typeof info.cost === 'number') { combinedCost += info.cost; costKnown = true; }
      if (typeof seconds === 'number') combinedSeconds += seconds;
      if (!result) return failReviewer(entry, 'relay', `relay exited ${entry.exitCode} without result.json`, null);
      if (result.readOnlyViolation === true) return failReviewer(entry, 'read_only_violation', 'relay reported a read-only violation; output rejected', result);
      if (Number.isInteger(entry.exitCode) && entry.exitCode !== 0) return failReviewer(entry, 'relay', `relay exited ${entry.exitCode}`, result);
      if (result.status !== 'completed') return failReviewer(entry, result.status === 'timeout' ? 'timeout' : 'relay', `relay status ${result.status}${result.error ? `: ${result.error}` : ''}`, result);
      if (info.coverage === 'incomplete') attempt.warnings.push(`${entry.role}: read-only tripwire coverage incomplete (readOnlyViolation null)`);
      if (info.coverage === 'unreported') attempt.warnings.push(`${entry.role}: read-only tripwire coverage unreported by this relay`);
      const doc = extractJson(result.finalMessage);
      if (!doc) return failReviewer(entry, 'bad_output', 'reviewer returned no parseable JSON block', result);
      const validation = validatePlanReview(doc, { round: roundNo, usedFindingIds: allFindingIds(run), usedAssumptionIds: allAssumptionIds(run), priorContestIds: priorContestIds(run, roundNo) });
      if (!validation.ok) return failReviewer(entry, 'bad_output', `invalid review: ${validation.errors.join('; ')}`, result);
      attempt.warnings.push(...validation.warnings.map(w => `${entry.role}: ${w}`));
      reports.push({ role: entry.role, reviewer, review: validation.doc });
    }
    if (reports.length !== reviewers.length) return failReviewer(entries[reports.length] || entries.at(-1), 'relay', `expected ${reviewers.length} reviewer reports but received ${reports.length}`, null);
    const merged = mergePlanReviews(run, reports);
    saveMetrics();
    attempt.status = 'completed';
    attempt.finishedAt = nowIso();
    round.review = { ...merged, attempt: attemptNo };
    run.status = 'awaiting_verdict';
    return run;
  });
}
/** Build the brief, run the relay, ingest. Marks the attempt failed on any internal error. */
export function runAttempt(home, runId, roundNo, attemptNo) {
  const run = loadRun(home, runId);
  const round = run.rounds[roundNo - 1];
  const attempt = round && round.attempts[attemptNo - 1];
  if (!round || !attempt || attempt.status !== 'running') throw usage(`round ${roundNo} attempt ${attemptNo} is not running`);
  const dir = runDir(home, runId);
  const attemptDir = path.join(dir, attempt.dir);
  try {
    const planBody = fs.readFileSync(path.join(dir, round.planPath), 'utf8');
    const reviewers = reviewersForAttempt(attempt);
    const results = [];
    for (let i = 0; i < reviewers.length; i++) {
      const reviewer = reviewers[i];
      const role = reviewer.role || (i === 0 ? 'primary' : `secondary-${i}`);
      const suffix = i === 0 ? '' : `-${role}`;
      const briefPath = path.join(attemptDir, `brief${suffix}.md`);
      const brief = buildBrief(run, roundNo, planBody, reviewer, role);
      fs.writeFileSync(briefPath, brief, { mode: 0o600 });
      updateRun(home, runId, cur => {
        const at = cur.rounds[roundNo - 1].attempts[attemptNo - 1];
        (at.promptSizes ||= []).push({ role, planBytes: Buffer.byteLength(planBody), historyBytes: Buffer.byteLength(renderHistory(run, roundNo)), briefBytes: Buffer.byteLength(brief) });
        return cur;
      });
      const relayDir = path.join(attemptDir, `relay${suffix}`);
      fs.mkdirSync(relayDir, { recursive: true, mode: 0o700 });
      const extraArgs = reviewer.implementer === 'codex' && !repoIdentity(run.cwd) ? ['--skip-git-repo-check'] : [];
      const r = runRelay({ implementer: reviewer.implementer, lane: reviewer.lane, briefPath, cwd: run.cwd, outDir: relayDir, timeout: run.timeout, extraArgs });
      results.push({ role, reviewer, relayDir, exitCode: r.exitCode, seconds: r.seconds, stderrTail: r.stderrTail });
      if (r.exitCode !== 0 || !r.result || r.result.status !== 'completed' || !extractJson(r.result.finalMessage)) break;
    }
    return ingestPlanReview(home, runId, roundNo, attemptNo, results);
  } catch (e) {
    return updateRun(home, runId, (cur) => {
      const rd = cur.rounds[roundNo - 1];
      const at = rd && rd.attempts[attemptNo - 1];
      if (at && at.status === 'running') failAttempt(cur, rd, at, 'internal', e.message);
      return cur;
    });
  }
}
/** Observe only: a running attempt whose worker is dead becomes failed. */
export function waitForRun(home, runId, maxWaitMs) {
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

// ---------- verdicts and stop conditions ----------

export function stopDecision({ round, rating, ratingValid, changed, agreed = false }) {
  if (round >= MAX_ROUNDS) return { next: 'stop', stopReason: 'round_limit' };
  if (ratingValid && rating >= ACCEPT_RATING) return { next: 'stop', stopReason: 'rating' };
  if (!changed) return { next: 'stop', stopReason: 'no_changes' };
  if (agreed) return { next: 'stop', stopReason: 'agreed' };
  return { next: 'continue', stopReason: null };
}
/** Both sides agree: the reviewer rated the text acceptable with no blocking finding, and the orchestrator declares no further review. */
export function planAgreed(review, doc) {
  return review.rating >= ACCEPT_RATING && !review.findings.some(f => f.severity === 'blocking') && doc.no_further_review === true && !missedDeclaresChange(doc);
}
export function applyVerdict(home, runId, roundNo, revisedBody, doc) {
  return updateRun(home, runId, (run) => {
    if (run.status !== 'awaiting_verdict') throw usage(`run ${runId} is ${run.status}; verdict needs a completed review awaiting a verdict`);
    const round = run.rounds[roundNo - 1];
    if (!round || roundNo !== run.rounds.length) throw usage(`round ${roundNo} is not the current round (${run.rounds.length})`);
    if (!round.review || round.verdict) throw usage(`round ${roundNo} ${round.verdict ? 'already has a verdict' : 'has no completed review'}`);
    const validation = validateVerdictDoc(doc, { findingIds: round.review.findings.map(f => f.id), contestedIds: round.review.contests.filter(c => c.stance === 'contest').map(c => c.id), assumptionIds: allAssumptionIds(run) });
    if (!validation.ok) throw usage('invalid verdict file', validation.errors);
    const split = splitPlan(revisedBody);
    if (split.error) throw usage(split.error);
    const changed = split.digest !== round.planDigest;
    if (!changed && verdictDeclaresChange(doc)) throw usage('verdict declares a change but the plan text is unchanged; apply it or drop the change field');
    const revisedPath = path.join(`round-${roundNo}`, 'plan-revised.md');
    fs.writeFileSync(path.join(runDir(home, runId), revisedPath), split.body, { mode: 0o600 });
    const agreed = changed && planAgreed(round.review, doc);
    round.verdict = { review_rating: doc.review_rating, verdicts: doc.verdicts, contest_rulings: doc.contest_rulings, assumptions: doc.assumptions, missed: doc.missed, no_further_review: doc.no_further_review === true, at: nowIso() };
    round.revisedDigest = split.digest;
    round.revisedPath = revisedPath;
    round.ratingValid = !changed;
    round.changed = changed;
    round.agreed = agreed;
    const decision = stopDecision({ round: roundNo, rating: round.review.rating, ratingValid: !changed, changed, agreed });
    round.next = decision.next;
    round.stopReason = decision.stopReason;
    run.status = decision.next === 'continue' ? 'continue' : 'stopped';
    run.stopReason = decision.stopReason;
    return run;
  });
}

// ---------- finish ----------

function md(s) { return String(s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|'); }
export function renderReviewSection(run, receipt) {
  const out = [`<!-- debate-plan:begin run=${run.runId} sha=${receipt.shortSha} -->`, '## Implementation handoff (debate-plan)', '', `Review outcome: **${run.outcome}**.`];
  const assumptions = new Map();
  const resolutions = new Map();
  const changes = new Set();
  const rulings = new Map();
  const findings = new Map(run.rounds.flatMap(round => (round.review?.findings || []).map(f => [f.id, f])));
  for (const round of run.rounds) for (const ruling of round.verdict?.contest_rulings || []) rulings.set(ruling.id, ruling);
  const hasChange = value => typeof value === 'string' && value.trim() && !/^(?:none|n\/a|no change|unchanged)[.!]?$/i.test(value.trim());
  for (const round of run.rounds) {
    for (const a of round.review?.assumptions || []) assumptions.set(a.id, a);
    for (const a of round.verdict?.assumptions || []) resolutions.set(a.id, a);
    for (const v of round.verdict?.verdicts || []) if (hasChange(v.change) && rulings.get(v.id)?.ruling !== 'reverse') changes.add(`- ${v.verdict === 'discard' ? 'Review change' : 'Applied'} ${md(v.id)}: ${md(v.change)}`);
    for (const m of round.verdict?.missed || []) if (missedDeclaresChange({ missed: [m] })) changes.add(`- Missed finding: ${md(m.claim)}${m.evidence ? ` (${md(m.evidence)})` : ''} · ${m.change?.trim() ? `change: ${md(m.change)}` : 'fixed'}`);
    for (const f of round.review?.findings || []) {
      const verdict = round.verdict?.verdicts.find(v => v.id === f.id);
      if (!verdict || (['confirm', 'modify'].includes(verdict.verdict) && !hasChange(verdict.change) && verdict.fixed !== true)) {
        out.push(`- Unresolved ${md(f.id)}: ${md(f.claim)}; ${md(f.recommendation)}${verdict ? ` (verdict: ${md(verdict.verdict)}; ${md(verdict.reason)})` : ''}`);
      }
    }
    for (const c of round.review?.contests || []) if (c.stance === 'contest' && !round.verdict?.contest_rulings.some(r => r.id === c.id)) out.push(`- Unresolved contest ${md(c.id)}: ${md(c.reason)}`);
  }
  out.push(...changes);
  for (const ruling of rulings.values()) if (ruling.ruling === 'reverse') {
    const finding = findings.get(ruling.id);
    out.push(`- Reversed ${md(ruling.id)}: ${md(ruling.reason)}${ruling.evidence ? ` (${md(ruling.evidence)})` : ''}${finding ? ` · Finding: ${md(finding.claim)}; recommendation: ${md(finding.recommendation)}` : ''}`);
  }
  const open = [...assumptions.values()].filter(a => !resolutions.has(a.id) || resolutions.get(a.id).resolution === 'open');
  out.push(`Open decisions: ${open.length ? open.map(a => `${md(a.id)}: ${md(a.decision)} (recommended: ${md(a.recommended)})`).join('; ') : 'none'}`);
  out.push(`Changes after the last review: ${receipt.unratedChanges ? 'yes — the finished text differs from the last reviewed snapshot and is unrated' : 'none'}`);
  if (run.selfReview) out.push(`Self-review report: ${md(run.selfReview.report)}. This is not a successful independent debate review.`);
  if (run.rounds.some(r => r.attempts.some(a => a.status === 'failed'))) out.push('Warning: a review attempt failed; see local run artifacts for failure details.');
  if (run.outcome !== 'completed') out.push(`**WARNING: this plan did not receive a successful review (outcome ${run.outcome}).**`);
  out.push('<!-- debate-plan:end -->');
  return `${out.join('\n')}\n`;
}
const FINISHABLE = new Set(['stopped', 'finished']);
export function finishPlan(home, runId, { body, sourcePath, selfReview, reason } = {}) {
  if (selfReview) updateRun(home, runId, r => { recordSelfReview(r, { report: selfReview, reason }); return r; });
  const run = loadRun(home, runId);
  requireFinishDecision(run);
  if (!FINISHABLE.has(run.status)) throw usage(`run ${runId} is ${run.status}; finish requires a stopped review with a verdict or authorized self-review`);
  const dir = runDir(home, runId);
  let writeTarget = null;
  if (body === undefined) {
    if (run.plan.origin === 'file') {
      try { body = fs.readFileSync(run.plan.sourcePath, 'utf8'); } catch (e) { throw usage(`cannot read registered plan ${run.plan.sourcePath}: ${e.message}`); }
      writeTarget = run.plan.sourcePath;
    } else {
      const last = [...run.rounds].reverse().find(r => r.revisedPath || r.planPath);
      body = run.plan.finalBody ?? (last ? fs.readFileSync(path.join(dir, last.revisedPath || last.planPath), 'utf8') : '');
    }
  } else if (sourcePath) {
    writeTarget = sourcePath;
  }
  const split = splitPlan(body);
  if (split.error) throw usage(split.error);
  if (run.selfReview && run.selfReview.snapshot !== split.digest) throw usage('self-review snapshot differs from the final plan; review the changed plan separately');
  const restamp = Boolean(run.plan.receipt);
  if (restamp && split.digest !== run.plan.receipt.digest) throw usage(`plan content changed after finish (digest ${split.digest.slice(0, 12)} ≠ receipt ${run.plan.receipt.digest.slice(0, 12)}); start a new review run with review --new`);
  const lastReviewed = [...run.rounds].reverse().find(r => r.review);
  // compare with the text the reviewer actually saw; a post-verdict revision is unrated until the next round reviews it
  const unratedChanges = restamp ? run.plan.receipt.unratedChanges : Boolean(lastReviewed && lastReviewed.planDigest !== split.digest);
  const session = loadSession(home, run.seat, run.sessionId);
  const now = nowIso();
  const receipt = { digest: split.digest, shortSha: split.digest.slice(0, 12), generation: session ? session.generation : 0, finishedAt: now, firstFinishedAt: run.plan.firstFinishedAt || now, planPath: writeTarget || run.plan.sourcePath, unratedChanges };
  const finished = updateRun(home, runId, (cur) => {
    if (!FINISHABLE.has(cur.status)) throw usage(`run ${runId} changed state to ${cur.status}`);
    cur.outcome = currentRound(cur)?.review ? 'completed' : 'failed';
    if (!cur.stopReason && cur.status !== 'finished') cur.stopReason = cur.rounds.some(r => r.review) ? 'finished_without_stop' : 'reviewer_failed';
    cur.status = 'finished';
    cur.finishedAt = cur.finishedAt || now;
    cur.plan.firstFinishedAt = receipt.firstFinishedAt;
    if (writeTarget) { cur.plan.sourcePath = writeTarget; cur.plan.origin = 'file'; }
    cur.plan.receipt = receipt;
    cur.plan.finalBody = split.body;
    if (!restamp) cur.orchestratorUsage = orchestratorUsageFromTranscript(session ? session.transcriptPath : null, cur.createdAt, now);
    return cur;
  });
  const section = renderReviewSection(finished, receipt);
  const finishedBody = renderWithBlock(body, split.block, section);
  fs.writeFileSync(path.join(dir, 'plan-final.md'), finishedBody, { mode: 0o600 });
  if (writeTarget) fs.writeFileSync(writeTarget, finishedBody);
  updateSession(home, run.seat, run.sessionId, (s) => { if (!s.planRuns.includes(runId)) s.planRuns.push(runId); return s; });
  upsertStatsRow(home, statsRowFromRun(finished));
  return { ok: true, runId, outcome: finished.outcome, stopReason: finished.stopReason, restamp, receipt, unratedChanges, reviewSection: section, finishedBody, writtenTo: writeTarget, warnings: finished.warnings };
}
/** Receipt check used by the Claude ExitPlanMode gate and the Codex Stop gate. Returns { ok, reason }. */
export function checkReceipt(run, { seat, sessionId, generation, planText, now = Date.now() }) {
  if (run.kind !== 'plan') return { ok: false, reason: `run ${run.runId} is not a plan run` };
  if (run.seat !== seat || run.sessionId !== sessionId) return { ok: false, reason: `run ${run.runId} belongs to ${run.seat} session ${run.sessionId}` };
  if (run.status !== 'finished' || !run.plan.receipt) return { ok: false, reason: `run ${run.runId} is ${run.status}; finish it first` };
  if (run.outcome === 'failed' && !run.selfReview) return { ok: false, reason: 'failed review requires user-authorized self-review before finishing' };
  const receipt = run.plan.receipt;
  if (receipt.generation !== generation) return { ok: false, reason: `receipt is for prompt generation ${receipt.generation}, current is ${generation}` };
  if (now - Date.parse(receipt.firstFinishedAt) > RECEIPT_TTL_MS) return { ok: false, reason: 'receipt is older than 24 hours' };
  const split = splitPlan(planText);
  if (split.error) return { ok: false, reason: split.error };
  if (!split.block) return { ok: false, reason: 'finished plans require exactly one debate-plan block outside fences' };
  if (split.block.runId !== run.runId || split.block.sha !== receipt.shortSha) return { ok: false, reason: `debate-plan block names run ${split.block.runId} sha ${split.block.sha}, receipt is ${run.runId} ${receipt.shortSha}` };
  if (split.digest !== receipt.digest) return { ok: false, reason: 'plan content differs from the finished receipt' };
  return { ok: true, reason: null, warning: run.outcome !== 'completed' ? `run ${run.runId} finished with outcome ${run.outcome}` : null };
}

// ---------- commands ----------

function reviewCommand(flags) {
  if (flags.reviewerLane && !flags.resume) throw usage('--reviewer-lane requires a user-authorized resume');
  const home = debateHome();
  requireWritableHome(home);
  const detach = flags.detach === true;
  let run;
  let planBody;
  let inputSource;
  if (flags.new) {
    const seat = validateSeat(flags.seat);
    const sessionId = sessionIdFor(seat, flags.session);
    const cwd = resolveCwdArg(flags.cwd);
    const timeout = flags.timeout || DEFAULT_TIMEOUT;
    if (!parseDuration(timeout)) throw usage('--timeout must be a duration like 20m');
    const plan = readPlanArg(flags.plan);
    if (!plan.body.trim()) throw usage('plan is empty');
    run = createRun(home, newPlanRun({ seat, sessionId, cwd, sourcePath: plan.sourcePath, origin: plan.origin, timeout }));
    fs.writeFileSync(path.join(runDir(home, run.runId), 'plan-input.md'), plan.body, { mode: 0o600 });
    updateSession(home, seat, sessionId, (s) => { s.planRuns.push(run.runId); return s; });
    planBody = plan.body;
    inputSource = { sourcePath: plan.sourcePath, origin: plan.origin };
  } else {
    run = loadRun(home, validateRunId(flags.run));
    if (run.kind !== 'plan') throw usage(`run ${run.runId} is a ${run.kind} run`);
    if (flags.retry || flags.resume) {
      if (flags.plan !== undefined) throw usage('retry/resume does not take --plan');
      if (flags.resume) validateResume(run, flags, home);
    } else {
      const plan = readPlanArg(flags.plan);
      if (!plan.body.trim()) throw usage('plan is empty');
      planBody = plan.body;
      inputSource = { sourcePath: plan.sourcePath, origin: plan.origin };
    }
  }
  const preflight = planPreflight(run.seat, run.cwd, flags.reviewerLane || run.reviewerLane);
  if (!preflight.ok) {
    const cur = updateRun(home, run.runId, (r) => { r.preflight = { status: 'failed', reason: preflight.reason, at: nowIso() }; if (r.status === 'new') r.status = 'preflight_failed'; return r; });
    printJson(reviewDoc(cur, { status: 'preflight_failed', error: preflight.reason }));
    return 0;
  }
  if (!flags.retry && !flags.resume) startRound(home, run.runId, planBody, inputSource);
  const started = startAttempt(home, run.runId, preflight.reviewers, { retry: flags.retry === true, resume: flags.resume ? flags : null });
  const round = currentRound(started);
  const attempt = currentAttempt(round);
  if (detach) {
    const logPath = path.join(runDir(home, run.runId), attempt.dir, 'worker.log');
    const pid = spawnDetached(CLI, ['plan', '_worker', '--run', run.runId, '--round', String(round.round), '--attempt', String(attempt.attempt)], logPath);
    setAttemptPid(home, run.runId, round.round, attempt.attempt, pid);
    printJson(reviewDoc(loadRun(home, run.runId), { status: 'running', pid, wait: cliCommand(`plan wait --run ${run.runId} --max-wait 60s`) }));
    return 0;
  }
  setAttemptPid(home, run.runId, round.round, attempt.attempt, process.pid);
  const done = runAttempt(home, run.runId, round.round, attempt.attempt);
  printJson(reviewDoc(done));
  return 0;
}
function waitCommand(flags) {
  const home = debateHome();
  const maxWait = parseDuration(flags.maxWait || '60s');
  if (!maxWait) throw usage('--max-wait must be a duration like 60s');
  const run = waitForRun(home, validateRunId(flags.run), maxWait);
  printJson(reviewDoc(run));
  return 0;
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
  const plan = readPlanArg(flags.plan);
  const run = applyVerdict(home, runId, roundNo, plan.body, doc);
  const round = run.rounds[roundNo - 1];
  printJson({ ok: true, runId, round: roundNo, next: round.next, stopReason: round.stopReason, ratingValid: round.ratingValid, rating: round.review.rating, changed: round.changed, agreed: round.agreed, revisedDigest: round.revisedDigest, runStatus: run.status, roundsUsed: run.rounds.length, maxRounds: MAX_ROUNDS });
  return 0;
}
function finishCommand(flags) {
  const home = debateHome();
  requireWritableHome(home);
  const runId = validateRunId(flags.run);
  const opts = { selfReview: flags.selfReview, reason: flags.reason };
  if (flags.plan !== undefined) { const plan = readPlanArg(flags.plan); opts.body = plan.body; opts.sourcePath = plan.sourcePath; }
  printJson(finishPlan(home, runId, opts));
  return 0;
}
function workerCommand(flags) {
  const home = debateHome();
  runAttempt(home, validateRunId(flags.run), Number(flags.round), Number(flags.attempt));
  return 0;
}

export function main(argv) {
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h') { process.stdout.write(HELP); return cmd ? 0 : 2; }
  const { flags } = parseArgs(argv.slice(1), {
    booleans: ['new', 'detach', 'retry', 'json'],
    values: ['plan', 'cwd', 'seat', 'session', 'timeout', 'run', 'maxWait', 'round', 'verdicts', 'kind', 'since', 'attempt', 'reason', 'reviewerLane', 'selfReview'],
  });
  if (flags.help) { process.stdout.write(HELP); return 0; }
  ensureHome(debateHome());
  switch (cmd) {
    case 'review': return reviewCommand(flags);
    case 'resume': return reviewCommand({ ...flags, resume: true });
    case 'wait': return waitCommand(flags);
    case 'verdict': return verdictCommand(flags);
    case 'finish': return finishCommand(flags);
    case 'stats': return statsCommand(flags, debateHome());
    case '_worker': return workerCommand(flags);
    default: throw usage(`unknown command ${cmd}`);
  }
}
