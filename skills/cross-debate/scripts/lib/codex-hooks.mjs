// Codex skips new or changed user hooks until they are trusted in /hooks. The app-server reports each hook's trust and
// writes trust through Codex's own config writer, so we never compute Codex's hash or edit config.toml ourselves.
// Verified on codex-cli 0.160.0: `hooks/list {}` lists hooks for the server's cwd without sign-in, whether or not
// features.hooks is set, as { data: [{ hooks: [{ key, command, source, currentHash, trustStatus }] }] }.
// `config/batchWrite` with an upsert on hooks.state adds [hooks.state."<key>"] trusted_hash entries, keeps the
// other entries, and preserves the rest of config.toml (comments, inline tables).
import { askCli } from './model-catalog.mjs';

const TIMEOUT_MS = 10_000; // app-server loads plugins before answering
const ARGS = ['app-server', '--listen', 'stdio://'];
const INITIALIZE = { id: 1, method: 'initialize', params: { clientInfo: { name: 'cross_debate', title: 'Cross Debate', version: '0.1.0' }, capabilities: {} } };
const LIST = 2, WRITE = 3, VERIFY = 4;

const eventOf = command => command.trim().split(/\s+/).at(-1);

/** User hooks whose command `owns` accepts, from a hooks/list result. Throws on an unexpected shape. */
function owned(result, owns) {
  if (!Array.isArray(result?.data)) throw new Error('unexpected hooks/list response');
  return result.data.flatMap(entry => Array.isArray(entry?.hooks) ? entry.hooks : [])
    .filter(hook => hook?.source === 'user' && typeof hook.command === 'string' && typeof hook.key === 'string' && owns(hook.command))
    .map(({ key, command, currentHash, trustStatus }) => ({ key, eventName: eventOf(command), currentHash, trustStatus }));
}

const missingFrom = (events, ...lists) => events.filter(event => lists.some(hooks => !hooks.some(hook => hook.eventName === event)));

/** Route app-server responses by id; any JSON-RPC error fails the whole exchange. */
function respond(handlers) {
  return (message, send) => {
    if (message.id === undefined) return null;
    if (message.error) throw new Error(message.error.message || 'app-server error');
    if (message.id === INITIALIZE.id) {
      send({ method: 'initialized' });
      send({ id: LIST, method: 'hooks/list', params: {} });
      return null;
    }
    return handlers[message.id]?.(message.result, send) ?? null;
  };
}

/** Read-only trust report for hooks `owns` accepts: { hooks, missing }, or null when the app-server cannot answer. */
export function codexHookStatus({ owns, events, spawnImpl, timeout = TIMEOUT_MS }) {
  return askCli('codex', ARGS, INITIALIZE, respond({
    [LIST]: result => {
      const hooks = owned(result, owns);
      return { hooks, missing: missingFrom(events, hooks) };
    },
  }), null, { spawnImpl, timeout });
}

/**
 * Trust exactly the user hooks whose command is one of `commands`, then list again to confirm.
 * Returns { ok, pending, missing }, or null when the app-server cannot answer. Never touches other hooks.
 */
export function trustCodexHooks({ commands, spawnImpl, timeout = TIMEOUT_MS }) {
  const owns = command => commands.includes(command);
  const events = commands.map(eventOf);
  let before = [];
  return askCli('codex', ARGS, INITIALIZE, respond({
    [LIST]: (result, send) => {
      before = owned(result, owns);
      const untrusted = before.filter(hook => hook.trustStatus === 'untrusted' || hook.trustStatus === 'modified');
      if (!untrusted.length) send({ id: VERIFY, method: 'hooks/list', params: {} });
      else send({ id: WRITE, method: 'config/batchWrite', params: { edits: [{
        keyPath: 'hooks.state', mergeStrategy: 'upsert',
        value: Object.fromEntries(untrusted.map(hook => [hook.key, { trusted_hash: hook.currentHash }])),
      }] } });
      return null;
    },
    [WRITE]: (_, send) => { send({ id: VERIFY, method: 'hooks/list', params: {} }); return null; },
    [VERIFY]: result => {
      const after = owned(result, owns);
      const missing = missingFrom(events, before, after);
      const pending = after.filter(hook => hook.trustStatus !== 'trusted').map(hook => hook.key);
      return { ok: !missing.length && !pending.length, pending, missing };
    },
  }), null, { spawnImpl, timeout });
}
