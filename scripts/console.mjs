#!/usr/bin/env node
// Local control console for the job hunter: fill in your details, see what was applied for, and open the sites that need
// you. Start it with `jobhunt console`. It listens on 127.0.0.1 only and prints a link with a random token; nothing is
// reachable from other machines, and other web pages cannot use it (token cookie, Host check, custom header on every change).
//
// Secrets (AI key, SMTP password, Jooble key, RSS links, Discord webhook) are NEVER sent to the browser: the page only learns
// whether they are set and a harmless hint. Settings go through the same strict, atomic, mode-600 file as the CLI.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import dns from 'node:dns/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { homeDir, loadConfig, applyChanges, SECRET_KEYS } from './lib/config.mjs';
import { parseProfile, renderProfile, validateProfile, emptyProfile } from './lib/profile.mjs';
import { lockBusy, acquireLock } from './lib/lock.mjs';
import { startSink, sinkCount } from './lib/sink.mjs';
import { REGIONS, DEFAULT_REGION, searchLocation } from './lib/regions.mjs';
import { sourceStatus } from './lib/sources.mjs';
import { Store, loadNodemailer, makeTransport, fromAddress, usesSink, sinkWithoutTestMode, isLocalHost } from './hunt.mjs';
import { SINK_PORT } from './lib/constants.mjs';

const here = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
const UI_DIR = path.join(here, 'console');
const redactAll = (text, secrets) => { let t = String(text); for (const v of secrets) if (v && v.length >= 6) t = t.split(v).join('<密钥>'); return t; };

// ---------------------------------------------------------------- settings schema ------------------------------------
const onoff = (v) => (/^(on|1|true|yes)$/i.test(v) ? 'on' : 'off');
export const FIELDS = [
  { key: 'AI_BASE_URL', group: 'ai', label: '接口地址', type: 'url', placeholder: 'https://api.deepseek.com', help: '任意 OpenAI 兼容接口。本机模型可以用 http://127.0.0.1:端口。' },
  { key: 'AI_API_KEY', group: 'ai', label: 'API 密钥', type: 'text', secret: true, help: '只保存在这台电脑上，页面永远不会再显示它。' },
  { key: 'AI_MODEL', group: 'ai', label: '模型', type: 'text', placeholder: 'deepseek-chat', help: '不填就用 deepseek-chat。' },
  { key: 'AI_JSON_MODE', group: 'ai', label: '要求接口按 JSON 格式回答（response_format）', type: 'bool', default: 'on', help: '绝大多数接口都支持；接口对此报 400 时再关掉。' },
  { key: 'JOB_KEYWORDS', group: 'sources', label: '搜索关键词', type: 'text', placeholder: '数据分析, 实习', help: '逗号分隔，每个关键词会单独搜一次。' },
  { key: 'JOB_REGION', group: 'sources', label: '目标地区（职位在哪里）', type: 'select', default: 'hk', options: ['hk', 'cn', 'tw', 'sg', 'jp', 'us', 'uk', 'ca', 'au', 'global'], labels: ['香港（默认）', '中国大陆', '台湾', '新加坡', '日本', '美国', '英国', '加拿大', '澳大利亚', '不限地区（只看可远程的岗位）'], help: '决定去哪里搜职位，也决定 AI 评分时哪些岗位算"在目标地区"。' },
  { key: 'JOB_LOCATION', group: 'sources', label: '更具体的地点（可选）', type: 'text', placeholder: 'Kowloon / Central', help: '比如香港的某个区；填了就用它搜索，留空用上面的地区。' },
  { key: 'JOOBLE_API_KEY', group: 'sources', label: 'Jooble API Key', type: 'text', secret: true, help: '在 jooble.org/api/about 免费申请。' },
  { key: 'JOB_RSS_URLS', group: 'sources', label: 'RSS 订阅地址', type: 'urls', secret: true, help: '任意职位 RSS（例如 rss.app 把 LinkedIn 搜索页转成的地址）。每行一个。' },
  { key: 'REMOTIVE', group: 'sources', label: '同时搜索 Remotive（只有远程岗位）', type: 'bool', help: '免费，不需要 key。' },
  { key: 'JOB_MAX_AGE_DAYS', group: 'sources', label: '忽略发布超过多少天的岗位', type: 'int', min: 1, max: 365, placeholder: '30' },
  { key: 'SMTP_HOST', group: 'mail', label: 'SMTP 服务器', type: 'host', placeholder: 'smtp.gmail.com' },
  { key: 'SMTP_PORT', group: 'mail', label: '端口', type: 'int', min: 1, max: 65535, placeholder: '465' },
  { key: 'SMTP_SECURE', group: 'mail', label: '加密方式', type: 'select', options: ['', 'on', 'off'], labels: ['自动（465 端口用 SSL，其它端口用 STARTTLS）', 'SSL（465）', 'STARTTLS（587 等；密码只在加密后发送）'], help: '除本机测试邮箱外，连接一定是加密的。' },
  { key: 'SMTP_USER', group: 'mail', label: '登录账号', type: 'text' },
  { key: 'SMTP_PASS', group: 'mail', label: '密码', type: 'text', secret: true, help: 'Gmail 请用"应用专用密码"，不是登录密码。' },
  { key: 'SMTP_FROM', group: 'mail', label: '发件人邮箱', type: 'email', help: '不填就用登录账号。' },
  { key: 'MAIL_FROM_NAME', group: 'mail', label: '发件人姓名', type: 'text', help: '不填就用个人资料里的姓名。' },
  { key: 'REPLY_TO', group: 'mail', label: '回复到', type: 'email', help: '不填就用个人资料里的邮箱。' },
  { key: 'AUTO_SEND', group: 'rules', label: '自动发送投递邮件', type: 'bool', default: 'on', help: '关闭后只写信、只列清单，从不发邮件。' },
  { key: 'MIN_SCORE', group: 'rules', label: '最低评分（0-10）', type: 'int', min: 1, max: 10, placeholder: '7', help: 'AI 觉得匹配度达到这个分才会投。' },
  { key: 'MAX_APPLICATIONS_PER_DAY', group: 'rules', label: '每天最多发几封邮件', type: 'int', min: 0, max: 50, placeholder: '10' },
  { key: 'MAX_JOBS_PER_RUN', group: 'rules', label: '每天最多看几个新岗位', type: 'int', min: 5, max: 100, placeholder: '40' },
  { key: 'RECIPIENT_COOLDOWN_DAYS', group: 'rules', label: '同一邮箱几天内不重复发', type: 'int', min: 0, max: 365, placeholder: '30' },
  { key: 'PAGE_EMAILS', group: 'rules', label: '也使用岗位网页里找到的邮箱（不太可靠）', type: 'bool', help: '默认只用岗位正文里写明的投递邮箱。网页上的邮箱常常是公司通用邮箱，不一定接收投递。' },
  { key: 'HR_EMAIL_SEARCH', group: 'rules', label: '岗位里没有邮箱时，去网上搜 HR 邮箱（风险更高）', type: 'bool', help: '需要下面两个 key；搜到的邮箱可能不是对的人。' },
  { key: 'SERPER_API_KEY', group: 'rules', label: 'Serper API Key', type: 'text', secret: true },
  { key: 'MAILBOXLAYER_API_KEY', group: 'rules', label: 'MailboxLayer API Key', type: 'text', secret: true },
  { key: 'MAIL_REDIRECT_TO', group: 'test', label: '测试模式：所有投递邮件改发到这个邮箱', type: 'email', help: '填了就进入测试模式：真正的收件人不会收到任何东西，邮件开头会写明"原本要发给谁"。要正式投递时清空它。' },
  { key: 'DISCORD_WEBHOOK_URL', group: 'notify', label: 'Discord Webhook（可选）', type: 'url', secret: true, help: '每天的日报也发一份到这个频道。' },
];
const FIELD = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
// ---- company logos: fetched by the SERVER (the page may only load images from itself), under strict rules ----
const privateAddr = (a) => {
  if (net.isIPv4(a)) { const [x, y] = a.split('.').map(Number); return x === 0 || x === 10 || x === 127 || x >= 224 || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127); }
  const v = a.toLowerCase(); if (v.startsWith('::ffff:')) return privateAddr(v.slice(7));
  return v === '::1' || v === '::' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
};
async function fetchLogo(ctx, url) {
  let u = url;
  for (let hop = 0; hop < 3; hop++) {
    let p; try { p = new URL(u); } catch (e) { return null; }
    if (p.protocol !== 'https:' || p.username || p.password) return null;                      // https only, no credentials in the URL
    const addrs = await ctx.lookup(p.hostname).catch(() => []);
    if (!addrs.length || addrs.some((a) => privateAddr(a.address || a))) return null;          // a posting must not make us call this computer or the LAN
    const r = await ctx.fetchImpl(p.href, { redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'job-hunter-console' } });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { u = new URL(r.headers.get('location'), p.href).href; continue; }   // every hop is checked again
    const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!r.ok || !/^image\/(png|jpeg|gif|webp)$/.test(type)) return null;                       // no SVG: it can carry script
    if (Number(r.headers.get('content-length')) > 300 * 1024) return null;
    const buf = await readUpTo(r, 300 * 1024);                                                    // never buffer a huge "logo"
    return buf && buf.length > 0 ? { buf, type } : null;
  }
  return null;
}

// the body of a response, or null once it exceeds `max` bytes (the rest is not read)
async function readUpTo(r, max) {
  if (!r.body || typeof r.body.getReader !== 'function') { const b = Buffer.from(await r.arrayBuffer()); return b.length <= max ? b : null; }
  const reader = r.body.getReader(); const chunks = []; let n = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; if (n > max) { reader.cancel().catch(() => {}); return null; } chunks.push(value); }
  return Buffer.concat(chunks);
}
const hostOf = (u) => { try { return new URL(u).host; } catch (e) { return ''; } };

// Returns [normalisedValue, null] or [null, message]. '' means "remove the setting".
export function validate(key, raw) {
  const f = FIELD[key];
  if (!f) return [null, '未知的设置项'];
  let v = String(raw ?? '');
  if (/[\r\n]/.test(v) && f.type !== 'urls') return [null, '不能包含换行'];
  if (v.includes("'")) return [null, "不能包含单引号 '"];
  v = f.type === 'urls' ? v : v.trim();
  if (v === '') return ['', null];
  switch (f.type) {
    case 'url': { if (key === 'AI_BASE_URL') v = v.replace(/\/+$/, '').replace(/\/(chat\/completions|completions|models)$/i, ''); /* the full endpoint was pasted: keep the root (and a /v1) */ return /^https:\/\/\S+$/.test(v) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/\S*)?$/.test(v) ? [v.replace(/\/+$/, ''), null] : [null, '应以 https:// 开头（本机服务可用 http://127.0.0.1）']; }
    case 'urls': { const list = v.split(/\s+/).filter(Boolean); return list.every((u) => /^https?:\/\/\S+$/.test(u)) ? [[...new Set(list)].join(' '), null] : [null, '每个地址都应以 http:// 或 https:// 开头']; }
    case 'int': { if (!/^\d+$/.test(v)) return [null, '应为整数']; const n = Number(v); return n < f.min || n > f.max ? [null, `应在 ${f.min} 到 ${f.max} 之间`] : [String(n), null]; }
    case 'bool': return [onoff(v), null];
    case 'email': return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? [v, null] : [null, '邮箱格式不对'];
    case 'select': return f.options.includes(v) ? [v, null] : [null, '选项不对'];
    case 'host': return /^[A-Za-z0-9.-]+$/.test(v) ? [v, null] : [null, '应为服务器域名，例如 smtp.gmail.com'];
    default: return v.length > 300 ? [null, '太长了'] : [v, null];
  }
}

// ---------------------------------------------------------------- context --------------------------------------------
export function makeContext(opts = {}) {
  const home = opts.home || homeDir();
  const label = opts.label || process.env.JOBHUNT_LABEL || 'com.cc-workspace.n8n-job-hunter';
  const scriptsDir = opts.scriptsDir || here;
  const profileFile = path.join(home, 'profile.md');
  const store = () => new Store(home, { dryRun: true }); // read-only view; writes append through appendEvent
  // applications.jsonl is parsed once per version of the file (size + mtime), not once per request / per logo
  let cache = { key: '', events: [] };
  const events = () => { let st; try { st = fs.statSync(path.join(home, 'data', 'applications.jsonl')); } catch (e) { return []; } const key = `${st.size}:${st.mtimeMs}`; if (cache.key !== key) cache = { key, events: store().events() }; return cache.events; };
  const cfg = () => loadConfig(home).values;
  const secrets = () => SECRET_KEYS.flatMap((k) => String(cfg()[k] || '').split(/\s+/)).filter((v) => v.length >= 6);
  const readProfile = () => { try { return parseProfile(fs.readFileSync(profileFile, 'utf8')); } catch (e) { return emptyProfile(); } };
  const resumeInfo = () => {
    const f = cfg().RESUME_FILE; if (!f) return { set: false };
    try { const st = fs.statSync(f); return { set: true, name: path.basename(f), size: st.size, exists: true }; } catch (e) { return { set: true, name: path.basename(f), exists: false }; }
  };
  const appendEvent = (ev) => { const d = path.join(home, 'data'); fs.mkdirSync(d, { recursive: true }); fs.appendFileSync(path.join(d, 'applications.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), ...ev })}\n`); };
  const sinkPort = opts.sinkPort || SINK_PORT;
  const lookup = opts.lookup || ((h) => dns.lookup(h, { all: true }));
  return { home, label, scriptsDir, sinkPort, lookup, fetchImpl: opts.fetchImpl || globalThis.fetch, profileFile, store, events, cfg, secrets, readProfile, resumeInfo, appendEvent, run: { proc: null, mode: '', startedAt: 0, lines: [], code: null }, env: opts.env || process.env, nodeBin: opts.nodeBin || process.execPath };
}

const effective = (ctx) => ctx.cfg();

const regionLabel = (code) => (REGIONS[code] || REGIONS[DEFAULT_REGION]).zh.replace(/（.*$/, '');
function checklist(ctx) {
  const s = ctx.cfg(); const prof = validateProfile(ctx.readProfile()); const resume = ctx.resumeInfo(); const src = sourceStatus(s);
  const smtpOk = !!(s.SMTP_HOST && fromAddress(s)) && s.AUTO_SEND !== 'off' && !sinkWithoutTestMode(s);
  const mailDetail = s.AUTO_SEND === 'off' ? '自动发送已关闭（到「投递规则」里重新打开才会发邮件）' : sinkWithoutTestMode(s) ? '发信服务器还是本机测试邮箱，而测试模式已关闭：不会发出任何邮件，请填真实的 SMTP 服务器' : smtpOk ? `已设置${usesSink(s) ? '（本机测试邮箱，测试模式）' : ''}` : '不填也能用，但有邮箱的岗位只会列出来，不会自动发';
  return [
    { id: 'profile', label: '个人资料', ok: prof.length === 0, detail: prof.length ? `还差：${prof.map((p) => p.label).join('、')}` : '已填写', page: 'settings', anchor: 'profile' },
    { id: 'ai', label: 'AI 接口', ok: !!(s.AI_BASE_URL && s.AI_API_KEY), detail: !s.AI_BASE_URL ? '还没填接口地址' : !s.AI_API_KEY ? '还没填 API 密钥' : '已设置', page: 'settings', anchor: 'ai' },
    { id: 'sources', label: '职位来源', ok: src.ok, detail: `地区：${regionLabel(s.JOB_REGION || DEFAULT_REGION)}。${src.ok ? `将使用：${src.usable.join('、')}` : '至少要一个来源：Jooble（要关键词）、RSS 或 Remotive'}${src.warnings.length ? `；${src.warnings[0]}` : ''}${!s.JOB_REGION && src.ok ? '；还没选目标地区（目前按香港搜索），请到「职位来源」里确认' : ''}`, page: 'settings', anchor: 'sources' },
    { id: 'mail', label: '发信邮箱', optional: true, ok: smtpOk, detail: mailDetail, page: 'settings', anchor: s.AUTO_SEND === 'off' ? 'rules' : 'mail' },
    { id: 'resume', label: '简历 PDF', optional: true, ok: resume.set && resume.exists, detail: resume.set ? (resume.exists ? resume.name : '文件找不到了，请重新上传') : '随投递邮件一起发出，不上传就不会自动发邮件', page: 'settings', anchor: 'mail' },
  ];
}

function scheduleInfo(ctx) {
  const raw = ctx.cfg().HUNT_TIME || '08:00';
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(raw); const time = m ? raw : '08:00';   // a hand-edited "8am" must not break the console
  const installed = (spawnSync('launchctl', ['list'], { encoding: 'utf8' }).stdout || '').includes(ctx.label);
  const next = new Date(); next.setHours(Number(time.slice(0, 2)), Number(time.slice(3)), 0, 0); if (next <= new Date()) next.setDate(next.getDate() + 1);
  const start = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));   // the retry slots schedule.sh installs (none past midnight)
  const retries = [20, 40, 90].map((x) => start + x).filter((t) => t < 1440).map((t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
  return { time, installed, next: next.toISOString(), valid: !!m, retries };
}

const httpOnly = (u) => (/^https?:\/\//.test(u || '') ? u : '');
const STATUS_GROUP = { manual: 'todo', sent: 'sent', sending: 'attention', unknown: 'attention', failed: 'attention', applied: 'done', dismissed: 'done', skipped: 'skipped' };
function jobsView(ctx) {
  const merged = new Map();
  for (const e of ctx.events()) {
    const prev = merged.get(e.id) || {};
    merged.set(e.id, { ...prev, ...Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)) });
  }
  const rawLogo = new Map(); for (const j of merged.values()) if (httpOnly(j.logo)) rawLogo.set(j.id, j.logo);
  const jobs = [...merged.values()].map((j) => ({ id: j.id, title: j.title || '', company: j.company || '', location: j.location || '', url: /^https?:\/\//.test(j.url || '') ? j.url : '', source: j.source || '', score: j.score ?? null, reason: j.reason || '', status: j.status, group: STATUS_GROUP[j.status] || 'other', to: j.to || '', intendedTo: j.intendedTo || '', redirected: !!j.redirected, subject: j.subject || '', note: j.note || '', ts: j.ts, salary: j.salary || '', jobType: j.jobType || '', tags: Array.isArray(j.tags) ? j.tags.slice(0, 6) : [], category: j.category || '', hasLogo: rawLogo.has(j.id), postedAt: j.postedAt || 0, summary: j.summary || '', highlights: Array.isArray(j.highlights) ? j.highlights.slice(0, 3) : [], concerns: Array.isArray(j.concerns) ? j.concerns.slice(0, 2) : [], applyUrl: httpOnly(j.applyUrl), contactSource: j.contactSource || '', hasDesc: !!j.desc, hasDraft: !!j.draft }));
  jobs.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const counts = { todo: 0, sent: 0, attention: 0, done: 0, skipped: 0 };
  for (const j of jobs) if (counts[j.group] !== undefined) counts[j.group] += 1;
  return { jobs, counts, rawLogo, merged };
}

// ---------------------------------------------------------------- tests of the user's own settings ----------------------
const fetchJson = async (url, init = {}) => { const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) { /* not json */ } return { status: r.status, ok: r.ok, json: j, text: t }; };
async function testAi(ctx) {
  const s = effective(ctx); if (!s.AI_BASE_URL || !s.AI_API_KEY) return { ok: false, message: '先填接口地址和密钥并保存' };
  const base = s.AI_BASE_URL.replace(/\/+$/, ''); const headers = { Authorization: `Bearer ${s.AI_API_KEY}` };
  try {
    const m = await fetchJson(`${base}/models`, { headers });
    const model = s.AI_MODEL || 'deepseek-chat';   // exactly what the run will use
    if (m.ok && m.json && Array.isArray(m.json.data)) {
      const ids = m.json.data.map((x) => x.id);
      if (ids.length && !ids.includes(model)) return { ok: false, message: `连接成功，但没有模型 "${model}"${s.AI_MODEL ? '' : '（没填模型时就用它）'}。可用的有：${ids.slice(0, 8).join('、')}` };
    } else if (m.status === 401 || m.status === 403) return { ok: false, message: '密钥不对或没有权限（401/403）' };
    // one real call shaped like the run's (JSON mode included), so a server that rejects response_format fails HERE, not tomorrow
    const body = { model, temperature: 0, max_tokens: 20, messages: [{ role: 'system', content: '只输出 JSON。' }, { role: 'user', content: '请只回复 {"ok": true}' }] };
    if (s.AI_JSON_MODE !== 'off') body.response_format = { type: 'json_object' };
    const c = await fetchJson(`${base}/chat/completions`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (c.ok) { const t = c.json && c.json.choices && c.json.choices[0] && c.json.choices[0].message && c.json.choices[0].message.content; const a = String(t || '').indexOf('{'); let parsed = null; try { parsed = JSON.parse(String(t).slice(a, String(t).lastIndexOf('}') + 1)); } catch (e) { /* no json */ }
      return parsed ? { ok: true, message: `连接成功，模型 ${model} 可用，会按 JSON 回答` } : { ok: false, message: `模型 ${model} 能连上，但回答里没有 JSON（评分和写信都需要 JSON）：${redactAll(String(t || '').slice(0, 80), ctx.secrets())}` }; }
    if (c.status === 404) return { ok: false, message: `接口返回 404：接口地址应只填到根路径（例如 https://api.deepseek.com，不带 /chat/completions），或者模型名 "${model}" 不存在` };
    if (c.status === 400 && /response_format|json_object/i.test(c.text)) return { ok: false, message: '接口不支持 response_format（JSON 模式）：把「要求接口按 JSON 格式回答」关掉再试' };
    return { ok: false, message: `接口返回 ${c.status}：${redactAll(c.text.slice(0, 120), ctx.secrets())}` };
  } catch (e) { return { ok: false, message: `连不上：${redactAll(e.message, ctx.secrets())}` }; }
}
async function testJobs(ctx) {
  const s = effective(ctx); const out = [];
  const kw = (s.JOB_KEYWORDS || '').split(/[,，;；\n]+/).map((x) => x.trim()).filter(Boolean)[0];
  if (s.JOOBLE_API_KEY) {
    if (!kw) out.push({ name: 'Jooble', ok: false, message: '还没填搜索关键词' });
    else try { const r = await fetchJson(`${s.JOOBLE_API_BASE || 'https://jooble.org/api'}/${s.JOOBLE_API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keywords: kw, location: searchLocation(s) }) }); out.push({ name: 'Jooble', ok: r.ok, message: r.ok ? `搜"${kw}"${searchLocation(s) ? `（${searchLocation(s)}）` : ''}得到 ${(r.json && r.json.jobs || []).length} 个岗位` : `返回 ${r.status}（key 对吗？）` }); } catch (e) { out.push({ name: 'Jooble', ok: false, message: `连不上：${redactAll(e.message, ctx.secrets())}` }); }
  }
  for (const feed of (s.JOB_RSS_URLS || '').split(/\s+/).filter(Boolean)) {
    try { const r = await fetchJson(feed); const n = (r.text.match(/<(item|entry)[\s>]/g) || []).length; out.push({ name: `RSS ${hostOf(feed)}`, ok: r.ok && n > 0, message: r.ok ? `读到 ${n} 条` : `返回 ${r.status}` }); } catch (e) { out.push({ name: `RSS ${hostOf(feed)}`, ok: false, message: `连不上：${redactAll(e.message, ctx.secrets())}` }); }
  }
  if (s.REMOTIVE === 'on') {
    try { const r = await fetchJson(`${s.REMOTIVE_API_BASE || 'https://remotive.com/api/remote-jobs'}?limit=3${kw ? `&search=${encodeURIComponent(kw)}` : ''}`); out.push({ name: 'Remotive', ok: r.ok, message: r.ok ? `可用（${(r.json && r.json.jobs || []).length} 条样例）` : `返回 ${r.status}` }); } catch (e) { out.push({ name: 'Remotive', ok: false, message: `连不上：${redactAll(e.message, ctx.secrets())}` }); }
  }
  if (!out.length) return { ok: false, message: '还没配置任何职位来源', items: [] };
  return { ok: out.every((x) => x.ok), message: out.every((x) => x.ok) ? '职位来源都可用' : '有来源不可用', items: out };
}
async function testSmtp(ctx) {
  const s = effective(ctx); if (!s.SMTP_HOST) return { ok: false, message: '先填 SMTP 服务器并保存' };
  const req = loadNodemailer(ctx.env, ctx.home); if (!req) return { ok: false, message: '找不到 nodemailer（需要 n8n 运行环境）' };
  try { await makeTransport(s, req).verify(); return { ok: true, message: `已连上 ${s.SMTP_HOST} 并登录成功（没有发送任何邮件）` }; } catch (e) {
    const hint = e.code === 'EAUTH' ? '账号或密码不对（Gmail 要用应用专用密码）' : /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/.test(`${e.code} ${e.message}`) ? '连不上服务器，检查服务器名和端口' : e.message;
    return { ok: false, message: redactAll(hint, ctx.secrets()) };
  }
}
async function testDiscord(ctx) {
  const s = effective(ctx); if (!s.DISCORD_WEBHOOK_URL) return { ok: false, message: '先填 Webhook 地址并保存' };
  try {
    const r = await fetch(s.DISCORD_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '求职助手：这是一条测试消息，说明 Discord 通知设置正常。', allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(15000) });
    return r.ok ? { ok: true, message: '已发送一条测试消息到 Discord，请去频道里看看' } : { ok: false, message: `Discord 返回 ${r.status}（Webhook 地址对吗？）` };
  } catch (e) { return { ok: false, message: `连不上：${redactAll(e.message, ctx.secrets())}` }; }
}
async function testMail(ctx) {
  const s = effective(ctx); const prof = ctx.readProfile();
  const to = s.REPLY_TO || prof.email || s.SMTP_USER;
  if (!s.SMTP_HOST || !to) return { ok: false, message: '先填好发信邮箱和个人资料里的邮箱' };
  const req = loadNodemailer(ctx.env, ctx.home); if (!req) return { ok: false, message: '找不到 nodemailer' };
  const resume = ctx.resumeInfo();
  try {
    await makeTransport(s, req).sendMail({ from: s.MAIL_FROM_NAME || prof.name ? { name: s.MAIL_FROM_NAME || prof.name, address: fromAddress(s) } : fromAddress(s), to, subject: '【求职助手】测试邮件', text: '这是求职助手发给你自己的测试邮件。\n收到它，说明发信设置正常；如果带着简历附件，说明简历也正常。', ...(resume.exists ? { attachments: [{ filename: resume.name, path: s.RESUME_FILE }] } : {}) });
    if (isLocalHost(s.SMTP_HOST)) return { ok: true, message: `发信链路正常：邮件已存入本机测试邮箱（${path.join(ctx.home, 'data', 'sink')}），没有发到任何真实邮箱${resume.exists ? '，带简历附件' : ''}` };
    return { ok: true, message: `已发给 ${to}${resume.exists ? '（带简历附件）' : '（没有简历附件）'}，请去收件箱看看` };
  } catch (e) { return { ok: false, message: redactAll(`发送失败：${e.code || ''} ${e.message}`, ctx.secrets()) }; }
}

// ---------------------------------------------------------------- running the hunt from the console ---------------------
function startRun(ctx, mode) {
  const r = ctx.run;
  if (r.proc || lockBusy(ctx.home)) return { ok: false, message: '已经有一次运行在进行中' };
  const args = [path.join(ctx.scriptsDir, 'hunt.mjs'), ...(mode === 'dry' ? ['--dry-run'] : ['--force'])];
  r.mode = mode; r.startedAt = Date.now(); r.lines = []; r.code = null;
  const env = { ...ctx.env, JOBHUNT_HOME: ctx.home };
  const proc = spawn(ctx.nodeBin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  r.proc = proc;
  const buf = { out: '', err: '' };
  const take = (k) => (d) => { buf[k] += d; const parts = buf[k].split('\n'); buf[k] = parts.pop(); for (const l of parts) r.lines.push(redactAll(l, ctx.secrets())); if (r.lines.length > 400) r.lines.splice(0, r.lines.length - 400); };
  proc.stdout.on('data', take('out')); proc.stderr.on('data', take('err'));
  proc.on('close', (code) => { for (const k of ['out', 'err']) if (buf[k]) r.lines.push(redactAll(buf[k], ctx.secrets())); r.code = code; r.proc = null; });
  proc.on('error', (e) => { r.lines.push(`启动失败：${e.message}`); r.code = -1; r.proc = null; });
  return { ok: true };
}

// ---------------------------------------------------------------- HTTP API -------------------------------------------
export function createApi(ctx) {
  const now = () => new Date().toLocaleDateString('sv-SE');
  return {
    'GET /api/state': () => {
      const { counts } = jobsView(ctx); const today = now();
      let last = null; try { last = JSON.parse(fs.readFileSync(path.join(ctx.home, 'data', 'state', 'last-run.json'), 'utf8')); } catch (e) { /* none */ }
      const items = checklist(ctx);
      const required = items.filter((i) => !i.optional);
      const s = ctx.cfg();
      return { ready: required.every((i) => i.ok), checklist: items, schedule: scheduleInfo(ctx), lastRun: last, counts, test: { redirect: s.MAIL_REDIRECT_TO || '', sink: { port: ctx.sinkPort, count: sinkCount(path.join(ctx.home, 'data', 'sink')), inUse: usesSink(s) }, autoSendOff: s.AUTO_SEND === 'off' }, configErrors: loadConfig(ctx.home).errors, doneToday: fs.existsSync(path.join(ctx.home, 'data', 'state', `done-${today}`)), running: !!ctx.run.proc || lockBusy(ctx.home) };
    },
    'GET /api/jobs': () => { const { jobs, counts } = jobsView(ctx); return { jobs, counts }; },
    'GET /api/job': ({ query }) => {
      const id = query.get('id') || ''; if (!/^[0-9a-f]{16}$/.test(id)) return { status: 400, body: { ok: false } };
      const j = jobsView(ctx).merged.get(id); return j ? { ok: true, desc: String(j.desc || ''), url: httpOnly(j.url), applyUrl: httpOnly(j.applyUrl) } : { status: 404, body: { ok: false } };
    },
    'GET /api/logo': async ({ query }) => {
      const id = query.get('id') || ''; if (!/^[0-9a-f]{16}$/.test(id)) return { status: 400, body: { ok: false } };
      const dir = path.join(ctx.home, 'data', 'logos'); const f = path.join(dir, id);
      const url = jobsView(ctx).rawLogo.get(id); if (!url) return { status: 404, body: { ok: false } };
      let cachedUrl = ''; try { cachedUrl = fs.readFileSync(`${f}.url`, 'utf8'); } catch (e) { /* not cached yet */ }
      if (cachedUrl === url) { // a cached answer, also a negative one (a dead or refused address is not fetched again on every page view)
        try { const type = fs.readFileSync(`${f}.type`, 'utf8'); return type === 'none' ? { status: 404, body: { ok: false } } : { status: 200, raw: fs.readFileSync(f), type }; } catch (e) { /* fall through */ }
      }
      const got = await fetchLogo(ctx, url).catch(() => null);
      fs.mkdirSync(dir, { recursive: true });
      if (!got) { try { fs.writeFileSync(`${f}.type`, 'none'); fs.writeFileSync(`${f}.url`, url); fs.rmSync(f, { force: true }); } catch (e) { /* cache only */ } return { status: 404, body: { ok: false } }; }
      fs.writeFileSync(f, got.buf); fs.writeFileSync(`${f}.type`, got.type); fs.writeFileSync(`${f}.url`, url);
      return { status: 200, raw: got.buf, type: got.type };
    },
    'GET /api/profile': () => { const p = ctx.readProfile(); return { profile: p, missing: validateProfile(p) }; },
    'PUT /api/profile': ({ body }) => {
      const src = (body && body.profile) || {}; const p = emptyProfile();
      for (const k of Object.keys(p)) p[k] = String(src[k] ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 6000);
      fs.mkdirSync(ctx.home, { recursive: true });
      const tmp = `${ctx.profileFile}.tmp-${process.pid}`; fs.writeFileSync(tmp, renderProfile(p), { mode: 0o600 }); fs.renameSync(tmp, ctx.profileFile);
      return { ok: true, missing: validateProfile(ctx.readProfile()) };
    },
    'GET /api/settings': () => {
      const v = ctx.cfg();
      return { resume: ctx.resumeInfo(), fields: FIELDS.map((f) => ({ ...f, value: f.secret ? null : (v[f.key] ?? ''), set: !!v[f.key], hint: f.secret && v[f.key] ? (f.type === 'urls' ? `${v[f.key].split(/\s+/).length} 个 · ${[...new Set(v[f.key].split(/\s+/).map(hostOf))].join('、')}` : f.key === 'DISCORD_WEBHOOK_URL' ? hostOf(v[f.key]) : '已保存在本机') : '' })) };
    },
    'PUT /api/settings': ({ body }) => {
      const changes = (body && body.changes) || {}; const out = {}; const errors = {};
      for (const [k, raw] of Object.entries(changes)) {
        if (raw === undefined) continue;
        if (raw === null) { if (FIELD[k]) out[k] = null; else errors[k] = '未知的设置项'; continue; }
        const [val, err] = validate(k, raw);
        if (err) errors[k] = err; else out[k] = val === '' ? null : val;
      }
      if (Object.keys(errors).length) return { status: 400, body: { ok: false, errors } };
      const cur = ctx.cfg();
      if (out.SMTP_HOST && !isLocalHost(out.SMTP_HOST) && cur.SMTP_FROM === 'job-hunter@localhost.test' && out.SMTP_FROM === undefined) out.SMTP_FROM = null;   // the test mailbox's placeholder sender
      applyChanges(ctx.home, out);
      return { ok: true };
    },
    'POST /api/test': async ({ body }) => {
      const what = body && body.what;
      if (what === 'ai') return testAi(ctx); if (what === 'jobs') return testJobs(ctx); if (what === 'smtp') return testSmtp(ctx); if (what === 'mail') return testMail(ctx); if (what === 'discord') return testDiscord(ctx);
      return { status: 400, body: { ok: false, message: '未知的测试' } };
    },
    'POST /api/resume': ({ raw, headers }) => {
      if (!raw || raw.length < 100) return { status: 400, body: { ok: false, message: '文件是空的' } };
      if (raw.length > 8 * 1024 * 1024) return { status: 413, body: { ok: false, message: '文件超过 8 MB' } };
      if (raw.subarray(0, 5).toString('latin1') !== '%PDF-') return { status: 400, body: { ok: false, message: '这不是 PDF 文件' } };
      const nm = (ctx.readProfile().name || '').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 20);
      const dir = path.join(ctx.home, 'profile'); fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, nm ? `${nm}-简历.pdf` : 'resume.pdf');
      const old = ctx.cfg().RESUME_FILE;
      const tmp = `${file}.tmp-${process.pid}`; fs.writeFileSync(tmp, raw, { mode: 0o600 }); fs.renameSync(tmp, file);
      if (old && old !== file && path.dirname(old) === dir) { try { fs.rmSync(old); } catch (e) { /* gone */ } }
      applyChanges(ctx.home, { RESUME_FILE: file });
      return { ok: true, name: path.basename(file), size: raw.length };
    },
    'POST /api/jobs/action': ({ body }) => {
      const { id, action } = body || {};
      if (!/^[0-9a-f]{16}$/.test(String(id))) return { status: 400, body: { ok: false, message: '无效的编号' } };
      const status = { applied: 'applied', dismissed: 'dismissed', reopen: 'manual' }[action];
      if (!status) return { status: 400, body: { ok: false, message: '无效的操作' } };
      const job = jobsView(ctx).jobs.find((j) => j.id === id);
      if (!job) return { status: 404, body: { ok: false, message: '找不到这个岗位' } };
      if (job.status === 'sent' || (job.status === 'skipped' && action !== 'reopen')) return { status: 400, body: { ok: false, message: '这个状态不能改' } };
      // "put back" means back to what it was before the user marked it (unknown/failed stay what they were); a skipped posting
      // the user rescues, or one with no earlier status, becomes a to-do
      const before = action === 'reopen' && job.status !== 'skipped' ? [...ctx.events()].reverse().find((e) => e.id === id && e.status && !['applied', 'dismissed'].includes(e.status)) : null;
      const next = before && before.status !== 'skipped' ? before.status : status;
      ctx.appendEvent({ id, status: next, note: undefined });
      return { ok: true, status: next };
    },
    'POST /api/jobs/dismiss-older': ({ body }) => {
      const days = Number(body && body.days); if (!Number.isFinite(days) || days < 1 || days > 3650) return { status: 400, body: { ok: false, message: '天数不对' } };
      const cut = Date.now() - days * 86400000;
      const old = jobsView(ctx).jobs.filter((j) => j.status === 'manual' && Date.parse(j.ts) < cut);
      for (const j of old) ctx.appendEvent({ id: j.id, status: 'dismissed' });
      return { ok: true, removed: old.length };
    },
    'POST /api/jobs/clear-test': async () => {
      // Forget everything that was only a test send (so those postings can be handled for real later). Rewrites the log,
      // so it takes the run lock: a running hunt must not append in the middle of it.
      const lock = await acquireLock(ctx.home, 'console-clear-test');
      if (!lock.ok) return { status: 409, body: { ok: false, message: '正在运行中，等它结束再清除' } };
      try {
        const file = path.join(ctx.home, 'data', 'applications.jsonl'); let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: true, removed: 0 }; }
        const lines = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
        // only test-sent postings the user has NOT decided about (an 我已投递 / 忽略 mark is kept, with its history)
        const last = new Map(); for (const e of lines) if (e.id && e.status) last.set(e.id, e.status);
        const ids = new Set(lines.filter((e) => e.redirected && !['applied', 'dismissed'].includes(last.get(e.id))).map((e) => e.id));
        if (!ids.size) return { ok: true, removed: 0 };
        const tmp = `${file}.tmp-${process.pid}`; fs.writeFileSync(tmp, lines.filter((e) => !ids.has(e.id)).map((e) => JSON.stringify(e)).join('\n') + '\n'); fs.renameSync(tmp, file);
        const dir = path.join(ctx.home, 'data', 'sent'); try { for (const f of fs.readdirSync(dir)) if ([...ids].some((id) => f.endsWith(`-${id}.txt`))) fs.rmSync(path.join(dir, f)); } catch (e) { /* none */ }
        return { ok: true, removed: ids.size };
      } finally { await lock.release(); }
    },
    'POST /api/sink/use': () => {
      const cur = ctx.cfg();
      // The saved account and password stay (the test mailbox accepts any login). Test mode is switched on with it: a run through
      // the sink must leave "test send" records (clearable, no cooldown), never "sent to hr@company.com" ones.
      applyChanges(ctx.home, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(ctx.sinkPort), SMTP_SECURE: 'off', MAIL_REDIRECT_TO: cur.MAIL_REDIRECT_TO || 'test@localhost.test' });   // (no placeholder From is persisted: fromAddress() supplies one for the local mailbox)
      return { ok: true, redirect: cur.MAIL_REDIRECT_TO || 'test@localhost.test' };
    },
    'GET /api/mail': ({ query }) => {
      const id = query.get('id') || '';
      if (!/^[0-9a-f]{16}$/.test(id)) return { status: 400, body: { ok: false } };
      for (const sub of ['sent', 'drafts']) {   // what was sent, else the letter written for a posting that was only listed
        const dir = path.join(ctx.home, 'data', sub); let f = null;
        try { f = fs.readdirSync(dir).filter((x) => x.endsWith(`-${id}.txt`)).sort().pop(); } catch (e) { /* none */ }
        if (f) return { ok: true, text: fs.readFileSync(path.join(dir, f), 'utf8'), draft: sub === 'drafts' };
      }
      return { status: 404, body: { ok: false, message: '没有找到邮件原文' } };
    },
    'POST /api/run': ({ body }) => { const mode = body && body.mode === 'dry' ? 'dry' : body && body.mode === 'real' ? 'real' : ''; if (!mode) return { status: 400, body: { ok: false } }; const r = startRun(ctx, mode); return r.ok ? r : { status: 409, body: r }; },
    'GET /api/run': () => { const r = ctx.run; const external = !r.proc && lockBusy(ctx.home); return { running: !!r.proc || external, external, mode: r.mode, startedAt: r.startedAt, code: r.code, lines: r.lines.slice(-200) }; },
    'POST /api/schedule': ({ body }) => {
      const t = String((body && body.time) || '');
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) return { status: 400, body: { ok: false, message: '时间格式应为 HH:MM（24 小时制）' } };
      const r = spawnSync('bash', [path.join(ctx.scriptsDir, 'schedule.sh'), t], { env: { ...ctx.env, JOBHUNT_HOME: ctx.home, JOBHUNT_LABEL: ctx.label }, encoding: 'utf8', timeout: 30000 });
      if (r.status !== 0) return { status: 500, body: { ok: false, message: (r.stderr || r.stdout || '安装定时任务失败').trim().slice(0, 300) } };
      applyChanges(ctx.home, { HUNT_TIME: t });
      return { ok: true, schedule: scheduleInfo(ctx) };
    },
    'GET /api/reports': () => { const d = path.join(ctx.home, 'data', 'reports'); try { return { dates: fs.readdirSync(d).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort().reverse().slice(0, 60) }; } catch (e) { return { dates: [] }; } },
    'GET /api/report': ({ query }) => {
      const d = query.get('date') || ''; if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { status: 400, body: { ok: false } };
      try { return { ok: true, text: fs.readFileSync(path.join(ctx.home, 'data', 'reports', `${d}.md`), 'utf8') }; } catch (e) { return { status: 404, body: { ok: false, message: '没有这一天的日报' } }; }
    },
    'GET /api/log': () => { try { const t = fs.readFileSync(path.join(ctx.home, 'logs', 'launchd.log'), 'utf8').split('\n').slice(-200); return { lines: t.map((l) => redactAll(l, ctx.secrets())) }; } catch (e) { return { lines: [] }; } },
  };
}

// ---------------------------------------------------------------- server ---------------------------------------------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
export function createServer(ctx, { token, port }) {
  const api = createApi(ctx);
  const same = (a, b) => { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const cookieToken = (req) => { const m = /(?:^|;\s*)jobhunt_console=([0-9a-f]+)/.exec(req.headers.cookie || ''); return m ? m[1] : ''; };
  const send = (res, status, body, type = 'application/json; charset=utf-8', extra = {}) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", ...extra });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const readBody = (req, max) => new Promise((resolve, reject) => { const chunks = []; let n = 0; req.on('data', (c) => { n += c.length; if (n > max) { reject(Object.assign(new Error('too big'), { status: 413 })); req.destroy(); } else chunks.push(c); }); req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject); });
  const server = http.createServer(async (req, res) => {
    try {
      const addr = server.address();
      if (![`127.0.0.1:${addr.port}`, `localhost:${addr.port}`].includes(req.headers.host || '')) return send(res, 421, { error: 'wrong host' }); // DNS rebinding
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/' && url.searchParams.has('t')) {
        if (!same(url.searchParams.get('t'), token)) return send(res, 403, '链接无效：请用终端里打印的链接打开。', 'text/plain; charset=utf-8');
        return send(res, 303, '', 'text/plain', { Location: '/', 'Set-Cookie': `jobhunt_console=${token}; HttpOnly; SameSite=Strict; Path=/` });
      }
      if (!same(cookieToken(req), token)) {
        if (url.pathname.startsWith('/api/')) return send(res, 403, { ok: false, message: '控制台已重新启动或链接已失效：请用终端里新打印的链接重新打开' });
        return send(res, 403, '<!doctype html><meta charset="utf-8"><title>求职助手</title><p>请用终端里打印的链接打开控制台（链接里带本次启动有效的口令）。</p>', 'text/html; charset=utf-8');
      }
      if (req.method !== 'GET' && req.headers['x-jobhunt-console'] !== '1') return send(res, 403, { error: 'missing header' });
      const file = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' }[url.pathname];
      if (file && req.method === 'GET') return send(res, 200, fs.readFileSync(path.join(UI_DIR, file)), TYPES[path.extname(file)]);
      const handler = api[`${req.method} ${url.pathname}`];
      if (!handler) return send(res, 404, { error: 'not found' });
      const isRaw = url.pathname === '/api/resume';
      const max = isRaw ? 9 * 1024 * 1024 : 1024 * 1024;
      if (Number(req.headers['content-length']) > max) return send(res, 413, { ok: false, message: isRaw ? '文件超过 8 MB' : 'too big' });
      const buf = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req, max);
      let body = null; if (!isRaw && buf.length) { try { body = JSON.parse(buf.toString('utf8')); } catch (e) { return send(res, 400, { error: 'bad json' }); } }
      const out = await handler({ body, raw: isRaw ? buf : null, query: url.searchParams, headers: req.headers });
      if (out && out.raw) return send(res, out.status, out.raw, out.type, { 'Cache-Control': 'private, max-age=86400' });
      if (out && typeof out.status === 'number' && out.body !== undefined) return send(res, out.status, out.body);
      return send(res, 200, out ?? { ok: true });
    } catch (e) {
      return send(res, e.status || 500, { ok: false, message: redactAll(e.message || 'error', ctx.secrets()) });
    }
  });
  server.listen(port, '127.0.0.1');
  return server;
}

// ---- command line ----
if (process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]))) {
  const ctx = makeContext();
  const token = crypto.randomBytes(24).toString('hex');
  let port = Number(process.env.JOBHUNT_CONSOLE_PORT || 5710); const first = port;
  const start = () => {
    const server = createServer(ctx, { token, port });
    server.on('error', (e) => { if (e.code === 'EADDRINUSE' && port < first + 10) { port += 1; start(); } else { console.error(`控制台启动失败：${e.message}`); process.exit(1); } });
    server.on('listening', () => {
      const link = `http://127.0.0.1:${server.address().port}/?t=${token}`;
      const sink = startSink({ dir: path.join(ctx.home, 'data', 'sink'), port: ctx.sinkPort });
      sink.on('error', (e) => console.error(`本机测试邮箱没能启动（${e.code}）：端口 ${ctx.sinkPort} 被占用？不影响其他功能`));
      sink.unref();
      console.log(`求职助手控制台：${link}\n（只在这台电脑上有效；关闭这个终端窗口或按 Ctrl+C 就会关掉控制台）`);
      if (!process.argv.includes('--no-open')) spawnSync('open', [link]);
    });
  };
  start();
}
