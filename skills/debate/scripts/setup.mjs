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
  loadLaneConfig, relaySupportsReadOnly, sleepMs,
} from './lib/common.mjs';

const HELP = `debate.mjs setup — configure reviewer lanes and host hooks, then check the install

Usage:
  setup init
  setup lanes [--opencode-model <provider/model>] [--write]
  setup hooks --agent claude|codex|cursor|opencode [--write]
  setup doctor [--cwd <dir>]

init walks you through reviewer lanes (CLI, model, effort), host hooks and the optional skills (ponytail,
babysit-pr), then runs doctor. Run it once after installing, in your own terminal.
lanes proposes only lanes missing from the global delegate-skills config (plan-main[-<seat>], plan-debate,
review-main, review-debate) for the reviewer CLIs on PATH. hooks prints the exact entries for one agent.
--write shows the change and asks y/N; it needs an interactive terminal and keeps a *.debate-bak backup.
Run setup through the same path your agent uses (the skill catalog path): permission allowlists match literally.
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
function confirmAndWrite(file, before, after, write = (f, text) => fs.writeFileSync(f, text), ask = null) {
  if (!ask) { requireTty(); ask = terminalAsk; }
  if (before === after) { process.stdout.write(`${file}: already up to date\n`); return false; }
  process.stdout.write(`\n${file}\n${lineDiff(before, after)}\n\n`);
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
  const warnings = order.length === 1 ? [`only ${order[0]} is available: both plan reviewers and both code reviewers use the same model, so the debate has no independent second opinion`] : [];
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
    return `seat ${seat}: plan reviewers ${primary ?? 'missing'} then ${secondary ?? 'missing'}${repeatsPrimary ? ' (same-model secondary: repeats the primary reviewer)' : secondary === seat ? ' (same-model secondary)' : ''}`;
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
  out.write(`\nentries:\n${agent === 'opencode' ? after : JSON.stringify(mergeHooks(agent, {}, entries), null, 2)}\n`);
  if (entries.allow) out.write(`\npermission allowlist (settings.json permissions.allow):\n${entries.allow.map(a => `  ${a}`).join('\n')}\n`);
  if (agent === 'codex') {
    out.write(`\nAdd to ${path.join(codexHome(), 'config.toml')} yourself (setup never edits TOML):\n[features]\nhooks = true\n\n[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(debateHome())}]\n`);
    out.write('Codex asks you to trust new or changed hook definitions on the next interactive start; review and accept them there.\n');
  }
  if (flags.write) confirmAndWrite(entries.file, before, after, undefined, ask);
  else out.write('\ndry run: add --write in your own terminal to merge, then restart the agent\n');
  return 0;
}

// ---------- doctor ----------

function doctorCommand(flags) {
  const rows = [];
  const add = (level, what, detail) => rows.push({ level, what, detail });
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
  add(available.length >= 2 ? 'ok' : available.length ? 'warn' : 'fail', 'reviewer CLIs', available.join(', ') || 'none on PATH');
  let lanes = {};
  try { lanes = loadLaneConfig(path.resolve(flags.cwd || process.cwd())).lanes; } catch (e) { add('fail', 'lane config', e.message); }
  for (const lane of [PLAN_LANES.main, PLAN_LANES.debate, ...CODE_REVIEW_LANES, ...available.map(s => `${PLAN_LANES.main}-${s}`)]) {
    const entry = lanes[lane];
    const optional = lane.startsWith(`${PLAN_LANES.main}-`);
    if (!entry) { add(optional ? 'ok' : 'fail', `lane ${lane}`, optional ? 'not set (uses plan-main)' : `missing; run node ${JSON.stringify(invokedCli())} setup init in your own terminal (or setup lanes)`); continue; }
    try {
      const readOnly = relaySupportsReadOnly(findScript(`${entry.implementer}-delegate`, 'relay.mjs'));
      add(readOnly ? 'ok' : 'fail', `lane ${lane}`, `${entry.implementer}${entry.model ? ` ${entry.model}` : ''} (${entry.source})${readOnly ? '' : ': relay lacks --read-only'}`);
    } catch (e) { add('fail', `lane ${lane}`, e.message); }
  }
  for (const line of seatPairs(lanes, available)) add(line.includes('same-model') ? 'warn' : 'ok', 'plan pairing', line);
  const writable = probeWritable(debateHome());
  add(writable ? 'fail' : 'ok', 'DEBATE_HOME', writable || debateHome());
  for (const agent of AGENTS) {
    const { file } = hookEntries(agent, invokedCli());
    let present = false;
    // JSON settings escape the quote inside the marker; the OpenCode plugin file stores it raw.
    try { const text = fs.readFileSync(file, 'utf8'); present = text.includes(marker(agent)) || text.includes(JSON.stringify(marker(agent)).slice(1, -1)); } catch { present = false; }
    add(present ? 'ok' : 'warn', `hooks ${agent}`, present ? file : `not installed (${file})`);
  }
  const mark = { ok: '✓', warn: '!', fail: '✗' };
  for (const r of rows) process.stdout.write(`${mark[r.level]} ${r.what}: ${r.detail}\n`);
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

/** Model ids per implementer from the bundled discover.mjs; any probe failure leaves the list empty. */
function discoverModels() {
  try {
    const r = spawnSync(process.execPath, [findScript('delegate-setup', 'discover.mjs')], { encoding: 'utf8', timeout: 60_000 });
    return Object.fromEntries(JSON.parse(r.stdout).discovered.map(d => [d.key, d.models?.values ?? []]));
  } catch { return {}; }
}

async function fleetStep(ask, available, models) {
  const config = await delegateConfig();
  const impls = await import(pathToFileURL(findScript('delegate-setup', 'implementers.mjs')).href);
  const efforts = { claude: impls.CLAUDE_EFFORT, agy: impls.AGY_EFFORT, copilot: impls.COPILOT_EFFORT, omp: impls.OMP_THINKING };
  const file = config.globalConfigPath();
  const current = config.readConfigFile(file)?.document ?? { version: 'delegate-fleet.v1', lanes: {} };
  const proposal = proposeLanes(available, {});
  const out = process.stdout;
  out.write(`\nReviewer lanes (config ${file}). Enter keeps the value in brackets.\n`);
  const names = [PLAN_LANES.main, PLAN_LANES.debate, ...CODE_REVIEW_LANES];
  const seatLanes = available.map(s => `${PLAN_LANES.main}-${s}`);
  if (available.length > 1 && confirm(ask, 'Different first plan reviewer per host?', true)) names.push(...seatLanes);
  const checkLane = (name, lane) => {
    const parsed = config.parseConfigDocument(JSON.stringify({ version: current.version, lanes: { [name]: lane } }), 'lane');
    return parsed.ok ? null : parsed.error.replace(/^lane: /, '');
  };
  const chosen = {};
  for (const name of names) {
    const base = Object.hasOwn(current.lanes, name) ? current.lanes[name] : (proposal.lanes[name] ?? { implementer: proposal.templates[name]?.implementer ?? available[0] });
    out.write('\n');
    const implementer = pick(ask, `${name} CLI`, { choices: [...new Set([...available, base.implementer])], def: base.implementer });
    const kept = implementer === base.implementer ? base : {};
    const listed = (models[implementer] ?? []).slice(0, 40);
    const model = pick(ask, `${name} model (number, name, or default)`, {
      choices: [...listed, 'default'], def: kept.model ?? 'default', free: true,
      check: m => checkLane(name, buildLane({ base: kept, implementer, model: m })),
    });
    const supports = impls.IMPLEMENTER_BY_KEY[implementer]?.supports ?? [];
    const dial = supports.includes('effort') ? 'effort' : supports.includes('variant') ? 'variant' : null;
    let value = 'none';
    if (dial) {
      const choices = [...(efforts[implementer] ?? []), 'none'];
      value = pick(ask, `${name} ${dial}${efforts[implementer] ? '' : ' (free text, or none)'}`, {
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
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  confirmAndWrite(file, before, `${JSON.stringify(parsed.document, null, 2)}\n`, (f) => config.writeAtomic(f, parsed.document), ask);
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
  // Read before discovery: probing a CLI can create its home, which would then look like an agent in use.
  const homes = { claude: claudeHome(), codex: codexHome(), cursor: path.join(os.homedir(), '.cursor'), opencode: opencodeHome() };
  const agents = AGENTS.filter(a => fs.existsSync(homes[a]));
  out.write(`debate setup. Reviewer CLIs on PATH: ${available.join(', ') || 'none'}\n`);
  if (!available.length) out.write(`no reviewer CLI found (${REVIEWER_CLIS.join(', ')}); install one and rerun init to configure lanes\n`);
  else if (confirm(ask, 'Configure reviewer lanes?', true)) await fleetStep(ask, available, discoverModels());
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
