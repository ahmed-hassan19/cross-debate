// setup.mjs — `debate.mjs setup`: a first-run wizard, propose missing reviewer lanes, print or merge host hook entries,
// and check the install. Nothing is written without an interactive terminal and an explicit y; an agent cannot edit
// its own settings.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  CLI, PLAN_LANES, CODE_REVIEW_LANES, usage, parseArgs, debateHome, probeWritable, findScript, skillRoots, VENDOR_SKILLS_DIR,
  loadLaneConfig, sleepMs, skillVersion, repositoryScope,
} from './lib/common.mjs';
import { resolveReviewOverride } from './lib/recovery.mjs';
import { discoverModelCatalog, modelMenu } from './lib/model-catalog.mjs';

const HELP = `debate.mjs setup — configure reviewer lanes and host hooks, then check the install

Usage:
  setup init
  setup lanes [--opencode-model <provider/model>] [--write]
  setup hooks --agent claude|codex|cursor|opencode [--write]
  setup doctor [--agent claude|codex|cursor|opencode] [--cwd <dir>]

init walks you through reviewer lanes (CLI, model, effort), host hooks and the optional skills (ponytail,
babysit-pr), then runs doctor. Run it once after installing, in your own terminal.
Automatic reviews run in every Git repository by default and use reviewer-provider quota. Use scope disable --cwd <dir> to opt out.
Reviewer 1 finds possible code issues; Reviewer 2 challenges them and can add missed issues. Both review plans independently.
Choose different CLIs or model families when available. Model lists are catalog suggestions, not access checks.
lanes proposes only lanes missing from the global delegate-skills config (plan-main[-<seat>], plan-debate,
review-main, review-debate) for the reviewer CLIs on PATH. hooks prints the exact entries for one agent.
--write shows the change and asks y/N; it needs an interactive terminal and keeps a *.debate-bak backup.
Run setup through the same path your agent uses (the skill catalog path): permission allowlists match literally.
doctor checks all hosts unless --agent selects one. It never launches reviewers or verifies sign-in/native hook trust.
`;
const REVIEWER_CLIS = ['claude', 'codex', 'opencode'];
const AGENTS = ['claude', 'codex', 'cursor', 'opencode'];
const HOOK_TIMEOUT = 15;

// ---------- shared ----------

/** The entrypoint path as the user invoked it (a catalog symlink stays a symlink), else the module's own path. */
export function invokedCli(argv1 = process.argv[1]) {
  return argv1 && path.basename(argv1) === 'debate.mjs' ? path.resolve(argv1) : CLI;
}
function realCli(invoked) { try { return fs.realpathSync(invoked); } catch { return invoked; } }
function onPath(name) {
  return (process.env.PATH || '').split(path.delimiter).filter(Boolean).some(dir => {
    try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return true; } catch { return false; }
  });
}
function readJsonFile(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw usage(`${file} is not valid JSON: ${e.message}; fix it before merging`); }
}
function lineDiff(before, after) {
  const old = new Set(before.split('\n'));
  const next = new Set(after.split('\n'));
  return [...before.split('\n').filter(l => !next.has(l)).map(l => `- ${l}`), ...after.split('\n').filter(l => !old.has(l)).map(l => `+ ${l}`)].join('\n');
}
function requireTty(what = '--write') {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw usage(`${what} needs an interactive terminal; run this command yourself (in Claude Code: type ! followed by the command)`);
}

// ---------- prompts ----------

let pending = '';
/** One line from stdin, synchronously (no readline, so it never competes with readSync); null at end of input. */
function readLine() {
  while (!pending.includes('\n')) {
    const buf = Buffer.alloc(256);
    let n = 0;
    try { n = fs.readSync(0, buf, 0, buf.length, null); } catch (e) { if (e.code === 'EAGAIN') { sleepMs(20); continue; } n = 0; }
    if (!n) { const rest = pending; pending = ''; return rest || null; }
    pending += buf.toString('utf8', 0, n);
  }
  const i = pending.indexOf('\n');
  const line = pending.slice(0, i);
  pending = pending.slice(i + 1);
  return line.replace(/\r$/, '');
}
/** The production ask: print the question, numbered choices and the default, then read one line. */
function terminalAsk(question, { choices = [], def = '' } = {}) {
  const list = choices.map((c, i) => `  ${i + 1}) ${c}\n`).join('');
  process.stdout.write(`${question}\n${list}${def ? `[${def}] ` : ''}> `);
  return readLine();
}
/** Ask until the answer passes: a choice number, a listed choice, free text when allowed, or Enter for the default. */
function pick(ask, question, { choices = [], def = '', free = false, check = () => null } = {}) {
  for (;;) {
    const raw = ask(question, { choices, def });
    if (raw === null || raw === undefined) throw usage('input ended; stopped before writing anything further');
    let answer = raw.trim() || def;
    if (/^\d+$/.test(answer) && choices[Number(answer) - 1]) answer = choices[Number(answer) - 1];
    const error = !answer ? 'an answer is required'
      : !free && !choices.includes(answer) ? `choose one of: ${choices.join(', ')}`
      : check(answer);
    if (!error) return answer;
    process.stdout.write(`  ${error}\n`);
  }
}
function confirm(ask, question, def = false) {
  const raw = ask(`${question} [${def ? 'Y/n' : 'y/N'}]`);
  if (raw === null || raw === undefined) throw usage('input ended; stopped before writing anything further');
  return raw.trim() ? /^y(es)?$/i.test(raw.trim()) : def;
}

/** Show the change, require a human y, back up, then write. Without an injected ask it needs a terminal. */
function confirmAndWrite(file, before, after, write = (f, text) => fs.writeFileSync(f, text), ask = null, summary = null) {
  if (!ask) { requireTty(); ask = terminalAsk; }
  if (before === after) { process.stdout.write(`${file}: already up to date\n`); return false; }
  process.stdout.write(`\n${file}\n${summary ?? lineDiff(before, after)}\n\n`);
  if (!confirm(ask, 'Write this change?')) { process.stdout.write('not written\n'); return false; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.debate-bak`);
  write(file, after);
  process.stdout.write(`wrote ${file}${fs.existsSync(`${file}.debate-bak`) ? ` (backup ${file}.debate-bak)` : ''}\n`);
  return true;
}

// ---------- lanes ----------

/**
 * Lanes to add for the available reviewer CLIs, never touching existing ones. plan-debate and review-main take the
 * first CLI in fixed order, review-debate a different one. plan-main-<seat> must differ from plan-debate so each seat
 * gets two models; after that it avoids an opencode lane with no model, then the seat's own CLI.
 */
export function proposeLanes(available, existing = {}, { opencodeModel = null } = {}) {
  const order = REVIEWER_CLIS.filter(c => available.includes(c));
  if (!order.length) throw usage(`no reviewer CLI found on PATH (${REVIEWER_CLIS.join(', ')})`);
  const other = (cli) => order.find(c => c !== cli) ?? cli;
  const wanted = { [PLAN_LANES.main]: order[0], [PLAN_LANES.debate]: order[0], [CODE_REVIEW_LANES[0]]: order[0], [CODE_REVIEW_LANES[1]]: other(order[0]) };
  const firstPlan = (seat) => order.filter(c => c !== order[0])
    .sort((a, b) => ((a === 'opencode' && !opencodeModel) - (b === 'opencode' && !opencodeModel)) || ((a === seat) - (b === seat)))[0];
  if (order.length > 1) for (const seat of order) wanted[`${PLAN_LANES.main}-${seat}`] = firstPlan(seat);
  const lanes = {};
  const templates = {};
  for (const [name, implementer] of Object.entries(wanted)) {
    if (Object.hasOwn(existing, name)) continue;
    if (implementer !== 'opencode') lanes[name] = { implementer };
    else if (opencodeModel) lanes[name] = { implementer, model: opencodeModel };
    else templates[name] = { implementer, model: '<provider/model>' };
  }
  const warnings = order.length === 1 ? [`only ${order[0]} is available: supported single-CLI setup; identical model choices limit reviewer diversity`] : [];
  return { lanes, templates, warnings };
}
/** Per seat, which CLIs review its plans, flagging a secondary that repeats the primary reviewer's model or the seat's own CLI. */
export function seatPairs(lanes, seats) {
  return seats.map(seat => {
    const first = lanes[`${PLAN_LANES.main}-${seat}`] ?? lanes[PLAN_LANES.main];
    const second = lanes[PLAN_LANES.debate];
    const primary = first?.implementer ?? null;
    const secondary = second?.implementer ?? null;
    const repeatsPrimary = secondary && secondary === primary && (second.model ?? null) === (first.model ?? null);
    return `seat ${seat}: plan reviewers ${primary ?? 'missing'} then ${secondary ?? 'missing'}${repeatsPrimary ? ' (secondary repeats the primary reviewer: supported, with limited model diversity)' : secondary === seat ? " (secondary is the seat's own CLI; review runs in a separate session)" : ''}`;
  });
}
async function delegateConfig() {
  return import(pathToFileURL(findScript('delegate-setup', 'config.mjs')).href);
}
async function lanesCommand(flags) {
  if (flags.opencodeModel && !/^[^/\s]+\/\S+$/.test(flags.opencodeModel)) throw usage('--opencode-model must be provider/model');
  const config = await delegateConfig();
  const file = config.globalConfigPath();
  const current = config.readConfigFile(file)?.document ?? { version: 'delegate-fleet.v1', lanes: {} };
  const available = REVIEWER_CLIS.filter(onPath);
  const proposal = proposeLanes(available, current.lanes, { opencodeModel: flags.opencodeModel });
  const merged = { ...current, lanes: { ...current.lanes, ...proposal.lanes } };
  const parsed = config.parseConfigDocument(JSON.stringify(merged), 'proposed config');
  if (!parsed.ok) throw usage(parsed.error);
  const out = process.stdout;
  out.write(`reviewer CLIs on PATH: ${available.join(', ') || 'none'}\nconfig: ${file}\n`);
  for (const w of proposal.warnings) out.write(`warning: ${w}\n`);
  if (Object.keys(proposal.templates).length) {
    out.write(`\nopencode lanes need a model; rerun with --opencode-model <provider/model>. Template:\n${JSON.stringify(proposal.templates, null, 2)}\n`);
    throw usage('--opencode-model <provider/model> is required for the opencode lanes above; nothing was written');
  }
  if (!Object.keys(proposal.lanes).length) out.write('all debate lanes already exist; nothing to add\n');
  else out.write(`\nlanes to add (existing lanes are never changed):\n${JSON.stringify(proposal.lanes, null, 2)}\n`);
  for (const line of seatPairs(merged.lanes, available)) out.write(`${line}\n`);
  if (flags.write && Object.keys(proposal.lanes).length) {
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    confirmAndWrite(file, before, `${JSON.stringify(parsed.document, null, 2)}\n`, (f) => config.writeAtomic(f, parsed.document));
  } else if (Object.keys(proposal.lanes).length) out.write('\ndry run: add --write in your own terminal to apply\n');
  return 0;
}

// ---------- hooks ----------

const marker = (agent) => `debate.mjs" hook ${agent}`;
function hookCommand(cli, agent, event) { return `node ${JSON.stringify(cli)} hook ${agent} ${event}`; }
function claudeHome() { return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'); }
function codexHome() { return process.env.CODEX_HOME || path.join(os.homedir(), '.codex'); }
function opencodeHome() { return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode'); }

/** Hook entries per agent: { file, events: { event: [{ matcher?, command }] }, allow? }. */
export function hookEntries(agent, cli) {
  // Agents, hooks and allowlists all use node "<path>"; inside double quotes the shell expands $, ` and \.
  if (/[$`"\\]/.test(cli)) throw usage(`the install path ${cli} contains $, \`, " or \\, which the shell expands inside the double-quoted commands agents run; rename or move the skill directory`);
  const cmd = (event) => hookCommand(cli, agent, event);
  if (agent === 'claude') {
    return { file: path.join(claudeHome(), 'settings.json'), events: {
      PreToolUse: [{ matcher: 'Bash', command: cmd('PreToolUse') }, { matcher: 'ExitPlanMode', command: cmd('PreToolUse') }],
      SessionStart: [{ command: cmd('SessionStart') }], UserPromptSubmit: [{ command: cmd('UserPromptSubmit') }], Stop: [{ command: cmd('Stop') }],
    }, allow: [...new Set([cli, realCli(cli)])].map(p => `Bash(node ${JSON.stringify(p)}:*)`) };
  }
  if (agent === 'codex') {
    return { file: path.join(codexHome(), 'hooks.json'), events: {
      PreToolUse: [{ matcher: '^Bash$', command: cmd('PreToolUse') }],
      SessionStart: [{ command: cmd('SessionStart') }], UserPromptSubmit: [{ command: cmd('UserPromptSubmit') }], Stop: [{ command: cmd('Stop') }],
    } };
  }
  if (agent === 'cursor') return { file: path.join(os.homedir(), '.cursor', 'hooks.json'), events: { beforeShellExecution: [{ command: cmd('beforeShellExecution') }] } };
  if (agent === 'opencode') return { file: path.join(opencodeHome(), 'plugins', 'debate.js'), events: { 'tool.execute.before': [{ command: cmd('tool.execute.before') }] } };
  throw usage(`--agent must be one of ${AGENTS.join('|')}`);
}

/** Merge our entries into a host hook document, replacing earlier debate entries for that agent. Idempotent. */
export function mergeHooks(agent, doc, entries) {
  const out = JSON.parse(JSON.stringify(doc || {}));
  const ours = (command) => typeof command === 'string' && command.includes(marker(agent));
  out.hooks = out.hooks && typeof out.hooks === 'object' ? out.hooks : {};
  if (agent === 'cursor') {
    out.version = out.version ?? 1;
    for (const [event, list] of Object.entries(entries.events)) {
      out.hooks[event] = [...(out.hooks[event] || []).filter(h => !ours(h.command)), ...list.map(({ command }) => ({ command }))];
    }
    return out;
  }
  for (const [event, groups] of Object.entries(out.hooks)) {
    if (!Array.isArray(groups)) continue;
    out.hooks[event] = groups.map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !ours(h.command)) })).filter(g => g.hooks.length);
  }
  for (const [event, list] of Object.entries(entries.events)) {
    out.hooks[event] = [...(out.hooks[event] || []), ...list.map(({ matcher, command }) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT }] }))];
  }
  if (entries.allow) {
    out.permissions = out.permissions && typeof out.permissions === 'object' ? out.permissions : {};
    out.permissions.allow = [...new Set([...(out.permissions.allow || []), ...entries.allow])];
  }
  return out;
}

export function opencodePlugin(cli) {
  return `// Generated by: node ${JSON.stringify(cli)} setup hooks --agent opencode
// Runs:${hookCommand(cli, 'opencode', 'tool.execute.before')}
// Experimental debate Git gate: blocks a bash call the hook denies. Fails open when the hook cannot run.
import { spawnSync } from 'node:child_process';

const CLI = ${JSON.stringify(cli)};

export const DebateGitGate = async ({ directory }) => ({
  'tool.execute.before': async (input, output) => {
    if (input.tool !== 'bash') return;
    const payload = JSON.stringify({ sessionID: input.sessionID, directory, tool: input.tool, args: output.args });
    const r = spawnSync('node', [CLI, 'hook', 'opencode', 'tool.execute.before'], { input: payload, encoding: 'utf8', timeout: ${HOOK_TIMEOUT * 1000} });
    let decision = null;
    try { decision = JSON.parse(r.stdout); } catch { decision = null; }
    if (decision && decision.deny) throw new Error(decision.reason);
  },
});
`;
}

function hooksCommand(flags, ask = null) {
  if (!AGENTS.includes(flags.agent)) throw usage(`--agent must be one of ${AGENTS.join('|')}`);
  const agent = flags.agent;
  const cli = invokedCli();
  const real = realCli(cli);
  const entries = hookEntries(agent, cli);
  const out = process.stdout;
  out.write(`agent: ${agent}${['cursor', 'opencode'].includes(agent) ? ' (experimental: Git commit/push gate only)' : ''}\nentrypoint as invoked: ${cli}\n`);
  if (real !== cli) out.write(`realpath: ${real} (allowlists match literally; the hook commands use the invoked path)\n`);
  out.write(`file: ${entries.file}\n`);
  let before = '';
  let after;
  if (agent === 'opencode') {
    if (fs.existsSync(entries.file)) {
      before = fs.readFileSync(entries.file, 'utf8');
      if (!before.includes(marker(agent))) throw usage(`${entries.file} exists and was not generated by debate setup; move it aside first`);
    }
    after = opencodePlugin(cli);
  } else {
    const doc = readJsonFile(entries.file);
    before = doc ? `${JSON.stringify(doc, null, 2)}\n` : '';
    after = `${JSON.stringify(mergeHooks(agent, doc, entries), null, 2)}\n`;
  }
  // With --write the diff below shows the same entries, so print them only on a dry run.
  if (!flags.write) out.write(`\nentries:\n${agent === 'opencode' ? after : JSON.stringify(mergeHooks(agent, {}, entries), null, 2)}\n`);
  if (entries.allow && !flags.write) out.write(`\npermission allowlist (settings.json permissions.allow):\n${entries.allow.map(a => `  ${a}`).join('\n')}\n`);
  if (agent === 'codex') {
    out.write(`\nAdd to ${path.join(codexHome(), 'config.toml')} yourself (setup never edits TOML):\n[features]\nhooks = true\n\n[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(debateHome())}]\n`);
    out.write('Codex asks you to trust new or changed hook definitions on the next interactive start; review and accept them there.\n');
  }
  if (flags.write) confirmAndWrite(entries.file, before, after, undefined, ask);
  else out.write('\ndry run: add --write in your own terminal to merge, then restart the agent\n');
  return 0;
}

// ---------- doctor ----------

/** Check the effective reviewers without writing settings or launching a reviewer. */
export async function reviewerReadiness(cwd, { globalConfig, seats = AGENTS } = {}) {
  let config;
  try {
    config = loadLaneConfig(cwd);
    if (globalConfig !== undefined) {
      const api = await delegateConfig();
      const parsed = api.parseConfigDocument(JSON.stringify(globalConfig), 'proposed reviewer settings');
      if (!parsed.ok) throw new Error(parsed.error);
      config.lanes = {
        ...Object.fromEntries(Object.entries(parsed.document.lanes).map(([name, entry]) => [name, { ...entry, source: 'global' }])),
        ...Object.fromEntries(Object.entries(config.lanes).filter(([, entry]) => entry.source === 'project')),
      };
    }
  } catch (error) {
    return { ok: false, lanes: {}, checks: [{ lane: 'configuration', ok: false, error: error.message }] };
  }
  const names = new Set([
    ...seats.map(seat => Object.hasOwn(config.lanes, `${PLAN_LANES.main}-${seat}`) ? `${PLAN_LANES.main}-${seat}` : PLAN_LANES.main),
    PLAN_LANES.debate, ...CODE_REVIEW_LANES,
  ]);
  const checks = [...names].map(lane => {
    const entry = config.lanes[lane];
    try {
      resolveReviewOverride(cwd, lane, { globalOnly: CODE_REVIEW_LANES.includes(lane), config });
      if (!onPath(entry.implementer)) throw new Error(`reviewer lane ${lane}: ${entry.implementer} is not on PATH; install it or choose another reviewer`);
      return { lane, entry, ok: true };
    } catch (error) { return { lane, entry, ok: false, error: error.message }; }
  });
  return { ok: checks.every(check => check.ok), lanes: config.lanes, checks };
}

async function doctorCommand(flags) {
  if (flags.agent !== undefined && !AGENTS.includes(flags.agent)) throw usage(`--agent must be one of ${AGENTS.join('|')}`);
  const seats = flags.agent ? [flags.agent] : AGENTS;
  const cwd = path.resolve(flags.cwd || process.cwd());
  const rows = [];
  const add = (level, what, detail) => rows.push({ level, what, detail });
  add('ok', 'cross-debate', skillVersion());
  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 18 ? 'ok' : 'fail', 'node', `${process.versions.node}${major >= 18 ? '' : ' (need 18+)'}`);
  const gitv = spawnSync('git', ['--version'], { encoding: 'utf8' });
  add(gitv.status === 0 ? 'ok' : 'fail', 'git', gitv.status === 0 ? gitv.stdout.trim() : 'not found');
  const gh = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' });
  add(gh.status === 0 ? 'ok' : 'warn', 'gh', gh.error ? 'not installed (needed for PR review and approve-delete)' : gh.status === 0 ? 'authenticated' : 'not authenticated (needed for PR review and approve-delete)');
  const roots = skillRoots();
  add('ok', 'delegate-skills roots', roots.join(', '));
  for (const [skill, script] of [['delegate-setup', 'config.mjs'], ...REVIEWER_CLIS.map(c => [`${c}-delegate`, 'relay.mjs'])]) {
    try {
      const file = findScript(skill, script);
      add('ok', `${skill}/${script}`, `${file}${file.startsWith(VENDOR_SKILLS_DIR) ? ' (bundled)' : ' (DELEGATE_SKILLS_DIR override)'}`);
    } catch (e) { add('fail', `${skill}/${script}`, e.message); }
  }
  const available = REVIEWER_CLIS.filter(onPath);
  add(available.length ? 'ok' : 'fail', 'reviewer CLIs', available.join(', ') || 'none on PATH');
  const scope = repositoryScope(cwd);
  add(scope.warnings.length ? 'warn' : 'ok', 'automatic reviews', !scope.identity ? 'off: not a Git repository' : scope.warnings.length ? scope.warnings.join('; ') : scope.enabled ? `on: ${scope.configured === null ? 'Git default' : 'explicitly enabled'}${scope.effective ? '' : ' (session off)'}` : 'off: explicit project opt-out');
  const { lanes, checks } = await reviewerReadiness(cwd, { seats });
  for (const { lane, entry, ok, error } of checks) {
    const binding = entry ? `${entry.implementer} ${entry.model || '(CLI default model)'}${entry.effort ? ` effort=${entry.effort}` : ''}${entry.variant ? ` variant=${entry.variant}` : ''} (${entry.source})` : '';
    add(ok ? 'ok' : 'fail', `lane ${lane}`, ok ? binding : [binding, error].filter(Boolean).join(': '));
  }
  if (checks.some(check => !check.ok)) add('warn', 'repair reviewers', 'run npx --yes github:ahmed-hassan19/cross-debate in your own terminal; inspect project overrides and their trust if reported above');
  for (const line of seatPairs(lanes, seats)) add(line.includes('limited model diversity') ? 'warn' : 'ok', 'plan pairing', line);
  if (lanes['review-main'] && lanes['review-debate'] && lanes['review-main'].implementer === lanes['review-debate'].implementer
    && lanes['review-main'].model === lanes['review-debate'].model) add('warn', 'code pairing', 'supported; identical CLI/model choices limit reviewer diversity');
  add('warn', 'reviewer sign-in', 'unverified; sign in using each configured CLI in your own terminal (doctor does not launch reviewers)');
  const writable = probeWritable(debateHome());
  add(writable ? 'fail' : 'ok', 'DEBATE_HOME', writable || debateHome());
  for (const agent of seats) {
    const { file } = hookEntries(agent, invokedCli());
    let present = false;
    // JSON settings escape the quote inside the marker; the OpenCode plugin file stores it raw.
    try { const text = fs.readFileSync(file, 'utf8'); present = text.includes(marker(agent)) || text.includes(JSON.stringify(marker(agent)).slice(1, -1)); } catch { present = false; }
    add(present ? 'ok' : 'warn', `hooks ${agent}`, present ? `definition marker found in ${file}; execution and native trust unverified` : `not installed (${file}); in your terminal: node ${JSON.stringify(invokedCli())} setup hooks --agent ${agent} --write`);
    if (agent === 'codex') add('warn', 'Codex manual check', `doctor does not parse config.toml or verify native trust. In ${path.join(codexHome(), 'config.toml')}, ensure features.hooks = true and sandbox_workspace_write.writable_roots includes ${JSON.stringify(debateHome())}, preserving existing roots. Restart Codex and review/trust the hooks when prompted.`);
  }
  const mark = { ok: '✓', warn: '!', fail: '✗' };
  for (const r of rows) process.stdout.write(`${mark[r.level]} ${r.what}: ${r.detail}\n`);
  const count = (level) => rows.filter(r => r.level === level).length;
  process.stdout.write(`${count('ok')} ok, ${count('warn')} warnings, ${count('fail')} failures\n`);
  return rows.some(r => r.level === 'fail') ? 1 : 0;
}

// ---------- init ----------

const OPTIONAL_SKILLS = ['ponytail', 'babysit-pr'];

/** Where each optional skill is installed, or null. Reads only plugin manifests and skill directories. */
export function detectOptional(env = process.env) {
  const home = env.HOME || os.homedir();
  const claude = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const codex = env.CODEX_HOME || path.join(home, '.codex');
  const skillDir = (name) => [path.join(home, '.agents', 'skills'), path.join(claude, 'skills'), path.join(codex, 'skills')]
    .map(root => path.join(root, name)).find(dir => fs.existsSync(path.join(dir, 'SKILL.md'))) ?? null;
  let claudePlugin = null;
  try {
    const manifest = path.join(claude, 'plugins', 'installed_plugins.json');
    if (Object.keys(JSON.parse(fs.readFileSync(manifest, 'utf8')).plugins || {}).some(k => k.startsWith('ponytail@'))) claudePlugin = manifest;
  } catch { claudePlugin = null; }
  const codexCache = path.join(codex, 'plugins', 'cache', 'ponytail');
  return {
    ponytail: claudePlugin ?? (fs.existsSync(codexCache) ? codexCache : null) ?? skillDir('ponytail-review'),
    'babysit-pr': skillDir('babysit-pr'),
  };
}

/** Install commands per optional skill, for the hosts on PATH. Upstream READMEs: DietrichGebert/ponytail, amElnagdy/review-skills. */
export function installCommands(skill, available) {
  if (skill === 'babysit-pr') return [{ host: 'skills', argv: [['npx', 'skills', 'add', 'amElnagdy/review-skills', '--skill', 'babysit-pr', '-g']] }];
  return [
    ...(available.includes('claude') ? [{ host: 'Claude Code', argv: [['claude', 'plugin', 'marketplace', 'add', 'DietrichGebert/ponytail'], ['claude', 'plugin', 'install', 'ponytail@ponytail']] }] : []),
    ...(available.includes('codex') ? [{ host: 'Codex', argv: [['codex', 'plugin', 'marketplace', 'add', 'DietrichGebert/ponytail'], ['codex', 'plugin', 'add', 'ponytail@ponytail']], note: 'run codex, open /hooks, and trust the two ponytail hooks' }] : []),
  ];
}

/** A lane from the wizard's answers. The same CLI keeps the lane's other dials; a different CLI starts clean. */
export function buildLane({ base = {}, implementer, model = 'default', dial = null, value = 'none' }) {
  const lane = base.implementer === implementer ? { ...base } : { implementer };
  if (model === 'default') delete lane.model; else lane.model = model;
  if (dial) { if (value === 'none') delete lane[dial]; else lane[dial] = value; }
  return lane;
}

const describeLane = (lane) => [lane.implementer, lane.model ?? 'default model', lane.effort ?? lane.variant].filter(Boolean).join(' ');

async function fleetStep(ask, available) {
  const config = await delegateConfig();
  const impls = await import(pathToFileURL(findScript('delegate-setup', 'implementers.mjs')).href);
  const efforts = { claude: impls.CLAUDE_EFFORT, agy: impls.AGY_EFFORT, copilot: impls.COPILOT_EFFORT, omp: impls.OMP_THINKING };
  const file = config.globalConfigPath();
  const current = config.readConfigFile(file)?.document ?? { version: 'delegate-fleet.v1', lanes: {} };
  const proposal = proposeLanes(available, {});
  const out = process.stdout;
  const catalogs = new Map();
  out.write(`\nReviewer lanes (config ${file})\n`);
  const names = [PLAN_LANES.main, PLAN_LANES.debate, ...CODE_REVIEW_LANES];
  const seatLanes = available.map(s => `${PLAN_LANES.main}-${s}`);
  const perHost = available.length > 1 && confirm(ask, 'Give each host its own first plan reviewer (plan-main-<host>, overriding plan-main)?', true);
  if (perHost) names.push(...seatLanes);
  const checkLane = (name, lane) => {
    const parsed = config.parseConfigDocument(JSON.stringify({ version: current.version, lanes: { [name]: lane } }), 'lane');
    return parsed.ok ? null : parsed.error.replace(/^lane: /, '');
  };
  const bases = Object.fromEntries(names.map(name => [name, Object.hasOwn(current.lanes, name) ? current.lanes[name]
    : (proposal.lanes[name] ?? { implementer: proposal.templates[name]?.implementer ?? available[0] })]));
  out.write(`\n${Object.hasOwn(current.lanes, PLAN_LANES.main) ? 'Current' : 'Proposed'} lanes:\n`);
  for (const name of names) out.write(`  ${name.padEnd(20)} ${describeLane(bases[name])}${checkLane(name, bases[name]) ? '  (needs a model)' : ''}\n`);
  if (perHost) out.write(`plan-main is only the fallback: each plan-main-<host> lane overrides it for that host.\n`);
  const changeAll = confirm(ask, 'Change any of these?');
  const chosen = {};
  for (const name of names) {
    const base = bases[name];
    if (!changeAll && !checkLane(name, base)) { chosen[name] = base; continue; }
    out.write('\n');
    const implementer = pick(ask, `${name} CLI`, { choices: [...new Set([...available, base.implementer])], def: base.implementer });
    const kept = implementer === base.implementer ? base : {};
    let model;
    if (implementer === 'opencode') model = pick(ask, `${name} model (provider/model)`, {
      def: kept.model ?? '', free: true,
      check: m => /^[^/\s]+\/\S+$/.test(m) ? checkLane(name, buildLane({ base: kept, implementer, model: m })) : 'enter provider/model',
    });
    else {
      if (!catalogs.has(implementer)) catalogs.set(implementer, await discoverModelCatalog(implementer));
      const choices = modelMenu(implementer, catalogs.get(implementer), kept.model).map(option => option.value === 'default' ? 'CLI default' : option.value === 'other' ? 'Enter another model' : option.value);
      const selected = pick(ask, `${name} model (catalog suggestions; access not verified)`, {
        choices, def: kept.model ?? 'CLI default',
      });
      model = selected === 'CLI default' ? 'default' : selected === 'Enter another model'
        ? pick(ask, `${name} model ID`, { free: true, check: m => checkLane(name, buildLane({ base: kept, implementer, model: m })) })
        : selected;
    }
    const supports = impls.IMPLEMENTER_BY_KEY[implementer]?.supports ?? [];
    const dial = supports.includes('effort') ? 'effort' : supports.includes('variant') ? 'variant' : null;
    let value = 'none';
    if (dial) {
      const choices = [...(efforts[implementer] ?? []), 'none'];
      value = pick(ask, `${name} ${dial}${efforts[implementer] ? '' : ` (type a value ${implementer} accepts, or none for its default)`}`, {
        choices, def: kept[dial] ?? 'none', free: !efforts[implementer],
        check: v => checkLane(name, buildLane({ base: kept, implementer, model, dial, value: v })),
      });
    }
    chosen[name] = buildLane({ base, implementer, model, dial, value });
  }
  const merged = { ...current, lanes: { ...current.lanes, ...chosen } };
  const parsed = config.parseConfigDocument(JSON.stringify(merged), 'proposed config');
  if (!parsed.ok) throw usage(parsed.error);
  out.write('\n');
  for (const w of proposal.warnings) out.write(`warning: ${w}\n`);
  for (const line of seatPairs(merged.lanes, available)) out.write(`${line}\n`);
  const changes = Object.entries(chosen).flatMap(([name, lane]) => {
    const old = Object.hasOwn(current.lanes, name) ? current.lanes[name] : null;
    if (!old) return [`  + ${name}: ${describeLane(lane)}`];
    return JSON.stringify(old) === JSON.stringify(lane) ? [] : [`  ~ ${name}: ${describeLane(old)} -> ${describeLane(lane)}`];
  });
  if (!changes.length && fs.existsSync(file)) { out.write('lanes unchanged; nothing to write\n'); return; }
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  confirmAndWrite(file, before, `${JSON.stringify(parsed.document, null, 2)}\n`, (f) => config.writeAtomic(f, parsed.document), ask, changes.join('\n'));
}

function optionalStep(ask, available, runner) {
  const out = process.stdout;
  const found = detectOptional();
  out.write('\nOptional skills:\n');
  for (const skill of OPTIONAL_SKILLS) out.write(`  ${skill}: ${found[skill] ? `installed (${found[skill]})` : 'missing'}\n`);
  for (const skill of OPTIONAL_SKILLS.filter(s => !found[s])) {
    const targets = installCommands(skill, available);
    if (!targets.length) { out.write(`  ${skill}: needs claude or codex on PATH to install; skipped\n`); continue; }
    if (!confirm(ask, `Install ${skill}?`)) continue;
    for (const { host, argv, note } of targets) {
      const failed = argv.find(cmd => { out.write(`$ ${cmd.join(' ')}\n`); return runner(cmd) !== 0; });
      if (failed) out.write(`  failed: ${failed.join(' ')}; run it yourself later\n`);
      else out.write(`  ${skill} installed for ${host}${note ? `; ${note}` : ''}\n`);
    }
  }
}

const defaultRunner = (argv) => spawnSync(argv[0], argv.slice(1), { stdio: 'inherit' }).status;

/** The first-run wizard. ask and runner are injected so tests can script it; production needs a terminal. */
export async function runInit({ ask = terminalAsk, runner = defaultRunner } = {}) {
  const out = process.stdout;
  const available = REVIEWER_CLIS.filter(onPath);
  // Read before discovery: probing a CLI can create its home folder.
  const homes = { claude: claudeHome(), codex: codexHome(), cursor: path.join(os.homedir(), '.cursor'), opencode: opencodeHome() };
  const bins = { claude: 'claude', codex: 'codex', cursor: 'cursor-agent', opencode: 'opencode' };
  const agents = AGENTS.filter(a => fs.existsSync(homes[a]) || onPath(bins[a]));
  out.write(`debate setup. Reviewer CLIs on PATH: ${available.join(', ') || 'none'}\n`);
  if (!available.length) out.write(`no reviewer CLI found (${REVIEWER_CLIS.join(', ')}); install one and rerun init to configure lanes\n`);
  else if (confirm(ask, 'Configure reviewer lanes?', true)) {
    await fleetStep(ask, available);
  }
  for (const agent of agents) {
    out.write('\n');
    if (!confirm(ask, `Install hooks for ${agent}?`, true)) continue;
    try { hooksCommand({ agent, write: true }, ask); out.write(`if the hooks were written, restart ${agent} to load them\n`); } catch (e) { out.write(`hooks for ${agent} skipped: ${e.message}\n`); }
  }
  optionalStep(ask, available, runner);
  out.write('\nInstall check:\n');
  return doctorCommand({});
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  const { flags } = parseArgs(rest, { booleans: ['write'], values: ['agent', 'opencodeModel', 'cwd'] });
  if (!cmd || cmd === '--help' || cmd === '-h' || flags.help) { process.stdout.write(HELP); return cmd ? 0 : 2; }
  if (cmd === 'init') { requireTty('setup init'); return runInit(); }
  if (cmd === 'lanes') return lanesCommand(flags);
  if (cmd === 'hooks') return hooksCommand(flags);
  if (cmd === 'doctor') return doctorCommand(flags);
  throw usage(`unknown setup command ${cmd}`);
}
