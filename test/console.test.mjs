import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createServer, makeContext } from '../scripts/console.mjs';
import { startSink, sinkCount } from '../scripts/lib/sink.mjs';
import { applyChanges } from '../scripts/lib/config.mjs';
import { renderProfile } from '../scripts/lib/profile.mjs';
import { tmpdir, startFakeWorld, startFakeSmtp, findNodemailer, TEST_PROFILE } from './helpers.mjs';

const nm = findNodemailer();
const TOKEN = 'a'.repeat(48);
const SECRET = 'test-secret-value-123456-not-a-real-key';

async function boot(opts = {}) {
  const home = tmpdir('jh-console-'); fs.mkdirSync(home, { recursive: true });
  const ctx = makeContext({ home, label: 'com.test.never-installed', env: { ...process.env, JOBHUNT_RUNTIME: nm && nm.dir, JOBHUNT_ENGINE: 'direct' }, ...opts });
  const server = createServer(ctx, { token: TOKEN, port: 0 });
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const call = async (method, url, body, { cookie = true, header = true, host, raw } = {}) => {
    const headers = { Host: host || `127.0.0.1:${port}` };
    if (cookie) headers.Cookie = `jobhunt_console=${TOKEN}`;
    if (header && method !== 'GET') headers['X-Jobhunt-Console'] = '1';
    let payload; if (raw) { payload = raw; headers['Content-Type'] = 'application/pdf'; } else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers, body: payload, redirect: 'manual' });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) { /* html */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  return { home, ctx, call, port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

test('access control: token cookie, Host check, custom header, CSP', async () => {
  const c = await boot();
  try {
    assert.equal((await c.call('GET', '/api/state', undefined, { cookie: false })).status, 403);
    const hostStatus = await new Promise((resolve, reject) => { const q = http.request({ host: '127.0.0.1', port: c.port, path: '/api/state', headers: { Host: 'evil.example:80', Cookie: `jobhunt_console=${TOKEN}` } }, (res) => { res.resume(); resolve(res.statusCode); }); q.on('error', reject); q.end(); });
    assert.equal(hostStatus, 421);                                                                          // DNS rebinding
    const bad = await fetch(`http://127.0.0.1:${c.port}/?t=wrong`, { redirect: 'manual' }); assert.equal(bad.status, 403);
    const good = await fetch(`http://127.0.0.1:${c.port}/?t=${TOKEN}`, { redirect: 'manual' });
    assert.equal(good.status, 303); assert.match(good.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await c.call('PUT', '/api/settings', { changes: {} }, { header: false })).status, 403);   // a plain web form cannot add the header
    const page = await c.call('GET', '/');
    assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.ok(!/<script>[^<]/.test(page.text), 'no inline script');
  } finally { await c.close(); }
});

test('secrets never reach the browser; invalid settings change nothing; the file is private', async () => {
  const c = await boot();
  try {
    const ok = await c.call('PUT', '/api/settings', { changes: { AI_API_KEY: SECRET, AI_BASE_URL: 'https://api.example.com/', AI_MODEL: 'deepseek-chat', MIN_SCORE: '8', JOB_RSS_URLS: 'https://rss.app/feeds/abc.xml' } });
    assert.equal(ok.json.ok, true);
    const file = path.join(c.home, 'config.local.env');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const everything = [(await c.call('GET', '/api/settings')).text, (await c.call('GET', '/api/state')).text, (await c.call('GET', '/api/jobs')).text, (await c.call('GET', '/api/log')).text].join('\n');
    assert.ok(!everything.includes(SECRET), 'secret leaked');
    assert.ok(!everything.includes('rss.app/feeds/abc'), 'rss link leaked');
    const f = (await c.call('GET', '/api/settings')).json.fields.find((x) => x.key === 'AI_API_KEY');
    assert.deepEqual([f.set, f.value], [true, null]);
    // trailing slash is normalised; a blank secret keeps the old one; null clears it
    assert.match(fs.readFileSync(file, 'utf8'), /AI_BASE_URL='https:\/\/api\.example\.com'/);
    const before = fs.readFileSync(file, 'utf8');
    const bad = await c.call('PUT', '/api/settings', { changes: { MIN_SCORE: '99', SMTP_HOST: "bad'host", AI_BASE_URL: 'http://evil.example.com', NOPE: 'x', AI_MODEL: 'fine' } });
    assert.equal(bad.status, 400);
    assert.deepEqual(Object.keys(bad.json.errors).sort(), ['AI_BASE_URL', 'MIN_SCORE', 'NOPE', 'SMTP_HOST']);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'nothing may be written when any value is invalid');
    await c.call('PUT', '/api/settings', { changes: { AI_API_KEY: null } });
    assert.ok(!fs.readFileSync(file, 'utf8').includes('AI_API_KEY'));
  } finally { await c.close(); }
});

test('profile round trip through the form, and what is still missing', async () => {
  const c = await boot();
  try {
    const empty = await c.call('GET', '/api/profile');
    assert.ok(empty.json.missing.length >= 3);
    const saved = await c.call('PUT', '/api/profile', { profile: TEST_PROFILE });
    assert.deepEqual(saved.json.missing, []);
    const back = await c.call('GET', '/api/profile');
    assert.deepEqual(back.json.profile, TEST_PROFILE);
    assert.equal(fs.readFileSync(path.join(c.home, 'profile.md'), 'utf8'), renderProfile(TEST_PROFILE));
    const half = await c.call('PUT', '/api/profile', { profile: { ...TEST_PROFILE, email: 'not-an-email', skills: '', education: '', experience: '' } });
    assert.deepEqual(half.json.missing.map((m) => m.field).sort(), ['email', 'skills']);
  } finally { await c.close(); }
});

test('job lists and the buttons: applied, dismissed, reopen; sent and skipped are final', async () => {
  const c = await boot();
  try {
    const id = (n) => n.repeat(16);
    c.ctx.appendEvent({ id: id('a'), status: 'manual', title: 'T1', company: 'Co', url: 'https://x.example/1', score: 8, reason: 'ok' });
    c.ctx.appendEvent({ id: id('b'), status: 'sent', title: 'T2', to: 'hr@co.com', subject: 'S' });
    c.ctx.appendEvent({ id: id('c'), status: 'skipped', title: 'T3', score: 2 });
    c.ctx.appendEvent({ id: id('d'), status: 'unknown', title: 'T4', to: 'x@y.com', note: 'maybe' });
    c.ctx.appendEvent({ id: id('e'), status: 'manual', title: 'Evil', url: 'javascript:alert(1)' });
    const jobs = (await c.call('GET', '/api/jobs')).json;
    assert.deepEqual(jobs.counts, { todo: 2, sent: 1, attention: 1, done: 0, skipped: 1 });
    assert.equal(jobs.jobs.find((j) => j.title === 'Evil').url, '', 'only http(s) links reach the page');
    assert.equal((await c.call('POST', '/api/jobs/action', { id: id('a'), action: 'applied' })).json.ok, true);
    assert.equal((await c.call('GET', '/api/jobs')).json.jobs.find((j) => j.id === id('a')).title, 'T1', 'the earlier details survive the new event');
    assert.deepEqual((await c.call('GET', '/api/jobs')).json.counts, { todo: 1, sent: 1, attention: 1, done: 1, skipped: 1 });
    assert.equal((await c.call('POST', '/api/jobs/action', { id: id('a'), action: 'reopen' })).json.ok, true);
    assert.equal((await c.call('POST', '/api/jobs/action', { id: id('b'), action: 'dismissed' })).status, 400);
    assert.equal((await c.call('POST', '/api/jobs/action', { id: id('c'), action: 'applied' })).status, 400);
    assert.equal((await c.call('POST', '/api/jobs/action', { id: '../../etc', action: 'applied' })).status, 400);
    assert.equal((await c.call('POST', '/api/jobs/action', { id: id('f'), action: 'applied' })).status, 404);
    assert.equal((await c.call('GET', '/api/mail?id=../../x')).status, 400);
  } finally { await c.close(); }
});

test('resume upload: only PDFs, private file named after the profile, RESUME_FILE set', async () => {
  const c = await boot();
  try {
    await c.call('PUT', '/api/profile', { profile: TEST_PROFILE });
    assert.equal((await c.call('POST', '/api/resume', undefined, { raw: Buffer.from('x'.repeat(500)) })).status, 400);
    const r = await c.call('POST', '/api/resume', undefined, { raw: Buffer.from(`%PDF-1.4\n${'x'.repeat(300)}`) });
    assert.equal(r.json.ok, true); assert.equal(r.json.name, '测试同学-简历.pdf');
    const file = path.join(c.home, 'profile', r.json.name);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(path.join(c.home, 'config.local.env'), 'utf8'), /RESUME_FILE='[^']*测试同学-简历\.pdf'/);
    assert.equal((await c.call('GET', '/api/settings')).json.resume.exists, true);
  } finally { await c.close(); }
});

test('the checklist follows the settings, and "ready" needs profile + AI + a source', async () => {
  const c = await boot();
  try {
    let st = (await c.call('GET', '/api/state')).json; assert.equal(st.ready, false);
    await c.call('PUT', '/api/profile', { profile: TEST_PROFILE });
    await c.call('PUT', '/api/settings', { changes: { AI_BASE_URL: 'https://api.example.com', AI_API_KEY: SECRET } });
    st = (await c.call('GET', '/api/state')).json; assert.equal(st.ready, false);
    await c.call('PUT', '/api/settings', { changes: { REMOTIVE: 'on' } });
    st = (await c.call('GET', '/api/state')).json; assert.equal(st.ready, true);
    assert.equal(st.checklist.find((i) => i.id === 'mail').ok, false);   // optional: not needed to be ready
    assert.equal((await c.call('POST', '/api/schedule', { time: '25:99' })).status, 400);
    // region: Hong Kong is the default, any listed region can be chosen and changed again, an unknown one is refused
    const region = async () => (await c.call('GET', '/api/settings')).json.fields.find((f) => f.key === 'JOB_REGION');
    assert.deepEqual([(await region()).default, (await region()).value], ['hk', '']);
    assert.match(st.checklist.find((i) => i.id === 'sources').detail, /地区：香港/);
    for (const r of ['sg', 'global', 'hk', 'us']) { assert.equal((await c.call('PUT', '/api/settings', { changes: { JOB_REGION: r } })).json.ok, true); assert.equal((await region()).value, r); }
    assert.match((await c.call('GET', '/api/state')).json.checklist.find((i) => i.id === 'sources').detail, /地区：美国/);
    assert.equal((await c.call('PUT', '/api/settings', { changes: { JOB_REGION: 'atlantis' } })).status, 400);
  } finally { await c.close(); }
});

test('settings tests, mail test and a real run from the console against local fakes', { skip: nm ? false : 'nodemailer not found' }, async () => {
  const c = await boot();
  const world = await startFakeWorld({ jobs: [
    { title: 'A 数据分析实习生', company: 'Acme', snippet: '[score:9] 简历请发 hr@acme-corp.com' },
    { title: 'B 数据分析助理', company: 'Beta', snippet: '[score:9] 请在官网投递。' },
  ] });
  const smtp = await startFakeSmtp();
  try {
    await c.call('PUT', '/api/profile', { profile: TEST_PROFILE });
    await c.call('POST', '/api/resume', undefined, { raw: Buffer.from(`%PDF-1.4\n${'x'.repeat(300)}`) });
    applyChanges(c.home, { AI_BASE_URL: `${world.base}/ai`, AI_API_KEY: SECRET, AI_MODEL: 'm', AI_DELAY_MS: '0', JOB_KEYWORDS: '数据分析', JOOBLE_API_KEY: 'k', JOOBLE_API_BASE: `${world.base}/jooble`, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURE: 'off', SMTP_FROM: 'tester@example.org' });
    const ai = (await c.call('POST', '/api/test', { what: 'ai' })).json; assert.equal(ai.ok, true, ai.message);
    applyChanges(c.home, { AI_MODEL: 'no-such-model' });
    const wrong = (await c.call('POST', '/api/test', { what: 'ai' })).json; assert.equal(wrong.ok, false); assert.match(wrong.message, /no-such-model/);
    applyChanges(c.home, { AI_MODEL: 'm' });
    const jobs = (await c.call('POST', '/api/test', { what: 'jobs' })).json; assert.equal(jobs.ok, true, jobs.message); assert.match(jobs.items[0].message, /2 个岗位/);
    assert.equal((await c.call('POST', '/api/test', { what: 'smtp' })).json.ok, true);
    const mail = (await c.call('POST', '/api/test', { what: 'mail' })).json; assert.equal(mail.ok, true, mail.message);
    assert.deepEqual(smtp.mails[0].to, ['tester@example.org']); assert.match(smtp.mails[0].raw, /filename/);

    // dry run: nothing sent, nothing recorded
    assert.equal((await c.call('POST', '/api/run', { mode: 'dry' })).json.ok, true);
    await waitDone(c);
    assert.equal(smtp.mails.length, 1);
    assert.ok(!fs.existsSync(path.join(c.home, 'data', 'applications.jsonl')));
    // real run
    assert.equal((await c.call('POST', '/api/run', { mode: 'real' })).json.ok, true);
    const run = await waitDone(c);
    assert.equal(run.code, 0, run.lines.join('\n'));
    assert.equal(smtp.mails.length, 2, 'one application mail on top of the test mail');
    assert.deepEqual(smtp.mails[1].to, ['hr@acme-corp.com']);
    assert.ok(!run.lines.join('\n').includes(SECRET));
    const view = (await c.call('GET', '/api/jobs')).json;
    assert.deepEqual([view.counts.sent, view.counts.todo], [1, 1]);
    const todo = view.jobs.find((j) => j.group === 'todo'); assert.match(todo.url, /\/job\/B/);   // the page to apply on is named
    const sentJob = view.jobs.find((j) => j.group === 'sent');
    assert.match((await c.call('GET', `/api/mail?id=${sentJob.id}`)).json.text, /应聘数据分析实习生/);
    const st = (await c.call('GET', '/api/state')).json; assert.equal(st.lastRun.result, 'ok'); assert.equal(st.doneToday, true);
    assert.match((await c.call('GET', '/api/reports')).json.dates[0], /^\d{4}-\d{2}-\d{2}$/);
  } finally { await world.close(); await smtp.close(); await c.close(); }
});

async function waitDone(c) {
  for (let i = 0; i < 200; i++) { const r = (await c.call('GET', '/api/run')).json; if (!r.running && r.code !== null) return r; await new Promise((x) => setTimeout(x, 100)); }
  const r = (await c.call('GET', '/api/run')).json; throw new Error(`run did not finish: ${JSON.stringify(r)}`);
}

test('everything can be edited again and again: profile, settings, secrets, test mode, and every button has an undo', async () => {
  const c = await boot();
  try {
    for (const role of ['数据分析', '后端开发', '产品运营']) {
      assert.equal((await c.call('PUT', '/api/profile', { profile: { ...TEST_PROFILE, role } })).json.ok, true);
      assert.equal((await c.call('GET', '/api/profile')).json.profile.role, role);
    }
    for (const [model, score] of [['m1', '6'], ['m2', '9'], ['m3', '7']]) {
      assert.equal((await c.call('PUT', '/api/settings', { changes: { AI_MODEL: model, MIN_SCORE: score } })).json.ok, true);
    }
    const f = (await c.call('GET', '/api/settings')).json.fields; assert.equal(f.find((x) => x.key === 'AI_MODEL').value, 'm3');
    // a secret can be replaced, kept (blank = untouched), cleared and set again
    await c.call('PUT', '/api/settings', { changes: { AI_API_KEY: 'first-secret-value' } });
    await c.call('PUT', '/api/settings', { changes: { AI_MODEL: 'm4' } });
    assert.match(fs.readFileSync(path.join(c.home, 'config.local.env'), 'utf8'), /AI_API_KEY='first-secret-value'/);
    await c.call('PUT', '/api/settings', { changes: { AI_API_KEY: 'second-secret-value' } });
    await c.call('PUT', '/api/settings', { changes: { AI_API_KEY: null } });
    await c.call('PUT', '/api/settings', { changes: { AI_API_KEY: 'third-secret-value' } });
    assert.match(fs.readFileSync(path.join(c.home, 'config.local.env'), 'utf8'), /AI_API_KEY='third-secret-value'/);
    // test mode on, changed, off, on again
    for (const to of ['a@x.com', 'b@x.com', null, 'c@x.com']) {
      await c.call('PUT', '/api/settings', { changes: { MAIL_REDIRECT_TO: to } });
      assert.equal((await c.call('GET', '/api/state')).json.test.redirect, to || '');
    }
    assert.equal((await c.call('PUT', '/api/settings', { changes: { MAIL_REDIRECT_TO: 'not-an-email' } })).status, 400);
    // every status change on a posting can be undone, in any order
    const id = 'e'.repeat(16); c.ctx.appendEvent({ id, status: 'manual', title: 'T', url: 'https://x.example' });
    for (const a of ['applied', 'reopen', 'dismissed', 'reopen', 'applied', 'reopen']) assert.equal((await c.call('POST', '/api/jobs/action', { id, action: a })).json.ok, true, a);
    assert.equal((await c.call('GET', '/api/jobs')).json.jobs.find((j) => j.id === id).status, 'manual');
    // a posting whose mail may have gone out can be marked handled by the user, and put back
    const u = 'f'.repeat(16); c.ctx.appendEvent({ id: u, status: 'unknown', title: 'U', to: 'x@y.com' });
    assert.equal((await c.call('POST', '/api/jobs/action', { id: u, action: 'applied' })).json.ok, true);
    assert.equal((await c.call('POST', '/api/jobs/action', { id: u, action: 'reopen' })).json.ok, true);
  } finally { await c.close(); }
});

test('test mode in the console: shown as redirected, "clear test records" frees those postings, real ones stay', { skip: nm ? false : 'nodemailer not found' }, async () => {
  const c = await boot();
  const world = await startFakeWorld({ jobs: [{ title: 'A 数据分析实习生', company: 'Acme', snippet: '[score:9] 简历请发 hr@acme-corp.com' }] });
  const smtp = await startFakeSmtp();
  try {
    await c.call('PUT', '/api/profile', { profile: TEST_PROFILE });
    await c.call('POST', '/api/resume', undefined, { raw: Buffer.from(`%PDF-1.4\n${'x'.repeat(300)}`) });
    applyChanges(c.home, { AI_BASE_URL: `${world.base}/ai`, AI_API_KEY: SECRET, AI_MODEL: 'm', AI_DELAY_MS: '0', JOB_KEYWORDS: 'x', JOOBLE_API_KEY: 'k', JOOBLE_API_BASE: `${world.base}/jooble`, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURE: 'off', SMTP_FROM: 'tester@example.org', MAIL_REDIRECT_TO: 'me@example.net' });
    c.ctx.appendEvent({ id: '9'.repeat(16), status: 'manual', title: 'Real todo', url: 'https://x.example/real' });   // not a test record
    assert.equal((await c.call('POST', '/api/run', { mode: 'real' })).json.ok, true); await waitDone(c);
    const sent = (await c.call('GET', '/api/jobs')).json.jobs.find((j) => j.group === 'sent');
    assert.deepEqual([sent.redirected, sent.to, sent.intendedTo], [true, 'me@example.net', 'hr@acme-corp.com']);
    assert.match((await c.call('GET', `/api/mail?id=${sent.id}`)).json.text, /originally: hr@acme-corp\.com/);
    const cleared = (await c.call('POST', '/api/jobs/clear-test')).json; assert.deepEqual([cleared.ok, cleared.removed], [true, 1]);
    const after = (await c.call('GET', '/api/jobs')).json; assert.equal(after.counts.sent, 0); assert.ok(after.jobs.some((j) => j.title === 'Real todo'));
    assert.deepEqual(fs.readdirSync(path.join(c.home, 'data', 'sent')), []);
    // freed: a second run handles it again (it is not blocked by the earlier test send)
    assert.equal((await c.call('POST', '/api/run', { mode: 'real' })).json.ok, true); await waitDone(c);
    assert.equal(smtp.mails.length, 2);
  } finally { await world.close(); await smtp.close(); await c.close(); }
});

test('local test mailbox: a real SMTP client can deliver to it, and "use it" fills in the settings', { skip: nm ? false : 'nodemailer not found' }, async () => {
  const c = await boot({ sinkPort: 0 });
  const dir = path.join(c.home, 'data', 'sink');
  const sink = startSink({ dir, port: 0 }); await new Promise((r) => sink.once('listening', r));
  try {
    const t = nm.req('nodemailer').createTransport({ host: '127.0.0.1', port: sink.address().port, secure: false, auth: { user: 'me@gmail.com', pass: 'app-password' }, tls: { rejectUnauthorized: false } });   // a real account stays configured: the sink accepts any login
    await t.sendMail({ from: 'a@b.co', to: 'x@y.co', subject: '主题', text: 'hello', attachments: [{ filename: 'r.pdf', content: Buffer.alloc(200000, 1) }] });   // big enough to arrive in several chunks
    assert.equal(sinkCount(dir), 1);
    assert.match(fs.readdirSync(dir)[0], /\.eml$/);
    assert.match(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8'), /X-Original-Rcpt: x@y\.co/);
    assert.equal((await c.call('POST', '/api/sink/use')).json.ok, true);
    const v = Object.fromEntries((await c.call('GET', '/api/settings')).json.fields.map((f) => [f.key, f.value]));
    assert.deepEqual([v.SMTP_HOST, v.SMTP_SECURE, v.SMTP_FROM], ['127.0.0.1', 'off', 'job-hunter@localhost.test']);
  } finally { sink.close(); await c.close(); }
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
const resp = (body, type, status = 200, headers = {}) => ({ ok: status < 400, status, headers: { get: (k) => ({ 'content-type': type, ...headers })[k.toLowerCase()] ?? null }, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) });

test('card data reaches the page, and company logos are fetched by the server under strict rules', async () => {
  const calls = [];
  const web = { 'https://cdn.example.org/ok.png': () => resp(PNG, 'image/png'), 'https://cdn.example.org/vec.svg': () => resp(Buffer.from('<svg onload="x"/>'), 'image/svg+xml'),
    'https://cdn.example.org/big.png': () => resp(Buffer.alloc(400 * 1024, 1), 'image/png'), 'https://cdn.example.org/redir.png': () => resp(Buffer.alloc(0), 'text/plain', 302, { location: 'https://inner.example.org/x.png' }) };
  const lookup = async (host) => [{ address: { 'private.example.org': '10.0.0.5', 'loop.example.org': '127.0.0.1', 'v6.example.org': 'fd12::1', 'inner.example.org': '192.168.1.20' }[host] || '93.184.216.34' }];
  const c = await boot({ lookup, fetchImpl: async (u) => { calls.push(u); return (web[u] || (() => resp(Buffer.alloc(0), 'text/plain', 404)))(); } });
  try {
    const ev = (n, logo) => c.ctx.appendEvent({ id: n.repeat(16), status: 'manual', title: `T${n}`, company: 'Acme Ltd', url: 'https://x.example/j', score: 9, summary: '做报表', highlights: ['a', 'b'], concerns: ['c'], salary: 'HK$20k', jobType: 'Internship', tags: ['SQL', 'Python'], logo, desc: 'FULL DESCRIPTION', applyUrl: 'https://x.example/apply' });
    ev('a', 'https://cdn.example.org/ok.png'); ev('b', 'http://cdn.example.org/ok.png'); ev('c', 'https://private.example.org/x.png'); ev('d', 'https://loop.example.org/x.png');
    ev('e', 'https://cdn.example.org/vec.svg'); ev('f', 'https://cdn.example.org/big.png'); ev('1', 'https://cdn.example.org/redir.png'); ev('2', 'https://v6.example.org/x.png'); ev('3', 'javascript:alert(1)');
    const list = (await c.call('GET', '/api/jobs')).json.jobs; const a = list.find((j) => j.title === 'Ta');
    assert.deepEqual([a.salary, a.jobType, a.summary, a.highlights, a.concerns, a.tags, a.hasLogo, a.applyUrl], ['HK$20k', 'Internship', '做报表', ['a', 'b'], ['c'], ['SQL', 'Python'], true, 'https://x.example/apply']);
    assert.ok(!JSON.stringify(list).includes('cdn.example.org'), 'the raw logo address is not sent to the page');
    assert.ok(!('desc' in a), 'long descriptions are fetched only on demand');
    assert.equal((await c.call('GET', `/api/job?id=${'a'.repeat(16)}`)).json.desc, 'FULL DESCRIPTION');
    const got = await c.call('GET', `/api/logo?id=${'a'.repeat(16)}`);
    assert.equal(got.status, 200); assert.equal(got.headers.get('content-type'), 'image/png');
    await c.call('GET', `/api/logo?id=${'a'.repeat(16)}`);
    assert.equal(calls.filter((u) => u.endsWith('ok.png')).length, 1, 'cached after the first fetch');
    for (const n of ['b', 'c', 'd', 'e', 'f', '1', '2', '3']) assert.equal((await c.call('GET', `/api/logo?id=${n.repeat(16)}`)).status, 404, `logo ${n} must be refused`);
    assert.deepEqual(calls.filter((u) => !u.includes('ok.png')), ['https://cdn.example.org/vec.svg', 'https://cdn.example.org/big.png', 'https://cdn.example.org/redir.png'], 'http, private, loopback, IPv6-private and the redirect to the LAN were refused BEFORE any request to them');
    assert.equal((await c.call('GET', '/api/logo?id=../../x')).status, 400);
  } finally { await c.close(); }
});

test('the Jooble "test source" button searches exactly what the real run searches (region, or the specific place)', async () => {
  const c = await boot();
  const world = await startFakeWorld({ jobs: [{ title: 'A', company: 'Acme', snippet: 'x' }] });
  try {
    applyChanges(c.home, { JOB_KEYWORDS: '数据分析', JOOBLE_API_KEY: 'k', JOOBLE_API_BASE: `${world.base}/jooble` });
    const loc = async () => { const r = (await c.call('POST', '/api/test', { what: 'jobs' })).json; assert.equal(r.ok, true, r.message); return world.log.joobleBodies.at(-1).location; };
    assert.equal(await loc(), 'Hong Kong');                                                     // the default region, not ""
    applyChanges(c.home, { JOB_REGION: 'sg' }); assert.equal(await loc(), 'Singapore');
    applyChanges(c.home, { JOB_LOCATION: 'Kowloon' }); assert.equal(await loc(), 'Kowloon');     // the specific place wins, as in the run
    applyChanges(c.home, { JOB_LOCATION: null, JOB_REGION: 'global' }); assert.equal(await loc(), '');
  } finally { await world.close(); await c.close(); }
});

test('undo puts a posting back to what it was (unknown stays unknown), the test mailbox keeps the saved account, and API calls without the cookie get a JSON answer', async () => {
  const c = await boot();
  try {
    const u = '7'.repeat(16); c.ctx.appendEvent({ id: u, status: 'unknown', title: 'U', to: 'x@y.com', note: 'maybe' });
    assert.equal((await c.call('POST', '/api/jobs/action', { id: u, action: 'applied' })).json.ok, true);
    const back = (await c.call('POST', '/api/jobs/action', { id: u, action: 'reopen' })).json;
    assert.deepEqual([back.ok, back.status], [true, 'unknown']);
    assert.equal((await c.call('GET', '/api/jobs')).json.jobs.find((j) => j.id === u).group, 'attention', 'not silently turned into a to-do');
    const m = '8'.repeat(16); c.ctx.appendEvent({ id: m, status: 'manual', title: 'M', url: 'https://x.example' });
    await c.call('POST', '/api/jobs/action', { id: m, action: 'dismissed' });
    assert.equal((await c.call('POST', '/api/jobs/action', { id: m, action: 'reopen' })).json.status, 'manual');
    applyChanges(c.home, { SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '465', SMTP_USER: 'me@gmail.com', SMTP_PASS: 'app-password-xyz' });
    assert.equal((await c.call('POST', '/api/sink/use')).json.ok, true);
    const cfg = fs.readFileSync(path.join(c.home, 'config.local.env'), 'utf8');
    assert.match(cfg, /SMTP_HOST='127\.0\.0\.1'/); assert.match(cfg, /SMTP_USER='me@gmail\.com'/); assert.match(cfg, /SMTP_PASS='app-password-xyz'/);
    const nocookie = await c.call('GET', '/api/state', undefined, { cookie: false });
    assert.equal(nocookie.status, 403); assert.equal(nocookie.json.ok, false); assert.match(nocookie.json.message, /链接/);
    const big = await c.call('POST', '/api/resume', undefined, { raw: Buffer.alloc(10 * 1024 * 1024, 1) });
    assert.equal(big.status, 413); assert.match(big.json.message, /8 MB/);
  } finally { await c.close(); }
});

test('a run started by launchd shows up as running in the console', async () => {
  const c = await boot();
  const { acquireLock } = await import('../scripts/lib/lock.mjs');
  const lock = await acquireLock(c.home, 'launchd-test');   // the run lock lives in HOME (hunt.mjs takes it there)
  try {
    const r = (await c.call('GET', '/api/run')).json;
    assert.deepEqual([r.running, r.external], [true, true]);
    assert.equal((await c.call('POST', '/api/run', { mode: 'dry' })).status, 409);
  } finally { await lock.release(); await c.close(); }
  assert.equal((await (async () => { const c2 = await boot(); try { return (await c2.call('GET', '/api/run')).json.running; } finally { await c2.close(); } })()), false);
});

test('the checklist follows the same source rule as the run; a hand-edited HUNT_TIME never breaks the page; the test mailbox switches test mode on', async () => {
  const c = await boot();
  try {
    await c.call('PUT', '/api/profile', { profile: TEST_PROFILE });
    applyChanges(c.home, { AI_BASE_URL: 'https://api.example.com', AI_API_KEY: SECRET, JOOBLE_API_KEY: 'k' });
    let st = (await c.call('GET', '/api/state')).json;
    assert.equal(st.ready, false, 'a Jooble key without keywords is not a usable source');
    applyChanges(c.home, { JOB_RSS_URLS: 'https://rss.example/f.xml' });
    st = (await c.call('GET', '/api/state')).json;
    assert.equal(st.ready, true); assert.match(st.checklist.find((i) => i.id === 'sources').detail, /将使用：RSS.*Jooble 需要搜索关键词/);
    applyChanges(c.home, { AI_BASE_URL: null });
    assert.match((await c.call('GET', '/api/state')).json.checklist.find((i) => i.id === 'ai').detail, /接口地址/);
    applyChanges(c.home, { HUNT_TIME: '8am' });
    const r = await c.call('GET', '/api/state'); assert.equal(r.status, 200); assert.deepEqual([r.json.schedule.time, r.json.schedule.valid], ['08:00', false]);
    applyChanges(c.home, { HUNT_TIME: '09:30', SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'me@gmail.com', SMTP_PASS: 'pw-secret-1' });
    assert.equal((await c.call('GET', '/api/state')).json.schedule.time, '09:30');
    const use = (await c.call('POST', '/api/sink/use')).json; assert.equal(use.ok, true);
    const after = (await c.call('GET', '/api/state')).json;
    assert.equal(after.test.redirect, 'test@localhost.test', 'a run through the test mailbox is a test run');
    assert.match(fs.readFileSync(path.join(c.home, 'config.local.env'), 'utf8'), /SMTP_PASS='pw-secret-1'/);
  } finally { await c.close(); }
});

test('logos: a dead or refused address is remembered (one fetch, not one per page view) until the posting gets a new address', async () => {
  const calls = [];
  const web = { 'https://cdn.example.org/new.png': () => resp(PNG, 'image/png') };
  const c = await boot({ lookup: async () => [{ address: '93.184.216.34' }], fetchImpl: async (u) => { calls.push(u); return (web[u] || (() => resp(Buffer.alloc(0), 'text/plain', 404)))(); } });
  try {
    const id = 'c'.repeat(16);
    c.ctx.appendEvent({ id, status: 'manual', title: 'T', company: 'Acme', url: 'https://x.example/j', logo: 'https://cdn.example.org/dead.png' });
    for (let i = 0; i < 3; i++) assert.equal((await c.call('GET', `/api/logo?id=${id}`)).status, 404);
    assert.equal(calls.length, 1, 'the dead address was fetched once');
    c.ctx.appendEvent({ id, status: 'manual', logo: 'https://cdn.example.org/new.png' });              // the posting now carries a working logo
    assert.equal((await c.call('GET', `/api/logo?id=${id}`)).status, 200);
    assert.equal((await c.call('GET', `/api/logo?id=${id}`)).status, 200);
    assert.deepEqual(calls, ['https://cdn.example.org/dead.png', 'https://cdn.example.org/new.png']);
  } finally { await c.close(); }
});

test('the Discord test posts one message to the webhook and reports the outcome; the schedule says which retry slots exist', async () => {
  const c = await boot();
  const world = await startFakeWorld({ jobs: [] });
  try {
    assert.equal((await c.call('POST', '/api/test', { what: 'discord' })).json.ok, false);
    applyChanges(c.home, { DISCORD_WEBHOOK_URL: `${world.base}/discord/hook` });
    const r = (await c.call('POST', '/api/test', { what: 'discord' })).json; assert.equal(r.ok, true, r.message);
    assert.equal(world.log.discord.length, 1); assert.match(world.log.discord[0], /测试消息/);
    applyChanges(c.home, { DISCORD_WEBHOOK_URL: `${world.base}/nowhere` });
    assert.match((await c.call('POST', '/api/test', { what: 'discord' })).json.message, /404/);
    applyChanges(c.home, { HUNT_TIME: '23:30' });
    assert.deepEqual((await c.call('GET', '/api/state')).json.schedule.retries, ['23:50']);                 // past midnight: not installed, and said so
    applyChanges(c.home, { HUNT_TIME: '08:00' });
    assert.deepEqual((await c.call('GET', '/api/state')).json.schedule.retries, ['08:20', '08:40', '09:30']);
  } finally { await world.close(); await c.close(); }
});
