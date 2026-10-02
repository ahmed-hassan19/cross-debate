// Send a brief to an implementer through its delegate-skills relay, read-only, and get the JSON back.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './shell.mjs';
import { findScript, loadLaneConfig, relaySupportsReadOnly, childEnv, cliCommand, extractJson as extractJsonDocument } from './common.mjs';

// ---------- lanes ----------

/** Lane dials that still apply to a read-only review (timeout comes from the command, the rest is read-only). */
const DIAL_FLAGS = { model: '--model', effort: '--effort', variant: '--variant', provider: '--provider' };

/**
 * Decide who plays a role. An explicit implementer wins; otherwise read the lane from the fleet config.
 * Returns { implementer, lane, dials }. lane is null and dials empty when the implementer was given explicitly.
 * The lane resolves here, against the user's repository: the relay runs in the reviewed checkout, where a
 * project lane's trust record is absent and a reviewed change could carry its own lane config.
 */
export function resolveRole(role, { explicit, lane, cwd }) {
  if (explicit === 'opencode') throw new Error(`opencode needs a model, which only a lane supplies; bind it in a lane and pass --${role}-lane <lane> instead of --${role} opencode`);
  if (explicit) return { implementer: explicit, lane: null, dials: {} };

  const config = loadLaneConfig(cwd);
  const entry = config.lanes && config.lanes[lane];
  if (!entry) {
    throw new Error(`lane "${lane}" is not configured. Run ${cliCommand('setup init')} in your own terminal (or setup lanes), or pass --${role} <implementer>`);
  }
  // The relay's own trust check never runs because dials are passed explicitly, so it happens here.
  if (entry.source === 'project' && !config.projectTrusted) {
    throw new Error(`lane "${lane}" comes from an untrusted project config; trust it with delegate-setup or use a global lane`);
  }
  const dials = Object.fromEntries(Object.entries(DIAL_FLAGS).filter(([field]) => entry[field] !== undefined).map(([field]) => [field, entry[field]]));
  return { implementer: entry.implementer, lane, dials };
}

// ---------- dispatch ----------

/**
 * Run one implementer on a brief, read-only, inside `cwd`. Artifacts land in `<outDir>/<role>/`.
 * Returns { text, seconds } where text is the implementer's final message.
 */
export function dispatch({ role, who, brief, cwd, outDir, timeout }) {
  const relay = findScript(`${who.implementer}-delegate`, 'relay.mjs');
  if (!relaySupportsReadOnly(relay)) {
    throw new Error(`${who.implementer}-delegate has no --read-only mode; choose another ${role} implementer`);
  }

  const dir = path.join(outDir, role);
  // A rerun on the same head reuses outDir; clear it so a relay that fails early cannot leave a stale result.json behind.
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const briefPath = path.join(dir, 'brief.md');
  fs.writeFileSync(briefPath, brief);

  const args = [relay, '--brief', briefPath, '--cd', cwd, '--read-only', '--out-dir', dir, '--timeout', timeout];
  for (const [field, value] of Object.entries(who.dials || {})) args.push(DIAL_FLAGS[field], String(value));
  if (who.implementer === 'codex') args.push('--ignore-user-config');

  log(`${role}: ${who.implementer}${who.lane ? ` (lane ${who.lane})` : ''} …`);
  const started = Date.now();
  const proc = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'], env: childEnv() });
  const seconds = Math.round((Date.now() - started) / 1000);

  const resultPath = path.join(dir, 'result.json');
  if (!fs.existsSync(resultPath)) {
    throw new Error(`${role}: relay exited ${proc.status} without writing result.json`);
  }
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  if (result.status !== 'completed') {
    throw new Error(`${role}: relay finished with status "${result.status}" (see ${dir})`);
  }
  if (result.readOnlyViolation === true) {
    throw new Error(`${role}: relay reported a read-only violation; its output is discarded (inspect ${dir})`);
  }

  log(`${role}: done in ${seconds}s`);
  return { text: result.finalMessage || '', seconds };
}

// ---------- parse the answer ----------

/** Pull the JSON document out of an implementer's final message (last ```json block wins). */
export function extractJson(message) {
  const doc = extractJsonDocument(message);
  if (doc === null) throw new Error('implementer returned no parseable JSON block');
  return doc;
}

/** Throw unless the document carries the schema id we asked for. */
export function expectSchema(doc, schema, role) {
  if (!doc || doc.schema !== schema) {
    throw new Error(`${role}: expected schema ${schema}, got ${doc && doc.schema}`);
  }
  return doc;
}
