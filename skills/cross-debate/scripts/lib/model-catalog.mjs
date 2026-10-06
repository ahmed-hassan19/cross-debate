import { spawn } from 'node:child_process';

const TIMEOUT_MS = 2500;
// ponytail: newest model per family as of 2026-10-05, used only when the CLI cannot list its models.
const fallback = {
  claude: ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'],
  codex: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-terra'],
};

// Catalogs list newest first, so the first ID seen per family is the newest. Codex tiers follow the version (gpt-6.1-sol).
const family = (cli, id) => cli === 'claude'
  ? (id.match(/(?:^|-)(fable|opus|sonnet|haiku)/i)?.[1].toLowerCase() || id)
  : (id.replace(/^gpt-[\d.]+-?/i, '') || 'gpt');

export function modelMenu(cli, catalog, existing = null) {
  const options = [{ value: 'default', label: 'CLI default', hint: 'recommended' }];
  const seen = new Set();
  for (const id of catalog?.length ? catalog : fallback[cli] || []) {
    if (typeof id !== 'string' || !id || /\s/.test(id)) continue;
    const group = family(cli, id);
    if (seen.has(group)) continue;
    seen.add(group);
    options.push({ value: id, label: id });
  }
  if (existing && !options.some(option => option.value === existing)) options.push({ value: existing, label: existing, hint: 'currently configured' });
  options.push({ value: 'other', label: 'Enter another model' });
  return options;
}

/**
 * Speak JSON lines with a CLI until `onMessage` returns a non-null result. Resolves `failure` on spawn errors, exit,
 * timeout, or when `onMessage` throws.
 */
export function askCli(cli, args, first, onMessage, failure, { spawnImpl = spawn, timeout = TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    let child;
    try { child = spawnImpl(cli, args, { stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { resolve(failure); return; }
    let done = false;
    let buffer = '';
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(result ?? failure);
    };
    const send = value => { try { child.stdin.write(`${JSON.stringify(value)}\n`); } catch { finish(); } };
    const timer = setTimeout(() => finish(), timeout);
    child.on('error', () => finish());
    child.on('exit', () => finish());
    child.stdin.on?.('error', () => finish());
    child.stdout.setEncoding('utf8'); // decodes multibyte characters split across chunks
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 1_000_000) return finish();
      while (!done && buffer.includes('\n')) {
        const end = buffer.indexOf('\n');
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        let result;
        try { result = onMessage(message, send); } catch { return finish(); }
        if (result != null) finish(result);
      }
    });
    send(first);
  });
}

const catalog = cli => ids => {
  const usable = ids.filter(id => typeof id === 'string');
  return usable.length ? usable : fallback[cli];
};

/**
 * The Agent SDK's initialize control request: Claude Code answers with the signed-in account's models
 * (SDKControlInitializeResponse.models) without starting a turn. --safe-mode skips the user's hooks and plugins.
 */
export function claudeModels(options) {
  return askCli('claude', ['-p', '--safe-mode', '--no-session-persistence', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
    { type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } },
    message => {
      if (message.type !== 'control_response' || message.response?.request_id !== 'models') return null;
      const models = message.response.response?.models;
      // The menu offers CLI default itself; the Default row may resolve to an older model that would hide a newer one.
      return Array.isArray(models) ? models.filter(model => model.value !== 'default').map(model => model.resolvedModel ?? model.value) : [];
    }, [], options).then(catalog('claude'));
}

export function codexModels(options) {
  return askCli('codex', ['app-server', '--listen', 'stdio://'],
    { id: 1, method: 'initialize', params: { clientInfo: { name: 'cross_debate', title: 'Cross Debate', version: '0.1.0' }, capabilities: {} } },
    (message, send) => {
      if (message.id === 1 && message.result) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'model/list', params: {} });
      }
      if (message.id !== 2) return null;
      const entries = message.result?.data ?? message.result?.models ?? [];
      return Array.isArray(entries) ? entries.map(entry => entry.model ?? entry.id ?? entry.slug) : [];
    }, [], options).then(catalog('codex'));
}

export async function discoverModelCatalog(cli) {
  if (cli === 'claude') return claudeModels();
  if (cli === 'codex') return codexModels();
  return [];
}
