import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runHunt } from '../scripts/hunt.mjs';
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
    assert.equal(r.acted.attention.length, 1);
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
