#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as p from '@clack/prompts';
import { initSync, parse, edit } from '@rainbowatcher/toml-edit-js';
import { hookEntries, mergeHooks, opencodePlugin, buildLane, reviewerReadiness } from '../skills/cross-debate/scripts/setup.mjs';
import { SKILL_DIR, debateHome, repositoryScope, writeAtomic, skillVersion, shellQuote } from '../skills/cross-debate/scripts/lib/common.mjs';
import { globalConfigPath, parseConfigDocument } from '../skills/cross-debate/vendor/delegate-skills/delegate-setup/scripts/config.mjs';
import { CLAUDE_EFFORT } from '../skills/cross-debate/vendor/delegate-skills/delegate-setup/scripts/implementers.mjs';
import { discoverModelCatalog, modelMenu } from '../skills/cross-debate/scripts/lib/model-catalog.mjs';

const labels = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor (experimental)', opencode: 'OpenCode (experimental)' };
const reviewerCLIs = ['claude', 'codex', 'opencode'];
const requiredLanes = ['plan-main', 'plan-debate', 'review-main', 'review-debate'];
const installCommand = 'npx --yes github:ahmed-hassan19/cross-debate';
const anyOf = values => new Intl.ListFormat('en', { type: 'disjunction' }).format(values);
const shortLabel = cli => labels[cli].replace(' (experimental)', '');
// Lead = review-main + plan-debate; Challenger = review-debate + plan-main. Index matches the wizard's pair.
const roles = [
  { name: 'Lead reviewer', code: 'review-main', plan: 'plan-debate', effort: 'high',
    cli: 'Your most capable, deep-thinking model works best here.',
    about: [
      'Goes through your code changes and pull requests first and writes down every',
      'problem it finds. After the Challenger has pushed back, it takes a second look',
      'and makes the final call on which problems are real. On plans, it gives a',
      'second, independent opinion.',
      'Best fit: your most capable model, one built for deep thinking (a frontier or',
      '"reasoning" model), with high effort. This role does the most work.',
    ] },
  { name: 'Challenger', code: 'review-debate', plan: 'plan-main', effort: 'medium or high',
    cli: 'A different model family from the Lead works best here.',
    about: [
      'Plays the skeptic. It questions each of the Lead reviewer\'s findings, flags the',
      'weak ones, and points out problems the Lead missed. On plans, it gives the first',
      'independent opinion.',
      'Best fit: a capable model from a different family than the Lead, for example',
      'Codex if the Lead is Claude. A fresh perspective catches more than a bigger',
      'model. A lighter, faster model is fine if you want to save usage, but very small',
      'models tend to just agree.',
    ] },
];
const rolesNote = [
  'Cross Debate asks two AI reviewers to look over your work before your agent shows it',
  'to you. They run in the background, through CLIs you already have signed in.',
  ...roles.flatMap(role => ['', role.name, ...role.about.map(line => `  ${line}`)]),
  '',
  'Effort is how long a model thinks before it answers. Higher effort is more',
  'thorough but slower, and it uses more of your plan. Press Enter to keep the',
  'CLI\'s own default.',
  '',
  'Your agent then checks every claim against the actual code before acting on it.',
  'Agreement between the two reviewers is not treated as proof.',
].join('\n');
function dialMessage(role, implementer) {
  if (implementer === 'opencode') return `${role.name} variant: a provider-specific name from your OpenCode config (Enter for the default)`;
  const levels = implementer === 'claude' ? anyOf(CLAUDE_EFFORT) : `for example ${anyOf(['low', 'medium', 'high', 'xhigh'])}`;
  return `${role.name} effort: ${levels} (${role.effort} recommended; Enter for the CLI default)`;
}
function defaultLabel(complete, available) {
  if (complete) return 'Keep my current reviewers';
  const askModel = available.slice(0, 2).includes('opencode') ? ' OpenCode will ask for a model.' : '';
  if (available.length === 1) return `Use ${available[0]} for both roles (works, but two model families catch more).${askModel}`;
  const [lead, challenger] = available;
  return `Use ${lead} + ${challenger} with their default models. ${shortLabel(lead)} leads, ${shortLabel(challenger)} challenges.${askModel}`;
}
const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const stat = file => { try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const onPath = name => (process.env.PATH || '').split(path.delimiter).some(dir => {
  try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return true; } catch { return false; }
});
const installDir = () => path.join(os.homedir(), '.agents', 'skills', 'cross-debate');
function physicalPath(file) {
  try { return fs.realpathSync(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return path.join(physicalPath(path.dirname(file)), path.basename(file));
  }
}
const slot = file => path.join(physicalPath(path.dirname(file)), path.basename(file));
function hostHomes() {
  return {
    claude: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    codex: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    cursor: path.join(os.homedir(), '.cursor'),
    opencode: path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode'),
  };
}

export function mergeCodex(text, home) {
  initSync();
  const doc = parse(text);
  for (const key of ['features', 'sandbox_workspace_write']) {
    if (doc[key] !== undefined && !object(doc[key])) throw new Error(`Codex ${key} must be a table`);
  }
  const roots = doc.sandbox_workspace_write?.writable_roots;
  if (roots !== undefined && (!Array.isArray(roots) || roots.some(root => typeof root !== 'string'))) {
    throw new Error('Codex writable_roots must be an array of paths');
  }
  if (doc.features?.hooks !== true) text = edit(text, 'features.hooks', true);
  try {
    if (roots === undefined) text = edit(text, 'sandbox_workspace_write.writable_roots', [home]);
    else if (!roots.includes(home)) text = edit(text, `sandbox_workspace_write.writable_roots.[${roots.length}]`, home);
  } catch {
    throw new Error('Cannot preserve this inline Codex writable_roots array. Convert sandbox_workspace_write to a [sandbox_workspace_write] table, then rerun. No settings changed.');
  }
  return text;
}

function validateHooks(doc, file) {
  if (!object(doc) || (doc.hooks !== undefined && !object(doc.hooks))) throw new Error(`${file}: expected a settings object with a hooks object`);
  for (const groups of Object.values(doc.hooks || {})) {
    if (!Array.isArray(groups) || groups.some(g => !object(g) || (g.hooks !== undefined && (!Array.isArray(g.hooks) || g.hooks.some(h => !object(h)))))) {
      throw new Error(`${file}: invalid hook entries; fix them before installing`);
    }
  }
  if (doc.permissions !== undefined && (!object(doc.permissions) || (doc.permissions.allow !== undefined && !Array.isArray(doc.permissions.allow)))) {
    throw new Error(`${file}: invalid permissions`);
  }
}
function ownedSkill(file) {
  return /^name: (?:cross-debate|debate)$/m.test(read(path.join(file, 'SKILL.md')))
    && fs.existsSync(path.join(file, 'scripts', 'debate.mjs'))
    && read(path.join(file, 'scripts', 'lib', 'common.mjs')).includes("'debate.run.v1'");
}
function laneError(lane) {
  const result = parseConfigDocument(json({ version: 'delegate-fleet.v1', lanes: { reviewer: lane } }));
  return result.ok ? undefined : result.error;
}

/** Build every file change before the single Apply prompt. No discovery command writes to agent homes. */
export function prepareInstall({ hosts, config, configBefore, cwd = process.cwd() }) {
  if (!hosts.length || hosts.some(host => !Object.hasOwn(labels, host))) throw new Error('Choose a supported host');
  const parsed = parseConfigDocument(json(config));
  if (!parsed.ok) throw new Error(parsed.error);
  const target = installDir();
  const homes = hostHomes();
  const changes = [];
  const add = (file, kind, value) => {
    if (changes.some(change => slot(change.file) === slot(file))) return;
    const previous = stat(file);
    if (kind !== 'text' && previous && !ownedSkill(file)) throw new Error(`${file} already exists and is not a recognized cross-debate installation; move it aside first`);
    if (kind === 'text' && previous && !previous.isFile()) throw new Error(`${file} is not a regular file; resolve it before installing`);
    const before = kind === 'text' ? read(file) : null;
    if (kind === 'text' && before === value) return;
    if (kind === 'link' && previous?.isSymbolicLink() && path.resolve(path.dirname(file), fs.readlinkSync(file)) === value) return;
    changes.push({ file, kind, value, before, previous });
  };
  if (configBefore !== undefined && read(globalConfigPath()) !== configBefore) throw new Error('Reviewer settings changed while the installer was open; rerun to review them.');
  add(target, 'copy', SKILL_DIR);
  add(globalConfigPath(), 'text', json(config));
  for (const host of hosts) {
    const catalog = path.join(homes[host], 'skills', 'cross-debate');
    if (slot(catalog) !== slot(target)) add(catalog, 'link', target);
    const cli = path.join(catalog, 'scripts', 'debate.mjs');
    const entries = hookEntries(host, cli);
    if (entries.allow) entries.allow = [...new Set([cli, path.join(target, 'scripts', 'debate.mjs'), path.join(slot(target), 'scripts', 'debate.mjs')])]
      .map(file => `Bash(node ${JSON.stringify(file)}:*)`);
    const before = read(entries.file);
    if (host === 'opencode') {
      if (before && !before.includes('debate.mjs" hook opencode')) throw new Error(`${entries.file} is not a generated cross-debate plugin`);
      add(entries.file, 'text', opencodePlugin(cli));
    } else {
      const doc = before ? JSON.parse(before) : {};
      validateHooks(doc, entries.file);
      add(entries.file, 'text', json(mergeHooks(host, doc, entries)));
    }
    if (host === 'codex') {
      const file = path.join(homes.codex, 'config.toml');
      add(file, 'text', mergeCodex(read(file), debateHome()));
    }
  }
  // Old commands keep working, but the old name no longer appears as a second skill.
  const sharedLegacy = path.join(path.dirname(target), 'debate');
  const retainedHosts = fs.existsSync(sharedLegacy) ? Object.entries(homes).filter(([host, home]) => {
    const legacy = path.join(home, 'skills', 'debate');
    return !hosts.includes(host) && fs.existsSync(legacy) && physicalPath(legacy) === physicalPath(sharedLegacy);
  }).map(([host]) => labels[host]) : [];
  const catalogs = new Set([path.dirname(target), ...hosts.map(host => path.join(homes[host], 'skills'))]);
  for (const catalog of catalogs) {
    const legacy = path.join(catalog, 'debate');
    if (retainedHosts.length && slot(legacy) === slot(sharedLegacy)) continue;
    if (stat(legacy) && ownedSkill(legacy)) add(legacy, 'compat', target);
  }
  return { changes, cwd, target, retainedHosts };
}

/** Back up entries themselves (never symlink referents); restore files if applying fails. */
export function applyInstall(plan) {
  const backupRoot = path.join(debateHome(), 'install-backups', randomUUID());
  const applied = [];
  try {
    for (const change of plan.changes) {
      const { file, kind, value, previous, before } = change;
      const current = stat(file);
      if (current?.ino !== previous?.ino || current?.mtimeMs !== previous?.mtimeMs || (kind === 'text' && read(file) !== before)) {
        throw new Error(`${file} changed while the installer was open; rerun to review the new settings`);
      }
      const backup = path.join(backupRoot, String(applied.length));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (previous) {
        fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
        fs.cpSync(file, backup, { recursive: true, verbatimSymlinks: true });
      }
      applied.push({ file, backup, previous });
      if (kind === 'text') writeAtomic(file, value);
      else {
        fs.rmSync(file, { recursive: true, force: true });
        if (kind === 'copy') {
          fs.cpSync(value, file, { recursive: true, dereference: false });
          writeAtomic(path.join(file, 'VERSION'), `${version}\n`);
        }
        else if (kind === 'link') fs.symlinkSync(value, file, 'dir');
        else {
          fs.mkdirSync(file);
          for (const name of ['scripts', 'references', 'assets', 'vendor']) fs.symlinkSync(path.join(value, name), path.join(file, name), 'dir');
        }
      }
    }
  } catch (error) {
    for (const { file, backup, previous } of applied.reverse()) {
      try {
        fs.rmSync(file, { recursive: true, force: true });
        if (previous?.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(backup), file, 'dir');
        else if (previous) fs.cpSync(backup, file, { recursive: true, verbatimSymlinks: true });
      } catch (restore) { error.message += `\nRestore ${file} from ${backup}: ${restore.message}`; }
    }
    throw error;
  }
  if (fs.existsSync(backupRoot)) {
    writeAtomic(path.join(backupRoot, 'manifest.json'), json(applied.map(({ file, backup }) => ({ file, backup }))));
    return backupRoot;
  }
  return null;
}

export async function install(ui = p, cwd = process.cwd()) {
  const ask = async (type, options) => {
    const answer = await ui[type](options);
    if (ui.isCancel(answer)) throw new Error('cancelled');
    return answer;
  };
  ui.intro('cross-debate · Cross-agent review for plans, code, and pull requests');
  ui.note(rolesNote, 'Meet your two reviewers');
  try {
    if (!onPath('git')) throw new Error('Install Git, then rerun cross-debate.');
    const available = reviewerCLIs.filter(onPath);
    if (!available.length) throw new Error('Install and sign in to Claude Code, Codex, or OpenCode first, then rerun cross-debate.');
    const homes = hostHomes();
    const detected = Object.keys(labels).filter(host => fs.existsSync(homes[host]) || onPath(host === 'cursor' ? 'cursor-agent' : host));
    const hosts = await ask('multiselect', {
      message: 'Where do you work? Space to select, Enter to continue.', required: true,
      options: Object.entries(labels).map(([value, label]) => ({ value, label })), initialValues: detected,
    });
    const configBefore = read(globalConfigPath());
    const checked = parseConfigDocument(configBefore || json({ version: 'delegate-fleet.v1', lanes: {} }));
    if (!checked.ok) throw new Error(checked.error);
    const current = checked.document;
    const complete = requiredLanes.every(name => current.lanes[name]);
    const choice = await ask('select', {
      message: 'Who should review your work?',
      options: [
        { value: 'default', label: defaultLabel(complete, available), hint: 'recommended' },
        { value: 'custom', label: 'Choose reviewers and models for plans and code' },
      ],
    });
    const choosePair = async (stage, initial = []) => {
      const pair = [];
      for (const [i, role] of roles.entries()) {
        const name = choice === 'custom' ? `${stage === 'plan' ? 'Plan' : 'Code'} review · ${role.name}` : role.name;
        const implementer = choice === 'custom' ? await ask('select', {
          message: `${name}: which CLI? ${role.cli}`, options: available.map(value => ({ value, label: labels[value] })),
          initialValue: initial[i]?.implementer ?? available[i % available.length],
        }) : available[i % Math.min(2, available.length)];
        let model = 'default';
        if (implementer === 'opencode') model = await ask('text', {
          message: `${name} model: OpenCode provider/model`,
          validate: value => !/^[^/\s]+\/\S+$/.test(value || '')
            ? 'Enter the provider/model ID from your OpenCode configuration'
            : laneError(buildLane({ implementer, model: value })),
        });
        else if (choice === 'custom') {
          const existing = current.lanes[stage === 'plan' ? role.plan : role.code];
          const catalog = await discoverModelCatalog(implementer);
          const selection = await ask('select', {
            message: `${name} model`,
            options: modelMenu(implementer, catalog, existing?.implementer === implementer ? existing.model : null),
            initialValue: 'default',
          });
          model = selection === 'other' ? await ask('text', {
            message: 'Enter another model ID',
            validate: value => laneError(buildLane({ implementer, model: value || '' })),
          }) : selection;
        }
        const dial = implementer === 'opencode' ? 'variant' : 'effort';
        const value = choice === 'custom' ? await ask('text', {
          message: dialMessage({ ...role, name }, implementer), defaultValue: 'none',
          validate: value => laneError(buildLane({ implementer, model: model || 'default', dial, value: value || 'none' })),
        }) : 'none';
        pair.push(buildLane({ implementer, model: model || 'default', dial, value: value || 'none' }));
      }
      return pair;
    };
    let pair = [], codePair = [];
    if (!complete || choice === 'custom') {
      pair = await choosePair('plan');
      codePair = choice === 'custom' && await ask('select', {
        message: 'Code reviews: use the same reviewers as plans?',
        options: [
          { value: 'same', label: 'Yes, same CLIs, models, and effort' },
          { value: 'separate', label: 'No, choose code reviewers separately', hint: 'for example, lighter models or lower effort' },
        ],
      }) === 'separate' ? await choosePair('code', pair) : pair;
    }
    const config = structuredClone(current);
    const proposed = { 'plan-main': pair[1], 'plan-debate': pair[0], 'review-main': codePair[0], 'review-debate': codePair[1] };
    for (const name of requiredLanes) if (choice === 'custom' || !config.lanes[name]) config.lanes[name] = proposed[name];
    if (choice === 'custom') for (const name of Object.keys(config.lanes).filter(n => n.startsWith('plan-main-'))) config.lanes[name] = pair[1];
    const describe = lane => [lane.implementer, lane.model || 'CLI default model', lane.effort || lane.variant].filter(Boolean).join(' / ') + (lane.source === 'project' ? ' (project override)' : '');
    const scope = repositoryScope(cwd);
    const readiness = await reviewerReadiness(cwd, { globalConfig: config, seats: hosts });
    if (!readiness.ok) throw new Error(readiness.checks.filter(check => !check.ok).map(check => check.error).join('\n'));
    const plan = prepareInstall({ hosts, config, configBefore, cwd });
    const lanes = readiness.lanes;
    const compact = file => file.startsWith(`${os.homedir()}/`) ? `~/${file.slice(os.homedir().length + 1)}` : file;
    const repeat = (a, b) => a.implementer === b.implementer && a.model === b.model;
    const sameModel = [
      ...(repeat(lanes['review-main'], lanes['review-debate']) ? ['code'] : []),
      ...hosts.filter(h => repeat(lanes[`plan-main-${h}`] || lanes['plan-main'], lanes['plan-debate'])).map(h => `${labels[h]} plans`),
    ];
    const roleLine = role => {
      const code = lanes[role.code], plan = lanes[role.plan];
      const same = ['implementer', 'model', 'effort', 'variant', 'source'].every(key => code[key] === plan[key]);
      return `${role.name}:`.padEnd(15) + describe(code) + (same ? '' : ` (plans: ${describe(plan)})`);
    };
    ui.note([
      `Hosts: ${hosts.map(h => labels[h]).join(', ')}`,
      ...roles.map(roleLine),
      ...hosts.filter(h => lanes[`plan-main-${h}`]).map(h => `${labels[h]} plans: first opinion from ${describe(lanes[`plan-main-${h}`])}`),
      ...(sameModel.length ? [`The Lead reviewer and Challenger use the same model (${sameModel.join(', ')}), so they'll tend to make the same mistakes. Pick different families if you can.`] : []),
      ...(plan.retainedHosts.length ? [`Keeping the legacy debate registration for ${plan.retainedHosts.join(', ')}. Select those hosts on a later run to finish migration.`] : []),
      `Current directory: ${scope.identity ? `${compact(scope.identity.worktreeRoot)} (${scope.warnings.length ? scope.warnings.join('; ') : scope.enabled ? 'automatic reviews on' : 'explicit opt-out'})` : 'not a Git repository; no automatic reviews here'}`,
      'Automatic reviews run in every Git project by default and consume reviewer-provider usage.',
      'Updating activates existing Git projects unless they already have an explicit opt-out.',
      'You can turn reviews off for any project after installing.',
      '', 'Files to install or update:', ...plan.changes.map(change => compact(change.file)),
      '', 'Existing entries are backed up. Reviewer sign-in is not checked.',
    ].join('\n'), 'Ready to install');
    if (!await ask('confirm', { message: 'Apply these changes?', initialValue: true })) throw new Error('cancelled');
    const backup = applyInstall(plan);
    if (backup) ui.log.info(`Backups: ${backup}`);
    const automaticHosts = hosts.filter(host => host === 'claude' || host === 'codex');
    const effective = repositoryScope(cwd).effective;
    const scopeCommand = action => `  ${installCommand} scope ${action} --cwd ${shellQuote(scope.identity.worktreeRoot)}`;
    const disableHint = () => ['To turn them off for one project:', scopeCommand('disable')];
    const optOut = !scope.identity ? [] : [
      'Automatic reviews are on by default in Git projects; existing opt-outs stay in effect.',
      ...(scope.configured === false
        ? ['This project is opted out. To turn reviews back on here:', scopeCommand('enable'), ...disableHint()]
        : [...disableHint(), 'Turn them back on with "scope enable".']),
    ];
    ui.note([
      `Installed cross-debate ${version} for ${hosts.map(host => labels[host]).join(', ')}.`,
      `Current directory: ${scope.identity ? `Git repository; automatic reviews ${effective ? 'on' : 'off'}` : 'not a Git repository; no automatic reviews'}.`,
      'Restart your agent to load cross-debate.',
      ...(hosts.includes('codex') ? ['In Codex, review and trust the new hooks when prompted.'] : []),
      'Verify from your project directory:',
      ...hosts.map(host => `node ${shellQuote(path.join(homes[host], 'skills', 'cross-debate', 'scripts', 'debate.mjs'))} setup doctor --agent ${host} --cwd ${shellQuote(cwd)}`),
      ...(effective && automaticHosts.length ? [`In ${automaticHosts.map(host => labels[host]).join(' and ')}, enter plan mode and describe your task. Plan and code reviews run automatically.`] : []),
      ...optOut,
      'First review prompt: Use cross-debate to review a plan for adding a small regression test in this project.',
      ...(hosts.some(host => host === 'cursor' || host === 'opencode') ? ['Cursor/OpenCode: request reviews explicitly; experimental hooks gate Git only.'] : []),
      'Expect reviewer findings, the agent\'s verified decisions, and a review outcome. Sign-in and native hook execution still need an interactive check.',
    ].join('\n'), 'Next');
    ui.outro('Installed. Your next agent session can use cross-debate.');
    return 0;
  } catch (error) {
    if (error.message === 'cancelled') { ui.cancel('Cancelled. No settings changed.'); return 0; }
    ui.cancel(error.message);
    return 1;
  }
}

async function main(argv) {
  const help = argv.includes('--help') || argv.includes('-h');
  if (['--version', '-v'].includes(argv[0])) {
    console.log(`cross-debate ${version}`);
    if (fs.existsSync(path.join(installDir(), 'SKILL.md'))) console.log(`Installed skill: ${skillVersion(installDir())}`);
    return 0;
  }
  if (['--help', '-h'].includes(argv[0]) || (argv[0] === 'install' && help)) {
    console.log(`cross-debate

Install or update:
  ${installCommand}

Other commands:
  ${installCommand} <command>

  scope enable                Re-enable automatic reviews in this Git project
  scope disable               Opt this Git project and linked worktrees out
  scope status                Check automatic review status
  setup doctor --agent codex  Check one host (or claude, cursor, opencode)
  review <PR URL> --dry-run    Run models without posting the PR review

Run installation in your own terminal. Node 22+ is required.`);
    return 0;
  }
  if (!argv.length || (argv.length === 1 && argv[0] === 'install')) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(`Installation needs an interactive terminal. Run ${installCommand} yourself.`);
    return install();
  }
  let cli = path.join(installDir(), 'scripts', 'debate.mjs');
  if (!fs.existsSync(cli)) {
    if (!help || !['plan', 'code', 'review', 'scope', 'stats', 'setup'].includes(argv[0])) throw new Error(`Install first: ${installCommand}`);
    cli = path.join(SKILL_DIR, 'scripts', 'debate.mjs');
  }
  const result = spawnSync(process.execPath, [cli, ...argv], { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
if (process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
