import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const shellFiles = ['install.sh', 'uninstall.sh', 'get.sh', ...fs.readdirSync(path.join(root, 'scripts')).filter((f) => f.endsWith('.sh') || f === 'jobhunt').map((f) => `scripts/${f}`)].filter((f) => fs.existsSync(path.join(root, f)));

test('every shell script parses', () => {
  for (const f of shellFiles) { const r = spawnSync('bash', ['-n', path.join(root, f)], { encoding: 'utf8' }); assert.equal(r.status, 0, `${f}: ${r.stderr}`); }
});

test('no $VAR is directly followed by a full-width character (bash would read it as part of the name and fail under set -u)', () => {
  for (const f of shellFiles) {
    const bad = fs.readFileSync(path.join(root, f), 'utf8').split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\$[A-Za-z_][A-Za-z0-9_]*[（）：，。、；！？「」]/.test(l));
    assert.deepEqual(bad, [], `${f}: write \${VAR} instead: ${JSON.stringify(bad)}`);
  }
});

test('the committed workflow is exactly what the sources build (and BUILD matches it)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-build-'));
  for (const d of ['scripts', 'workflows/src']) fs.cpSync(path.join(root, d), path.join(tmp, d), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'workflows'), { recursive: true });
  const r = spawnSync(process.execPath, [path.join(tmp, 'scripts/build-workflow.mjs')], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr);
  for (const f of ['job-hunter.json', 'BUILD']) assert.equal(fs.readFileSync(path.join(tmp, 'workflows', f), 'utf8'), fs.readFileSync(path.join(root, 'workflows', f), 'utf8'), `${f} is stale: run node scripts/build-workflow.mjs`);
});

test('the lock file matches package.json (npm ci will accept it)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
});

test('workflow stage code only uses what the n8n Code-node sandbox provides (no URL, fetch, AbortSignal ...)', () => {
  // Found the hard way: `new URL(...)` threw a ReferenceError inside n8n (but works in plain Node), and a catch swallowed it.
  const dir = path.join(root, 'workflows/src'); const files = [...fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f)), ...fs.readdirSync(path.join(dir, 'lib')).map((f) => path.join(dir, 'lib', f))];
  for (const f of files) {
    const code = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    const m = code.match(/\bnew URL\b|\bURLSearchParams\b|\bAbortSignal\b|\bstructuredClone\b|[^.\w]fetch\(|\bTextDecoder\b|\bBuffer\.from\(/);
    assert.equal(m, null, `${path.relative(root, f)} uses ${m && m[0]}, which is not available in n8n's sandbox`);
  }
});

test('install.sh reads the previously chosen run time back from the settings file (the line schedule.sh writes)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-time-'));
  fs.writeFileSync(path.join(home, 'config.local.env'), "AI_MODEL='m'\nHUNT_TIME='09:30'\n");
  const line = fs.readFileSync(path.join(root, 'install.sh'), 'utf8').split('\n').find((l) => l.includes('sed -n "s/^HUNT_TIME='));
  assert.ok(line, 'the extraction line exists');
  const r = spawnSync('bash', ['-c', `HOME_DIR=${JSON.stringify(home)}; TIME=""; ${line}; echo "$TIME"`], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), '09:30', r.stderr);
  const w = spawnSync('bash', ['-c', `HOME_DIR=${JSON.stringify(path.join(home, 'nope'))}; TIME=""; ${line}; echo "[$TIME]"`], { encoding: 'utf8' });
  assert.equal(w.stdout.trim(), '[]');
  // what schedule.sh writes keeps every other line and the file private
  const cfg = path.join(home, 'config.local.env');
  const write = fs.readFileSync(path.join(root, 'scripts/schedule.sh'), 'utf8').split('\n').filter((l) => /CFG=|CFG\.new/.test(l)).join('\n');
  const s = spawnSync('bash', ['-euo', 'pipefail', '-c', `umask 077; HOME_DIR=${JSON.stringify(home)}; TIME=07:15\n${write}`], { encoding: 'utf8' });
  assert.equal(s.status, 0, s.stderr);
  assert.equal(fs.readFileSync(cfg, 'utf8'), "AI_MODEL='m'\nHUNT_TIME='07:15'\n"); assert.equal(fs.statSync(cfg).mode & 0o777, 0o600);
});

test('the console page never builds HTML from strings (third-party text is only ever text)', () => {
  for (const f of ['scripts/console/app.js', 'scripts/console/index.html']) {
    const code = fs.readFileSync(path.join(root, f), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    const m = code.match(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|createContextualFragment|\bon[a-z]+\s*=\s*["']/);
    assert.equal(m, null, `${f} uses ${m && m[0]}`);
  }
});
