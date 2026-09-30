#!/usr/bin/env node
// debate.mjs — the single entrypoint (one permission allowlist entry covers every command).
import { SEATS, runCli, isMainModule, usage, parseArgs, printJson, resolveCwdArg, repositoryScope, changeRepositoryScope, debateHome, ensureHome, statsCommand } from './lib/common.mjs';

const HELP = `debate.mjs — plan cross-review, local candidate review with a push gate, and two-model PR review

Usage:
  debate.mjs plan <command> ...       cross-review a final plan (plan --help)
  debate.mjs code <command> ...       review a local candidate commit, approve pushes (code --help)
  debate.mjs review <pr|--local> ...  two-model debate review of a GitHub PR or working tree (review --help)
  debate.mjs setup lanes|hooks|doctor configure reviewer lanes and host hooks, check the install (setup --help)
  debate.mjs scope enable|disable|status --cwd <dir>
  debate.mjs stats [--kind plan|code] [--seat ${SEATS.join('|')}] [--since 30d] [--json]
  debate.mjs hook <agent> <event>     host hook dispatcher (JSON payload on stdin)

Environment: DEBATE_HOME (default ~/.local/share/debate), DEBATE=off, DELEGATE_SKILLS_DIR. --help never launches a model.
`;

function shared(argv) {
  const { flags, positional } = parseArgs(argv.slice(1), { booleans: ['json'], values: ['cwd', 'kind', 'seat', 'since'] });
  if (flags.help) { process.stdout.write(HELP); return 0; }
  if (argv[0] === 'stats') { ensureHome(debateHome()); return statsCommand(flags, debateHome()); }
  const cwd = resolveCwdArg(flags.cwd);
  if (positional.length !== 1 || !['enable', 'disable', 'status'].includes(positional[0])) throw usage('scope requires enable, disable, or status');
  printJson(positional[0] === 'status' ? { ok: true, ...repositoryScope(cwd) } : changeRepositoryScope(cwd, positional[0] === 'enable'));
  return 0;
}

/** review.mjs exits 2 (usage) and 3 (already reviewed) itself; any thrown failure exits 1 with the debate-review: prefix. */
async function review(argv) {
  try {
    await (await import('./review.mjs')).main(argv);
  } catch (error) {
    process.stderr.write(`debate-review: ${error && error.message ? error.message : error}\n`);
    process.exitCode = 1;
  }
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  if ((cmd === 'plan' || cmd === 'code') && rest[0] === 'scope') return runCli(shared, rest);
  switch (cmd) {
    case 'plan': return runCli((await import('./plan.mjs')).main, rest);
    case 'code': return runCli((await import('./code.mjs')).main, rest);
    case 'review': return review(rest);
    case 'hook': process.exitCode = (await import('./hooks.mjs')).main(rest); return;
    case 'setup': return runCli((await import('./setup.mjs')).main, rest);
    case 'scope': case 'stats': return runCli(shared, argv);
    case '--help': case '-h': process.stdout.write(HELP); return;
    default: process.stdout.write(HELP); process.exitCode = 2;
  }
}

if (isMainModule(import.meta.url)) await main(process.argv.slice(2));
