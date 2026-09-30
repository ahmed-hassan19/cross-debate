import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildBrief } from '../skills/debate/scripts/lib/briefs.mjs';

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
    for (const field of ['BASE', 'HEAD', 'FINDINGS_JSON']) assert.ok(brief.includes(input[field]));
    if (role === 'final') assert.ok(brief.includes(input.DEBATE_JSON));
    for (const field of ['PR_TITLE', 'PR_BODY', 'SPEC', 'STANDARDS', 'TELEMETRY', 'REVIEWER']) {
      assert.ok(!brief.includes(input[field]), `${field} must not reach ${role}`);
    }
    assert.ok(brief.includes(`debate-review.${role}.v1`));
  });
}

test('role input contracts reject missing required arguments', () => {
  assert.throws(() => buildBrief('debate', { BASE: 'base', HEAD: 'head' }), /missing FINDINGS_JSON/);
  assert.throws(() => buildBrief('unknown', input), /unknown review brief role/);
});

test('packaged templates resolve inside the skill directory: the plan brief and the review schema and prompts', async () => {
  const { TEMPLATE_PATH } = await import('../skills/debate/scripts/plan.mjs');
  const skill = new URL('../skills/debate/', import.meta.url);
  assert.equal(TEMPLATE_PATH, fs.realpathSync(new URL('assets/review-brief.md', skill)));
  assert.ok(fs.existsSync(new URL('references/schema.md', skill)));
  for (const role of ['main', 'debate', 'final']) assert.ok(buildBrief(role, input).length > 0);
});
