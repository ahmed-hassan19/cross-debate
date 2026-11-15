// Exercise the bundled relay through every cross-debate dispatch shape, without model calls.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runRelay } from '../skills/cross-debate/scripts/lib/common.mjs';
import { dispatch } from '../skills/cross-debate/scripts/lib/dispatch.mjs';

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'debate-vendor-')));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
for (const key of ['DELEGATE_SKILLS_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS']) delete process.env[key];
Object.assign(process.env, { HOME: path.join(scratch, 'home'), XDG_CONFIG_HOME: path.join(scratch, 'xdg'),
  DEBATE_HOME: path.join(scratch, 'state'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
const bin = path.join(scratch, 'bin');
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.symlinkSync(process.execPath, path.join(bin, 'node'));
process.env.PATH = `${bin}:/usr/bin:/bin`;
fs.writeFileSync(path.join(bin, 'opencode'), `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) console.log(process.env.FAKE_VERSION);
else {
  fs.writeFileSync(process.env.FAKE_ARGV, JSON.stringify(process.argv.slice(2)));
  console.log(JSON.stringify({type:'text',part:{id:'answer',type:'text',text:'review complete'}}));
}
`, { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('codex-cli 0.169.0');
else {
  fs.writeFileSync(process.env.FAKE_ARGV, JSON.stringify(args));
  fs.writeFileSync(args[args.indexOf('-o') + 1], 'review complete');
  console.log(JSON.stringify({type:'thread.started',thread_id:'thread-test'}));
}
`, { mode: 0o755 });
const model = 'cloudflare/@cf/meta/llama';
const configDir = path.join(process.env.XDG_CONFIG_HOME, 'delegate-skills');
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ version: 'delegate-fleet.v1',
  lanes: { reviewer: { implementer: 'opencode', model, variant: 'high' },
    'codex-reviewer': { implementer: 'codex', model: 'review-model', effort: 'high' } } }));

for (const shape of ['plan', 'judge', 'dispatch', 'resume']) {
  test(`bundled Codex: ${shape} suppresses project docs and stays read-only`, () => {
    const dir = fs.mkdtempSync(path.join(scratch, 'codex-'));
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    const init = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    process.env.FAKE_ARGV = path.join(dir, 'argv.json');
    const outDir = path.join(dir, 'output');
    let result;
    if (shape === 'dispatch') {
      const response = dispatch({ role: 'main', who: { implementer: 'codex', dials: { model: 'review-model', effort: 'high' } },
        brief: 'Review only.', cwd: repo, outDir, timeout: '10s' });
      assert.equal(response.text, 'review complete');
      result = JSON.parse(fs.readFileSync(path.join(outDir, 'main', 'result.json')));
    } else {
      const briefPath = path.join(dir, 'brief.md');
      fs.writeFileSync(briefPath, 'Review only.');
      const extraArgs = shape === 'judge' ? ['--model', 'judge-model', '--effort', 'medium']
        : shape === 'resume' ? ['--session', 'thread-test'] : [];
      const response = runRelay({ implementer: 'codex', lane: 'codex-reviewer', briefPath, cwd: repo, outDir,
        timeout: '10s', extraArgs });
      assert.equal(response.exitCode, 0, response.stderrTail);
      result = response.result;
    }
    assert.equal(result.status, 'completed');
    assert.equal(result.finalMessage, 'review complete');
    assert.equal(result.noProjectDoc, true);
    assert.equal(result.ignoreUserConfig, true);
    assert.deepEqual(result.touchedFiles, []);
    const argv = JSON.parse(fs.readFileSync(process.env.FAKE_ARGV));
    const override = argv.indexOf('project_doc_max_bytes=0');
    assert.equal(argv.filter(arg => arg === 'project_doc_max_bytes=0').length, 1);
    assert.equal(argv[override - 1], '-c');
    assert.equal(argv[argv.indexOf('-s') + 1], 'read-only');
    assert.equal(argv[argv.indexOf('-m') + 1], shape === 'judge' ? 'judge-model' : 'review-model');
    if (shape === 'resume') {
      assert.equal(argv[argv.indexOf('resume') + 1], 'thread-test');
      assert.ok(override > argv.indexOf('resume'));
    }
  });
}

for (const version of ['1.17.13', '2.2.5']) for (const shape of ['plan', 'judge', 'dispatch']) {
  test(`bundled OpenCode ${version}: ${shape} dials and read-only completion`, () => {
    const dir = fs.mkdtempSync(path.join(scratch, 'case-'));
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    const git = args => {
      const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    git(['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(repo, 'source.txt'), 'unchanged\n');
    git(['add', '.']);
    git(['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init']);
    const head = git(['rev-parse', 'HEAD']);
    Object.assign(process.env, { FAKE_VERSION: version, FAKE_ARGV: path.join(dir, 'argv.json') });
    const variant = shape === 'plan' ? 'high' : 'low';
    const outDir = path.join(dir, 'output');
    let result;
    if (shape === 'dispatch') {
      const response = dispatch({ role: 'main', who: { implementer: 'opencode', dials: { model, variant } },
        brief: 'Review only.', cwd: repo, outDir, timeout: '10s' });
      assert.equal(response.text, 'review complete');
      result = JSON.parse(fs.readFileSync(path.join(outDir, 'main', 'result.json')));
    } else {
      const briefPath = path.join(dir, 'brief.md');
      fs.writeFileSync(briefPath, 'Review only.');
      const response = runRelay({ implementer: 'opencode', lane: 'reviewer', briefPath, cwd: repo, outDir,
        timeout: '10s', extraArgs: shape === 'judge' ? ['--model', model, '--variant', variant] : [] });
      assert.equal(response.exitCode, 0, response.stderrTail);
      result = response.result;
    }
    assert.equal(result.status, 'completed');
    assert.equal(result.finalMessage, 'review complete');
    assert.notEqual(result.readOnlyViolation, true);
    const argv = JSON.parse(fs.readFileSync(process.env.FAKE_ARGV));
    assert.equal(argv[argv.indexOf('--model') + 1], version.startsWith('2') ? `${model}#${variant}` : model);
    assert.equal(argv.includes('--variant'), version.startsWith('1'));
    if (version.startsWith('1')) assert.equal(argv[argv.indexOf('--variant') + 1], variant);
    assert.equal(argv[argv.indexOf('--agent') + 1], 'plan');
    assert.equal(argv.includes('--auto'), false);
    assert.equal(git(['status', '--porcelain']), '');
    assert.equal(git(['rev-parse', 'HEAD']), head);
    assert.equal(fs.readFileSync(path.join(repo, 'source.txt'), 'utf8'), 'unchanged\n');
  });
}
