// End to end through the REAL n8n (installed by scripts/install.sh into a throw-away folder). Skipped when the runtime is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runHunt } from '../scripts/hunt.mjs';
import { tmpdir, writeProfile, startFakeWorld, startFakeSmtp, baseEnv, findNodemailer } from './helpers.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = process.env.JOBHUNT_RUNTIME || path.join(os.homedir(), '.n8n-morning-brief');
const have = fs.existsSync(path.join(runtime, 'node_modules/.bin/n8n')) && findNodemailer();
const skip = have ? false : 'n8n runtime not found';
const PATH = `${runtime}/.runtime/node/bin:${runtime}/node_modules/.bin:${process.env.PATH}`;

test('install.sh + a real n8n run: same outcome as the direct engine, and a re-install replaces the workflow', { skip, timeout: 180000 }, async () => {
  const home = tmpdir('jh-n8n-');
  const world = await startFakeWorld({ jobs: [
    { title: 'A 数据分析实习生', company: 'Acme', snippet: '[score:9] 简历请发 hr@acme-corp.com' },
    { title: 'B 数据分析助理', company: 'Beta', snippet: '[score:9] 请在官网投递。' },
    { title: 'C 销售代表', company: 'Gamma', snippet: '[score:3] 驻外销售。' },
  ] });
  const smtp = await startFakeSmtp();
  try {
    const inst = spawnSync('bash', [path.join(root, 'install.sh'), '--no-schedule'], { env: { ...process.env, PATH, JOBHUNT_HOME: home, JOBHUNT_RUNTIME: runtime }, encoding: 'utf8' });
    assert.equal(inst.status, 0, inst.stderr + inst.stdout);
    writeProfile(home); // overwrite the template with a filled profile
    const env = { PATH, JOBHUNT_RUNTIME: runtime, ...baseEnv(home, world, smtp), N8N_PORT: '5791' };
    const r = await runHunt({ env, args: [], notifier: () => {}, log: () => {} });
    assert.equal(r.code, 0, r.message);
    assert.equal(smtp.mails.length, 1);
    assert.deepEqual(smtp.mails[0].to, ['hr@acme-corp.com']);
    assert.equal(r.plan.items.length, 3);
    assert.equal(r.plan.build, fs.readFileSync(path.join(home, 'workflows/BUILD'), 'utf8').trim());
    assert.match(r.report, /已邮件投递 1/);

    // a re-imported (changed) workflow must be what n8n runs next time: stamp a new build into it and import it over the old one
    const wfFile = path.join(home, 'workflows/job-hunter.json');
    const old = fs.readFileSync(path.join(home, 'workflows/BUILD'), 'utf8').trim();
    fs.writeFileSync(wfFile, fs.readFileSync(wfFile, 'utf8').split(old).join('v2probe00000'));
    fs.writeFileSync(path.join(home, 'workflows/BUILD'), 'v2probe00000\n');
    const imp = spawnSync('n8n', ['import:workflow', `--input=${wfFile}`], { env: { ...process.env, PATH, N8N_USER_FOLDER: path.join(home, 'data/n8n') }, encoding: 'utf8' });
    assert.equal(imp.status, 0, imp.stderr);
    const r2 = await runHunt({ env, args: ['--force'], notifier: () => {}, log: () => {} });
    assert.equal(r2.code, 0, r2.message);
    assert.equal(r2.plan.build, 'v2probe00000');                            // the NEW version ran, not the one imported before
    assert.equal(smtp.mails.length, 1);                                    // and nothing was sent twice
  } finally { await world.close(); await smtp.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
