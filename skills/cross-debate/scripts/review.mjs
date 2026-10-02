// review.mjs — `debate.mjs review`
//
// Review a GitHub PR or a local working tree with two implementers that debate, then post one review.
//
//   1. main reviewer   → findings
//   2. debate reviewer → confirm / refute / downgrade each finding, add its own
//   3. main reviewer   → final call (agreed / contested / withdrawn)
//   4. post one review with inline comments (or print it with --dry-run / --local)
//
// Shells out to git, gh, and delegate-skills relays in --read-only. Never commits, never
// edits the PR branch, never approves or requests changes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { run, text, log } from './lib/shell.mjs';
import { scanDiffForSecrets } from './lib/common.mjs';
import { snapshotWorkingTree } from './lib/local.mjs';
import { parseTarget, parseOrigin, projectPath, cloneUrl, fetchPR, alreadyReviewed, fetchSpec, postReview } from './lib/forge.mjs';
import { diffLineMap, anchor } from './lib/diff.mjs';
import { resolveRole, dispatch, extractJson } from './lib/dispatch.mjs';
import { validateFindings, validateDebate, validateFinal } from './lib/validate.mjs';
import { renderInline, renderBody } from './lib/render.mjs';

/** Project-level agent settings that can launch commands (hooks, plugins, MCP servers) when a reviewer session starts. */
export const AGENT_CONFIG = ['.claude', '.codex', '.opencode', 'opencode.json', 'opencode.jsonc', '.mcp.json'];

import { buildBrief } from './lib/briefs.mjs';

const HELP = `debate.mjs review — two-model debate review of a GitHub PR or a local working tree

Usage:
  debate.mjs review --local [--base <ref>] [--repo-dir <dir>] [options]
  debate.mjs review <pr-url | number> [--dry-run] [options]

Targets:
  GitHub        https://github.com/<owner>/<repo>/pull/<n> (GitHub Enterprise hosts need gh auth)
  <n>           resolved against the origin of the current clone

Options:
  --local                   Review the working tree. No forge access. Prints the review.
  --main <implementer>      Main reviewer (claude|codex|cursor|grok|pi…; opencode only via a lane). Default: the lane.
  --debate <implementer>    Debate reviewer. Default: the lane.
  --main-lane <name>        Fleet lane for main (default: review-main).
  --debate-lane <name>      Fleet lane for debate (default: review-debate).
  --contested post|drop     Findings debate refuted but main kept (default: post, tagged).
  --min-confidence <0-1>    Drop findings (main F* and debate D*) below this confidence (default: 0.5).
  --base <ref>              Base override (PR: forge base sha; --local: origin/HEAD, else main, else master).
  --repo-dir <dir>          Local clone (PR) or the working tree to snapshot (--local). Default: cwd.
  --out-dir <dir>           Artifacts (default: ~/.cache/debate-review/… ).
  --timeout <dur>           Per-implementer relay watchdog (default: 30m).
  --dry-run                 Print a live PR review instead of posting. Does not combine with --local.
  --force                   Post even if this head sha already has a debate-review.
  --keep                    Keep the temporary worktree (PR) or snapshot clone (--local).
  --help

Exit codes: 0 posted/printed · 1 failure · 2 usage · 3 head already reviewed (use --force)
`;

// ============================================================ args

function parseArgs(argv) {
  const opts = {
    mainLane: 'review-main',
    debateLane: 'review-debate',
    contested: 'post',
    minConfidence: 0.5,
    timeout: '30m',
  };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) fail(2, `missing value for ${arg}`);
      return argv[++i];
    };

    if (arg === '--help' || arg === '-h') { process.stdout.write(HELP); process.exit(0); }
    else if (arg === '--main') opts.main = value();
    else if (arg === '--debate') opts.debate = value();
    else if (arg === '--main-lane') opts.mainLane = value();
    else if (arg === '--debate-lane') opts.debateLane = value();
    else if (arg === '--contested') opts.contested = value();
    else if (arg === '--min-confidence') opts.minConfidence = Number(value());
    else if (arg === '--base') opts.base = value();
    else if (arg === '--repo-dir') opts.repoDir = value();
    else if (arg === '--out-dir') opts.outDir = value();
    else if (arg === '--timeout') opts.timeout = value();
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--local') opts.local = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--keep') opts.keep = true;
    else if (arg.startsWith('--')) fail(2, `unknown option ${arg}`);
    else positional.push(arg);
  }

  if (opts.local && opts.dryRun) {
    fail(2, '--local and --dry-run do not combine; --local prints a working tree, --dry-run prints a live PR');
  }
  if (opts.local && positional.length !== 0) {
    fail(2, '--local does not take a PR URL; drop the URL or use --dry-run');
  }
  if (!opts.local && opts.dryRun && positional.length !== 1) {
    fail(2, '--dry-run needs a PR URL; for a working tree use --local');
  }
  if (!opts.local && positional.length !== 1) fail(2, HELP);
  if (!['post', 'drop'].includes(opts.contested)) fail(2, '--contested must be post or drop');
  if (!(opts.minConfidence >= 0 && opts.minConfidence <= 1)) fail(2, '--min-confidence must be 0..1');

  if (!opts.local) opts.target = positional[0];
  return opts;
}

function fail(code, message) {
  process.stderr.write(`debate-review: ${message}\n`);
  process.exit(code);
}

// ============================================================ local checkout

function currentOrigin() {
  const r = run('git', ['remote', 'get-url', 'origin'], { allowFail: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

function cloneMatches(dir, target) {
  const r = run('git', ['-C', dir, 'remote', 'get-url', 'origin'], { allowFail: true });
  if (r.status !== 0) return false;
  const origin = parseOrigin(r.stdout.trim());
  return origin
    && origin.host === target.host
    && origin.origin.toLowerCase() === target.origin.toLowerCase()
    && origin.owner.toLowerCase() === target.owner.toLowerCase()
    && origin.repo.toLowerCase() === target.repo.toLowerCase();
}

/** Find a local clone of the PR's repo: --repo-dir, else cwd, else a cache clone. */
function findClone(target, opts, auth) {
  if (opts.repoDir) {
    if (!cloneMatches(opts.repoDir, target)) throw new Error(`--repo-dir origin does not match ${projectPath(target)}`);
    return path.resolve(opts.repoDir);
  }

  const top = run('git', ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (top.status === 0 && cloneMatches(top.stdout.trim(), target)) return top.stdout.trim();

  const cacheName = [target.host, target.origin, target.owner, target.repo].join('__').replace(/\//g, '__');
  const cache = path.join(os.homedir(), '.cache', 'debate-review', 'clones', cacheName);
  if (!fs.existsSync(cache)) {
    log(`cloning ${projectPath(target)} into ${cache}`);
    run('git', [...auth.args, 'clone', '--filter=blob:none', cloneUrl(target), cache],
      { env: auth.env, stdio: ['ignore', 'ignore', 'inherit'] });
  }
  return cache;
}

/** Fetch the PR head + base and check the head out in a throwaway worktree. */
function makeWorktree(clone, pr, baseBranch, auth) {
  fetchHead(clone, pr, auth);
  run('git', [...auth.args, '-C', clone, 'fetch', '--quiet', 'origin', baseBranch], { env: auth.env });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-review-'));
  fs.rmSync(dir, { recursive: true, force: true }); // git wants to create it
  run('git', ['-C', clone, 'worktree', 'add', '--detach', '--quiet', dir, pr.head]);
  return dir;
}

/** Fetch the ref that carries the PR head. */
function fetchHead(clone, pr, auth) {
  const first = run('git', [...auth.args, '-C', clone, 'fetch', '--quiet', 'origin', pr.fetchRef],
    { allowFail: true, env: auth.env });
  if (first.status !== 0) throw new Error(`cannot fetch ${pr.fetchRef}\n${first.stderr}`);
  if (run('git', ['-C', clone, 'cat-file', '-e', `${pr.head}^{commit}`], { allowFail: true }).status !== 0) {
    throw new Error(`fetched ${pr.fetchRef}, but reviewed head ${pr.head} is missing; the head may have moved`);
  }
}

function removeWorktree(clone, dir) {
  run('git', ['-C', clone, 'worktree', 'remove', '--force', dir], { allowFail: true });
}

// ============================================================ briefs

/** Files that document how code should be written in this repo (the Standards axis). */
function findStandards(worktree) {
  const candidates = ['CONTRIBUTING.md', 'CODING_STANDARDS.md', 'CLAUDE.md', 'AGENTS.md', '.github/PULL_REQUEST_TEMPLATE.md', 'docs/agents'];
  const found = [];
  for (const rel of candidates) {
    const abs = path.join(worktree, rel);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isDirectory()) {
      for (const f of fs.readdirSync(abs)) found.push(path.join(rel, f));
    } else {
      found.push(rel);
    }
  }
  return found.length ? found.join(', ') : 'none found, skip the Standards axis';
}

// ============================================================ flow

export async function main(argv) {
  const opts = parseArgs(argv);

  let target = null;
  let pr;
  let clone;
  let worktree;
  let outDir;
  let localSnapshot = null;
  let repoDirForRoles;
  const auth = { args: [], env: process.env };
  const printOnly = Boolean(opts.local || opts.dryRun);

  if (opts.local) {
    const given = opts.repoDir
      ? path.resolve(opts.repoDir)
      : text('git', ['rev-parse', '--show-toplevel']);
    localSnapshot = snapshotWorkingTree(given, { keep: opts.keep, base: opts.base });
    repoDirForRoles = text('git', ['-C', given, 'rev-parse', '--show-toplevel']);
    pr = localSnapshot.pr;
    worktree = localSnapshot.dir;
    clone = localSnapshot.dir;
    outDir = opts.outDir || path.join(
      os.homedir(),
      '.cache',
      'debate-review',
      'local',
      path.basename(repoDirForRoles),
      pr.headRef.replace(/\//g, '__'),
      pr.head.slice(0, 12),
    );
    log(`local ${path.basename(repoDirForRoles)} @ ${pr.head.slice(0, 10)} (${pr.headRef} → ${pr.baseRef})`);
  } else {
    target = parseTarget(opts.target, currentOrigin());
    pr = fetchPR(target);
    log(`${projectPath(target)}#${target.number} @ ${pr.head.slice(0, 10)} (${pr.headRef} → ${pr.baseRef})`);
    outDir = opts.outDir || path.join(
      os.homedir(),
      '.cache',
      'debate-review',
      `${target.owner.replace(/\//g, '__')}__${target.repo}`,
      String(target.number),
      pr.head.slice(0, 12),
    );

    if (!opts.force && !opts.dryRun && alreadyReviewed(target, pr)) {
      log('this head already has a debate-review; use --force to post another');
      process.exit(3);
    }

    clone = findClone(target, opts, auth);
    worktree = makeWorktree(clone, pr, pr.baseRef, auth);
    repoDirForRoles = clone;
  }

  const baseRef = opts.local ? pr.baseSha : (opts.base || pr.baseSha);
  const startedAt = new Date().toISOString();

  const runLog = {
    schema: 'debate-review.run.v1',
    local: Boolean(opts.local),
    repoDir: opts.local ? repoDirForRoles : undefined,
    snapshotDir: opts.local ? localSnapshot.dir : undefined,
    base: opts.local ? { name: pr.baseRef, sha: pr.baseSha } : undefined,
    snapshotCommit: opts.local ? pr.head : undefined,
    target,
    pr,
    outDir,
    printOnly,
    force: Boolean(opts.force),
    startedAt,
    stages: {},
  };
  const save = () => fs.writeFileSync(path.join(outDir, 'run.json'), JSON.stringify(runLog, null, 2));

  try {
    fs.mkdirSync(outDir, { recursive: true });
    const diff = text('git', ['-C', worktree, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', `${baseRef}...HEAD`]);
    if (!diff.trim()) throw new Error('empty diff, nothing to review');
    const secretHits = scanDiffForSecrets(diff);
    if (secretHits.length) {
      runLog.secretHits = secretHits;
      save();
      throw new Error(`${secretHits.length} potential secret(s) in the diff; no reviewer ran: ${secretHits.map(h => `${h.file} (diff line ${h.diffLine}, ${h.pattern})`).join('; ')}`);
    }
    const commits = text('git', ['-C', worktree, 'log', `${baseRef}..HEAD`, '--oneline']);
    const lineMap = diffLineMap(diff);
    // The worktree is this command's disposable checkout of possibly untrusted code. Agent configuration in it would
    // run when a reviewer starts (a headless Claude session loads project hooks), so it is removed first.
    for (const name of AGENT_CONFIG) fs.rmSync(path.join(worktree, name), { recursive: true, force: true });
    // Read-only relays may not run git (the Claude relay allows only Read/Glob/Grep), so hand them the diff as files.
    // Exclusive creation: a checkout-provided .debate-review entry or symlink must not redirect these writes.
    const inputDir = path.join(worktree, '.debate-review');
    try { fs.mkdirSync(inputDir); } catch (e) { throw new Error(e.code === 'EEXIST' ? 'the reviewed tree contains .debate-review; refusing to write review inputs over it' : e.message); }
    fs.writeFileSync(path.join(inputDir, 'diff.patch'), diff, { flag: 'wx' });
    fs.writeFileSync(path.join(inputDir, 'commits.txt'), commits, { flag: 'wx' });

    const who = {
      main: resolveRole('main', { explicit: opts.main, lane: opts.mainLane, cwd: repoDirForRoles }),
      debate: resolveRole('debate', { explicit: opts.debate, lane: opts.debateLane, cwd: repoDirForRoles }),
    };
    runLog.who = who;
    save();

    const common = {
      BASE: baseRef,
      HEAD: pr.head,
    };
    const send = (role, implementer, brief) => dispatch({
      role, who: implementer, brief, cwd: worktree, outDir, timeout: opts.timeout,
    });

    const spec = opts.local ? 'none found, skip the Spec axis' : fetchSpec(target, pr, commits);

    const mainBrief = buildBrief('main', {
      ...common,
      PR_TITLE: pr.title,
      PR_BODY: pr.body.slice(0, 6000) || '(empty)',
      SPEC: spec,
      STANDARDS: findStandards(worktree),
    });
    const mainRun = send('main', who.main, mainBrief);
    const findings = validateFindings(extractJson(mainRun.text));
    findings.findings = findings.findings.filter(f => (f.confidence ?? 1) >= opts.minConfidence);
    runLog.stages.main = { seconds: mainRun.seconds, doc: findings };
    save();
    log(`main: ${findings.findings.length} finding(s) after the confidence filter`);

    const debateBrief = buildBrief('debate', {
      ...common,
      FINDINGS_JSON: JSON.stringify(findings, null, 2),
    });
    const debateRun = send('debate', who.debate, debateBrief);
    const debate = validateDebate(extractJson(debateRun.text), findings);
    debate.new_findings = debate.new_findings.filter(f => (f.confidence ?? 1) >= opts.minConfidence);
    runLog.stages.debate = { seconds: debateRun.seconds, doc: debate };
    save();
    log(`debate: ${debate.verdicts.length} verdict(s), ${debate.new_findings.length} new finding(s) after the confidence filter`);

    let finalDoc;
    const nothingToDebate = findings.findings.length === 0 && debate.new_findings.length === 0;
    if (nothingToDebate) {
      finalDoc = {
        schema: 'debate-review.final.v1',
        head: pr.head,
        summary: findings.summary || 'No material findings from either reviewer.',
        findings: [],
      };
    } else {
      const finalBrief = buildBrief('final', {
        ...common,
        FINDINGS_JSON: JSON.stringify(findings, null, 2),
        DEBATE_JSON: JSON.stringify(debate, null, 2),
      });
      const finalRun = send('final', who.main, finalBrief);
      finalDoc = validateFinal(extractJson(finalRun.text), findings, debate);
      runLog.stages.final = { seconds: finalRun.seconds, doc: finalDoc };
    }
    finalDoc.head = pr.head;
    const axisOf = new Map([...findings.findings, ...debate.new_findings].map(f => [f.id, f.axis]));
    for (const f of finalDoc.findings || []) if (!f.axis) f.axis = axisOf.get(f.id);
    save();

    const toPost = (finalDoc.findings || []).filter(f =>
      f.status === 'agreed' || (f.status === 'contested' && opts.contested === 'post'));

    const comments = [];
    const unanchored = [];
    for (const f of toPost) {
      const a = anchor(lineMap, f);
      if (!a) { unanchored.push(f); continue; }
      let body = renderInline(f);
      if (a.snapped) body += `\n_(anchored to the nearest diff line; the finding named ${f.line_start}-${f.line_end})_\n`;
      comments.push({ ...a, body, claim: f.claim });
    }
    const body = renderBody({ who, finalDoc, posted: toPost, unanchored });

    runLog.posted = {
      body,
      comments,
      withdrawn: (finalDoc.findings || []).filter(f => f.status === 'withdrawn').map(f => f.id),
    };
    save();

    if (printOnly) {
      const kind = opts.local ? 'local' : 'dry-run';
      process.stdout.write(`\n===== REVIEW BODY =====\n${body}\n`);
      for (const c of comments) {
        const range = c.start_line ? `${c.start_line}-${c.line}` : String(c.line);
        process.stdout.write(`\n===== ${c.path}:${range} =====\n${c.body}\n`);
      }
      process.stdout.write(`\n(${kind}: nothing posted; artifacts in ${outDir})\n`);
    } else {
      const result = postReview(target, pr, body, comments);
      runLog.postResult = result;
      save();
      log(`posted ${comments.length} inline comment(s): ${result.url}`);
      process.stdout.write(`${result.url}\n`);
    }
  } finally {
    if (opts.local) {
      if (localSnapshot) localSnapshot.cleanup();
    } else if (!opts.keep) {
      removeWorktree(clone, worktree);
    }
    runLog.finishedAt = new Date().toISOString();
    try { save(); } catch { /* snapshot cleanup may have already finished */ }
  }
}
