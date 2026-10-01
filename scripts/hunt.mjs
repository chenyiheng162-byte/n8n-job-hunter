#!/usr/bin/env node
// Daily runner. Order of work:
//   1. preflight (profile, AI, sources)      2. run the workflow (n8n, or direct) -> a PLAN
//   3. act on the plan: e-mail the postings that have an application address, list the rest for the user
//   4. bookkeeping (state/applications.jsonl), the report (reports/DATE.md, to-apply.csv), notifications.
// Usage: hunt.mjs [--dry-run] [--direct] [--force] [--scheduled]
//   --dry-run   run everything up to the plan and print the report; sends nothing, writes no state, no marker
//   --direct    do not use n8n (plain Node, same stage code)
//   --force     ignore "already done today"
//   --scheduled quiet mode for launchd: a not-yet-configured install is a no-op with one notification a day
// Exit: 0 done (or nothing to do today), 1 failed (a later retry slot may succeed), 2 not configured.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadConfig, homeDir, KEYS, SECRET_KEYS } from './lib/config.mjs';
import { acquireLock } from './lib/lock.mjs';
import { sourceStatus } from './lib/sources.mjs';
import { SINK_PORT } from './lib/constants.mjs';
import { loadNodemailer as runtimeLoadNodemailer } from './lib/runtime.mjs';
import { parseProfile, validateProfile } from './lib/profile.mjs';
import { runDirect, runN8n, makeHttp, pruneExecutions } from './engine.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const today = (d = new Date()) => d.toLocaleDateString('sv-SE');
// A cell that starts with = + - @ (or a tab / CR) would be run as a formula when the file is opened in Excel; titles and reasons
// come from third-party sites, so such cells get a leading apostrophe.
const csvCell = (v) => { const t = String(v ?? ''); return `"${(/^[=+\-@\t\r]/.test(t) ? `'${t}` : t).replace(/"/g, '""')}"`; };
const redact = (s, secrets = []) => {
  let t = String(s || '').replace(/https?:\/\/\S+/g, '<链接>');
  for (const v of secrets) if (v && v.length >= 6) t = t.split(v).join('<密钥>');
  return t;
};

// ------------------------------------------------------------------ settings
export const isLocalHost = (h) => /^(127\.0\.0\.1|localhost|::1)$/i.test(String(h || ''));
// the console's local test mailbox: mail "sent" there is a file on this computer, so it is only ever a test
export const usesSink = (s) => isLocalHost(s.SMTP_HOST) && Number(s.SMTP_PORT || 465) === Number(s.JOBHUNT_SINK_PORT || SINK_PORT); // (JOBHUNT_SINK_PORT: tests)
export const sinkWithoutTestMode = (s) => usesSink(s) && !s.MAIL_REDIRECT_TO;
// the From address: SMTP_FROM, else the login, else (only for the local test mailbox) a placeholder that is never persisted
export const SINK_FROM = 'job-hunter@localhost.test';
// (an earlier version persisted the placeholder into the settings: it counts as unset anywhere but the test mailbox)
export const fromAddress = (s) => (s.SMTP_FROM === SINK_FROM && !usesSink(s) ? '' : s.SMTP_FROM) || s.SMTP_USER || (usesSink(s) ? SINK_FROM : '');
export function resolveSettings(env = process.env) {
  const home = homeDir(env);
  const cfg = loadConfig(home);
  const s = { ...cfg.values, ...Object.fromEntries(Object.entries(env).filter(([k]) => KEYS.includes(k) || /^JOBHUNT_/.test(k) || k === 'N8N_PORT')) }; // the environment may override the file (tests)
  const num = (k, d) => { const n = Number(s[k]); return Number.isFinite(n) && s[k] !== undefined && s[k] !== '' ? n : d; };
  return { home, cfg, s, num, profileFile: env.JOBHUNT_PROFILE_FILE || path.join(home, 'profile.md') };
}

export function preflight({ s, profileFile, cfg }, { forSending = true } = {}) {
  const problems = []; const warnings = [];
  if (cfg.errors.length) warnings.push(`config.local.env 第 ${cfg.errors.join(', ')} 行无法识别，已跳过`);
  let profile = '';
  try { profile = fs.readFileSync(profileFile, 'utf8'); } catch (e) { problems.push(`没有找到个人资料：${profileFile}`); }
  if (profile) { const bad = validateProfile(parseProfile(profile)); if (bad.length) problems.push(`个人资料还没填完：${bad.map((b) => `${b.label}（${b.message}）`).join('、')}`); }
  if (!s.AI_BASE_URL || !s.AI_API_KEY) problems.push('还没配置 AI（AI_BASE_URL / AI_API_KEY）');
  const src = sourceStatus(s);
  if (!src.ok) problems.push(s.JOOBLE_API_KEY && !s.JOB_KEYWORDS ? '还没配置搜索关键词 JOB_KEYWORDS（Jooble 需要）' : '还没配置职位来源（JOOBLE_API_KEY / JOB_RSS_URLS / REMOTIVE=on 至少一个）');
  else warnings.push(...src.warnings);
  if (s.MAIL_REDIRECT_TO) warnings.push(`测试模式已开启：所有投递邮件都会改发到 ${s.MAIL_REDIRECT_TO}，真正的收件人不会收到任何东西`);
  if (forSending && s.AUTO_SEND !== 'off') {
    if (!s.SMTP_HOST || !fromAddress(s)) warnings.push('没有配置发信邮箱（SMTP_*）：有邮箱的岗位只会写好信，列出来让你自己发');
    else if (sinkWithoutTestMode(s)) warnings.push('发信服务器还是本机测试邮箱，但测试模式已关闭：不会发出任何邮件，所有岗位只列出。要正式投递请在「发信邮箱」里填真实的 SMTP 服务器');
    else if (!s.RESUME_FILE) warnings.push('没有配置 RESUME_FILE：不带简历的投递没有意义，所有岗位只会列出来');
    else { try { fs.accessSync(s.RESUME_FILE, fs.constants.R_OK); } catch (e) { warnings.push(`读不到简历文件 ${s.RESUME_FILE}：所有岗位只会列出来`); } }
  }
  return { problems, warnings, profile };
}

const profileField = (profile, labels) => { for (const l of labels) { const m = profile.match(new RegExp(`^[\\s>*-]*${l}\\s*[:：]\\s*(.+)$`, 'mi')); if (m && m[1].trim() && !/待填写/.test(m[1])) return m[1].trim(); } return ''; };

// ------------------------------------------------------------------ state
const SEND_STATUS = ['sending', 'sent', 'unknown', 'failed'];
export class Store {
  constructor(home, { dryRun = false } = {}) {
    this.dir = path.join(home, 'data'); this.file = path.join(this.dir, 'applications.jsonl'); this.dryRun = dryRun;
    this.stateDir = path.join(this.dir, 'state'); this.reports = path.join(this.dir, 'reports');
    if (!dryRun) for (const d of [this.dir, this.stateDir, this.reports, path.join(this.dir, 'sent'), path.join(this.dir, 'drafts')]) fs.mkdirSync(d, { recursive: true });
  }
  // the letter written for a posting that was listed instead of sent, so the user can read and use it
  saveDraft(it) { if (this.dryRun || !it.body) return false; try { fs.writeFileSync(path.join(this.dir, 'drafts', `${today()}-${it.id}.txt`), `To: ${it.to || ''}\nSubject: ${it.subject || ''}\n\n${it.body}\n`); return true; } catch (e) { return false; } }
  events() {
    let t = ''; try { t = fs.readFileSync(this.file, 'utf8'); } catch (e) { /* none yet */ }
    return t.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  }
  record(ev) { if (this.dryRun) return; fs.appendFileSync(this.file, `${JSON.stringify({ ts: new Date().toISOString(), ...ev })}\n`); }
  // How many postings were (possibly) mailed today. Counted per posting, not per event: one send writes "sending" AND
  // "sent" (or "unknown"), and a send that certainly failed frees its slot again.
  // (Only the sender's own events carry `to`: a console mark, or an undo restoring an earlier status, is not a send.)
  sentToday(day = today()) {
    const byId = new Map();
    for (const e of this.events()) { if (!e.id || e.to === undefined || !SEND_STATUS.includes(e.status)) continue; const c = byId.get(e.id) || { today: false, last: '' }; if (e.status !== 'failed' && e.ts && today(new Date(e.ts)) === day) c.today = true; c.last = e.status; byId.set(e.id, c); }
    return [...byId.values()].filter((c) => c.today && c.last !== 'failed').length;
  }
  // When was `to` last really written to? Decided per posting by its LAST send status (a failed send reached nobody and must
  // not start a cooldown; a test-mode send is not real contact). 0 = never.
  lastContact(to) {
    const t = String(to).toLowerCase(); const last = new Map();
    for (const e of this.events()) if (e.id && e.to !== undefined && SEND_STATUS.includes(e.status)) last.set(e.id, e);
    return Math.max(0, ...[...last.values()].filter((e) => e.status !== 'failed' && e.to && !e.redirected && String(e.to).toLowerCase() === t).map((e) => Date.parse(e.ts) || 0));
  }
  marker(name) { return path.join(this.stateDir, name); }
  has(name) { return fs.existsSync(this.marker(name)); }
  set(name) { if (!this.dryRun) fs.writeFileSync(this.marker(name), `${new Date().toISOString()}\n`); }
}

// ------------------------------------------------------------------ sending
// "failed"  = the mail certainly did not leave (could not connect, login refused, recipient refused): retried on a later day.
// "unknown" = it may have left (timeout, broken connection mid-way): never sent again automatically.
const CERTAINLY_NOT_SENT_CODE = /^(EAUTH|EENVELOPE)$/;                       // login refused / every recipient refused
const CERTAINLY_NOT_SENT_MSG = /\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b/; // never connected
const certainlyNotSent = (e) => { const code = String((e && (e.code || (e.cause && e.cause.code))) || ''); const msg = String((e && e.message) || ''); return CERTAINLY_NOT_SENT_CODE.test(code) || CERTAINLY_NOT_SENT_MSG.test(msg) || code === 'ETLS' || (e && e.command === 'STARTTLS') || /STARTTLS|initiating TLS/i.test(msg); }; // (ETLS: STARTTLS refused or failed, which happens before anything is sent)
// ("Connection closed unexpectedly" and timeouts are NOT in these lists: they can happen after the body went out.)
// nodemailer ships with n8n: find it in the runtime folder that provides n8n (see lib/runtime.mjs)
export const loadNodemailer = runtimeLoadNodemailer;
export function makeTransport(s, req) {
  const nodemailer = req('nodemailer');
  const port = Number(s.SMTP_PORT || 465);
  const secure = s.SMTP_SECURE ? s.SMTP_SECURE === 'on' : port === 465;
  const local = /^(127\.0\.0\.1|localhost|::1)$/i.test(String(s.SMTP_HOST || ''));
  return nodemailer.createTransport({
    host: s.SMTP_HOST, port, secure,
    requireTLS: !secure && !local, // on 587 etc. the password only goes out after STARTTLS; never in clear (the local test mailbox has no TLS)
    ...(s.SMTP_USER ? { auth: { user: s.SMTP_USER, pass: s.SMTP_PASS || '' } } : {}),
    connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 60000,
  });
}
export function makeMailer(s, req) {
  const transport = makeTransport(s, req);
  return async (mail) => {
    try { const r = await transport.sendMail(mail); return { status: 'sent', messageId: r.messageId }; } catch (e) {
      const code = String((e && (e.code || (e.cause && e.cause.code))) || '');
      return { status: certainlyNotSent(e) ? 'failed' : 'unknown', reason: `${code || 'error'} ${redact(e && e.message).slice(0, 160)}` };
    }
  };
}

export async function act({ plan, store, ctx, send, log = () => {} }) {
  const { s, num, fromName, replyTo } = ctx;
  const out = { sent: [], listed: [], skipped: [], attention: [], deferred: [] };
  const cap = num('MAX_APPLICATIONS_PER_DAY', 10);
  const cooldownMs = num('RECIPIENT_COOLDOWN_DAYS', 30) * 86400000;
  const canSend = s.AUTO_SEND !== 'off' && !!send && !ctx.dryRun && cap > 0; // a cap of 0 is a pause: listed once, like AUTO_SEND=off (not deferred and re-scored every day)
  let count = store.sentToday();
  const used = new Set();
  // what the console shows on a card: kept in the event so the page needs nothing else (the long description only for postings the user may act on)
  const lean = (it) => ({ id: it.id, title: it.title, company: it.company, location: it.location, url: it.url, source: it.source, score: it.score, reason: it.reason });
  const base = (it) => ({ ...lean(it), salary: it.salary || undefined, jobType: it.jobType || undefined, tags: it.tags && it.tags.length ? it.tags : undefined, category: it.category || undefined, logo: it.logo || undefined, postedAt: it.postedAt || undefined, summary: it.summary || undefined, highlights: it.highlights && it.highlights.length ? it.highlights : undefined, concerns: it.concerns && it.concerns.length ? it.concerns : undefined, applyUrl: it.applyUrl || undefined, desc: it.desc || undefined, contactSource: it.contactSource || undefined });
  const manual = (it, note) => { const draft = store.saveDraft(it); out.listed.push({ ...it, note: note || it.note }); store.record({ ...base(it), status: 'manual', to: it.to || undefined, note: note || it.note || undefined, draft: draft || undefined }); };

  for (const it of plan.items) {
    if (it.route === 'skip') { out.skipped.push(it); store.record({ ...lean(it), status: 'skipped' }); continue; }
    if (it.route !== 'email') { manual(it); continue; }

    const intended = it.to.toLowerCase();
    // TEST MODE: every application mail goes to MAIL_REDIRECT_TO instead; the real recipient receives nothing, and the
    // mail itself says who it was meant for. Test sends are not real contact: no cooldown, and they do not count as "written to".
    const redirect = (s.MAIL_REDIRECT_TO || '').toLowerCase();
    const to = redirect || intended;
    const extra = redirect ? { intendedTo: intended, redirected: true } : {};
    if (!canSend) { manual(it, ctx.dryRun ? '（试运行：没有发送）' : cap <= 0 && send && s.AUTO_SEND !== 'off' ? '邮件已写好但没有发送（每日上限设为 0）' : sinkWithoutTestMode(s) ? '邮件已写好但没有发送（发信服务器还是本机测试邮箱，测试模式又已关闭）' : s.AUTO_SEND === 'off' ? '邮件已写好但没有发送（自动发送已关闭）' : '邮件已写好但没有发送（没配好发信邮箱或简历）'); continue; }
    if (used.has(intended) || (!redirect && Date.now() - store.lastContact(intended) < cooldownMs)) { manual(it, `近期已给 ${intended} 发过邮件，这次改为列出，请自己决定`); continue; }
    if (count >= cap) { out.deferred.push({ ...it, note: `今天已达每日上限 ${cap} 封，留到明天（不记录，明天会重新评估）` }); continue; }

    used.add(intended); count += 1;
    const subject = redirect ? `【测试】${it.subject}` : it.subject;
    const text = redirect
      ? `【测试模式】这封邮件原本要发给：${intended}\n岗位：${it.company ? `${it.company} · ` : ''}${it.title}\n${it.url}\n（它被重定向到了你自己的邮箱，真正的收件人没有收到任何东西。）\n\n———— 以下是原本会发出的邮件 ————\n\n${it.body}`
      : it.body;
    store.record({ ...base(it), status: 'sending', to, subject, ...extra }); // written BEFORE the attempt: a crash leaves "unknown", never a resend
    const r = await send({
      from: fromName ? { name: fromName, address: fromAddress(s) } : fromAddress(s), to, subject, text,
      ...(replyTo ? { replyTo } : {}), attachments: [{ filename: path.basename(s.RESUME_FILE), path: s.RESUME_FILE }],
    });
    log(`mail to ${to}${redirect ? ` (test mode; meant for ${intended})` : ''}: ${r.status}`);
    const item = { ...it, to, intendedTo: redirect ? intended : undefined };
    if (r.status === 'sent') {
      store.record({ ...base(it), status: 'sent', to, subject, messageId: r.messageId, ...extra });
      try { fs.writeFileSync(path.join(store.dir, 'sent', `${today()}-${it.id}.txt`), `To: ${to}${redirect ? ` (originally: ${intended})` : ''}\nSubject: ${subject}\n\n${text}\n`); } catch (e) { /* a record only */ }
      out.sent.push(item);
    } else if (r.status === 'failed') {
      count -= 1; used.delete(intended);
      store.record({ ...base(it), status: 'failed', to, note: r.reason, ...extra });
      out.attention.push({ ...item, note: `发送失败（明天重试）：${r.reason}` });
    } else {
      store.record({ ...base(it), status: 'unknown', to, note: r.reason, ...extra });
      out.attention.push({ ...item, note: `发送结果不确定，可能已发出，不会自动重发：${r.reason}` });
    }
  }
  return out;
}

// ------------------------------------------------------------------ the to-apply spreadsheet
// to-apply.csv is rewritten from the current state after every run: every posting that was ever listed for the user, with
// what the user did about it in the console (待投递 / 我已投递 / 已忽略), newest first. Excel opens it directly.
const CSV_STATUS = { manual: '待投递', applied: '我已投递', dismissed: '已忽略' };
export function writeTodoCsv(store) {
  const merged = new Map();
  for (const e of store.events()) { if (!e.id) continue; const m = merged.get(e.id) || {}; merged.set(e.id, { ...m, ...e, listedAt: m.listedAt || (e.status === 'manual' ? e.ts : undefined) }); }
  const rows = [...merged.values()].filter((j) => CSV_STATUS[j.status] && j.listedAt).sort((a, b) => String(b.listedAt).localeCompare(String(a.listedAt)));
  const file = path.join(store.dir, 'to-apply.csv');
  if (!rows.length && !fs.existsSync(file)) return;
  const text = `﻿日期,公司,岗位,评分,投递链接,理由,备注,状态\n${rows.map((j) => [today(new Date(j.listedAt)), j.company, j.title, j.score, j.applyUrl || j.url, j.reason, j.note || '', CSV_STATUS[j.status]].map(csvCell).join(',')).join('\n')}${rows.length ? '\n' : ''}`;
  const tmp = `${file}.tmp-${process.pid}`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file);
}

// ------------------------------------------------------------------ report
export function renderReport({ plan, result, date, dryRun, warnings }) {
  const L = [];
  const job = (it) => `${it.company ? `${it.company} · ` : ''}${it.title}`;
  L.push(`# 求职日报 ${date}${dryRun ? '（试运行，没有发送任何邮件）' : ''}`, '');
  const deferred = result.deferred || [];
  L.push(`新岗位 ${plan.fetched} 个 · 评分合格 ${plan.items.filter((i) => i.route !== 'skip').length} · **已邮件投递 ${result.sent.length}** · **需要你自己投递 ${result.listed.length}** · 不合适 ${result.skipped.length}${deferred.length ? ` · 留到明天 ${deferred.length}` : ''}${result.attention.length ? ` · 需留意 ${result.attention.length}` : ''}`, '');
  if (result.sent.length) { L.push('## ✅ 已邮件投递'); for (const it of result.sent) L.push(`- ${job(it)}（${it.score} 分）→ ${it.intendedTo ? `${it.intendedTo}（测试模式：实际发到 ${it.to}）` : it.to}`); L.push(''); }
  if (result.listed.length) {
    L.push('## 📝 需要你自己投递（点链接去投递网站）');
    for (const it of result.listed) L.push(`- [ ] **${job(it)}**（${it.score} 分）${it.applyUrl || it.url}${it.reason ? `\n  - ${it.reason}` : ''}${it.note ? `\n  - ⚠️ ${it.note}` : ''}${it.to ? `\n  - 邮箱：${it.to}` : ''}`);
    L.push('');
  }
  if (result.attention.length) { L.push('## ⚠️ 需要留意'); for (const it of result.attention) L.push(`- ${job(it)} → ${it.to || ''}：${it.note}`); L.push(''); }
  if (deferred.length) { L.push('## ⏭ 留到明天（今天已达每日上限，明天重新评估）'); for (const it of deferred) L.push(`- ${job(it)} → ${it.to || ''}`); L.push(''); }
  const warn = [...(plan.warnings || []), ...(warnings || [])];
  if (result.sent.some((i) => i.intendedTo)) warn.unshift('测试模式：投递邮件都被重定向到了测试邮箱，真正的收件人没有收到任何东西');
  if (plan.overflow) warn.push(`还有 ${plan.overflow} 个新岗位超出每次处理上限，明天继续`);
  if (warn.length) { L.push('## 提示'); for (const w of warn) L.push(`- ${w}`); L.push(''); }
  if (!plan.items.length) L.push('今天没有新岗位。', '');
  return L.join('\n');
}

// After waking from sleep the network can be a minute or two late (seen in practice): wait for it, longer if we just woke.
export async function waitForNetwork(url, { fetchImpl = globalThis.fetch, maxMs, log = () => {} } = {}) {
  if (!url) return true;
  let limit = maxMs;
  if (limit === undefined) {
    limit = 60000;
    try { const m = (spawnSync('sysctl', ['-n', 'kern.waketime'], { encoding: 'utf8' }).stdout || '').match(/sec = (\d+)/); if (m && Date.now() / 1000 - Number(m[1]) < 300) limit = 180000; } catch (e) { /* default */ }
  }
  const deadline = Date.now() + limit;
  for (;;) {
    try { await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) }); return true; } catch (e) { /* not yet */ }
    if (Date.now() >= deadline) { log('network still unreachable, continuing anyway'); return false; }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const notify = (title, text) => { try { spawnSync('osascript', ['-e', `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)}`], { timeout: 5000 }); } catch (e) { /* optional */ } };

async function postDiscord(url, text, fetchImpl) {
  try { await makeHttp(fetchImpl)({ method: 'POST', url, body: { content: text.slice(0, 1900), allowed_mentions: { parse: [] } }, timeout: 15000 }); } catch (e) { /* the report file is the record; Discord is a courtesy */ } // no mentions: a posting title could say @everyone
}

// ------------------------------------------------------------------ main
export async function runHunt({ env = process.env, args = [], fetchImpl = globalThis.fetch, send, log = () => {}, notifier = notify } = {}) {
  const dryRun = args.includes('--dry-run'); const direct = args.includes('--direct') || env.JOBHUNT_ENGINE === 'direct'; const force = args.includes('--force'); const scheduled = args.includes('--scheduled');
  const st = resolveSettings(env);
  const store = new Store(st.home, { dryRun });
  const date = today();
  const result = { code: 0, report: '' };

  const pf = preflight(st);
  if (pf.problems.length) {
    const msg = `求职助手还没配置完：${pf.problems.join('；')}`;
    log(msg);
    if (!dryRun) { try { fs.writeFileSync(path.join(store.stateDir, 'last-run.json'), JSON.stringify({ ts: new Date().toISOString(), result: 'unconfigured', message: msg })); } catch (e) { /* informational */ } }
    if (!dryRun && !store.has(`notified-${date}`)) { store.set(`notified-${date}`); notifier('求职助手', msg.slice(0, 120)); }
    return { code: 2, message: msg, report: msg };
  }
  if (!dryRun && !force && store.has(`done-${date}`)) { log('today is already done'); return { code: 0, message: 'already done today', report: '' }; }

  const t0 = Date.now();
  const secrets = SECRET_KEYS.map((k) => st.s[k]).filter(Boolean).flatMap((v) => String(v).split(/\s+/));
  const lastRun = (o) => { if (!dryRun) { try { fs.writeFileSync(path.join(store.stateDir, 'last-run.json'), JSON.stringify({ ts: new Date().toISOString(), ms: Date.now() - t0, ...o })); } catch (e) { /* informational */ } } };
  // One run at a time, by the system's own file lock (released automatically however this process ends). A dry run takes it
  // too: it runs the same n8n folder and plan file, so it must not overlap a real run. The lock file lives in HOME, outside
  // data/, so a dry run still writes nothing under data/.
  const got = await acquireLock(st.home, dryRun ? 'hunt-dry-run' : 'hunt');
  if (!got.ok && !got.error) { log(`another run is in progress (${got.holder})`); return { code: 0, message: 'another run in progress', report: dryRun ? '已经有一次运行在进行中，请等它结束再试运行' : '' }; }
  if (!got.ok) { // no lock tool / it broke: say so loudly (exit 1, retried by a later slot) instead of pretending a run is in progress
    const msg = `求职助手运行失败：无法获取运行锁（${got.message || got.holder}）`;
    log(msg); lastRun({ result: 'failed', message: msg });
    if (!dryRun && !store.has(`notified-${date}`)) { store.set(`notified-${date}`); notifier('求职助手', msg.slice(0, 120)); }
    return { code: 1, message: msg, report: msg };
  }
  const lock = got;
  try {
    if (scheduled && st.s.AI_BASE_URL) await waitForNetwork(st.s.AI_BASE_URL, { fetchImpl, log });
    const stageEnv = { ...process.env, ...env, ...st.s, JOBHUNT_HOME: st.home, JOBHUNT_PROFILE_FILE: st.profileFile, JOBHUNT_STATE_FILE: store.file };
    const planFile = path.join(store.dir, 'state', 'plan.json');
    let plan;
    // the build that install.sh imported into n8n (the runtime folder's copy; the repo's copy only when run straight from the repo)
    const expectedBuild = [path.join(st.home, 'workflows', 'BUILD'), path.join(here, '..', 'workflows', 'BUILD')].map((f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch (e) { return ''; } }).find(Boolean) || '';
    if (direct) plan = await runDirect({ env: stageEnv, fetchImpl, log });
    else {
      try { fs.mkdirSync(store.dir, { recursive: true }); fs.mkdirSync(store.stateDir, { recursive: true }); plan = await runN8n({ env: stageEnv, home: st.home, planFile, expectedBuild, log }); } catch (e) {
        if (!e.notExecuted) throw e;
        log(`${e.message}; falling back to the direct engine`);
        plan = await runDirect({ env: stageEnv, fetchImpl, log });
      }
    }
    // every source failing (network down after waking from sleep) is a failure, not "no new jobs": a later slot tries again
    // (a source that answered with zero postings did not fail)
    if (!plan.fetched && !plan.sourcesOk && (plan.warnings || []).some((w) => /^(Jooble|Remotive|RSS)/.test(w))) throw new Error(`所有职位来源都失败了：${plan.warnings[0]}`);

    // warnings carry upstream error bodies: the exact secrets are scrubbed before anything is written or posted
    plan.warnings = (plan.warnings || []).map((w) => redact(w, secrets));
    // sending
    let sender = send;
    const warnings = pf.warnings.map((w) => redact(w, secrets));
    const wantSend = st.s.AUTO_SEND !== 'off' && st.s.SMTP_HOST && fromAddress(st.s) && !sinkWithoutTestMode(st.s) && st.s.RESUME_FILE && fs.existsSync(st.s.RESUME_FILE);
    if (!sender && wantSend && !dryRun) {
      const req = loadNodemailer(env, st.home);
      if (req) sender = makeMailer(st.s, req); else warnings.push('找不到 nodemailer，无法发邮件（有邮箱的岗位只列出）');
    }
    const profile = pf.profile;
    const ctx = { s: st.s, num: st.num, dryRun, fromName: st.s.MAIL_FROM_NAME || profileField(profile, ['姓名', 'Name']), replyTo: st.s.REPLY_TO || profileField(profile, ['邮箱', 'Email', 'E-mail']) };
    const acted = await act({ plan, store, ctx, send: sender, log });

    const report = renderReport({ plan, result: acted, date, dryRun, warnings });
    result.report = report; result.acted = acted; result.plan = plan;
    if (!dryRun) {
      fs.writeFileSync(path.join(store.reports, `${date}.md`), `${report}\n`);
      writeTodoCsv(store);
      store.set(`done-${date}`);
      const testMode = !!st.s.MAIL_REDIRECT_TO;
      lastRun({ result: 'ok', engine: direct ? 'direct' : 'n8n', sent: acted.sent.length, listed: acted.listed.length, skipped: acted.skipped.length, attention: acted.attention.length, deferred: acted.deferred.length, fetched: plan.fetched, warnings: (plan.warnings || []).length + warnings.length, testMode });
      const head = `${testMode ? '【测试模式，没有真正发出】' : ''}已投递 ${acted.sent.length} · 待你投递 ${acted.listed.length}${acted.deferred.length ? ` · 留到明天 ${acted.deferred.length}` : ''}${acted.attention.length ? ` · 需留意 ${acted.attention.length}` : ''}`;
      notifier('求职日报', head);
      if (st.s.DISCORD_WEBHOOK_URL) await postDiscord(st.s.DISCORD_WEBHOOK_URL, report, fetchImpl);
    }
    return result;
  } catch (e) {
    const msg = `求职助手运行失败：${redact(e.message, secrets).slice(0, 300)}`;
    log(msg);
    lastRun({ result: 'failed', message: msg });
    if (!dryRun && !store.has(`notified-${date}`)) { store.set(`notified-${date}`); notifier('求职助手', msg.slice(0, 120)); }
    return { code: 1, message: msg, report: msg };
  } finally {
    if (!direct && !dryRun) pruneExecutions(st.home);
    await lock.release();
  }
}

if (process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]))) {
  const args = process.argv.slice(2);
  const r = await runHunt({ args, log: (m) => process.stderr.write(`[hunt] ${m}\n`) });
  if (args.includes('--dry-run') || !args.includes('--scheduled')) process.stdout.write(`${r.report || r.message || ''}\n`);
  process.exit(r.code);
}
