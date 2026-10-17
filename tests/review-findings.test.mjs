import test from 'node:test';
import assert from 'node:assert/strict';
import { coerceEfficiency, finalizeFindings, gateSuggestion } from '../skills/cross-debate/scripts/review.mjs';
import { renderInline, suggestionBlock } from '../skills/cross-debate/scripts/lib/render.mjs';
import { validateFindings } from '../skills/cross-debate/scripts/lib/validate.mjs';
import { anchor } from '../skills/cross-debate/scripts/lib/diff.mjs';
import { joinBackendFindings } from '../skills/cross-debate/scripts/code.mjs';

const finding = (over) => ({ id: 'F1', file: 'a.js', line_start: 10, line_end: 12, severity: 'non-blocking', axis: 'correctness', claim: 'c', ...over });

test('blocking efficiency findings are made non-blocking, and debate efficiency findings are dropped', () => {
  const main = { findings: [finding({ axis: 'efficiency', severity: 'blocking' }), finding({ id: 'F2', severity: 'blocking' })] };
  assert.equal(coerceEfficiency(main, 'main').length, 1);
  assert.deepEqual(main.findings.map(f => f.severity), ['non-blocking', 'blocking']);

  const debate = { new_findings: [finding({ id: 'D1', axis: 'efficiency', severity: 'blocking' }), finding({ id: 'D2', severity: 'blocking' })] };
  assert.match(coerceEfficiency(debate, 'debate')[0], /dropped D1/);
  assert.deepEqual(debate.new_findings.map(f => f.id), ['D2']);
});

test('final efficiency severity uses the original axis even when the final stage omits or relabels it', () => {
  const findings = { findings: [finding({ axis: 'efficiency' }), finding({ id: 'F2', axis: 'efficiency' })] };
  const debate = { verdicts: [{ id: 'F1', verdict: 'confirm' }, { id: 'F2', verdict: 'confirm' }], new_findings: [] };
  const finalDoc = { findings: [
    finding({ status: 'agreed', severity: 'blocking', axis: undefined }),
    finding({ id: 'F2', status: 'agreed', severity: 'blocking', axis: 'correctness' }),
  ] };
  assert.equal(finalizeFindings(finalDoc, findings, debate).length, 2);
  assert.deepEqual(finalDoc.findings.map(f => [f.axis, f.severity]), [['efficiency', 'non-blocking'], ['efficiency', 'non-blocking']]);
});

test('suggestions come only from the original, on an unchanged location, agreed and endorsed', () => {
  const original = (id, over) => finding({ id, suggestion: 'fixed();', ...over });
  const findings = { findings: [original('F1'), original('F2'), original('F3'), original('F4'), original('F5'), original('F6')] };
  const debate = {
    verdicts: [['F1', 'confirm'], ['F2', 'confirm'], ['F3', 'downgrade'], ['F4', 'confirm'], ['F5', 'confirm'], ['F6', 'confirm']].map(([id, verdict]) => ({ id, verdict })),
    new_findings: [finding({ id: 'D1', severity: 'blocking', suggestion: 'd();' })],
  };
  const finalDoc = { findings: [
    finding({ id: 'F1', status: 'agreed', suggestion: 'model rewrote this' }),
    finding({ id: 'F2', status: 'contested' }),
    finding({ id: 'F3', status: 'agreed' }),
    finding({ id: 'F4', status: 'agreed', line_end: 13 }),
    finding({ id: 'F5', status: 'agreed', file: 'b.js' }),
    finding({ id: 'D1', status: 'agreed', severity: 'blocking' }),
    finding({ id: 'F6', status: 'agreed', suggestion: null, recommendation: 'a different fix' }),
  ] };
  finalizeFindings(finalDoc, findings, debate);
  assert.deepEqual(finalDoc.findings.map(f => f.suggestion), ['fixed();', undefined, undefined, undefined, undefined, 'd();', undefined]);
});

test('the suggestion gate requires the anchor to cover exactly the finding lines', () => {
  const lines = new Map([['a.js', new Set([10, 11, 12, 20, 22])]]);
  const gated = (f) => gateSuggestion(anchor(lines, f), f);
  assert.equal(gated(finding({ suggestion: 's' })), 's');
  assert.equal(gated(finding({ line_start: 20, line_end: 20, suggestion: 's' })), 's');
  assert.equal(gated(finding({ line_start: 9, line_end: 12, suggestion: 's' })), undefined, 'start outside the diff');
  assert.equal(gated(finding({ line_start: 20, line_end: 22, suggestion: 's' })), undefined, 'range crosses a hunk gap');
  assert.equal(gated(finding({ line_start: 13, line_end: 13, suggestion: 's' })), undefined, 'snapped end');
  assert.equal(gated(finding()), undefined, 'no suggestion');
});

test('rendered suggestion blocks use a fence longer than any backtick run inside', () => {
  assert.equal(suggestionBlock('x();\n'), '```suggestion\nx();\n```');
  assert.equal(suggestionBlock('a ``` b\n````c'), '`````suggestion\na ``` b\n````c\n`````');
  const body = renderInline(finding({ status: 'agreed', recommendation: 'r' }), 'x();');
  assert.ok(body.indexOf('Suggested: r') < body.indexOf('```suggestion\nx();\n```'));
  assert.ok(!renderInline(finding({ status: 'agreed', suggestion: 'x();' })).includes('```suggestion'), 'only a gated suggestion renders');
});

test('validate accepts the efficiency axis and a string suggestion, and rejects other suggestion types', () => {
  const doc = (f) => ({ schema: 'debate-review.findings.v1', verdict: 'needs-attention', findings: [f] });
  assert.doesNotThrow(() => validateFindings(doc(finding({ axis: 'efficiency', suggestion: 'x' }))));
  assert.throws(() => validateFindings(doc(finding({ suggestion: 42 }))), /suggestion must be a string/);
});

test('a code candidate is never blocked by an efficiency finding, even from an older run log', () => {
  const run = { stages: {
    main: { doc: { summary: '', findings: [finding({ axis: 'efficiency' })] } },
    debate: { doc: { verdicts: [{ id: 'F1', verdict: 'confirm' }], new_findings: [] } },
    final: { doc: { findings: [{ id: 'F1', status: 'agreed', severity: 'blocking' }] } },
  } };
  const joined = joinBackendFindings(run, 1);
  assert.equal(joined.findings[0].severity, 'non-blocking');
});
