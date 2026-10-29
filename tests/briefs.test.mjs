import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildBrief } from '../skills/cross-debate/scripts/lib/briefs.mjs';

const input = {
  BASE: 'base-ref', HEAD: 'head-sha', PR_TITLE: 'title sentinel',
  PR_BODY: 'body sentinel with literal {{HEAD}}', SPEC: 'spec sentinel',
  STANDARDS: 'standards sentinel', FINDINGS_JSON: '{"claim":"actionable finding"}',
  DEBATE_JSON: '{"verdict":"refute","evidence":"guard sentinel"}',
  TELEMETRY: 'telemetry sentinel', REVIEWER: 'identity sentinel',
};

test('main keeps PR and Spec context while substitution preserves literal input', () => {
  const brief = buildBrief('main', input);
  for (const field of ['PR_TITLE', 'PR_BODY', 'SPEC', 'STANDARDS']) assert.ok(brief.includes(input[field]));
  assert.ok(brief.includes('debate-review.findings.v1'));
  assert.ok(!brief.includes(input.TELEMETRY));
  assert.ok(!brief.includes(input.REVIEWER));
});

for (const role of ['debate', 'final']) {
  test(`${role} receives code references and arguments without unrelated context`, () => {
    const brief = buildBrief(role, input);
    for (const field of ['BASE', 'HEAD', 'STANDARDS', 'FINDINGS_JSON']) assert.ok(brief.includes(input[field]));
    if (role === 'final') assert.ok(brief.includes(input.DEBATE_JSON));
    for (const field of ['PR_TITLE', 'PR_BODY', 'SPEC', 'TELEMETRY', 'REVIEWER']) {
      assert.ok(!brief.includes(input[field]), `${field} must not reach ${role}`);
    }
    assert.ok(brief.includes(`debate-review.${role}.v1`));
  });
}

test('role input contracts reject missing required arguments', () => {
  assert.throws(() => buildBrief('debate', { BASE: 'base', HEAD: 'head', STANDARDS: 'none' }), /missing FINDINGS_JSON/);
  assert.throws(() => buildBrief('final', { BASE: 'base', HEAD: 'head', FINDINGS_JSON: '{}', DEBATE_JSON: '{}' }), /missing STANDARDS/);
  assert.throws(() => buildBrief('unknown', input), /unknown review brief role/);
});

test('packaged templates resolve inside the skill directory: the plan brief and the review schema and prompts', async () => {
  const { TEMPLATE_PATH } = await import('../skills/cross-debate/scripts/plan.mjs');
  const skill = new URL('../skills/cross-debate/', import.meta.url);
  assert.equal(TEMPLATE_PATH, fs.realpathSync(new URL('assets/review-brief.md', skill)));
  assert.ok(fs.existsSync(new URL('references/schema.md', skill)));
  for (const role of ['main', 'debate', 'final']) assert.ok(buildBrief(role, input).length > 0);
});

const blockingDefinition = [
  'Blocking requires an evidence-backed, reachable trigger and a material failure of current requirements or safety guarantees.',
  'A real defect that is rare in supported use and low in impact is non-blocking.',
  'Rarity alone never makes authorization bypass, sensitive-data exposure, incorrect financial operations, or irreversible data loss non-blocking.',
].join(' ');
const prose = value => value.replace(/\s+/g, ' ');

for (const role of ['main', 'debate', 'final']) {
  for (const empty of [false, true]) {
    test(`${role} receives the full blocking policy with ${empty ? 'empty' : 'populated'} findings`, () => {
      const brief = prose(buildBrief(role, empty ? {
        ...input, FINDINGS_JSON: '{"findings":[]}', DEBATE_JSON: '{"verdicts":[],"new_findings":[]}',
      } : input));
      assert.ok(brief.includes(blockingDefinition));
      assert.ok(brief.includes('Apply the blocking definition supplied in the schema below'));
      assert.equal(brief.split('Blocking requires').length - 1, 1, 'definition comes from the role schema once');
      assert.ok(!brief.includes('Blocking means it ships a defect'));
      assert.ok(!brief.includes('It materially affects one of the axes above'));
    });
  }
}

test('debate distinguishes severity, confidence, guards, and suggestion corrections', () => {
  const brief = prose(buildBrief('debate', input));
  for (const rule of [
    'Lower severity only when the remaining defect falls below the blocking bar.',
    'A confidence-only concession preserves justified severity while an evidence-backed trigger remains.',
    'A partially effective guard leaves the residual defect to assess under the same bar.',
    'fully guarded (cite the guard)',
    'no evidence-backed trigger remains (name the unsupported premise)',
    'preserve justified severity, and request `"suggestion": null`',
  ]) assert.ok(brief.includes(rule), rule);
  assert.ok(!brief.includes('That includes realistic but unverified state'));
  assert.ok(!brief.includes('a race, nil on a rare but reachable path'));
});

test('final prompt and its schema keep downgrade disputes agreed and reserve contested for refutations', () => {
  const brief = prose(buildBrief('final', input));
  const prompt = brief.slice(0, brief.indexOf('## Schema'));
  const schema = brief.slice(brief.indexOf('## 3.'));
  for (const text of [prompt, schema]) {
    assert.ok(text.includes('an `F*` held against an evidenced refutation'));
    assert.ok(text.includes('Both remain eligible for posting under `--contested drop`'));
    assert.ok(text.includes('The final schema has no confidence field'));
    assert.ok(text.includes('no evidence-backed trigger remains'));
    assert.ok(text.includes('unsupported premise'));
    assert.ok(text.includes('`"suggestion": null`'));
  }
  assert.ok(brief.includes('Reject an invalid severity downgrade by keeping justified severity and `agreed`'));
  assert.ok(brief.includes('Accept a valid severity downgrade by changing `severity` and marking `agreed`'));
  assert.ok(schema.includes('An accepted severity downgrade changes severity; a rejected one keeps justified severity'));
  assert.ok(schema.includes('A wrong patch does not make a blocking defect non-blocking'));
  assert.ok(!brief.includes('If the challenge is wrong and you can show why, use `contested`'));
  assert.ok(!brief.includes('Accept a valid `downgrade` by changing `severity`'));
  assert.ok(!schema.includes('both models stand behind it'));
  assert.ok(!schema.includes('"confidence":'));
});
