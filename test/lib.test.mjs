import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { acquireLock, lockBusy } from '../scripts/lib/lock.mjs';
import { parseProfile, renderProfile, validateProfile, emptyProfile } from '../scripts/lib/profile.mjs';
import { parseConfig, applyChanges, loadConfig, SECRET_KEYS, SECRET } from '../scripts/lib/config.mjs';
import { tmpdir, TEST_PROFILE, loadCommon } from './helpers.mjs';
import http from 'node:http';
import { makeHttp } from '../scripts/engine.mjs';
import { REGIONS, searchLocation } from '../scripts/lib/regions.mjs';

test('lock: a second holder is refused, release frees it, and a killed holder frees it too', async () => {
  const dir = tmpdir('jh-lock-');
  const a = await acquireLock(dir, 'one'); assert.equal(a.ok, true);
  assert.equal(lockBusy(dir), true);
  const b = await acquireLock(dir, 'two'); assert.equal(b.ok, false); assert.match(b.holder, /one/);
  await a.release(); assert.equal(lockBusy(dir), false);
  const c = await acquireLock(dir, 'three'); assert.equal(c.ok, true); await c.release();
  // a process that dies without releasing must not leave the lock behind
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { acquireLock } from ${JSON.stringify(path.resolve('scripts/lib/lock.mjs'))}; const l = await acquireLock(${JSON.stringify(dir)}, 'child'); console.log(l.ok ? 'held' : 'no'); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => child.stdout.once('data', r)); assert.equal(lockBusy(dir), true);
  child.kill('SIGKILL'); await new Promise((r) => child.once('exit', r));
  for (let i = 0; i < 50 && lockBusy(dir); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(lockBusy(dir), false);
});

test('profile: render/parse round trip, old template counts as empty, validation', () => {
  assert.deepEqual(parseProfile(renderProfile(TEST_PROFILE)), TEST_PROFILE);
  const template = fs.readFileSync(path.resolve('profile.example.md'), 'utf8');
  assert.deepEqual(parseProfile(template), emptyProfile());
  assert.ok(validateProfile(parseProfile(template)).length >= 4);
  assert.deepEqual(validateProfile(TEST_PROFILE), []);
  assert.deepEqual(validateProfile({ ...TEST_PROFILE, email: 'x' }).map((m) => m.field), ['email']);
  // text that looks like markup or headings in a free-text field cannot break the structure
  const tricky = { ...TEST_PROFILE, experience: '做过 A\n\n### 子标题\n- 一条\n> 引用' };
  assert.equal(parseProfile(renderProfile(tricky)).experience.includes('子标题'), true);
});

test('config: strict parsing, atomic private writes, backup, removal', () => {
  const parsed = parseConfig("AI_API_KEY='k'\nrm -rf /\nUNKNOWN='x'\nMIN_SCORE=7\n# c\nSMTP_HOST=\"h\"\nAI_MODEL='a'b'\n");
  assert.deepEqual(parsed.values, { AI_API_KEY: 'k', MIN_SCORE: '7', SMTP_HOST: 'h' });
  assert.deepEqual(parsed.errors, [2, 3, 7]);
  const home = tmpdir('jh-cfg-');
  applyChanges(home, { AI_MODEL: 'm1', MIN_SCORE: '8' });
  applyChanges(home, { AI_MODEL: 'm2', MIN_SCORE: null });
  const f = path.join(home, 'config.local.env');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(loadConfig(home).values, { AI_MODEL: 'm2' });
  assert.match(fs.readFileSync(`${f}.bak`, 'utf8'), /m1/);
  assert.throws(() => applyChanges(home, { AI_MODEL: "it's" }), /quotes/);
  assert.throws(() => applyChanges(home, { NOT_A_KEY: 'x' }), /unknown/);
  assert.deepEqual(fs.readdirSync(home).filter((n) => n.includes('.tmp-')), [], 'no temp files left behind');
});

test('lock: when no lock tool works the answer is an error, not "held by someone else"', async () => {
  const dir = tmpdir('jh-lock-');
  const r = spawn(process.execPath, ['--input-type=module', '-e', `import { acquireLock, lockBusy } from ${JSON.stringify(path.resolve('scripts/lib/lock.mjs'))}; const l = await acquireLock(${JSON.stringify(dir)}, 'x'); console.log(JSON.stringify({ ok: l.ok, error: !!l.error, busy: lockBusy(${JSON.stringify(dir)}) }));`], { env: { ...process.env, JOBHUNT_LOCK_TOOL: '/nonexistent/lockf' }, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = ''; r.stdout.on('data', (d) => { out += d; }); await new Promise((res) => r.once('exit', res));
  assert.deepEqual(JSON.parse(out), { ok: false, error: true, busy: false });
});

test('the region table used by the console is the one baked into the workflow code', () => {
  const src = fs.readFileSync(path.resolve('workflows/src/lib/common.js'), 'utf8');
  const line = src.split('\n').find((l) => l.startsWith('const REGIONS = '));
  const baked = new Function(`${line.replace(/^const REGIONS = /, 'return ')}`)();   // the object literal itself
  assert.deepEqual(baked, REGIONS);
  assert.equal(searchLocation({}), 'Hong Kong'); assert.equal(searchLocation({ JOB_REGION: 'sg' }), 'Singapore');
  assert.equal(searchLocation({ JOB_REGION: 'sg', JOB_LOCATION: 'Jurong' }), 'Jurong'); assert.equal(searchLocation({ JOB_REGION: 'global' }), '');
  assert.equal(searchLocation({ JOB_REGION: 'atlantis' }), 'Hong Kong');
});

test('profile: the shipped template filled in by hand (headings with a note in brackets) is read; "## " inside a text field stays text', () => {
  const tpl = fs.readFileSync(path.resolve('profile.example.md'), 'utf8');
  assert.match(tpl, /^## 求职意向（/m, 'the template heading this test is about');
  const filled = tpl.replace('姓名：待填写', '姓名：张三').replace('邮箱：待填写', '邮箱：z@example.com').replace(/想找的岗位：待填写[^\n]*/, '想找的岗位：数据分析实习生').replace(/## 技能\n待填写[^\n]*/, '## 技能\nPython、SQL、Tableau，熟悉数据清洗、可视化与 A/B 测试，英语 CET-6。');
  const p = parseProfile(filled);
  assert.equal(p.role, '数据分析实习生'); assert.deepEqual(validateProfile(p), []);
  const tricky = { ...TEST_PROFILE, experience: '2023 实习\n## 不是标题\n- 做过报表', other: '## 技能 不是一个新节' };
  assert.deepEqual(parseProfile(renderProfile(tricky)), tricky);
  assert.equal(parseProfile(renderProfile(tricky).replace(/\n/g, '\r\n')).experience, tricky.experience);   // CRLF files too
});

test('which settings are secrets: keys, passwords, webhooks and feed links, but not the search keywords', () => {
  assert.deepEqual(SECRET_KEYS.sort(), ['AI_API_KEY', 'DISCORD_WEBHOOK_URL', 'JOB_RSS_URLS', 'JOOBLE_API_KEY', 'MAILBOXLAYER_API_KEY', 'SERPER_API_KEY', 'SMTP_PASS']);
  assert.equal(SECRET.test('JOB_KEYWORDS'), false);
});

test('which links a posting page may be fetched from: public DNS names and plain public IPs only, whatever the spelling', () => {
  const { fetchable, canonicalUrl } = loadCommon({});
  for (const ok of ['https://boards.greenhouse.io/acme/jobs/1', 'http://jobs.example-corp.com:8080/x?y=1', 'https://93.184.216.34/p', 'https://1password.com/jobs']) assert.equal(fetchable(ok), true, ok);
  for (const bad of ['http://127.0.0.1/', 'http://127.0.0.1./', 'http://127.1/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/', 'http://2130706433/', 'http://localhost/', 'http://localhost./', 'http://intranet/', 'http://router.lan/', 'http://x.local/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://user@127.0.0.1/', 'http://a@b.com/', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://169.254.169.254/latest', 'http://100.64.0.1/', 'ftp://x.com/', 'javascript:alert(1)', 'https://evil.test/', 'https://x.example/']) assert.equal(fetchable(bad), false, bad);
  assert.equal(loadCommon({ JOBHUNT_ALLOW_LOCAL_FETCH: 'on' }).fetchable('http://127.0.0.1:1234/job/x'), true, 'tests may fetch their fake pages');
  assert.equal(canonicalUrl('https://jooble.org/desc/123?ckey=a&pos=1'), 'https://jooble.org/desc/123');
  assert.equal(canonicalUrl('https://example.com/j/1?id=7&utm_source=x'), 'https://example.com/j/1?id=7');
});

test('the direct engine understands the n8n options a stage uses to walk redirects itself', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/bounce') { res.writeHead(302, { Location: '/final' }); return res.end(); }
    if (req.url === '/missing') { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('gone'); }
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('final page');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`; const h = makeHttp();
  try {
    const r = await h({ url: `${base}/bounce`, disableFollowRedirect: true, returnFullResponse: true, ignoreHttpStatusErrors: true });
    assert.equal(r.statusCode, 302); assert.equal(r.headers.location, '/final');                      // not followed: the stage decides
    assert.equal(await h({ url: `${base}/bounce` }), 'final page', 'without the option redirects are simply followed');
    assert.equal((await h({ url: `${base}/missing`, returnFullResponse: true, ignoreHttpStatusErrors: true })).body, 'gone');
    await assert.rejects(h({ url: `${base}/missing` }), /404/);
  } finally { srv.close(); }
});
