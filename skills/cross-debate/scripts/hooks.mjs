// hooks.mjs — `debate.mjs hook <agent> <event>`: one dispatcher for every host's hooks (JSON payload on stdin).
// Host adapters normalize each payload and render each decision in that host's own output format.
// Never launches a reviewer, never returns an allow decision, fails open on errors/timeouts with a stderr note.
// Guardrail, not a security boundary. Importing this module has no side effects.

import fs from 'node:fs';
import path from 'node:path';
import {
  SESSION_RE, SHELLS, SKILL_DIR, usage, nowIso, log, newEventId, debateHome, ensureHome, automationOff, readStdin, cliCommand,
  loadRun, loadSession, updateSession, loadLedger, updateLedger, auditEvent, sessionKey, repoIdentity, headSha, emptyTreeSha, branchOf,
  startFingerprint, porcelainStatus, splitPlan, planPathFromTranscript, extractProposedPlan, gitGateDecision, isPidAlive,
  repositoryScope, worktreeRoots, treeOf, git,
} from './lib/common.mjs';
import { checkReceipt } from './plan.mjs';

const PLAN_GUIDE = path.join(SKILL_DIR, 'references', 'plan.md');
const CODE_GUIDE = path.join(SKILL_DIR, 'references', 'code.md');
const plan = (args) => cliCommand(`plan ${args}`);
const code = (args) => cliCommand(`code ${args}`);
const DEADLINE_MS = 8000;
const TERMINAL = new Set(['passed', 'waived']);

// ---------- host adapters ----------
// parse(payload) → { sessionId, cwd, permissionMode, tool: 'shell'|'exit_plan'|null, command, toolCwd, transcriptPath,
// subagent, stopHookActive, lastMessage }. render(event, { kind: 'deny'|'block'|'context', text }) → host output.

function commandFromToolInput(input) {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return null;
  const c = input.command;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.every(x => typeof x === 'string')) {
    if (c.length >= 3 && SHELLS.has(path.basename(c[0])) && /^-l?c$/.test(c[1])) return c[2];
    return c.map(x => (/[\s'"$`\;&|<>()]/.test(x) ? `'${x.replace(/'/g, "'\\''")}'` : x)).join(' ');
  }
  return null;
}
const str = (v) => (typeof v === 'string' && v ? v : null);
function agentParse(payload, subagent) {
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const tool = payload.tool_name === 'Bash' ? 'shell' : payload.tool_name === 'ExitPlanMode' ? 'exit_plan' : null;
  return {
    sessionId: payload.session_id, cwd: str(payload.cwd), permissionMode: payload.permission_mode ?? null, tool,
    command: tool === 'shell' ? commandFromToolInput(payload.tool_input) : null, toolCwd: str(input.cwd) || str(input.workdir),
    transcriptPath: str(payload.transcript_path), subagent, stopHookActive: Boolean(payload.stop_hook_active),
    lastMessage: payload.last_assistant_message ?? null,
  };
}
function agentRender(event, { kind, text }) {
  if (kind === 'deny') return { hookSpecificOutput: { hookEventName: event, permissionDecision: 'deny', permissionDecisionReason: text } };
  if (kind === 'block') return { decision: 'block', reason: text };
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}
const AGENT_EVENTS = { SessionStart: 'SessionStart', UserPromptSubmit: 'UserPromptSubmit', PreToolUse: 'PreToolUse', Stop: 'Stop' };
const denyOnly = (render) => (event, result) => (result.kind === 'deny' ? render(result.text) : null);
/** planGate: where a finished plan is enforced ('tool' = ExitPlanMode, 'stop' = the final proposed_plan). */
export const HOSTS = {
  claude: { events: AGENT_EVENTS, planGate: 'tool', remindAlways: false, parse: p => agentParse(p, Boolean(p.agent_id || p.agent_type)), render: agentRender },
  codex: { events: AGENT_EVENTS, planGate: 'stop', remindAlways: true, parse: p => agentParse(p, Boolean(p.subagent)), render: agentRender },
  // Experimental: the Git commit/push gate only.
  cursor: {
    events: { beforeShellExecution: 'PreToolUse' }, planGate: null, remindAlways: false,
    parse: p => ({ sessionId: p.conversation_id, cwd: str(p.cwd) || str(p.workspace_roots?.[0]), permissionMode: null, tool: 'shell', command: str(p.command), toolCwd: str(p.cwd), transcriptPath: null, subagent: false, stopHookActive: false, lastMessage: null }),
    render: denyOnly(text => ({ permission: 'deny', user_message: text, agent_message: text })),
  },
  // Experimental: the Git commit/push gate only. The generated plugin forwards { sessionID, directory, tool, args } and throws on deny.
  opencode: {
    events: { 'tool.execute.before': 'PreToolUse' }, planGate: null, remindAlways: false,
    parse: p => ({ sessionId: p.sessionID, cwd: str(p.directory), permissionMode: null, tool: p.tool === 'bash' ? 'shell' : null, command: commandFromToolInput(p.args), toolCwd: str(p.args?.workdir), transcriptPath: null, subagent: false, stopHookActive: false, lastMessage: null }),
    render: denyOnly(text => ({ deny: true, reason: text })),
  },
};
const deny = (text) => ({ kind: 'deny', text });
const block = (text) => ({ kind: 'block', text });
const context = (text) => ({ kind: 'context', text });

// ---------- event handlers ----------

function onSessionStart({ seat, sessionId, cwd, input, home, gitOpts }) {
  updateSession(home, seat, sessionId, (s) => { s.transcriptPath = input.transcriptPath || s.transcriptPath; s.cwd = cwd; return s; });
  if (!repositoryScope(cwd, { home, ...gitOpts }).effective) return { output: null, note: 'outside automatic scope' };
  const identity = repoIdentity(cwd, gitOpts);
  if (!identity) return { output: null, note: 'not a repository' };
  const key = sessionKey(seat, sessionId);
  let recorded = false;
  updateLedger(home, identity, (l) => {
    if (l.baselines[key]) return l;
    const head = headSha(identity.worktreeRoot, gitOpts);
    l.baselines[key] = { seat, sessionId, headSha: head || emptyTreeSha(identity.worktreeRoot), branch: branchOf(identity.worktreeRoot, gitOpts), startFingerprint: startFingerprint(identity.worktreeRoot, gitOpts), at: nowIso(), source: 'session_start', reason: null, runId: null, eventId: newEventId() };
    recorded = true;
    return l;
  });
  return { output: null, note: recorded ? 'baseline recorded' : 'baseline already present' };
}
function planReminder(host, seat, sessionId, cwd) {
  return `debate-plan: this session is in plan mode. Before presenting the final plan${host.planGate === 'tool' ? ' (ExitPlanMode is gated)' : ' (the final proposed_plan is gated at Stop)'}, cross-review it with two reviewer lanes by following ${PLAN_GUIDE}. Seat: ${seat}. Session ID: ${sessionId}. cwd: ${cwd}. Command: ${plan('<subcommand>')}.`;
}
function codeReminder(seat, sessionId, cwd, active) {
  return `debate-code: before reporting implementation complete, review the local candidate commit by following ${CODE_GUIDE}. Seat: ${seat}. Session ID: ${sessionId}. cwd: ${cwd}.${active ? ` This session owns active candidate run ${active.runId} (base ${active.baseSha.slice(0, 12)}); corrections must amend that candidate.` : ''} Command: ${code('<subcommand>')}. Never push without explicit user approval.`;
}
function onUserPromptSubmit({ host, seat, sessionId, cwd, input, home, gitOpts }) {
  const session = updateSession(home, seat, sessionId, (s) => { s.generation += 1; s.transcriptPath = input.transcriptPath || s.transcriptPath; s.cwd = cwd; return s; });
  if (!repositoryScope(cwd, { home, ...gitOpts }).effective) return { output: null, note: 'outside automatic scope' };
  const key = sessionKey(seat, sessionId);
  const identity = repoIdentity(cwd, gitOpts);
  let active = null;
  if (identity) {
    const ledger = updateLedger(home, identity, (l) => { l.deferrals = l.deferrals.filter(d => !(d.sessionKey === key && d.generation < session.generation)); return l; });
    if (ledger.active && ledger.active.sessionKey === key) active = ledger.active;
  }
  const planMode = input.permissionMode === 'plan';
  if (!host.remindAlways) {
    if (planMode) return { output: context(planReminder(host, seat, sessionId, cwd)), note: 'plan reminder' };
    if (active) return { output: context(codeReminder(seat, sessionId, cwd, active)), note: 'active candidate reminder' };
    return { output: null, note: 'no reminder' };
  }
  return { output: context(planMode ? planReminder(host, seat, sessionId, cwd) : codeReminder(seat, sessionId, cwd, active)), note: planMode ? 'plan instruction' : 'code instruction' };
}
function exitPlanGate({ seat, sessionId, cwd, input, home, now }) {
  if (input.permissionMode !== 'plan') return { output: null, note: 'not plan mode' };
  const session = loadSession(home, seat, sessionId);
  const generation = session ? session.generation : 0;
  const runs = session ? session.planRuns : [];
  const denial = (reason) => {
    return { output: deny(`debate-plan: ${reason}. Before ExitPlanMode: if this plan is unchanged and already finished, re-stamp with: ${plan('finish --run <run-id>')}; otherwise run review --new / verdict / finish as described in ${PLAN_GUIDE} (seat ${seat}, session ${sessionId}, cwd ${cwd}). Use DEBATE=off only for an explicit user opt-out.`), note: 'denied' };
  };
  if (!runs.length) return denial('no debate-plan run exists for this session');
  const transcriptPlan = planPathFromTranscript(input.transcriptPath);
  let lastReason = 'no finished run matched';
  for (const runId of [...runs].reverse()) {
    let run;
    try { run = loadRun(home, runId); } catch (e) { lastReason = e.message; continue; }
    const file = run.plan.sourcePath || transcriptPlan;
    if (transcriptPlan && run.plan.sourcePath && transcriptPlan !== run.plan.sourcePath) { lastReason = `run ${runId} reviewed ${run.plan.sourcePath}, the current plan file is ${transcriptPlan}`; continue; }
    if (!file) { lastReason = `run ${runId} has no registered plan file`; continue; }
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { lastReason = `cannot read ${file}: ${e.message}`; continue; }
    const check = checkReceipt(run, { seat, sessionId, generation, planText: text, now });
    if (check.ok) return { output: null, note: check.warning ? `receipt ok with warning: ${check.warning}` : `receipt ok for run ${runId}` };
    lastReason = check.reason;
  }
  return denial(lastReason);
}
function onPreToolUse(ctx) {
  const { host, input, cwd, home, gitOpts } = ctx;
  if (host.planGate === 'tool' && input.tool === 'exit_plan') return repositoryScope(cwd, { home, ...gitOpts }).effective ? exitPlanGate(ctx) : { output: null, note: 'outside automatic scope' };
  if (input.tool !== 'shell') return { output: null, note: 'not a shell tool' };
  if (!input.command) return { output: null, note: 'no command' };
  const decision = gitGateDecision({ command: input.command, cwd: input.toolCwd || cwd, home, gitOpts });
  if (decision.decision === 'deny') return { output: deny(decision.reason), note: 'denied' };
  return { output: null, note: decision.approvalId ? `push permitted under approval ${decision.approvalId}` : 'pass' };
}
function planStopGate({ seat, sessionId, input, home, now }) {
  const once = (reason) => (input.stopHookActive ? { output: null, note: `already blocked once: ${reason}` } : { output: block(`debate-plan: ${reason}. Finish the plan with ${plan('finish --run <run-id> --plan -')} (see ${PLAN_GUIDE}) and emit the finished body with its review block inside proposed_plan.`), note: 'blocked' });
  const extracted = extractProposedPlan(input.lastMessage);
  if (extracted.error) return once(extracted.error);
  if (extracted.body === null) return { output: null, note: 'no proposed_plan in the final message' };
  const split = splitPlan(extracted.body);
  if (split.error) return once(split.error);
  if (!split.block) return once('the proposed plan carries no debate-plan review block');
  let run;
  try { run = loadRun(home, split.block.runId); } catch (e) { return once(`unknown run ${split.block.runId}`); }
  const session = loadSession(home, seat, sessionId);
  const check = checkReceipt(run, { seat, sessionId, generation: session ? session.generation : 0, planText: extracted.body, now });
  if (!check.ok) return once(check.reason);
  return { output: null, note: check.warning ? `receipt ok with warning: ${check.warning}` : 'receipt ok' };
}
/** Terminal receipts from the ledgers of every worktree of the repository; a reviewed commit may have been promoted from a linked worktree. Never throws. */
function repositoryReceipts(home, root, gitOpts) {
  let roots;
  try { roots = worktreeRoots(root, gitOpts); } catch { roots = [root]; }
  const receipts = [];
  for (const wt of roots) {
    try {
      const identity = repoIdentity(wt, gitOpts);
      const ledger = identity && loadLedger(home, identity.repoKey);
      if (ledger) receipts.push(...ledger.receipts.filter(r => TERMINAL.has(r.outcome)));
    } catch { /* an unreadable worktree or ledger contributes no receipts */ }
  }
  return receipts;
}

/** Give the Stop hook lifecycle-aware guidance for the active code candidate. */
function activeCodeRunHint(home, active, sessionKeyValue, head) {
  if (!active || !active.runId) return null;
  let run;
  try { run = loadRun(home, active.runId); } catch { return null; }
  if (!run || run.kind !== 'code') return null;
  const owner = active.sessionKey === sessionKeyValue ? 'this session' : `session ${run.sessionId}`;
  const round = run.rounds?.at(-1) || null;
  const attempt = round?.attempts?.at(-1) || null;
  const label = `active candidate run ${run.runId} (${owner})`;

  if (run.status === 'running' && attempt?.status === 'running') {
    if (isPidAlive(attempt.pid)) {
      return {
        reason: `${label} has a review attempt running in the background (round ${round.round}, attempt ${attempt.attempt}). Wait for that review to complete; do not start another review or use defer to bypass the active review.`,
        note: 'blocked: review running',
      };
    }
    return {
      reason: `${label} is marked as running, but its worker is no longer alive. Reap the result with ${code(`wait --run ${run.runId} --max-wait 1s`)}, then follow the recorded recovery state.`,
      note: 'blocked: review worker needs reaping',
    };
  }
  if (run.status === 'awaiting_verdict') {
    return {
      reason: `${label} has completed its review and is awaiting a verdict (round ${round?.round ?? '?'}). Record the verdict before finishing; do not start another review.`,
      note: 'blocked: verdict required',
    };
  }
  if (run.status === 'continue') {
    return {
      reason: `${label} requires its next review round. Amend the candidate if needed, then run review --run ${run.runId}; do not begin a second candidate.`,
      note: 'blocked: next review round required',
    };
  }
  if (run.status === 'stopped') {
    return {
      reason: `${label} has a completed review and verdict but no terminal receipt. Run finish --run ${run.runId} before reporting completion.`,
      note: 'blocked: finish required',
    };
  }
  return null;
}
/** Commits reachable from head but not from base nor any remote-tracking ref, each with parents and tree. Null when Git cannot answer. */
function unpublishedCommits(root, base, head, gitOpts) {
  try {
    const r = git(root, ['log', '--format=%H %P %T', `${base}..${head}`, '--not', '--remotes'], { ...gitOpts, allowFail: true });
    if (r.status !== 0) return null;
    return r.stdout.split('\n').filter(Boolean).map(line => { const parts = line.trim().split(/\s+/); return { sha: parts[0], tree: parts.at(-1), parents: parts.slice(1, -1) }; });
  } catch { return null; }
}
function codeStopGate({ seat, sessionId, cwd, input, home, gitOpts }) {
  const identity = repoIdentity(cwd, gitOpts);
  if (!identity) return { output: null, note: 'not a repository' };
  const root = identity.worktreeRoot;
  const key = sessionKey(seat, sessionId);
  const session = loadSession(home, seat, sessionId);
  const generation = session ? session.generation : 0;
  let ledger = loadLedger(home, identity.repoKey);
  if (ledger && ledger.deferrals.some(d => d.sessionKey === key && !d.consumed && d.generation === generation)) {
    let consumed = false;
    ledger = updateLedger(home, identity, (l) => {
      const d = l.deferrals.find(x => x.sessionKey === key && !x.consumed && x.generation === generation);
      if (d) { d.consumed = true; d.consumedAt = nowIso(); consumed = true; auditEvent(l, { type: 'deferral_consumed', seat, sessionId, generation, deferralEventId: d.eventId }); }
      return l;
    });
    if (consumed) return { output: null, note: 'deferral consumed' };
  }
  if (input.stopHookActive) return { output: null, note: 'stop_hook_active: already blocked this turn' };
  const head = headSha(root, gitOpts);
  if (!head) return { output: null, note: 'unborn HEAD' };
  const baseline = ledger && ledger.baselines[key];
  const deferHint = `If this turn is an unfinished checkpoint or a question, run: ${code(`defer --seat ${seat} --session ${sessionId} --cwd ${JSON.stringify(root)}`)} --reason "<why unfinished>"`;
  if (!baseline) {
    return { output: block(`debate-code: no session baseline is registered for ${root}. Register the before-change commit explicitly: ${code(`baseline --seat ${seat} --session ${sessionId} --cwd ${JSON.stringify(root)}`)} --base <before-change-sha> --reason "<basis>" (current HEAD ${head.slice(0, 12)} is acceptable only if nothing changed in this session). Then follow ${CODE_GUIDE} (begin/adopt → commit → review → verdict → finish). ${deferHint}`), note: 'blocked: no baseline' };
  }
  const fingerprint = startFingerprint(root, gitOpts);
  if (head === baseline.headSha && fingerprint === baseline.startFingerprint) return { output: null, note: 'nothing changed since the session baseline' };
  let dirty = [];
  try { dirty = porcelainStatus(root, gitOpts); } catch { dirty = [{ code: '??', path: '<status unavailable>' }]; }
  const clean = dirty.length === 0;
  // no diff against the baseline commit remains (e.g. pre-existing untracked files were since excluded): nothing to review
  if (clean && head === baseline.headSha) return { output: null, note: 'clean worktree at the session baseline HEAD' };
  // receipts are matched by commit or by tree across every worktree of the repository: a squash-merge or
  // fast-forward of a candidate reviewed in a linked worktree carries the same tree under a new commit
  const receipts = repositoryReceipts(home, root, gitOpts);
  const isReceipted = (sha, tree) => receipts.some(r => r.commitSha === sha || (tree && r.treeId === tree));
  let headTree = null;
  try { headTree = treeOf(root, head, gitOpts); } catch { headTree = null; }
  const receipted = isReceipted(head, headTree);
  if (clean && receipted) return { output: null, note: 'clean HEAD has a passed/waived receipt' };
  if (receipted) {
    // the commit is already certified; only the worktree differs, so a full re-review of the same tree is the wrong reflex
    const shown = dirty.slice(0, 5).map(e => `${(e.code || '??').trim() || '??'} ${e.path}`).join(', ');
    return { output: block(`debate-code: HEAD ${head.slice(0, 12)} already has a passed/waived receipt; only the worktree is dirty (${dirty.length} entr${dirty.length === 1 ? 'y' : 'ies'}: ${shown}). Remove or ignore generated artifacts, or commit intended changes as a new candidate (begin → commit → review → verdict → finish per ${CODE_GUIDE}); do not re-review the unchanged commit. ${deferHint}`), note: 'blocked: dirty worktree over a receipted HEAD' };
  }
  const moved = head !== baseline.headSha;
  if (clean && moved) {
    // promotion: a pull, merge, or checkout brought in only published commits, receipted commits, or merge commits.
    // Merge commits are trusted structurally; conflict edits inside one are not reviewed here.
    const since = unpublishedCommits(root, baseline.headSha, head, gitOpts);
    if (since && since.every(c => c.parents.length >= 2 || isReceipted(c.sha, c.tree))) return { output: null, note: 'HEAD moved by published, receipted, or merge commits only' };
  }
  const promotionHint = moved ? ` If HEAD moved because reviewed work was merged, pulled, or rebased (a promotion, not new work), register it: ${code(`baseline --seat ${seat} --session ${sessionId} --cwd ${JSON.stringify(root)}`)} --base ${head} --reason "promotion: <what was merged and where it was reviewed>"; never create a no-op candidate to re-review promoted work.` : '';
  const active = ledger.active;
  const activeHint = activeCodeRunHint(home, active, key, head);
  if (activeHint) return { output: block(`debate-code: ${activeHint.reason}`), note: activeHint.note };
  const activeNote = active ? (active.sessionKey === key ? ` Active candidate: run ${active.runId} (base ${active.baseSha.slice(0, 12)}); continue with review/verdict/finish.` : ` Note: run ${active.runId} (session ${active.sessionId}) owns this worktree's active candidate.`) : '';
  const untrackedOnly = !clean && dirty.every(e => e.code === '??');
  const untrackedHint = untrackedOnly ? ` Every dirty path is untracked: if they are local-only (e.g. CLAUDE.md, AGENTS.md) or generated, add them to .git/info/exclude instead of committing; never stage them just to clear this gate.` : '';
  return { output: block(`debate-code: work changed since the session baseline ${baseline.headSha.slice(0, 12)} and HEAD ${head.slice(0, 12)} has no passed/waived review receipt${clean ? '' : ' (worktree is dirty)'}.${untrackedHint} Follow ${CODE_GUIDE}: begin (or adopt) → git add -A → git commit → review → verdict → finish, with session ${sessionId} and cwd ${JSON.stringify(root)}.${activeNote}${promotionHint} ${deferHint}`), note: 'blocked: unreviewed changes' };
}
function onStop(ctx) {
  if (!repositoryScope(ctx.cwd, { home: ctx.home, ...ctx.gitOpts }).effective) return { output: null, note: 'outside automatic scope' };
  if (ctx.input.permissionMode === 'plan') return ctx.host.planGate === 'stop' ? planStopGate(ctx) : { output: null, note: 'plan mode: ExitPlanMode is the gate' };
  return codeStopGate(ctx);
}

/** Dispatch one hook event for a host. Returns { output, note }; output null means pass-through with no stdout. */
export function handleHook(agent, event, payload, { home = debateHome(), env = process.env, now = Date.now() } = {}) {
  const host = Object.hasOwn(HOSTS, agent) ? HOSTS[agent] : null;
  if (!host) throw usage(`agent must be one of ${Object.keys(HOSTS).join('|')}`);
  const internal = Object.hasOwn(host.events, event) ? host.events[event] : null;
  if (!internal) return { output: null, note: `unmapped event ${event}` };
  if (env.DEBATE_CHILD === '1') return { output: null, note: 'child session' };
  if (env.DEBATE === 'off' || automationOff(home)) return { output: null, note: 'automation off' };
  if (!payload || typeof payload !== 'object') return { output: null, note: 'no payload' };
  const input = host.parse(payload);
  if (input.subagent) return { output: null, note: 'subagent' };
  const { sessionId } = input;
  if (typeof sessionId !== 'string' || !SESSION_RE.test(sessionId)) return { output: null, note: 'payload has no valid session_id' };
  const cwd = input.cwd || process.cwd();
  const deadline = now + DEADLINE_MS;
  const gitOpts = { timeout: Math.max(500, deadline - Date.now()) };
  ensureHome(home);
  const ctx = { host, seat: agent, event: internal, sessionId, cwd, input, home, now, gitOpts };
  const handlers = { SessionStart: onSessionStart, UserPromptSubmit: onUserPromptSubmit, PreToolUse: onPreToolUse, Stop: onStop };
  const { output, note } = handlers[internal](ctx);
  return { output: output ? host.render(event, output) : null, note };
}

/** `hook <agent> <event>`: always exits 0 so a hook failure never blocks the host; errors pass with a stderr note. */
export function main(argv) {
  if (argv[0] === '--help' || argv[0] === '-h' || !argv.length) {
    process.stdout.write(`debate.mjs hook <${Object.keys(HOSTS).join('|')}> <event>  (JSON payload on stdin)\n`);
    return argv.length ? 0 : 2;
  }
  const [agent, event] = argv;
  let payload;
  try { payload = JSON.parse(readStdin() || '{}'); } catch (e) { log(`invalid payload JSON: ${e.message}; passing`); return 0; }
  try {
    const { output, note } = handleHook(agent, event, payload);
    if (note) log(`${agent} ${event}: ${note}`);
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (e) {
    log(`${agent} ${event}: hook error, passing: ${e && e.message ? e.message : e}`);
  }
  return 0;
}
