import fs from 'node:fs';

const root = new URL('../../', import.meta.url);
const roles = {
  main: { template: 'review-main.md', section: 1, schema: 'SCHEMA_FINDINGS', fields: ['BASE', 'HEAD', 'PR_TITLE', 'PR_BODY', 'SPEC', 'STANDARDS'] },
  debate: { template: 'review-debate.md', section: 2, schema: 'SCHEMA_DEBATE', fields: ['BASE', 'HEAD', 'FINDINGS_JSON'] },
  final: { template: 'review-rebuttal.md', section: 3, schema: 'SCHEMA_FINAL', fields: ['BASE', 'HEAD', 'FINDINGS_JSON', 'DEBATE_JSON'] },
};

/** Keep each role's input limited to its template contract, including on future template edits. */
export function buildBrief(role, input) {
  const contract = roles[role];
  if (!contract) throw new Error(`unknown review brief role: ${role}`);
  const schema = fs.readFileSync(new URL('references/schema.md', root), 'utf8');
  const values = { [contract.schema]: '## ' + schema.split(/^## /m)[contract.section] };
  for (const field of contract.fields) {
    if (input[field] === undefined) throw new Error(`${role} brief missing ${field}`);
    values[field] = input[field];
  }
  const template = fs.readFileSync(new URL(`assets/prompts/${contract.template}`, root), 'utf8');
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, field) => {
    if (!Object.hasOwn(values, field)) throw new Error(`${role} brief has unsupported field ${field}`);
    return values[field];
  });
}
