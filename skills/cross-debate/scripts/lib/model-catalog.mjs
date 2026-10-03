import { spawn } from 'node:child_process';

const TIMEOUT_MS = 2500;
const fallback = {
  claude: ['opus', 'sonnet', 'haiku'],
  codex: ['gpt-5.4', 'gpt-5.4-mini'],
};

const family = (cli, id) => cli === 'claude'
  ? (id.match(/(?:^|-)opus|(?:^|-)sonnet|(?:^|-)haiku/i)?.[0].replace('-', '').toLowerCase() || id)
  : (id.match(/^(?:gpt-[\d.]+|o\d+|codex)/i)?.[0].replace(/[\d.]+$/, '') || id);

export function modelMenu(cli, catalog, existing = null) {
  const options = [{ value: 'default', label: 'CLI default', hint: 'recommended' }];
  const seen = new Set();
  for (const id of catalog?.length ? catalog : fallback[cli] || []) {
    if (typeof id !== 'string' || !id || /\s/.test(id)) continue;
    const group = family(cli, id);
    if (seen.has(group)) continue;
    seen.add(group);
    options.push({ value: id, label: id, hint: 'catalog suggestion; access not verified' });
  }
  if (existing && !options.some(option => option.value === existing)) options.push({ value: existing, label: existing, hint: 'currently configured' });
  options.push({ value: 'other', label: 'Enter another model' });
  return options;
}

export async function claudeModels({ key = process.env.ANTHROPIC_API_KEY, fetchImpl = fetch, timeout = TIMEOUT_MS } = {}) {
  if (!key) return fallback.claude;
  try {
    const response = await fetchImpl('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) return fallback.claude;
    const body = await response.json();
    const ids = body.data?.map(model => model.id).filter(id => typeof id === 'string');
    return ids?.length ? ids : fallback.claude;
  } catch { return fallback.claude; }
}

export function codexModels({ spawnImpl = spawn, timeout = TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    let child;
    try { child = spawnImpl('codex', ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { resolve(fallback.codex); return; }
    let done = false;
    let buffer = '';
    const finish = ids => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(ids?.length ? ids : fallback.codex);
    };
    const send = value => { try { child.stdin.write(`${JSON.stringify(value)}\n`); } catch { finish(); } };
    const timer = setTimeout(() => finish(), timeout);
    child.on('error', () => finish());
    child.on('exit', () => finish());
    child.stdin.on?.('error', () => finish());
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      if (buffer.length > 1_000_000) return finish();
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n');
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1 && message.result) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'model/list', params: {} });
        }
        if (message.id === 2) {
          const entries = message.result?.data ?? message.result?.models ?? [];
          finish(Array.isArray(entries) ? entries.map(entry => entry.model ?? entry.id ?? entry.slug).filter(id => typeof id === 'string') : []);
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'cross_debate', title: 'Cross Debate', version: '0.1.0' }, capabilities: {} } });
  });
}

export async function discoverModelCatalog(cli) {
  if (cli === 'claude') return claudeModels();
  if (cli === 'codex') return codexModels();
  return [];
}
