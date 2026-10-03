import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readHistory, aggregateHistory } from '../scripts/history-report.mjs';
import { computeStats, statsRowFromRun } from '../skills/cross-debate/scripts/lib/common.mjs';

const finding = (id = 'F1') => ({ id, severity: 'blocking', status: 'agreed', claim: 'PRIVATE_SENTINEL' });
const verdict = (id = 'F1', decision = 'confirm') => ({ id, verdict: decision, fixed: true });
const round = (n = 1, findings = [finding()], verdicts = [verdict()]) => ({ round: n,
  attempts: [{ status: 'completed', seconds: 10, agents: [{ usage: { input: 100, output: 20 }, cost: 0.25 }] }],
  review: { findings }, verdict: { verdicts, review_rating: 8 } });
const run = (runId, extra = {}) => ({ schema: 'debate.run.v1', runId, kind: 'code', seat: 'codex',
  createdAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:00Z', status: 'finished', outcome: 'passed', rounds: [round()], ...extra });
const standalone = () => ({ schema: 'debate-review.run.v1', local: false, startedAt: '2026-01-01T00:00:00Z',
  finishedAt: '2026-01-01T00:01:00Z', stages: { main: { seconds: 20, doc: { schema: 'debate-review.findings.v1', findings: [finding()] } },
    debate: { seconds: 30, doc: { schema: 'debate-review.debate.v1', new_findings: [] } }, final: { seconds: 10, doc: { schema: 'debate-review.final.v1', findings: [finding()] } } } });
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'debate-history-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { home: path.join(root, 'home'), archives: [path.join(root, 'a'), path.join(root, 'b')], reviewCache: path.join(root, 'cache') };
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  const raw = (base, value) => write(path.join(base, 'runs', value.runId, 'run.json'), value);
  return { root, options, write, raw };
}

test('history reconciliation honors raw, current, archive argument, file, and row precedence', t => {
  const { options, write, raw } = fixture(t), [a, b] = options.archives;
  const stats = (base, name, rows) => write(path.join(base, name), rows.map(r => JSON.stringify(statsRowFromRun(r))).join('\n'));
  raw(a, run('raw-wins')); stats(options.home, 'stats.jsonl', [run('raw-wins'), run('current-stats')]);
  raw(a, run('archive-tie', { outcome: 'failed' })); raw(b, run('archive-tie', { outcome: 'passed' }));
  raw(a, run('current-raw', { outcome: 'failed' })); raw(options.home, run('current-raw'));
  stats(a, 'stats.jsonl.bak', [run('file-tie', { outcome: 'failed' }), run('archive-stats', { outcome: 'failed' })]);
  stats(a, 'stats.jsonl', [run('file-tie', { outcome: 'waived' }), run('row-tie', { outcome: 'failed' }), run('row-tie')]);
  stats(b, 'stats.jsonl.bak', [run('archive-stats'), run('current-stats', { outcome: 'failed' })]);
  const history = readHistory(options), selected = Object.fromEntries(history.workflows.map(x => [x.record.runId, x]));
  assert.equal(selected['raw-wins'].source, 'archiveRaw');
  assert.equal(selected['archive-tie'].record.outcome, 'passed');
  assert.equal(selected['current-raw'].source, 'currentRaw');
  assert.equal(selected['current-stats'].source, 'currentStatsOnly');
  assert.equal(selected['file-tie'].record.outcome, 'waived');
  assert.equal(selected['row-tie'].record.outcome, 'passed');
  assert.equal(selected['archive-stats'].record.outcome, 'passed');
  assert.equal(aggregateHistory(history).statsOnly.runs, 4);
  assert.equal(readHistory({ ...options, archives: [b, a] }).workflows.find(x => x.record.runId === 'archive-tie').record.outcome, 'failed');
  assert.equal(readHistory({ ...options, archives: [] }).workflows.length, 3, 'archives are opt-in');
  const before = history.inputs.map(file => fs.readFileSync(file));
  assert.deepEqual(aggregateHistory(readHistory(options)), aggregateHistory(history), 'aggregation is deterministic');
  assert.deepEqual(history.inputs.map(file => fs.readFileSync(file)), before, 'input bytes stay unchanged');
});

test('inventory excludes audits, backend copies, clones, deeper decoys, and all symlinks', t => {
  const { root, options, write, raw } = fixture(t);
  raw(options.home, run('real'));
  write(path.join(options.home, 'runs/real/round-1/attempt-1/backend/run.json'), standalone());
  write(path.join(options.home, 'sessions/session.json'), run('session-decoy'));
  write(path.join(options.home, 'runs/malformed/run.json'), '{');
  write(path.join(options.home, 'runs/unsupported/run.json'), { schema: 'future' });
  raw(options.home, run('invalid-rounds', { rounds: [{}] }));
  write(path.join(options.home, 'stats.jsonl'), JSON.stringify({ schema: 'debate.stats.v1', recordType: 'audit', kind: 'code' }));
  const normal = path.join(options.reviewCache, 'owner__repo/1/abcdef012345/run.json');
  write(normal, standalone());
  write(path.join(options.reviewCache, 'local/repo/branch/abcdef012345/run.json'), { ...standalone(), local: true });
  for (const file of ['clones/owner__repo/1/abcdef012345/run.json', 'owner__repo/1/abcdef012345/deeper/run.json', 'random/deeper/abcdef012345/run.json']) write(path.join(options.reviewCache, file), standalone());
  fs.symlinkSync(path.dirname(normal), path.join(options.reviewCache, 'owner__repo/1/abcdef012346'));
  fs.symlinkSync(path.join(options.home, 'runs/real'), path.join(options.home, 'runs/symlink'));
  fs.symlinkSync(options.home, path.join(root, 'linked-home'));
  fs.mkdirSync(path.join(options.home, 'child/runs'), { recursive: true });
  assert.equal(readHistory({ ...options, home: path.join(root, 'linked-home/child'), archives: [] }).workflows.length, 0);
  const history = readHistory(options);
  assert.equal(history.workflows.length, 1);
  assert.equal(history.standalone.length, 2);
  assert.equal(history.coverage.auditRowsIgnored, 1);
  assert.equal(history.coverage.malformedRecords, 2);
  assert.equal(history.coverage.unsupportedRecords, 1);
  assert.equal(history.coverage.symlinksSkipped, 2);
});

test('occurrences join same-round verdicts and separate outcomes and partial measurement coverage', t => {
  const { options, raw, write } = fixture(t);
  const multi = run('multi', { rounds: [round(1), round(2, [finding(), finding('F2')], [verdict('F1', 'discard'), verdict('orphan')])] });
  multi.rounds[1].attempts.push({ status: 'failed', seconds: null, agents: [{ usage: null, cost: null }] });
  multi.rounds[1].attempts.push({ status: 'completed', seconds: 0 });
  raw(options.home, multi);
  raw(options.home, run('waived', { outcome: 'waived', rounds: [] }));
  raw(options.home, run('failed', { outcome: 'failed', rounds: [] }));
  raw(options.home, run('unfinished', { status: 'running', finishedAt: null, rounds: [] }));
  raw(options.home, run('changed', { code: { unreviewedAmendment: true }, rounds: [] }));
  raw(options.home, run('plan-changed', { kind: 'plan', outcome: 'completed', plan: { receipt: { unratedChanges: true } } }));
  raw(options.home, run('label-only', { rounds: [] }));
  write(path.join(options.reviewCache, 'owner__repo/1/abcdef012345/run.json'), standalone());
  const report = aggregateHistory(readHistory(options)), code = report.workflows.code;
  assert.deepEqual(code.findings, { occurrences: 3, adjudicated: 2, confirm: 1, modify: 0, discard: 1, acceptedBlocking: 1,
    recordedFixed: 1, recordedFixedBlocking: 1, agreedDiscarded: 1, unadjudicated: 1, unmatchedVerdicts: 1 });
  assert.equal(code.runsContaining.withRecordedBlockingFixes, 1);
  for (const key of ['withFindings', 'withAdjudicatedFindings', 'withUnadjudicated', 'withUnmatchedVerdicts', 'withAgreedDiscarded']) assert.equal(code.runsContaining[key], 1, key);
  assert.equal(code.runsContaining.withFailures, 1);
  for (const key of ['failed', 'waived', 'unfinished', 'changedAfterReview', 'finishedWithoutVerdict']) assert.equal(code.reviewStates[key], 1, key);
  assert.equal(report.workflows.plan.reviewStates.changedAfterReview, 1);
  assert.equal(code.failedAttempts, 1);
  assert.deepEqual(code.recordedAttemptSeconds, { eligible: 4, recorded: 3, missing: 1, total: 20, median: 10 });
  assert.equal(code.wallElapsedSeconds.recorded, 5);
  assert.equal(code.providerReported.inputTokens.recorded, 2);
  assert.equal(code.providerReported.costUsd.missing, 1);
  assert.equal(code.orchestratorNonAdditive.inputTokens.total, null);
  assert.equal(report.standalone.records, 1);
  assert.equal(report.standalone.orchestratorVerdicts, 0);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_SENTINEL|owner__repo|abcdef012345/);
});

test('run counts for each decision count a run once across repeated findings and rounds', t => {
  const { options, raw } = fixture(t);
  const repeated = n => round(n, ['F1', 'F2', 'F3', 'F4'].map(finding),
    [verdict('F1'), verdict('F2'), verdict('F3', 'modify'), verdict('F4', 'discard')]);
  raw(options.home, run('repeated', { rounds: [repeated(1), repeated(2)] }));
  raw(options.home, run('empty-verdict', { rounds: [round(1, [], [])] }));
  const code = aggregateHistory(readHistory(options)).workflows.code;
  assert.equal(code.findings.occurrences, 8);
  assert.equal(code.findings.confirm, 4);
  assert.equal(code.findings.modify, 2);
  assert.equal(code.findings.discard, 2);
  for (const key of ['withFindings', 'withAdjudicatedFindings', 'withConfirm', 'withModify', 'withDiscard']) assert.equal(code.runsContaining[key], 1, key);
  assert.equal(code.runsContaining.withVerdicts, 2, 'empty verdict is coverage, not an adjudicated finding');
  assert.equal(code.runsContaining.withRounds, 2);
});

test('stats since filters exported rows and kind filters audit totals without changing JSON structure', t => {
  const { options, write } = fixture(t);
  const recent = new Date(Date.now() - 60_000).toISOString();
  const rows = [statsRowFromRun(run('recent', { createdAt: recent })), statsRowFromRun(run('old')),
    ...['plan', 'code'].map(kind => ({ schema: 'debate.stats.v1', recordType: 'audit', kind, seat: 'codex', at: recent })),
    { schema: 'debate.stats.v1', recordType: 'audit', kind: 'code', seat: 'codex', at: '2026-01-01' }];
  assert.equal(computeStats(rows, { kind: 'code', since: 3_600_000 }).audits, 1);
  write(path.join(options.home, 'stats.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
  const result = spawnSync(process.execPath, ['skills/cross-debate/scripts/debate.mjs', 'stats', '--kind', 'code', '--since', '1h', '--json'],
    { encoding: 'utf8', env: { ...process.env, DEBATE_HOME: options.home } });
  assert.equal(result.status, 0, result.stderr);
  const doc = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(doc), ['ok', 'home', 'filters', 'summary', 'rows']);
  assert.equal(doc.rows.length, 2); assert.equal(doc.summary.runs, 1); assert.equal(doc.summary.audits, 1);
});
