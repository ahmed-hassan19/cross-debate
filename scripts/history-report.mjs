import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { debateHome, isMainModule } from '../skills/cross-debate/scripts/lib/common.mjs';

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
  const events = { withRounds: 0, withAttempts: 0, withFailures: 0, withVerdicts: 0, withFindings: 0, withAdjudicatedFindings: 0,
    withConfirm: 0, withModify: 0, withDiscard: 0, withAgreedDiscarded: 0, withUnadjudicated: 0, withUnmatchedVerdicts: 0,
    withAcceptedFindings: 0, withAcceptedBlocking: 0, withRecordedFixes: 0, withRecordedBlockingFixes: 0 };
  const attempts = [], agents = [];
  for (const run of runs) {
    const seen = new Set();
    for (const round of run.rounds) {
      seen.add('withRounds');
      attempts.push(...round.attempts);
      for (const attempt of round.attempts) {
        seen.add('withAttempts');
        if (attempt.status === 'failed') seen.add('withFailures');
        agents.push(...(attempt.agents?.length ? attempt.agents : attempt.reviewer ? [{ usage: attempt.usage, cost: attempt.cost }] : []));
      }
      if (round.verdict) seen.add('withVerdicts');
      const byId = new Map((round.review?.findings || []).map(f => [f.id, f]));
      const verdicts = new Map((round.verdict?.verdicts || []).map(v => [v.id, v]));
      for (const id of verdicts.keys()) if (!byId.has(id)) { findings.unmatchedVerdicts++; seen.add('withUnmatchedVerdicts'); }
      for (const [id, finding] of byId) {
        findings.occurrences++; seen.add('withFindings');
        const verdict = verdicts.get(id);
        if (!verdict) { findings.unadjudicated++; seen.add('withUnadjudicated'); continue; }
        findings.adjudicated++; findings[verdict.verdict]++; seen.add('withAdjudicatedFindings');
        seen.add({ confirm: 'withConfirm', modify: 'withModify', discard: 'withDiscard' }[verdict.verdict]);
        if (verdict.verdict === 'discard') {
          if (finding.status === 'agreed') { findings.agreedDiscarded++; seen.add('withAgreedDiscarded'); }
          continue;
        }
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
  // A later round rates the revised plan, so first-to-last change reflects revisions after review.
  const rated = runs.map(r => r.rounds.map(x => x.review?.rating).filter(number)).filter(r => r.length > 1);
  const ratings = { multiRoundRuns: rated.length, first: measure(rated.map(r => r[0])), last: measure(rated.map(r => r.at(-1))),
    improved: rated.filter(r => r.at(-1) > r[0]).length, unchanged: rated.filter(r => r.at(-1) === r[0]).length,
    declined: rated.filter(r => r.at(-1) < r[0]).length,
    firstAtLeast8: rated.filter(r => r[0] >= 8).length, lastAtLeast8: rated.filter(r => r.at(-1) >= 8).length };
  return { runs: runs.length, statuses: distribution(runs.map(r => r.status), statuses), outcomes: distribution(runs.map(r => r.outcome), outcomes),
    reviewStates: distribution(runs.map(reviewState), ['failed', 'waived', 'unfinished', 'changedAfterReview', 'blocked', 'finishedWithVerdict', 'finishedWithoutVerdict']),
    rounds: measure(runs.map(r => r.rounds.length)), attempts: attempts.length, failedAttempts: attempts.filter(a => a.status === 'failed').length,
    attemptStatuses: distribution(attempts.map(a => a.status), ['running', 'completed', 'failed']),
    findings, runsContaining: events, ratings, recordedAttemptSeconds: measure(attempts.map(a => a.seconds)), wallElapsedSeconds: measure(runs.map(elapsed)),
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

const HELP = `Usage: node scripts/history-report.mjs [--home <dir>] [--review-cache <dir>]
       [--archive <dir> ...] [--format json|markdown]

Read-only, dependency-free maintainer report. No models or network requests.
Defaults: DEBATE_HOME or ~/.local/share/debate; ~/.cache/debate-review; Markdown to stdout.
Current home: runs/*/run.json and stats.jsonl. Each explicit archive: runs/*/run.json,
stats.jsonl and stats.jsonl.bak. No archives are scanned by default.
Cache: <owner>__<repo>/<pr>/<sha12>/run.json or local/<repo>/<branch>/<sha12>/run.json.
Excludes clones/, deeper files, symlinks, and custom --out-dir locations outside these layouts.
Raw wins over stats; current wins over archives within each class; later archive arguments win ties.
Within one root stats.jsonl wins over .bak; within a file the last row for a runId wins.
Use frozen inputs to reproduce a snapshot. Output contains aggregate metadata only.
`;
const display = value => value === null ? 'unreported' : String(Math.round(value * 10000) / 10000);
const counts = values => Object.entries(values).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`).join('; ') || 'none';
const pct = (n, d) => d ? `${Math.round(n / d * 100)}%` : 'n/a';
const share = (n, d) => `${n} of ${d} (${pct(n, d)})`;
const table = (headings, rows) => [headings, headings.map(() => '---'), ...rows].map(row => `| ${row.join(' | ')} |`).join('\n');
export function renderMarkdown(report) {
  const cohorts = Object.entries(report.workflows), c = report.coverage, s = report.standalone;
  const metrics = [
    ['Raw workflow runs', r => r.runs], ['Runs with verdicts', r => r.runsContaining.withVerdicts],
    ['Rounds / runs with rounds', r => `${r.rounds.total ?? 0} / ${r.runsContaining.withRounds}`], ['Attempts / failures', r => `${r.attempts} / ${r.failedAttempts}`],
    ['Runs with attempts', r => r.runsContaining.withAttempts],
    ['Runs with failed attempts', r => r.runsContaining.withFailures], ['Finding occurrences / adjudicated', r => `${r.findings.occurrences} / ${r.findings.adjudicated}`],
    ['Confirm / modify / discard', r => `${r.findings.confirm} / ${r.findings.modify} / ${r.findings.discard}`],
    ['Runs with findings / adjudicated findings', r => `${r.runsContaining.withFindings} / ${r.runsContaining.withAdjudicatedFindings}`],
    ['Runs with confirm / modify / discard', r => `${r.runsContaining.withConfirm} / ${r.runsContaining.withModify} / ${r.runsContaining.withDiscard}`],
    ['Runs with accepted findings', r => r.runsContaining.withAcceptedFindings], ['Accepted blocking occurrences / runs', r => `${r.findings.acceptedBlocking} / ${r.runsContaining.withAcceptedBlocking}`],
    ['Recorded fixed occurrences / runs', r => `${r.findings.recordedFixed} / ${r.runsContaining.withRecordedFixes}`],
    ['Recorded blocking fixes / runs', r => `${r.findings.recordedFixedBlocking} / ${r.runsContaining.withRecordedBlockingFixes}`],
    ['Backend-agreed occurrences discarded / runs', r => `${r.findings.agreedDiscarded} / ${r.runsContaining.withAgreedDiscarded}`],
    ['Unadjudicated findings / unmatched verdicts', r => `${r.findings.unadjudicated} / ${r.findings.unmatchedVerdicts}`],
    ['Runs with unadjudicated findings / unmatched verdicts', r => `${r.runsContaining.withUnadjudicated} / ${r.runsContaining.withUnmatchedVerdicts}`],
  ];
  const accepted = r => r.findings.confirm + r.findings.modify;
  const passed = r => r.outcomes.passed + r.outcomes.completed;
  const fixes = (r, cell) => r === report.workflows.plan ? 'not recorded' : cell;
  const gains = [
    ['Passed or completed outcome', r => share(passed(r), r.runs)],
    ['Runs with verdicts that accepted findings', r => share(r.runsContaining.withAcceptedFindings, r.runsContaining.withVerdicts)],
    ['Runs with verdicts that accepted blocking findings', r => share(r.runsContaining.withAcceptedBlocking, r.runsContaining.withVerdicts)],
    ['Runs with verdicts that fixed blocking findings', r => fixes(r, share(r.runsContaining.withRecordedBlockingFixes, r.runsContaining.withVerdicts))],
    ['Adjudicated findings accepted (confirm or modify)', r => share(accepted(r), r.findings.adjudicated)],
    ['Adjudicated findings discarded', r => share(r.findings.discard, r.findings.adjudicated)],
    ['Accepted findings marked fixed', r => fixes(r, share(r.findings.recordedFixed, accepted(r)))],
    ['Accepted blocking findings marked fixed', r => fixes(r, share(r.findings.recordedFixedBlocking, r.findings.acceptedBlocking))],
    ['Reviewer rating, first → last round (median)', r => r.ratings.multiRoundRuns ? `${display(r.ratings.first.median)} → ${display(r.ratings.last.median)}` : 'n/a'],
    ['Multi-round runs whose rating improved / unchanged / declined', r => r.ratings.multiRoundRuns
      ? [r.ratings.improved, r.ratings.unchanged, r.ratings.declined].map(n => pct(n, r.ratings.multiRoundRuns)).join(' / ') + ` of ${r.ratings.multiRoundRuns}` : 'n/a'],
    ['Multi-round runs rated 8+, first → last round', r => r.ratings.multiRoundRuns
      ? `${pct(r.ratings.firstAtLeast8, r.ratings.multiRoundRuns)} → ${pct(r.ratings.lastAtLeast8, r.ratings.multiRoundRuns)} of ${r.ratings.multiRoundRuns}` : 'n/a'],
  ];
  const timing = cohorts.flatMap(([name, r]) => [[`${name}: recorded attempt seconds`, r.recordedAttemptSeconds], [`${name}: wall elapsed seconds`, r.wallElapsedSeconds]]);
  timing.push(['standalone: recorded stage seconds', s.recordedStageSeconds], ['standalone: wall elapsed seconds', s.wallElapsedSeconds]);
  const measurement = rows => table(['Measurement', 'Recorded / eligible', 'Missing', 'Total', 'Median'],
    rows.map(([name, m]) => [name, `${m.recorded} / ${m.eligible}`, m.missing, display(m.total), display(m.median)]));
  return [
    '# Recorded review outcomes',
    `Dataset start range (UTC): ${report.dataset.earliestStart || 'unreported'} to ${report.dataset.latestStart || 'unreported'}; ${report.dataset.startsRecorded} recorded starts.`,
    'One maintainer\'s changing workflows. These are recorded outcomes, not a benchmark against another method.',
    '## Source coverage',
    table(['Selected source', 'Records'], Object.entries(c.selected)),
    `${c.inputFiles} metadata files read; ${c.validRawRecords} valid raw records, ${c.validStatsRecords} valid stats rows, ${c.validStandaloneRecords} valid standalone records before reconciliation.`,
    `${c.duplicateRawRecords} duplicate raw records; ${c.duplicateStatsRecords} duplicate stats rows; ${c.statsShadowedByRaw} stats records replaced by raw records; ${c.auditRowsIgnored} audit rows excluded.`,
    `${c.malformedRecords} malformed and ${c.unsupportedRecords} unsupported records; ${c.symlinksSkipped} symlinks skipped.`,
    `Stats-only coverage: ${report.statsOnly.runs} runs (${counts(report.statsOnly.kinds)}). These lack raw finding joins and are excluded from the workflow tables.`,
    '## Workflow occurrences',
    table(['Metric', 'Plan', 'Code'], metrics.map(([name, get]) => [name, ...cohorts.map(([, r]) => get(r))])),
    '## Rates and measured changes',
    table(['Measure', 'Plan', 'Code'], gains.map(([name, get]) => [name, ...cohorts.map(([, r]) => get(r))])),
    'Rates use the counts above; denominators are shown in each cell. Ratings are the reviewers\' combined score (the lower of the two) for the plan text each round reviewed. A later round reviews the revised plan, so a rise reflects revisions made after review, scored by reviewers who saw the earlier round; it is not an independent quality measure. Runs with fewer than two rated rounds are excluded from rating rows. Plan change prose is not a recorded fix, so plan fix rates are not recorded.',
    ...cohorts.map(([name, r]) => `${name}: recorded statuses: ${counts(r.statuses)}. Recorded outcomes: ${counts(r.outcomes)}.\n\n${name}: review states: ${counts(r.reviewStates)}. Attempt states: ${counts(r.attemptStatuses)}.`),
    'Each occurrence is identified by (runId, round, findingId) internally. Verdicts join only to findings in the same round. Confirm/modify counts as accepted; blocking uses that finding\'s recorded severity. Fixes require an accepted verdict with fixed=true. Plan change prose is not a recorded fix. Occurrences can repeat a bug across rounds; these are not unique bugs or semantic deduplication.',
    'A finished/completed label alone does not establish successful review. Failed, waived, unfinished, blocked, and changed-after-review records remain separate. Finished-with-verdict is a coverage category, not a quality judgment.',
    '## Time and usage coverage', measurement(timing),
    'Attempt time is the recorded attempt.seconds field; its measurement differs across workflow versions. Wall elapsed time is finishedAt minus createdAt/startedAt and can include waiting and interruptions. These are not interchangeable. Missing or invalid values are excluded, not zero-filled.',
    measurement(cohorts.flatMap(([name, r]) => Object.entries(r.providerReported).filter(([, v]) => object(v)).map(([field, m]) => [`${name}: provider-reported ${field}`, m]))),
    'Usage denominators are recorded agent entries, not every possible provider call. Cost is provider-reported USD coverage, not total spend or ROI. Cache fields are already represented in provider input accounting where applicable; do not add them to input totals. No model rankings, causal comparisons, or time-saved claims are made.',
    measurement(cohorts.flatMap(([name, r]) => Object.entries(r.orchestratorNonAdditive).map(([field, m]) => [`${name}: orchestrator ${field} (non-additive)`, m]))),
    'Orchestrator tokens cover transcript windows and may overlap other work. They remain separate and must not be added to reviewer totals.',
    '## Standalone cache coverage',
    `${s.records} records: ${s.local} local and ${s.pr} PR reviews. ${s.withMainAndDebate} contain both main and debate stages; ${s.withRenderedReview} contain a rendered review; ${s.withFinishedTimestamp} have a finished timestamp. A timestamp is also written on failure and does not prove success or posting.`,
    `${s.sourceFindingOccurrences} source finding occurrences. Final backend dispositions: ${counts(s.finalDispositions)}. Orchestrator verdicts: 0. These records do not establish accepted fixes. Provider usage is not recorded in this metadata schema.`,
    '## Cohorts and limitations',
    'Workflow input is `runs/*/run.json` plus `stats.jsonl`. Explicit archives also allow `stats.jsonl.bak`. Raw wins over stats, current sources win over archives within each class, later archive arguments win archive ties, stats.jsonl wins over its backup, and the last row within a file wins. Audit events, sessions, receipts, and nested code backend files are not additional runs.',
    'Standalone input is limited to `<owner>__<repo>/<pr>/<sha12>/run.json` and `local/<repo>/<branch>/<sha12>/run.json`. clones/, arbitrary deeper files, symlinks, and custom --out-dir locations outside these layouts are excluded. Cached paths can overwrite earlier executions; absence of metadata does not prove no review occurred.',
    'Only explicitly supplied archives are included. Private source records, prompts, narratives, identities, and paths are excluded from public output. Computation is reproducible locally from frozen metadata; readers cannot independently audit the private source records. Record the inventory cutoff beside a published snapshot.',
    '[Regeneration and private snapshot procedure](https://github.com/ahmed-hassan19/cross-debate/blob/main/CONTRIBUTING.md#regenerating-the-field-report).',
  ].join('\n\n') + '\n';
}

export function main(argv) {
  const options = { archives: [] };
  let format = 'markdown';
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') { process.stdout.write(HELP); return 0; }
    if (!['--home', '--review-cache', '--archive', '--format'].includes(flag) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      process.stderr.write(HELP); return 2;
    }
    const value = argv[++i];
    if (flag === '--format') format = value;
    else if (flag === '--archive') options.archives.push(path.resolve(value));
    else options[flag === '--home' ? 'home' : 'reviewCache'] = path.resolve(value);
  }
  if (!['json', 'markdown'].includes(format)) { process.stderr.write('format must be json or markdown\n'); return 2; }
  const report = aggregateHistory(readHistory(options));
  process.stdout.write(format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report));
  return 0;
}
if (isMainModule(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch { process.stderr.write('history-report: unable to read selected metadata; check input roots and permissions\n'); process.exitCode = 1; }
}
