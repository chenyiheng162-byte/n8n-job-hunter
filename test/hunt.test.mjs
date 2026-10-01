import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runHunt, preflight, resolveSettings, Store } from '../scripts/hunt.mjs';
import { acquireLock } from '../scripts/lib/lock.mjs';
import http from 'node:http';
import { makeHttp, MAX_BODY } from '../scripts/engine.mjs';
import { tmpdir, writeProfile, startFakeWorld, startFakeSmtp, baseEnv, findNodemailer } from './helpers.mjs';

const nm = findNodemailer();
const skip = nm ? false : 'nodemailer not found (needs the n8n runtime folder)';
const JOBS = [
  { title: 'A 数据分析实习生', company: 'Acme', snippet: '负责报表。[score:9] 简历请发 hr@acme-corp.com', },
  { title: 'B 数据分析助理', company: 'Beta', snippet: '[score:9] 请在官网投递，无邮箱。' },
  { title: 'C 销售代表', company: 'Gamma', snippet: '[score:3] 需要驻外销售。' },
  { title: 'D 假邮箱岗位', company: 'Delta', snippet: '[score:9] 联系 noreply@delta.com 或 logo@2x.png' },
];
const run = (home, world, smtp, extra = {}, args = ['--direct']) => runHunt({ env: { JOBHUNT_RUNTIME: nm && nm.dir, ...baseEnv(home, world, smtp, extra) }, args, notifier: () => {} });
const events = (home) => fs.readFileSync(path.join(home, 'data', 'applications.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
async function setup(opts = {}, jobs = JOBS) {
  const home = tmpdir(); writeProfile(home);
  const world = await startFakeWorld({ jobs, ...opts }); const smtp = await startFakeSmtp(opts.smtp);
  return { home, world, smtp, done: async () => { await world.close(); await smtp.close(); } };
}

test('e-mails the posting with an address, lists the others, skips the poor fit', { skip }, async () => {
  const t = await setup();
  try {
    const r = await run(t.home, t.world, t.smtp);
    assert.equal(r.code, 0, r.message);
    assert.equal(t.smtp.mails.length, 1);
    assert.deepEqual(t.smtp.mails[0].to, ['hr@acme-corp.com']);
    assert.match(t.smtp.mails[0].raw, /filename="?resume\.pdf/);          // the resume is attached
    const st = Object.fromEntries(events(t.home).filter((e) => e.status !== 'sending').map((e) => [e.title[0], e.status]));
    assert.deepEqual(st, { A: 'sent', B: 'manual', C: 'skipped', D: 'manual' });
    assert.match(r.report, /已邮件投递 1/);
    assert.match(r.report, /需要你自己投递 2/);
    assert.match(r.report, /\/job\/B/);                                     // the site to apply on is named
    assert.ok(fs.existsSync(path.join(t.home, 'data', 'reports')));
    const csv = fs.readFileSync(path.join(t.home, 'data', 'to-apply.csv'), 'utf8');
    assert.equal(csv.split('\n').filter(Boolean).length, 3);               // header + B + D
  } finally { await t.done(); }
});

test('the same day twice is a no-op, and a forced second day never re-sends or re-lists', { skip }, async () => {
  const t = await setup();
  try {
    await run(t.home, t.world, t.smtp);
    const again = await run(t.home, t.world, t.smtp);
    assert.equal(again.message, 'already done today');
    const forced = await run(t.home, t.world, t.smtp, {}, ['--direct', '--force']);
    assert.equal(forced.code, 0);
    assert.equal(t.smtp.mails.length, 1);
    assert.equal(forced.plan.items.length, 0);                              // everything was handled before: nothing new
    assert.equal(t.world.log.ai.filter((u) => /A 数据分析实习生/.test(u)).length, 2); // screen + draft, once
  } finally { await t.done(); }
});

test('daily cap: extra e-mail postings wait for tomorrow and are not recorded', { skip }, async () => {
  const jobs = [1, 2, 3].map((n) => ({ title: `J${n} 分析`, company: `Co${n}`, snippet: `[score:9] 投递 hr${n}@co${n}.com` }));
  const t = await setup({}, jobs);
  try {
    const r = await run(t.home, t.world, t.smtp, { MAX_APPLICATIONS_PER_DAY: '2' });
    assert.equal(t.smtp.mails.length, 2);
    assert.equal(r.acted.deferred.length, 1); assert.equal(r.acted.attention.length, 0); assert.match(r.report, /留到明天 1/);
    assert.equal(events(t.home).filter((e) => e.title.startsWith('J3')).length, 0);
  } finally { await t.done(); }
});

test('a draft with a placeholder is never sent: falls back to the posting site', { skip }, async () => {
  const t = await setup({}, [{ title: 'E 分析', company: 'Eps', snippet: '[score:9] [draft:bad] hr@eps.com' }]);
  try {
    const r = await run(t.home, t.world, t.smtp);
    assert.equal(t.smtp.mails.length, 0);
    assert.equal(r.acted.listed.length, 1);
    assert.match(r.acted.listed[0].note, /没写好/);
  } finally { await t.done(); }
});

test('dry run sends nothing and writes nothing', { skip }, async () => {
  const t = await setup();
  try {
    const r = await run(t.home, t.world, t.smtp, {}, ['--direct', '--dry-run']);
    assert.equal(r.code, 0);
    assert.equal(t.smtp.mails.length, 0);
    assert.ok(!fs.existsSync(path.join(t.home, 'data')));
    assert.match(r.report, /试运行/);
  } finally { await t.done(); }
});

test('AUTO_SEND=off writes the letters but lists everything', { skip }, async () => {
  const t = await setup();
  try {
    const r = await run(t.home, t.world, t.smtp, { AUTO_SEND: 'off' });
    assert.equal(t.smtp.mails.length, 0);
    assert.equal(r.acted.sent.length, 0);
    assert.equal(r.acted.listed.length, 3);
  } finally { await t.done(); }
});

test('mail may have left (connection dropped after DATA): recorded unknown, never resent', { skip }, async () => {
  const t = await setup({ smtp: { mode: 'drop-after-data' } });
  try {
    const r = await run(t.home, t.world, t.smtp);
    assert.equal(events(t.home).filter((e) => e.title.startsWith('A')).pop().status, 'unknown');
    assert.match(r.report, /不确定/);
    await run(t.home, t.world, t.smtp, {}, ['--direct', '--force']);
    assert.equal(events(t.home).filter((e) => e.title.startsWith('A') && e.status === 'sending').length, 1);
  } finally { await t.done(); }
});

test('recipient refused: recorded failed (retried tomorrow), not unknown', { skip }, async () => {
  const t = await setup({ smtp: { mode: 'refuse-rcpt' } });
  try {
    await run(t.home, t.world, t.smtp);
    assert.equal(events(t.home).filter((e) => e.title.startsWith('A')).pop().status, 'failed');
  } finally { await t.done(); }
});

test('not configured: exit 2 with a plain message and nothing else happens', async () => {
  const home = tmpdir();
  const r = await runHunt({ env: { JOBHUNT_HOME: home }, args: ['--direct'], notifier: () => {} });
  assert.equal(r.code, 2);
  assert.match(r.message, /个人资料/);
  assert.ok(!fs.existsSync(path.join(home, 'data', 'applications.jsonl')));
});

test('AI down: the run fails (a later slot retries) and records nothing', { skip }, async () => {
  const t = await setup({ aiDown: true });
  try {
    const r = await run(t.home, t.world, t.smtp);
    assert.equal(r.code, 1);
    assert.match(r.message, /AI/);
    assert.ok(!fs.existsSync(path.join(t.home, 'data', 'state', 'done-' + new Date().toLocaleDateString('sv-SE'))));
  } finally { await t.done(); }
});

test('all job sources failing is a failure, not "no new jobs"', { skip }, async () => {
  const t = await setup();
  try {
    const r = await run(t.home, t.world, t.smtp, { JOOBLE_API_BASE: `${t.world.base}/nowhere` });
    assert.equal(r.code, 1);
    assert.match(r.message, /职位来源/);
  } finally { await t.done(); }
});

test('test mode: mail goes to the redirect address only, says who it was meant for, and is not "real contact"', { skip }, async () => {
  const t = await setup();
  try {
    const r = await run(t.home, t.world, t.smtp, { MAIL_REDIRECT_TO: 'me@example.net' });
    assert.equal(t.smtp.mails.length, 1);
    assert.deepEqual(t.smtp.mails[0].to, ['me@example.net']);                              // never the real recipient
    assert.ok(!t.smtp.mails.some((m) => m.to.includes('hr@acme-corp.com')));
    const body = Buffer.from(t.smtp.mails[0].raw.replace(/\r\n/g, '').match(/base64([A-Za-z0-9+/=]+)/)?.[1] || '', 'base64').toString();
    assert.match(body, /原本要发给：hr@acme-corp\.com/);
    assert.match(body, /您好，我是测试同学/);                                              // the real letter follows the banner
    const e = events(t.home).filter((x) => x.title.startsWith('A')).pop();
    assert.deepEqual([e.status, e.to, e.intendedTo, e.redirected], ['sent', 'me@example.net', 'hr@acme-corp.com', true]);
    assert.match(r.report, /测试模式/);
    assert.match(fs.readFileSync(path.join(t.home, 'data', 'sent', fs.readdirSync(path.join(t.home, 'data', 'sent'))[0]), 'utf8'), /originally: hr@acme-corp\.com/);
  } finally { await t.done(); }
});

test('test mode: the real recipient is not blocked afterwards (no cooldown from a test send)', { skip }, async () => {
  const t = await setup({}, [{ title: 'A 分析', company: 'Acme', snippet: '[score:9] hr@acme-corp.com' }]);
  try {
    await run(t.home, t.world, t.smtp, { MAIL_REDIRECT_TO: 'me@example.net' });
    // forget the posting (as "clear test records" does) and run for real: the address must still be usable
    fs.writeFileSync(path.join(t.home, 'data', 'applications.jsonl'), events(t.home).filter((e) => !e.redirected).map((e) => JSON.stringify(e)).join('\n'));
    const r = await run(t.home, t.world, t.smtp, {}, ['--direct', '--force']);
    assert.equal(r.acted.sent.length, 1);
    assert.deepEqual(t.smtp.mails.at(-1).to, ['hr@acme-corp.com']);
  } finally { await t.done(); }
});

test('lowering the minimum score brings earlier "not suitable" postings back for another look', { skip }, async () => {
  const t = await setup({}, [{ title: 'M 分析', company: 'Mid', snippet: '[score:6] 请在官网投递。' }]);
  try {
    await run(t.home, t.world, t.smtp);                                              // MIN_SCORE 7: skipped
    assert.equal(events(t.home).pop().status, 'skipped');
    const again = await run(t.home, t.world, t.smtp, {}, ['--direct', '--force']);   // same threshold: not looked at again
    assert.equal(again.plan.items.length, 0);
    const lowered = await run(t.home, t.world, t.smtp, { MIN_SCORE: '6' }, ['--direct', '--force']);
    assert.equal(lowered.acted.listed.length, 1);                                    // now acceptable: listed for the user to apply
    assert.equal(events(t.home).pop().status, 'manual');
  } finally { await t.done(); }
});

test('an address found only on the posting page is a hint, not a recipient (unless PAGE_EMAILS=on)', { skip }, async () => {
  const jobs = [{ title: 'P 分析', company: 'Page', snippet: '[score:9] 请看官网。', page: '<html><body>Contact: jobs@page-corp.com</body></html>' }];
  const t = await setup({}, jobs);
  try {
    const r = await run(t.home, t.world, t.smtp);
    assert.equal(t.smtp.mails.length, 0);
    assert.match(r.acted.listed[0].note, /jobs@page-corp\.com.*不确定/);
    const on = await run(t.home, t.world, t.smtp, { PAGE_EMAILS: 'on' }, ['--direct', '--force']);   // the posting was already handled: nothing new
    assert.equal(on.plan.items.length, 0);
  } finally { await t.done(); }
  const t2 = await setup({}, jobs);
  try {
    await run(t2.home, t2.world, t2.smtp, { PAGE_EMAILS: 'on' });
    assert.deepEqual(t2.smtp.mails[0].to, ['jobs@page-corp.com']);
  } finally { await t2.done(); }
});

test('target region: Hong Kong by default, selectable, a specific place wins, and the AI is told', { skip }, async () => {
  const jobs = [{ title: 'R 分析', company: 'Reg', snippet: '[score:9] 请在官网投递。' }];
  const searchedAs = async (extra) => {
    const t = await setup({}, jobs);
    try { await run(t.home, t.world, t.smtp, extra); return { loc: t.world.log.joobleBodies[0].location, sys: t.world.log.sys[0] || '' }; } finally { await t.done(); }
  };
  const hk = await searchedAs({});                                   assert.equal(hk.loc, 'Hong Kong');           assert.match(hk.sys, /目标地区：香港/);
  const sg = await searchedAs({ JOB_REGION: 'sg' });                 assert.equal(sg.loc, 'Singapore');           assert.match(sg.sys, /目标地区：新加坡/);
  const area = await searchedAs({ JOB_LOCATION: 'Kowloon' });        assert.equal(area.loc, 'Kowloon');           assert.match(area.sys, /具体到：Kowloon/);
  const any = await searchedAs({ JOB_REGION: 'global' });            assert.equal(any.loc, '');                   assert.match(any.sys, /不限地区/);
  const bad = await searchedAs({ JOB_REGION: 'atlantis' });          assert.equal(bad.loc, 'Hong Kong');          // an unknown value falls back to the default
});

test('everything shown on a card travels with the posting: salary, type, AI summary and fit points (skipped ones stay lean)', { skip }, async () => {
  const t = await setup({}, [
    { title: 'F 分析', company: 'Fit', snippet: '[score:9] 请在官网投递。', salary: 'HK$20k-25k', type: 'Internship' },
    { title: 'G 销售', company: 'Low', snippet: '[score:2] 销售。', salary: '1' },
  ]);
  try {
    await run(t.home, t.world, t.smtp);
    const f = events(t.home).filter((e) => e.title.startsWith('F')).pop();
    assert.deepEqual([f.salary, f.jobType, f.summary], ['HK$20k-25k', 'Internship', '测试摘要：负责数据报表']);
    assert.deepEqual(f.highlights, ['SQL 匹配', 'Tableau 匹配', '远程']);              // at most three
    assert.deepEqual(f.concerns, ['需要英语']);
    assert.ok(f.desc && f.desc.includes('请在官网投递'));                              // the description is kept for postings the user can act on
    const g = events(t.home).filter((e) => e.title.startsWith('G')).pop();
    assert.equal(g.status, 'skipped'); assert.equal(g.desc, undefined); assert.equal(g.summary, undefined);
  } finally { await t.done(); }
});

test('the exact application link is taken from the posting page ("Apply" button), ignoring share/mailto links', { skip }, async () => {
  const page = '<html><body><a href="https://www.facebook.com/sharer?u=x">Share</a><a href="mailto:x@y.z">Apply by mail</a><a href="/careers">All careers</a><a class="btn" href="/apply/12345?src=hunter&amp;x=1">Apply now</a></body></html>';
  const t = await setup({}, [{ title: 'L 分析', company: 'Link', snippet: '[score:9] 请在官网投递。', page }]);
  try {
    const r = await run(t.home, t.world, t.smtp);
    const item = r.acted.listed[0];
    assert.equal(item.applyUrl, `${t.world.base}/apply/12345?src=hunter&x=1`);               // resolved against the posting URL
    assert.match(r.report, /\/apply\/12345/);                                           // and the report points at it
    assert.equal(events(t.home).pop().applyUrl, item.applyUrl);
  } finally { await t.done(); }
});

test('to-apply.csv: a posting title that looks like a spreadsheet formula is neutralised', { skip }, async () => {
  const t = await setup({}, [{ title: '=HYPERLINK("http://evil.example","click")', company: '+cmd', snippet: '[score:9] 请在官网投递。' }]);
  try {
    await run(t.home, t.world, t.smtp);
    const csv = fs.readFileSync(path.join(t.home, 'data', 'to-apply.csv'), 'utf8');
    assert.match(csv, /"'\+cmd","'=HYPERLINK\(""http:\/\/evil\.example"",""click""\)"/);
    assert.ok(!/,"=HYPERLINK/.test(csv) && !/,"\+cmd"/.test(csv), 'no cell may start with a formula character');
  } finally { await t.done(); }
});

test('daily cap counts postings, not events: a forced second run the same day still has the remaining quota', { skip }, async () => {
  const mk = (ns) => ns.map((n) => ({ title: `J${n} 分析`, company: `Co${n}`, snippet: `[score:9] 投递 hr${n}@co${n}.com` }));
  const t = await setup({}, mk([1, 2]));
  const later = await startFakeWorld({ jobs: mk([3, 4, 5]) });                                  // three NEW postings later the same day
  try {
    const first = await run(t.home, t.world, t.smtp, { MAX_APPLICATIONS_PER_DAY: '4' });
    assert.equal(first.acted.sent.length, 2);
    const second = await run(t.home, later, t.smtp, { MAX_APPLICATIONS_PER_DAY: '4' }, ['--direct', '--force']);
    assert.equal(second.acted.sent.length, 2, 'two slots were left (one "sending" + one "sent" event per mail must count once)');
    assert.equal(second.acted.deferred.length, 1);
    assert.equal(t.smtp.mails.length, 4);
  } finally { await later.close(); await t.done(); }
});

test('recipient cooldown: an address written to long ago is used again, a recent one is not (and is said so)', { skip }, async () => {
  const seed = (home, daysAgo) => { fs.mkdirSync(path.join(home, 'data'), { recursive: true }); fs.writeFileSync(path.join(home, 'data', 'applications.jsonl'), `${JSON.stringify({ ts: new Date(Date.now() - daysAgo * 86400000).toISOString(), id: 'f'.repeat(16), status: 'sent', title: 'Old', to: 'hr@acme-corp.com' })}\n`); };
  const t = await setup({}, [JOBS[0]]);
  try {
    seed(t.home, 45);                                                                           // 45 days ago, cooldown 30: free again
    const r = await run(t.home, t.world, t.smtp);
    assert.equal(r.acted.sent.length, 1); assert.deepEqual(t.smtp.mails[0].to, ['hr@acme-corp.com']);
  } finally { await t.done(); }
  const t2 = await setup({}, [JOBS[0]]);
  try {
    seed(t2.home, 5);                                                                           // 5 days ago: still cooling down
    const r = await run(t2.home, t2.world, t2.smtp);
    assert.equal(t2.smtp.mails.length, 0);
    assert.equal(r.acted.listed.length, 1);                                                     // listed for the user, nothing sent
    assert.equal(r.acted.listed[0].route, 'site');
  } finally { await t2.done(); }
});

test('Remotive: one request per run, also without keywords (the checklist accepts Remotive alone)', { skip }, async () => {
  const t = await setup({}, [{ title: 'Remote Data Analyst', company: 'Rem', snippet: '[score:9] apply on our site' }]);
  try {
    const r = await run(t.home, t.world, t.smtp, { JOOBLE_API_KEY: '', JOB_KEYWORDS: '', REMOTIVE: 'on', REMOTIVE_API_BASE: `${t.world.base}/remotive` });
    assert.equal(r.code, 0, r.message);
    assert.equal(t.world.log.remotive.length, 1);
    assert.equal(r.acted.listed.length, 1); assert.equal(r.acted.listed[0].source, 'remotive');
    await run(t.home, t.world, t.smtp, { JOOBLE_API_KEY: '', JOB_KEYWORDS: '数据分析, 实习, 后端, 前端', REMOTIVE: 'on', REMOTIVE_API_BASE: `${t.world.base}/remotive` }, ['--direct', '--force']);
    assert.equal(t.world.log.remotive.length, 2, 'still one request, however many keywords');
    assert.match(t.world.log.remotive[1], /search=%E6%95%B0%E6%8D%AE%E5%88%86%E6%9E%90/);
  } finally { await t.done(); }
});

test('a broken run lock is a failure (exit 1), never "another run is in progress" (exit 0)', { skip }, async () => {
  const t = await setup();
  try {
    const env = { ...process.env, JOBHUNT_RUNTIME: nm && nm.dir, ...baseEnv(t.home, t.world, t.smtp), JOBHUNT_LOCK_TOOL: '/nonexistent/lockf' };
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/hunt.mjs', import.meta.url)), '--direct'], { env, encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /运行锁/);
    assert.equal(t.smtp.mails.length, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.home, 'data', 'state', 'last-run.json'), 'utf8')).result, 'failed');
  } finally { await t.done(); }
});

test('a posting keeps its id although the board changes the tracking parameters of its link every day (Jooble, LinkedIn)', { skip }, async () => {
  // the link carries per-request parameters; the e-mail is in the posting text, so the page itself is never fetched
  const jooble = { title: 'T 分析', company: 'Track', snippet: '[score:9] 简历请发 hr@track-corp.com', link: (n) => `https://jooble.org/desc/-4153853036742835734?ckey=%E5%88%86%E6%9E%90&rgn=22&pos=${n}&elckey=2089203587920567170&sid=${n}00${n}&age=${n}&scr=${n}.5` };
  const t = await setup({}, [jooble]);
  try {
    const first = await run(t.home, t.world, t.smtp);
    assert.equal(first.acted.sent.length, 1);
    const second = await run(t.home, t.world, t.smtp, {}, ['--direct', '--force']);
    assert.equal(second.plan.items.length, 0, 'the same posting with a different tracking query is not new');
    assert.equal(t.smtp.mails.length, 1);
  } finally { await t.done(); }
  const t2 = await setup({}, [{ ...jooble, link: (n) => `https://www.linkedin.com/jobs/view/3990001234/?refId=r${n}&trackingId=t${n}&position=${n}&pageNum=0` }]);
  try {
    await run(t2.home, t2.world, t2.smtp);
    assert.equal((await run(t2.home, t2.world, t2.smtp, {}, ['--direct', '--force'])).plan.items.length, 0);
  } finally { await t2.done(); }
});

test('a send that certainly failed is retried on a later run: its own "sending" record must not start a cooldown', { skip }, async () => {
  const t = await setup({}, [JOBS[0]]);
  const refusing = await startFakeSmtp({ mode: 'refuse-rcpt' });
  try {
    const r1 = await run(t.home, t.world, t.smtp, { SMTP_PORT: String(refusing.port) });
    assert.equal(events(t.home).filter((e) => e.title.startsWith('A')).pop().status, 'failed');
    assert.equal(r1.acted.attention.length, 1);
    const r2 = await run(t.home, t.world, t.smtp, {}, ['--direct', '--force']);           // the server works again
    assert.equal(r2.acted.sent.length, 1, 'retried and sent, not listed as "recently written to"');
    assert.deepEqual(t.smtp.mails.at(-1).to, ['hr@acme-corp.com']);
  } finally { await refusing.close(); await t.done(); }
});

test('one failing source next to a source that answered with nothing is "no new jobs", not a failed run', { skip }, async () => {
  const t = await setup({}, []);                                                                 // Jooble answers: zero postings
  try {
    const r = await run(t.home, t.world, t.smtp, { JOB_RSS_URLS: `${t.world.base}/nowhere` });  // the feed is broken
    assert.equal(r.code, 0, r.message);
    assert.match(r.report, /今天没有新岗位/); assert.match(r.report, /RSS/);                   // ... and the broken feed is reported
  } finally { await t.done(); }
  const t2 = await setup({}, []);
  try {
    const r = await run(t2.home, t2.world, t2.smtp, { JOOBLE_API_BASE: `${t2.world.base}/nowhere`, JOB_RSS_URLS: `${t2.world.base}/nowhere` });
    assert.equal(r.code, 1); assert.match(r.message, /所有职位来源都失败/);                     // nobody answered: a failure (retried later)
  } finally { await t2.done(); }
});

test('placeholder check: blanks are caught, ordinary brackets and comparisons are not', { skip }, async () => {
  const mk = (n, body) => ({ title: `D${n} 分析`, company: `Co${n}`, snippet: `[score:9] [body:${body}] hr${n}@co${n}.com` });
  const t = await setup({}, [mk(1, '【求职申请】应聘数据分析实习生：我有 <2 years 经验，详见附件（请查收）。' + '补充说明。'.repeat(12)), mk(2, '您好，我是[姓名]，应聘贵公司岗位。' + '内容'.repeat(40)), mk(3, 'Dear Hiring Manager, I am applying for the [Position] role at your company. ' + 'More text here. '.repeat(6))]);
  try {
    const r = await run(t.home, t.world, t.smtp);
    assert.deepEqual(r.acted.sent.map((i) => i.title[1]), ['1']);
    assert.deepEqual(r.acted.listed.map((i) => i.title[1]).sort(), ['2', '3']);
    assert.match(r.acted.listed[0].note, /投递邮箱：hr/);                                      // the address is still shown to the user
  } finally { await t.done(); }
});

test('a dry run waits its turn too: while another run holds the lock it does nothing (and still writes nothing)', { skip }, async () => {
  const t = await setup();
  const held = await acquireLock(t.home, 'scheduled-run');
  try {
    const r = await run(t.home, t.world, t.smtp, {}, ['--direct', '--dry-run']);
    assert.equal(r.message, 'another run in progress'); assert.match(r.report, /进行中/);
    assert.equal(t.world.log.ai.length, 0, 'no AI calls were made');
    assert.ok(!fs.existsSync(path.join(t.home, 'data')));
  } finally { await held.release(); await t.done(); }
});

test('preflight and the console agree on job sources: a Jooble key without keywords is a warning when another source exists, a problem when alone', () => {
  const home = tmpdir(); writeProfile(home);
  const pf = (extra) => preflight(resolveSettings({ JOBHUNT_HOME: home, AI_BASE_URL: 'https://ai.example', AI_API_KEY: 'k', ...extra }), { forSending: false });
  assert.deepEqual(pf({ JOOBLE_API_KEY: 'j' }).problems.filter((p) => /关键词/.test(p)).length, 1);
  const mixed = pf({ JOOBLE_API_KEY: 'j', JOB_RSS_URLS: 'https://rss.example/f.xml' });
  assert.deepEqual(mixed.problems, []); assert.ok(mixed.warnings.some((w) => /Jooble 需要搜索关键词/.test(w)));
  assert.deepEqual(pf({ REMOTIVE: 'on' }).problems, []);
  assert.equal(pf({}).problems.filter((p) => /职位来源/.test(p)).length, 1);
});

test('HR e-mail search needs both keys: with only Serper nothing is searched and the report says why', { skip }, async () => {
  const t = await setup({}, [{ title: 'S 分析', company: 'Searchable', snippet: '[score:9] 请在官网投递。' }]);
  try {
    const r = await run(t.home, t.world, t.smtp, { HR_EMAIL_SEARCH: 'on', SERPER_API_KEY: 'serp', SERPER_API_BASE: `${t.world.base}/nowhere` });
    assert.equal(r.code, 0, r.message);
    assert.ok(r.plan.warnings.some((w) => /MAILBOXLAYER_API_KEY/.test(w)), r.plan.warnings.join('; '));
    assert.ok(!r.plan.warnings.some((w) => /邮箱搜索失败/.test(w)), 'no search was attempted');
  } finally { await t.done(); }
});

test('RSS 2.0 and Atom feeds: CDATA titles, entities, <content:encoded>, self-closing Atom links, dates and max age', { skip }, async () => {
  const rss = (base) => `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>t</title>
<item><title><![CDATA[CDATA <b>数据分析</b> 实习]]></title><link>${base}/job/R1</link><description>short teaser</description><content:encoded><![CDATA[<p>Full text [score:9] apply at hr@rss-corp.com</p>]]></content:encoded><pubDate>${new Date().toUTCString()}</pubDate></item>
<item><title>Old one</title><link>${base}/job/R2</link><description>[score:9] hr@old.example</description><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
</channel></rss>`;
  const atom = (base) => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>a</title>
<entry><title>Atom &amp; Co 数据分析</title><link rel="alternate" href="${base}/job/A1?x=1&amp;y=2"/><summary type="html">&lt;p&gt;[score:9] mail hr@atom-corp.com&lt;/p&gt;</summary><updated>${new Date().toISOString()}</updated></entry>
</feed>`;
  const t = await setup({ feeds: { '/feed/rss.xml': rss, '/feed/atom.xml': atom } }, []);
  try {
    const r = await run(t.home, t.world, t.smtp, { JOOBLE_API_KEY: '', JOB_KEYWORDS: '', JOB_RSS_URLS: `${t.world.base}/feed/rss.xml ${t.world.base}/feed/atom.xml` });
    assert.equal(r.code, 0, r.message);
    assert.equal(r.plan.fetched, 3); assert.equal(r.plan.items.length, 2, 'the 2024 item is older than JOB_MAX_AGE_DAYS');
    const byTitle = Object.fromEntries(r.plan.items.map((i) => [i.title, i]));
    assert.ok(byTitle['CDATA 数据分析 实习'], Object.keys(byTitle).join('|'));
    assert.match(byTitle['CDATA 数据分析 实习'].desc, /Full text/);                               // the full text, not the teaser
    assert.equal(byTitle['Atom & Co 数据分析'].url, `${t.world.base}/job/A1?x=1&y=2`);
    assert.deepEqual(t.smtp.mails.map((m) => m.to[0]).sort(), ['hr@atom-corp.com', 'hr@rss-corp.com']);
  } finally { await t.done(); }
});

test('AI answers in prose: the run stops after three failures in a row and records nothing', { skip }, async () => {
  const jobs = [1, 2, 3, 4].map((n) => ({ title: `P${n} 分析`, company: `Co${n}`, snippet: `[score:9] hr${n}@co${n}.com` }));
  const t = await setup({ aiReply: (kind) => (kind === 'score' ? 'I think this is a great job for you!' : undefined) }, jobs);
  try {
    const r = await run(t.home, t.world, t.smtp);
    assert.equal(r.code, 1); assert.match(r.message, /AI 连续 3 次失败/);
    assert.ok(t.world.log.ai.length <= 6 && t.world.log.ai.length >= 3, `stopped early (${t.world.log.ai.length} calls)`);   // 3 postings x up to 2 attempts, never the 4th
    assert.ok(!fs.existsSync(path.join(t.home, 'data', 'applications.jsonl')));
    assert.equal(t.smtp.mails.length, 0);
  } finally { await t.done(); }
});

test('AI wraps the JSON in a code fence and sends the score as a string: still understood', { skip }, async () => {
  const t = await setup({ aiReply: (kind) => (kind === 'score' ? '```json\n' + JSON.stringify({ score: '9', reason: '很匹配', summary: '做报表', highlights: [], concerns: [], language: 'zh' }) + '\n```' : undefined) }, [JOBS[0]]);
  try {
    const r = await run(t.home, t.world, t.smtp);
    assert.equal(r.acted.sent.length, 1); assert.equal(r.acted.sent[0].score, 9);
  } finally { await t.done(); }
});

test('a daily cap of 0 is a pause: postings are listed once with the address, not deferred and re-scored every day', { skip }, async () => {
  const t = await setup({}, [JOBS[0]]);
  try {
    const r = await run(t.home, t.world, t.smtp, { MAX_APPLICATIONS_PER_DAY: '0' });
    assert.equal(t.smtp.mails.length, 0); assert.equal(r.acted.attention.length, 0);
    assert.equal(r.acted.listed.length, 1); assert.match(r.acted.listed[0].note, /每日上限设为 0/); assert.equal(r.acted.listed[0].to, 'hr@acme-corp.com');
    const again = await run(t.home, t.world, t.smtp, { MAX_APPLICATIONS_PER_DAY: '0' }, ['--direct', '--force']);
    assert.equal(again.plan.items.length, 0, 'handled: not fetched and scored again');
  } finally { await t.done(); }
});

test('a hostile feed cannot stall the run: the body is bounded and items are cut out in linear time', { skip }, async () => {
  const big = (base) => `<rss><channel>${'<item><title>x</title>'.repeat(20000)}</channel></rss>`;                 // 20k unclosed items, ~400 KB
  const t = await setup({ feeds: { '/feed/evil.xml': big } }, []);
  try {
    const t0 = Date.now();
    const r = await run(t.home, t.world, t.smtp, { JOOBLE_API_KEY: '', JOB_KEYWORDS: '', JOB_RSS_URLS: `${t.world.base}/feed/evil.xml` });
    assert.equal(r.code, 0, r.message); assert.equal(r.plan.fetched, 0);
    assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0} ms`);
  } finally { await t.done(); }
  // the direct engine stops reading a response past MAX_BODY
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); const chunk = Buffer.alloc(1024 * 1024, 65); let n = 0; const push = () => { while (n < 12 && res.write(chunk)) n += 1; if (n >= 12) res.end(); else res.once('drain', push); }; push(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { await assert.rejects(makeHttp()({ url: `http://127.0.0.1:${srv.address().port}/` }), /larger than/); assert.ok(MAX_BODY <= 12 * 1024 * 1024); } finally { srv.close(); }
});

test('a posting link to this computer or the local network is never fetched for its page', { skip }, async () => {
  const jobs = [{ title: 'N 分析', company: 'Net', snippet: '[score:9] 请在官网投递。', page: '<html><a href="/apply">Apply</a></html>' }];
  const t = await setup({}, jobs);
  try {
    const r = await run(t.home, t.world, t.smtp, { JOBHUNT_ALLOW_LOCAL_FETCH: '' });                           // the fake page lives on 127.0.0.1: refused
    assert.equal(r.acted.listed.length, 1); assert.equal(r.acted.listed[0].applyUrl, '');
    assert.deepEqual(t.world.log.pages, [], 'no request went to the local address');
    const t2 = await setup({}, jobs);
    try { const ok = await run(t2.home, t2.world, t2.smtp); assert.match(ok.acted.listed[0].applyUrl, /\/apply$/); assert.equal(t2.world.log.pages.length, 1); } finally { await t2.done(); }
  } finally { await t.done(); }
});

test('secrets echoed by an upstream error never reach the report or Discord', { skip }, async () => {
  const t = await setup({}, [JOBS[1]]);
  try {
    const key = 'jooble-secret-123456';
    const r = await run(t.home, t.world, t.smtp, { JOOBLE_API_KEY: key, JOOBLE_API_BASE: `${t.world.base}/jooble-echo`, JOB_RSS_URLS: `${t.world.base}/feed/none.xml`, REMOTIVE: 'on', REMOTIVE_API_BASE: `${t.world.base}/remotive`, DISCORD_WEBHOOK_URL: `${t.world.base}/discord/x` });
    assert.equal(r.code, 0, r.message);
    assert.ok(r.plan.warnings.some((w) => /Jooble/.test(w)), 'the failing source is reported');
    assert.ok(!r.report.includes(key), 'report'); assert.ok(!fs.readFileSync(path.join(t.home, 'data', 'reports', `${new Date().toLocaleDateString('sv-SE')}.md`), 'utf8').includes(key), 'report file');
    assert.equal(t.world.log.discord.length, 1); assert.ok(!t.world.log.discord[0].includes(key), 'discord');
    assert.deepEqual(JSON.parse(t.world.log.discord[0]).allowed_mentions, { parse: [] });
  } finally { await t.done(); }
});

test('console bookkeeping (a mark, an undo) is never a send: it does not count against the cap, forget a recipient or use up a retry', { skip }, async () => {
  // readers in hunt.mjs
  const home = tmpdir(); fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  const old = new Date(Date.now() - 10 * 86400000).toISOString(); const id = 'd'.repeat(16);
  fs.writeFileSync(path.join(home, 'data', 'applications.jsonl'), [{ ts: old, id, status: 'sending', to: 'hr@acme-corp.com' }, { ts: old, id, status: 'unknown', to: 'hr@acme-corp.com' }, { ts: new Date().toISOString(), id, status: 'dismissed' }, { ts: new Date().toISOString(), id, status: 'unknown' }].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const store = new Store(home, { dryRun: true });
  assert.equal(store.sentToday(), 0, 'the undo event dated today is not a send');
  assert.equal(store.lastContact('hr@acme-corp.com'), Date.parse(old), 'the recipient of the real send is still remembered');
  // the retry budget of the workflow: three real failures, not three console events
  const t = await setup({}, [JOBS[0]]);
  const refusing = await startFakeSmtp({ mode: 'refuse-rcpt' });
  try {
    await run(t.home, t.world, t.smtp, { SMTP_PORT: String(refusing.port) });
    const pid = events(t.home).find((e) => e.title.startsWith('A')).id;
    for (let i = 0; i < 2; i++) fs.appendFileSync(path.join(t.home, 'data', 'applications.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), id: pid, status: 'dismissed' })}\n${JSON.stringify({ ts: new Date().toISOString(), id: pid, status: 'failed' })}\n`);   // dismiss + undo, twice
    const r = await run(t.home, t.world, t.smtp, {}, ['--direct', '--force']);
    assert.equal(r.acted.sent.length, 1, 'still retried: only one real attempt failed');
  } finally { await refusing.close(); await t.done(); }
});

test('to-apply.csv mirrors the state after every run: what the user marked in the console shows up in Excel, newest first', { skip }, async () => {
  const t = await setup();
  try {
    await run(t.home, t.world, t.smtp);
    const csv = () => fs.readFileSync(path.join(t.home, 'data', 'to-apply.csv'), 'utf8').split('\n').filter(Boolean);
    assert.equal(csv().length, 3); assert.ok(csv().slice(1).every((l) => l.endsWith('"待投递"')));
    const b = events(t.home).find((e) => e.title.startsWith('B')).id;
    fs.appendFileSync(path.join(t.home, 'data', 'applications.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), id: b, status: 'applied' })}\n`);   // as the console does
    await run(t.home, t.world, t.smtp, {}, ['--direct', '--force']);
    const lines = csv(); assert.equal(lines.length, 3, 'rewritten, not appended');
    assert.ok(lines.some((l) => /"B 数据分析助理".*"我已投递"$/.test(l)), lines.join('\n')); assert.ok(lines.some((l) => /"D 假邮箱岗位".*"待投递"$/.test(l)));
  } finally { await t.done(); }
});

test('the same vacancy from another board (another link, same title and company) is not new', { skip }, async () => {
  const t = await setup({}, [{ title: 'X 数据分析实习生', company: 'Acme', snippet: '[score:9] 简历请发 hr@acme-corp.com' }]);
  try {
    const first = await run(t.home, t.world, t.smtp); assert.equal(first.acted.sent.length, 1);
    // tomorrow Remotive lists the same vacancy under its own link
    const again = await run(t.home, t.world, t.smtp, { JOOBLE_API_KEY: '', JOB_KEYWORDS: '', REMOTIVE: 'on', REMOTIVE_API_BASE: `${t.world.base}/remotive` }, ['--direct', '--force']);
    assert.equal(again.plan.fetched, 1); assert.equal(again.plan.items.length, 0);
  } finally { await t.done(); }
});

test('the local test mailbox without test mode sends nothing: postings are listed with their letter kept, and the report says why', { skip }, async () => {
  const t = await setup();
  try {
    const r = await run(t.home, t.world, t.smtp, { SMTP_HOST: '127.0.0.1', SMTP_PORT: '5725', SMTP_FROM: '', SMTP_USER: '' });   // the sink's address, MAIL_REDIRECT_TO cleared
    assert.equal(r.code, 0, r.message); assert.equal(r.acted.sent.length, 0);
    assert.ok(r.report.includes('本机测试邮箱'), r.report);
    const a = r.acted.listed.find((i) => i.title.startsWith('A')); assert.match(a.note, /本机测试邮箱/);
    const draft = fs.readdirSync(path.join(t.home, 'data', 'drafts')).find((f) => f.endsWith(`-${a.id}.txt`));
    assert.ok(draft, 'the letter is kept'); assert.match(fs.readFileSync(path.join(t.home, 'data', 'drafts', draft), 'utf8'), /To: hr@acme-corp\.com[\s\S]*您好，我是测试同学/);
    assert.equal(events(t.home).find((e) => e.id === a.id && e.status === 'manual').draft, true);
    // with test mode on, the same setup is a working test setup (nodemailer talks to the fake server standing in for the sink)
    const t2 = await setup();
    try { const ok = await run(t2.home, t2.world, t2.smtp, { SMTP_FROM: '', SMTP_USER: '', MAIL_REDIRECT_TO: 'me@example.net' }); assert.equal(ok.acted.sent.length, 1); assert.match(t2.smtp.mails[0].raw, /From: .*job-hunter@localhost\.test/); } finally { await t2.done(); }
  } finally { await t.done(); }
});

test('`jobhunt config set` refuses what the run would ignore, and normalises what it can', () => {
  const home = tmpdir('jh-cli-');
  const cli = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/jh.mjs', import.meta.url)), 'config', 'set', ...args], { env: { ...process.env, JOBHUNT_HOME: home }, encoding: 'utf8' });
  assert.equal(cli('MIN_SCORE', '99').status, 1); assert.equal(cli('JOB_REGION', '中国大陆').status, 1); assert.equal(cli('AI_BASE_URL', 'ftp://x').status, 1);
  assert.equal(cli('REMOTIVE', 'yes').status, 0); assert.equal(cli('AI_JSON_MODE', 'true').status, 0); assert.equal(cli('AI_BASE_URL', 'https://api.deepseek.com/chat/completions').status, 0);
  const cfg = fs.readFileSync(path.join(home, 'config.local.env'), 'utf8');
  assert.match(cfg, /REMOTIVE='on'/); assert.match(cfg, /AI_JSON_MODE='on'/); assert.match(cfg, /AI_BASE_URL='https:\/\/api\.deepseek\.com'/);
  assert.ok(!/MIN_SCORE/.test(cfg));
});
