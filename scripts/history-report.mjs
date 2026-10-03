import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { debateHome } from '../skills/cross-debate/scripts/lib/common.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const unique = values => new Set(values).size === values.length;
const decisions = ['confirm', 'modify', 'discard'];
const statuses = ['new', 'running', 'round_open', 'awaiting_verdict', 'continue', 'stopped', 'review_failed', 'preflight_failed', 'finished'];
const outcomes = ['passed', 'completed', 'failed', 'waived', 'changed_after_review', 'blocked', 'exhausted_with_blockers', 'bad_output', 'secrets_detected', 'unsupported_state', 'nothing_to_review'];
const findingsValid = values => Array.isArray(values) && values.every(f => object(f) && text(f.id) && ['blocking', 'non-blocking'].includes(f.severity)) && unique(values.map(f => f.id));
function validRaw(run) {
  return text(run.runId) && ['plan', 'code'].includes(run.kind) && Array.isArray(run.rounds)
    && unique(run.rounds.map(r => r?.round)) && run.rounds.every(r => object(r) && Number.isInteger(r.round) && r.round > 0
      && Array.isArray(r.attempts) && r.attempts.every(a => object(a) && (a.agents == null || (Array.isArray(a.agents) && a.agents.every(object))))
      && (r.review == null || (object(r.review) && findingsValid(r.review.findings)))
      && (r.verdict == null || (object(r.verdict) && Array.isArray(r.verdict.verdicts)
        && unique(r.verdict.verdicts.map(v => v?.id)) && r.verdict.verdicts.every(v => object(v) && text(v.id) && decisions.includes(v.verdict)))));
}
function validStats(row) {
  return row.recordType === 'run' && text(row.runId) && ['plan', 'code'].includes(row.kind)
    && number(row.rounds) && Array.isArray(row.perRound) && row.perRound.every(object) && object(row.claims);
}
function validStandalone(run) {
  const schemas = { main: 'debate-review.findings.v1', debate: 'debate-review.debate.v1', final: 'debate-review.final.v1' };
  return typeof run.local === 'boolean' && object(run.stages)
    && Object.entries(run.stages).every(([name, s]) => Object.hasOwn(schemas, name) && object(s) && object(s.doc) && s.doc.schema === schemas[name])
    && (!run.stages.main || findingsValid(run.stages.main.doc.findings))
    && (!run.stages.debate || findingsValid(run.stages.debate.doc.new_findings || []))
    && (!run.stages.final || findingsValid(run.stages.final.doc.findings));
}

// Only the documented metadata layouts are traversed; filenames and raw fields never reach aggregate output.
export function readHistory({ home = debateHome(),
  reviewCache = path.join(os.homedir(), '.cache/debate-review'), archives = [] } = {}) {
  const coverage = { inputFiles: 0, validRawRecords: 0, validStatsRecords: 0, validStandaloneRecords: 0,
    auditRowsIgnored: 0, malformedRecords: 0, unsupportedRecords: 0, symlinksSkipped: 0,
    duplicateRawRecords: 0, duplicateStatsRecords: 0, statsShadowedByRaw: 0,
    selected: { currentRaw: 0, archiveRaw: 0, currentStatsOnly: 0, archiveStatsOnly: 0, standalone: 0 } };
  const inputs = [], raw = new Map(), stats = new Map(), standalone = [];
  const stat = file => { try { const s = fs.lstatSync(file); if (s.isSymbolicLink()) { coverage.symlinksSkipped++; return null; } return s; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  const dirs = dir => stat(dir)?.isDirectory() ? fs.readdirSync(dir).sort().filter(name => stat(path.join(dir, name))?.isDirectory()) : [];
  const safeRoot = root => {
    for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
      if (!stat(dir)?.isDirectory()) return false;
      if (dir === path.dirname(dir)) return true;
    }
  };
  const read = file => {
    if (!stat(file)?.isFile()) return null;
    inputs.push(file); coverage.inputFiles++;
    return fs.readFileSync(file, 'utf8');
  };
  const parse = (bytes, schema, valid) => {
    let record;
    try { record = JSON.parse(bytes); } catch { coverage.malformedRecords++; return null; }
    if (!object(record)) { coverage.malformedRecords++; return null; }
    if (record.schema !== schema) { coverage.unsupportedRecords++; return null; }
    if (schema === 'debate.stats.v1' && record.recordType === 'audit') { coverage.auditRowsIgnored++; return null; }
    if (!valid(record)) { coverage.malformedRecords++; return null; }
    return record;
  };
  const put = (map, record, source, counter) => {
    if (map.has(record.runId)) coverage[counter]++;
    map.set(record.runId, { record, source });
  };
  for (const [root, current] of [...archives.map(root => [root, false]), [home, true]]) {
    if (!safeRoot(root)) continue;
    for (const name of dirs(path.join(root, 'runs'))) {
      const bytes = read(path.join(root, 'runs', name, 'run.json'));
      const record = bytes === null ? null : parse(bytes, 'debate.run.v1', validRaw);
      if (record) { coverage.validRawRecords++; put(raw, record, current ? 'currentRaw' : 'archiveRaw', 'duplicateRawRecords'); }
    }
    for (const name of current ? ['stats.jsonl'] : ['stats.jsonl.bak', 'stats.jsonl']) {
      const bytes = read(path.join(root, name));
      for (const line of bytes?.split('\n').filter(line => line.trim()) || []) {
        const record = parse(line, 'debate.stats.v1', validStats);
        if (record) { coverage.validStatsRecords++; put(stats, record, current ? 'currentStatsOnly' : 'archiveStatsOnly', 'duplicateStatsRecords'); }
      }
    }
  }
  for (const repo of safeRoot(reviewCache) ? dirs(reviewCache) : []) {
    const root = path.join(reviewCache, repo);
    const branches = repo === 'local' ? dirs(root).flatMap(name => dirs(path.join(root, name)).map(branch => path.join(root, name, branch)))
      : /^[^/]+__[^/]+$/.test(repo) ? dirs(root).filter(pr => /^[1-9]\d*$/.test(pr)).map(pr => path.join(root, pr)) : [];
    for (const branch of branches) for (const sha of dirs(branch).filter(name => /^[a-f0-9]{12}$/i.test(name))) {
      const bytes = read(path.join(branch, sha, 'run.json'));
      const record = bytes === null ? null : parse(bytes, 'debate-review.run.v1', validStandalone);
      if (record) { standalone.push(record); coverage.validStandaloneRecords++; }
    }
  }
  const workflows = [...raw.values()];
  for (const [id, entry] of stats) { if (raw.has(id)) coverage.statsShadowedByRaw++; else workflows.push(entry); }
  workflows.sort((a, b) => a.record.runId < b.record.runId ? -1 : a.record.runId > b.record.runId ? 1 : 0);
  for (const entry of workflows) coverage.selected[entry.source]++;
  coverage.selected.standalone = standalone.length;
  return { workflows, standalone, coverage, inputs };
}

function distribution(values, allowed) {
  const result = Object.fromEntries([...allowed, 'missing', 'other'].map(key => [key, 0]));
  for (const value of values) result[value == null ? 'missing' : allowed.includes(value) ? value : 'other']++;
  return result;
}
function measure(values) {
  const known = values.filter(number).sort((a, b) => a - b), n = known.length;
  return { eligible: values.length, recorded: n, missing: values.length - n,
    total: n ? known.reduce((a, b) => a + b, 0) : null,
    median: n ? (known[Math.floor((n - 1) / 2)] + known[Math.floor(n / 2)]) / 2 : null };
}
const elapsed = run => date(run.finishedAt) && date(run.createdAt || run.startedAt)
  ? (Date.parse(run.finishedAt) - Date.parse(run.createdAt || run.startedAt)) / 1000 : null;
function reviewState(run) {
  const last = run.rounds.at(-1);
  if (run.outcome === 'waived' || run.waiver) return 'waived';
  if (run.status === 'review_failed' || ['failed', 'bad_output', 'secrets_detected', 'unsupported_state'].includes(run.outcome)
    || last?.attempts.at(-1)?.status === 'failed' || run.selfReview) return 'failed';
  if (run.outcome === 'changed_after_review' || run.code?.unreviewedAmendment || run.plan?.receipt?.unratedChanges) return 'changedAfterReview';
  if (['blocked', 'exhausted_with_blockers'].includes(run.outcome) || last?.unfixedBlockers?.length) return 'blocked';
  if (run.status !== 'finished' || !date(run.finishedAt)) return 'unfinished';
  return last?.review && last?.verdict && last.attempts.at(-1)?.status === 'completed' ? 'finishedWithVerdict' : 'finishedWithoutVerdict';
}
function workflowAggregate(runs) {
  const findings = { occurrences: 0, adjudicated: 0, confirm: 0, modify: 0, discard: 0, acceptedBlocking: 0,
    recordedFixed: 0, recordedFixedBlocking: 0, agreedDiscarded: 0, unadjudicated: 0, unmatchedVerdicts: 0 };
  const events = { withAttempts: 0, withFailures: 0, withVerdicts: 0, withAcceptedFindings: 0, withAcceptedBlocking: 0, withRecordedFixes: 0, withRecordedBlockingFixes: 0 };
  const attempts = [], agents = [];
  for (const run of runs) {
    const seen = new Set();
    for (const round of run.rounds) {
      attempts.push(...round.attempts);
      for (const attempt of round.attempts) {
        seen.add('withAttempts');
        if (attempt.status === 'failed') seen.add('withFailures');
        agents.push(...(attempt.agents?.length ? attempt.agents : attempt.reviewer ? [{ usage: attempt.usage, cost: attempt.cost }] : []));
      }
      if (round.verdict) seen.add('withVerdicts');
      const byId = new Map((round.review?.findings || []).map(f => [f.id, f]));
      const verdicts = new Map((round.verdict?.verdicts || []).map(v => [v.id, v]));
      for (const id of verdicts.keys()) if (!byId.has(id)) findings.unmatchedVerdicts++;
      for (const [id, finding] of byId) {
        findings.occurrences++;
        const verdict = verdicts.get(id);
        if (!verdict) { findings.unadjudicated++; continue; }
        findings.adjudicated++; findings[verdict.verdict]++;
        if (verdict.verdict === 'discard') { if (finding.status === 'agreed') findings.agreedDiscarded++; continue; }
        seen.add('withAcceptedFindings');
        if (finding.severity === 'blocking') { findings.acceptedBlocking++; seen.add('withAcceptedBlocking'); }
        if (verdict.fixed === true) {
          findings.recordedFixed++; seen.add('withRecordedFixes');
          if (finding.severity === 'blocking') { findings.recordedFixedBlocking++; seen.add('withRecordedBlockingFixes'); }
        }
      }
    }
    for (const key of seen) events[key]++;
  }
  return { runs: runs.length, statuses: distribution(runs.map(r => r.status), statuses), outcomes: distribution(runs.map(r => r.outcome), outcomes),
    reviewStates: distribution(runs.map(reviewState), ['failed', 'waived', 'unfinished', 'changedAfterReview', 'blocked', 'finishedWithVerdict', 'finishedWithoutVerdict']),
    rounds: measure(runs.map(r => r.rounds.length)), attempts: attempts.length, failedAttempts: attempts.filter(a => a.status === 'failed').length,
    attemptStatuses: distribution(attempts.map(a => a.status), ['running', 'completed', 'failed']),
    findings, runsContaining: events, recordedAttemptSeconds: measure(attempts.map(a => a.seconds)), wallElapsedSeconds: measure(runs.map(elapsed)),
    providerReported: { agentRecords: agents.length, inputTokens: measure(agents.map(a => a.usage?.input)), outputTokens: measure(agents.map(a => a.usage?.output)),
      cacheReadTokens: measure(agents.map(a => a.usage?.cacheRead)), cacheWriteTokens: measure(agents.map(a => a.usage?.cacheWrite)), costUsd: measure(agents.map(a => a.cost)) },
    orchestratorNonAdditive: { inputTokens: measure(runs.map(r => r.orchestratorUsage?.input)), outputTokens: measure(runs.map(r => r.orchestratorUsage?.output)) } };
}
export function aggregateHistory(history) {
  const raw = history.workflows.filter(x => x.source.endsWith('Raw')).map(x => x.record);
  const statsOnly = history.workflows.filter(x => x.source.endsWith('StatsOnly')).map(x => x.record);
  const dates = [...history.workflows.map(x => date(x.record.createdAt || x.record.startedAt)), ...history.standalone.map(r => date(r.startedAt))].filter(Boolean).sort();
  const standalone = history.standalone;
  const stages = standalone.flatMap(r => Object.values(r.stages));
  const finalFindings = standalone.flatMap(r => r.stages.final?.doc.findings || []);
  return { schema: 'cross-debate.history-report.v1', dataset: { earliestStart: dates[0] || null, latestStart: dates.at(-1) || null, startsRecorded: dates.length },
    coverage: history.coverage, workflows: { plan: workflowAggregate(raw.filter(r => r.kind === 'plan')), code: workflowAggregate(raw.filter(r => r.kind === 'code')) },
    statsOnly: { runs: statsOnly.length, kinds: distribution(statsOnly.map(r => r.kind), ['plan', 'code']), outcomes: distribution(statsOnly.map(r => r.outcome), outcomes),
      recordedRounds: measure(statsOnly.map(r => r.rounds)), wallElapsedSeconds: measure(statsOnly.map(r => r.durationSec)) },
    standalone: { records: standalone.length, local: standalone.filter(r => r.local).length, pr: standalone.filter(r => !r.local).length,
      withFinishedTimestamp: standalone.filter(r => date(r.finishedAt)).length,
      withMainAndDebate: standalone.filter(r => r.stages.main && r.stages.debate).length,
      withRenderedReview: standalone.filter(r => object(r.posted)).length,
      sourceFindingOccurrences: standalone.reduce((n, r) => n + (r.stages.main?.doc.findings.length || 0) + (r.stages.debate?.doc.new_findings?.length || 0), 0),
      finalDispositions: distribution(finalFindings.map(f => f.status), ['agreed', 'contested', 'withdrawn']),
      recordedStageSeconds: measure(stages.map(s => s.seconds)), wallElapsedSeconds: measure(standalone.map(elapsed)), orchestratorVerdicts: 0 } };
}
