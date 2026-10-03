import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../scripts/history-report.mjs', import.meta.url));
const secret = 'PRIVATE_SENTINEL_9c247e';
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${secret}-`)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), cache = path.join(root, '.cache/debate-review');
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  const invoke = args => spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', env: { ...process.env, HOME: root, DEBATE_HOME: home, PATH: path.join(root, 'bin') },
  });
  const trap = path.join(root, 'called-reviewer');
  fs.mkdirSync(path.join(root, 'bin'));
  for (const name of ['claude', 'codex', 'opencode', 'curl', 'git']) {
    const file = path.join(root, 'bin', name);
    fs.writeFileSync(file, `#!/bin/sh\necho called > '${trap}'\nexit 99\n`, { mode: 0o755 });
  }
  return { root, home, cache, write, invoke, trap };
}
const raw = (extra = {}) => ({ schema: 'debate.run.v1', runId: secret, kind: 'code', status: secret, outcome: secret,
  createdAt: '2026-01-02T03:04:05Z', repo: secret, sessionId: secret, cwd: secret, commit: secret, prompt: secret,
  rounds: [{ round: 1, attempts: [{ status: secret, model: secret, seconds: null, agents: [{ model: secret, usage: null }] }],
    review: { summary: secret, findings: [{ id: secret, severity: 'blocking', status: secret, claim: secret, evidence: secret }] },
    verdict: { verdicts: [{ id: secret, verdict: 'confirm', fixed: true, reason: secret }] } }], ...extra });

test('CLI emits deterministic allowlisted aggregates without private text, writes, or reviewer calls', t => {
  const { root, home, cache, write, invoke, trap } = fixture(t);
  const file = path.join(home, 'runs', secret, 'run.json');
  write(file, raw());
  const standalone = path.join(cache, `${secret}__repo/12/0123456789ab/run.json`);
  write(standalone, { schema: 'debate-review.run.v1', local: false, repo: secret, model: secret, sha: secret,
    stages: { final: { seconds: null, doc: { schema: 'debate-review.final.v1', findings: [{ id: secret, severity: 'blocking', status: secret, claim: secret }] } } } });
  const inputs = [file, standalone].map(file => fs.readFileSync(file));
  const json = invoke(['--format', 'json']);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(invoke(['--format', 'json']).stdout, json.stdout);
  const report = JSON.parse(json.stdout);
  assert.equal(report.workflows.code.runs, 1, 'DEBATE_HOME default is honored');
  assert.equal(report.standalone.records, 1, 'default standalone cache uses HOME');
  assert.equal(report.workflows.code.outcomes.other, 1);
  assert.equal(report.workflows.code.findings.recordedFixedBlocking, 1);
  assert.equal(report.workflows.code.recordedAttemptSeconds.missing, 1);
  assert.deepEqual(Object.keys(report), ['schema', 'dataset', 'coverage', 'workflows', 'statsOnly', 'standalone']);
  const markdown = invoke([]);
  assert.equal(markdown.status, 0, markdown.stderr);
  assert.equal(markdown.stdout, invoke(['--format', 'markdown']).stdout);
  assert.ok(markdown.stdout.includes('`<owner>__<repo>/<pr>/<sha12>/run.json`'), 'layout placeholders must render as code, not HTML');
  for (const phrase of ['not unique bugs', 'unreported', 'Recorded / eligible', 'non-additive', 'custom --out-dir', 'cannot independently audit', 'Finished-with-verdict']) assert.ok(markdown.stdout.includes(phrase), phrase);
  for (const output of [json.stdout, json.stderr, markdown.stdout, markdown.stderr]) {
    assert.ok(!output.includes(secret)); assert.ok(!output.includes(root));
    assert.doesNotMatch(output, /0123456789ab|sessionId|"runId"|"claim"|"prompt"/);
  }
  assert.deepEqual([file, standalone].map(file => fs.readFileSync(file)), inputs);
  assert.equal(fs.existsSync(trap), false);
});

test('CLI accepts explicit roots and repeated archives in order', t => {
  const { root, write, invoke } = fixture(t);
  const a = path.join(root, 'archive-a'), b = path.join(root, 'archive-b');
  write(path.join(a, 'runs/a/run.json'), raw({ outcome: 'failed' }));
  write(path.join(b, 'runs/b/run.json'), raw({ outcome: 'waived' }));
  const result = invoke(['--home', path.join(root, 'empty'), '--review-cache', path.join(root, 'empty-cache'), '--archive', a, '--archive', b, '--format', 'json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.workflows.code.runs, 1);
  assert.equal(report.workflows.code.outcomes.waived, 1);
  assert.equal(report.coverage.selected.archiveRaw, 1);
});

test('CLI explains exclusions, rejects usage errors, and supports empty histories', t => {
  const { invoke } = fixture(t);
  const help = invoke(['--help']);
  assert.equal(help.status, 0);
  for (const phrase of ['custom --out-dir', 'clones/', 'symlinks', 'No archives', 'No models or network']) assert.ok(help.stdout.includes(phrase), phrase);
  for (const args of [['--unknown'], ['--home'], ['--format', 'csv'], ['--archive', '--format', 'json']]) assert.equal(invoke(args).status, 2, args.join(' '));
  const empty = invoke(['--format', 'json']);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(JSON.parse(empty.stdout).dataset.earliestStart, null);
});
