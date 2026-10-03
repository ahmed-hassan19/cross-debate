import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseConfigDocument } from '../skills/cross-debate/vendor/delegate-skills/delegate-setup/scripts/config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => fs.readFileSync(file, 'utf8');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60_000, ...options });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.error || ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    assert.equal(entry.isSymbolicLink(), false, `skill must ship real files: ${file}`);
    return entry.isDirectory() ? files(file) : [file];
  });
}

test('packed skill installs outside the checkout and runs without npm dependencies', { timeout: 120_000 }, t => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cross-debate package ')));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const cache = run('npm', ['config', 'get', 'cache'], { cwd: root }).trim();
  const home = path.join(temp, 'home');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GIT_|DEBATE|DELEGATE_|CODEX_|CLAUDE_|NPM_CONFIG_|NODE_PATH|NODE_OPTIONS)/i.test(key)));
  Object.assign(env, { HOME: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    XDG_CONFIG_HOME: path.join(home, '.config'), DEBATE_HOME: path.join(home, 'state'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    npm_config_userconfig: path.join(temp, 'npmrc'), npm_config_globalconfig: path.join(temp, 'global-npmrc') });
  fs.mkdirSync(home);
  const [packed] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], { cwd: root, env }));
  const paths = new Set(packed.files.map(file => file.path));
  for (const file of ['package.json', 'bin/cross-debate.mjs', 'LICENSE', 'skills/cross-debate/SKILL.md',
    'skills/cross-debate/LICENSE', 'skills/cross-debate/THIRD_PARTY_NOTICES.md']) assert.ok(paths.has(file), `missing ${file}`);
  for (const file of files(path.join(root, 'skills/cross-debate'))) assert.ok(paths.has(path.relative(root, file)), `not packed: ${file}`);
  assert.ok([...paths].every(file => !/^(?:tests|scripts|node_modules|\.git|\.github)\/|^CONTRIBUTING\.md$/.test(file)));
  run('tar', ['-xzf', path.join(temp, packed.filename), '-C', temp], { env });
  const unpacked = path.join(temp, 'package');
  // npm ci uses the reviewed dependency graph and the cache populated by npm ci in the checkout.
  fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(unpacked, 'package-lock.json'));
  run('npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache], { cwd: unpacked, env });
  const entrypoint = path.join(unpacked, 'bin/cross-debate.mjs');
  const version = JSON.parse(read(path.join(unpacked, 'package.json'))).version;
  fs.accessSync(entrypoint, fs.constants.X_OK);
  assert.match(run(entrypoint, ['--help'], { cwd: temp, env }), /cross-debate/);
  assert.equal(run(entrypoint, ['--version'], { cwd: temp, env }).trim(), `cross-debate ${version}`);
  const skill = path.join(unpacked, 'skills/cross-debate');
  assert.equal(read(path.join(skill, 'LICENSE')), read(path.join(root, 'LICENSE')));
  const frontmatter = read(path.join(skill, 'SKILL.md')).match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatter, 'SKILL.md must have frontmatter');
  assert.match(frontmatter[1], /^name: cross-debate$/m);
  assert.match(frontmatter[1], /^license: MIT$/m);
  for (const [field, limit] of [['description', 1024], ['compatibility', 500]]) {
    const value = frontmatter[1].match(new RegExp(`^${field}: (.+)$`, 'm'))?.[1];
    assert.ok(value && value.length <= limit, `${field} must be a nonempty string of at most ${limit} characters`);
  }
  for (const file of files(path.join(unpacked, 'examples'))) assert.equal(parseConfigDocument(read(file), file).ok, true);
  const documents = [path.join(unpacked, 'README.md'), ...files(path.join(unpacked, 'docs')), ...files(skill)];
  for (const file of documents.filter(file => file.endsWith('.md'))) {
    const links = [...read(file).matchAll(/\[[^\]]+\]\(([^)\s]+)\)|(?:src|srcset)="([^"]+)"/g)];
    for (const match of links) {
      const href = match[1] || match[2];
      const repository = 'https://github.com/ahmed-hassan19/cross-debate/blob/main/';
      if (href.startsWith(repository)) {
        assert.ok(fs.existsSync(path.join(root, href.slice(repository.length).split('#')[0])), `missing repository target: ${href}`);
        continue;
      }
      if (/^(?:[a-z]+:|#)/i.test(href)) continue;
      assert.ok(fs.existsSync(path.resolve(path.dirname(file), decodeURIComponent(href.split('#')[0]))), `${file}: broken link ${href}`);
    }
  }
  const bin = path.join(temp, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['claude', 'codex']) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nif [ "$1" != "app-server" ]; then printf called > "$HOME/reviewer-called"; fi\nexit 99\n', { mode: 0o755 });
  }
  fs.symlinkSync(run('which', ['git']).trim(), path.join(bin, 'git'));
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  env.PATH = bin;
  const project = path.join(temp, 'project');
  fs.mkdirSync(project);
  run('git', ['init', '-q', project], { env });
  run(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const { install } = await import(${JSON.stringify(pathToFileURL(entrypoint).href)});
    const ui = { intro() {}, note() {}, outro() {}, log: { info() {} }, isCancel: () => false,
      multiselect: async () => ['claude', 'codex'], select: async () => 'default', confirm: async () => true,
      cancel: message => assert.fail(message) };
    assert.equal(await install(ui, process.cwd()), 0);
  `], { cwd: project, env });
  const installed = path.join(home, '.agents/skills/cross-debate');
  assert.equal(read(path.join(installed, 'LICENSE')), read(path.join(root, 'LICENSE')));
  for (const host of ['.claude', '.codex']) {
    assert.equal(fs.realpathSync(path.join(home, host, 'skills/cross-debate')), installed);
    const settings = read(path.join(home, host, host === '.claude' ? 'settings.json' : 'hooks.json'));
    assert.ok(!settings.includes(unpacked) && !settings.includes(root), 'hooks must reference the installed skill');
  }
  fs.rmSync(unpacked, { recursive: true, force: true });
  const cli = path.join(installed, 'scripts/debate.mjs');
  assert.equal(run(process.execPath, [cli, '--version'], { cwd: project, env }).trim(), `cross-debate ${version}`);
  for (const command of ['plan', 'code', 'review']) run(process.execPath, [cli, command, '--help'], { cwd: project, env });
  assert.match(run(process.execPath, [cli, 'setup', 'doctor'], { cwd: project, env }), /0 failures/);
  const scope = JSON.parse(run(process.execPath, [cli, 'scope', 'status', '--cwd', project, '--json'], { cwd: project, env }));
  assert.equal(scope.enabled, true); assert.equal(scope.effective, true);
  assert.equal(fs.existsSync(path.join(home, 'reviewer-called')), false, 'smoke checks must not call reviewers');
});
