'use strict';
// Job hunter console. Everything is built with DOM calls (never innerHTML): posting titles and descriptions come from
// third-party sites and must be treated as text, not markup.
const $ = (s) => document.querySelector(s);
const NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  home: 'M3 11l9-8 9 8M5 10v10h14V10', list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01', mail: 'M4 5h16v14H4zM4 7l8 6 8-6',
  all: 'M3 7h18M3 12h18M3 17h18', gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 00-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 00-2-1.2L14 3h-4l-.6 2.7a7 7 0 00-2 1.2l-2.3-1-2 3.4 2 1.5a7 7 0 000 2.4l-2 1.5 2 3.4 2.3-1a7 7 0 002 1.2L10 21h4l.6-2.7a7 7 0 002-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z',
  doc: 'M6 3h9l4 4v14H6zM14 3v5h5', check: 'M5 12l5 5 9-10', ext: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6', play: 'M7 4l13 8-13 8z',
};
const icon = (name) => { const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'i'); const p = document.createElementNS(NS, 'path'); p.setAttribute('d', ICONS[name] || ''); s.append(p); return s; };
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs && (attrs.nodeType || typeof attrs === 'string' || Array.isArray(attrs))) { kids.unshift(attrs); attrs = {}; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v; else if (k === 'on') for (const [e, f] of Object.entries(v)) el.addEventListener(e, f);
    else if (k === 'text') el.textContent = v; else if (k === 'value') el.value = v; else if (k === 'checked') el.checked = !!v; else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
const fmtTime = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

async function api(method, url, body, raw) {
  const init = { method, headers: { 'X-Jobhunt-Console': '1' } };
  if (raw) { init.body = raw; init.headers['Content-Type'] = 'application/pdf'; } else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  let r; try { r = await fetch(url, init); } catch (e) { return { ok: false, httpStatus: 0, message: '连不上控制台：它可能已经关闭（关掉了终端窗口？），请重新运行 jobhunt console' }; }
  let j = {}; try { j = await r.json(); } catch (e) { /* empty */ }
  if (!r.ok && j.ok === undefined) j.ok = false; j.httpStatus = r.status;
  if ((r.status === 403 || r.status === 421) && !j.message) j.message = '控制台已重新启动或链接已失效：请用终端里新打印的链接重新打开';
  return j;
}
const gone = (...rs) => rs.find((r) => r && (r.httpStatus === 0 || r.httpStatus === 403 || r.httpStatus === 421));
function toast(text, bad, undo) {
  const t = h('div', { class: `toast${bad ? ' bad' : ''}` }, text);
  if (undo) t.append(h('button', { class: 'btn ghost sm toast-undo', on: { click: () => { t.remove(); undo(); } } }, '撤销'));
  $('#toasts').append(t); setTimeout(() => t.remove(), undo ? 8000 : bad ? 6000 : 3000);
}
let modalOpener = null;
function modal(title, text) { modalOpener = document.activeElement; $('#modal-title').textContent = title; $('#modal-body').textContent = text; $('#modal').hidden = false; $('#modal-close').focus(); }
function closeModal() { if ($('#modal').hidden) return; $('#modal').hidden = true; if (modalOpener && modalOpener.focus) modalOpener.focus(); }
$('#modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

const S = { page: 'home', st: null, jobs: null, settings: null, profile: null, filter: 'all', runTimer: null, nav: 0 };
const PAGES = [['home', '总览', 'home'], ['todo', '待投递', 'list'], ['sent', '已投递', 'mail'], ['all', '全部岗位', 'all'], ['reports', '日报', 'doc'], ['settings', '设置', 'gear']];

async function refresh() {
  const [st, jobs] = await Promise.all([api('GET', '/api/state'), api('GET', '/api/jobs')]);
  const g = gone(st, jobs); if (g) throw new Error(g.message);
  S.st = st; S.jobs = jobs; renderNav(); tickClock();
}
function renderNav() {
  const nav = $('#nav'); nav.replaceChildren();
  const c = (S.jobs && S.jobs.counts) || {};
  for (const [id, label, ic] of PAGES) {
    const n = id === 'todo' ? c.todo : id === 'sent' ? (c.attention || 0) : 0;
    nav.append(h('button', { class: S.page === id ? 'on' : '', on: { click: () => go(id) } }, icon(ic), label, n ? h('span', { class: `badge ${id === 'sent' ? 'warn' : 'ok'}`, text: String(n) }) : null));
  }
}
async function go(page, anchor, { keepScroll = false } = {}) {
  const my = ++S.nav; const y = window.scrollY;     // a slower, earlier navigation must not overwrite a later one
  S.page = page; renderNav();
  const view = $('#view'); view.replaceChildren(h('p', { class: 'muted', text: '加载中…' }));
  try {
    await refresh();
    const pages = { home: pageHome, todo: pageTodo, sent: pageSent, all: pageAll, reports: pageReports, settings: pageSettings };
    const body = await pages[page]();
    if (my !== S.nav) return;
    view.replaceChildren(testBanner(), body);
  } catch (e) {
    if (my !== S.nav) return;
    view.replaceChildren(h('div', { class: 'card' }, h('h2', { text: '页面没能加载' }), h('p', { class: 'muted', text: e.message || String(e) }), h('button', { class: 'btn', on: { click: () => go(page, anchor) } }, '重试')));
    return;
  }
  if (anchor) { const el = document.getElementById(anchor); if (el) el.scrollIntoView({ block: 'start' }); } else window.scrollTo(0, keepScroll ? y : 0);
}

function testBanner() {
  const t = S.st && S.st.test; const box = h('div');
  if (!t) return box;
  if (t.redirect) box.append(h('div', { class: 'banner' }, h('b', { text: '测试模式已开启' }), h('span', { text: `：所有投递邮件都改发到 ${t.redirect}，真正的收件人不会收到任何东西（每封邮件开头会写明"原本要发给谁"）。${t.sink && t.sink.inUse ? '发信服务器是本机测试邮箱：要正式投递，还要到「发信邮箱」里填真实的 SMTP 服务器。' : ''}` }), h('button', { class: 'btn sm', on: { click: () => go('settings', 'test') } }, '去关闭')));
  else if (t.sink && t.sink.inUse) box.append(h('div', { class: 'banner' }, h('b', { text: '不会发出任何邮件' }), h('span', { text: '：发信服务器还是本机测试邮箱，而测试模式已关闭。要正式投递，请到「发信邮箱」里填真实的 SMTP 服务器；要继续测试，请重新开启测试模式。' }), h('button', { class: 'btn sm', on: { click: () => go('settings', 'mail') } }, '去设置')));
  if (t.autoSendOff) box.append(h('div', { class: 'banner' }, h('b', { text: '自动发送已关闭' }), h('span', { text: '：只写信、只列清单，不会发出任何邮件。' }), h('button', { class: 'btn sm', on: { click: () => go('settings', 'rules') } }, '去打开')));
  return box;
}

// ---------------------------------------------------------------- shared pieces ----------------------------------
// ---- pieces of a posting card ----
const hue = (str) => { let n = 0; for (const c of String(str || '?')) n = (n * 31 + c.codePointAt(0)) % 360; return n; };
function avatar(j, size) {
  const name = (j.company || '').trim() || (j.title || '').trim() || '?'; const initial = ([...name][0] || '?').toUpperCase();
  const box = h('div', { class: `avatar${size ? ` ${size}` : ''}`, title: j.company || '' }, h('span', { text: initial }));
  box.style.setProperty('--h', String(hue(name)));
  if (j.hasLogo) { const img = h('img', { alt: '', loading: 'lazy', src: `/api/logo?id=${j.id}` }); img.addEventListener('error', () => img.remove()); box.append(img); }
  return box;
}
function ring(score) {
  const n = Math.max(0, Math.min(10, Number(score) || 0)); const C = 2 * Math.PI * 17;
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 44 44'); svg.setAttribute('class', `ring ${n >= 9 ? 'hi' : n >= 7 ? 'mid' : 'lo'}`);
  const track = document.createElementNS(NS, 'circle'); for (const [k, v] of [['cx', 22], ['cy', 22], ['r', 17], ['class', 'ring-track']]) track.setAttribute(k, v);
  const bar = document.createElementNS(NS, 'circle'); for (const [k, v] of [['cx', 22], ['cy', 22], ['r', 17], ['class', 'ring-bar'], ['stroke-dasharray', `${(C * n) / 10} ${C}`], ['transform', 'rotate(-90 22 22)']]) bar.setAttribute(k, v);
  const t = document.createElementNS(NS, 'text'); for (const [k, v] of [['x', 22], ['y', 27], ['text-anchor', 'middle'], ['class', 'ring-num']]) t.setAttribute(k, v); t.textContent = String(n);
  svg.append(track, bar, t); const w = h('div', { class: 'ring-wrap', title: `AI 匹配评分 ${n} / 10` }); w.append(svg); return w;
}
const ago = (ms) => { if (!ms) return ''; const d = Math.floor((Date.now() - ms) / 86400000); return d <= 0 ? '今天发布' : d === 1 ? '昨天发布' : d < 30 ? `${d} 天前发布` : `${Math.floor(d / 30)} 个月前发布`; };
const SRC = { jooble: 'Jooble', remotive: 'Remotive', rss: 'RSS' };
const chip = (text, cls) => h('span', { class: `chip${cls ? ` ${cls}` : ''}`, text });
const where = (u) => { try { const p = new URL(u); const path = p.pathname.replace(/\/$/, ''); return p.host.replace(/^www\./, '') + (path.length > 34 ? `${path.slice(0, 34)}…` : path); } catch (e) { return ''; } };
const STATUS_LABEL = { manual: '待投递', sent: '已发送', sending: '发送中断', unknown: '结果不确定', failed: '发送失败', applied: '我已投递', dismissed: '已忽略', skipped: '不合适' };

function jobRow(j, mode) {
  const meta = [j.company, j.location, j.jobType, j.salary].filter(Boolean);
  const chips = h('div', { class: 'chips' }, ...j.tags.map((t) => chip(t)), j.category && !j.tags.length ? chip(j.category) : null, chip(SRC[j.source] || j.source || '来源未知', 'src'), j.postedAt ? chip(ago(j.postedAt), 'faint') : null);
  const apply = safeUrl(j.applyUrl) || safeUrl(j.url);
  const acts = h('div', { class: 'acts' });
  if (mode === 'todo') {
    if (apply) acts.append(h('a', { class: 'btn primary', href: apply, target: '_blank', rel: 'noopener noreferrer' }, '前往投递', icon('ext')));
    if (j.applyUrl && safeUrl(j.url) && j.url !== j.applyUrl) acts.append(h('a', { class: 'btn', href: j.url, target: '_blank', rel: 'noopener noreferrer' }, '岗位页面'));
    acts.append(h('button', { class: 'btn', on: { click: () => act(j, 'applied') } }, icon('check'), '我已投递'), h('button', { class: 'btn ghost', on: { click: () => act(j, 'dismissed') } }, '忽略'));
  } else if (mode === 'sent') {
    acts.append(h('button', { class: 'btn', on: { click: (e) => toggleMail(j, e.currentTarget.closest('.jcard')) } }, icon('mail'), '邮件预览'));
  } else if (mode === 'attention') {
    if (apply) acts.append(h('a', { class: 'btn', href: apply, target: '_blank', rel: 'noopener noreferrer' }, '打开岗位', icon('ext')));
    acts.append(h('button', { class: 'btn', on: { click: () => act(j, 'applied') } }, j.status === 'failed' ? '不再重试（从这里移除）' : '我已确认，移除'));
  } else if (mode === 'done') {
    acts.append(h('button', { class: 'btn ghost', on: { click: () => act(j, 'reopen') } }, '撤销（放回原来的状态）'));
  } else if (mode === 'all') {
    if (apply) acts.append(h('a', { class: 'btn', href: apply, target: '_blank', rel: 'noopener noreferrer' }, '打开岗位', icon('ext')));
    if (j.status === 'skipped') acts.append(h('button', { class: 'btn', title: 'AI 评分不够但你想投：放到待投递里', on: { click: () => act(j, 'reopen') } }, '放到待投递'));
  }
  if (j.hasDraft && (mode === 'todo' || mode === 'all' || mode === 'done')) acts.append(h('button', { class: 'btn', on: { click: (e) => toggleMail(j, e.currentTarget.closest('.jcard')) } }, icon('mail'), '看写好的邮件'));
  if (j.hasDesc || j.summary) acts.append(h('button', { class: 'btn ghost', on: { click: () => showJob(j) } }, '岗位详情'));

  const how = h('div', { class: 'how' });
  if (mode === 'todo') {
    how.append(apply ? h('span', {}, icon('ext'), ` 会打开：${where(apply)}`) : h('span', { text: '没有可用的链接' }),
      j.applyUrl ? h('span', { class: 'badge ok', text: '直达申请页' }) : h('span', { class: 'badge', text: '岗位页面（申请入口在页面里）' }),
      j.to ? h('span', { class: 'badge warn', text: `邮箱 ${j.to}（见说明）` }) : null);
  } else if (mode === 'sent' || mode === 'attention') {
    if (mode === 'attention') how.append(h('span', { class: 'badge warn', text: STATUS_LABEL[j.status] || j.status }), h('span', { class: 'hint', text: { failed: '确定没有发出去。明天会自动重试（最多 3 次）；如果是账号或密码问题，先到「设置 → 发信邮箱」点「验证登录」。', unknown: '可能已经发出：到你邮箱的「已发送」里确认一下；没有的话用「打开岗位」自己投递。不会自动重发。', sending: '上次发送被打断，不知道有没有发出：同上，请自己确认；不会自动重发。' }[j.status] || '' }));
    how.append(h('span', {}, icon('mail'), j.redirected ? ` 原本要发给 ${j.intendedTo}，实际发到 ${j.to}` : ` 发给 ${j.to || '—'}`),
      j.contactSource ? h('span', { class: 'badge', text: { posting: '邮箱来自岗位正文', page: '邮箱来自岗位网页', search: '邮箱来自网上搜索' }[j.contactSource] || j.contactSource }) : null,
      j.redirected ? h('span', { class: 'badge warn', text: '测试发送' }) : null, h('span', { class: 'badge', text: '附简历 PDF' }));
  }
  return h('div', { class: 'jcard' },
    avatar(j),
    h('div', { class: 'jmain' },
      h('div', { class: 'jtitle' }, j.title || '（无标题）', mode === 'all' ? h('span', { class: 'badge', text: STATUS_LABEL[j.status] || j.status }) : null),
      h('div', { class: 'jmeta', text: meta.join(' · ') }),
      chips,
      j.summary ? h('div', { class: 'jsum', text: j.summary }) : null,
      j.highlights.length || j.concerns.length ? h('div', { class: 'chips fit' }, ...j.highlights.map((t) => chip(`✓ ${t}`, 'good')), ...j.concerns.map((t) => chip(`! ${t}`, 'care'))) : null,
      j.reason ? h('div', { class: 'jwhy' }, h('b', { text: 'AI：' }), j.reason) : null,
      j.note ? h('div', { class: 'note', text: j.note }) : null,
      how.childNodes.length ? how : null,
      h('div', { class: 'jfoot' }, acts, h('span', { class: 'faint sm', text: fmtTime(j.ts) }))),
    j.score !== null ? ring(j.score) : null);
}
async function toggleMail(j, card) {
  const old = card.querySelector('.mailprev'); if (old) return old.remove();
  const r = await api('GET', `/api/mail?id=${j.id}`);
  card.querySelector('.jmain').append(h('div', { class: 'mailprev' }, h('div', { class: 'faint sm', text: r.draft ? '为这个岗位写好的邮件（没有发出；可以复制后自己发）' : '这封邮件的原文（连同你的简历 PDF 一起发出）' }), h('pre', { text: r.ok ? r.text : (r.message || '没有找到邮件原文') })));
}
async function showJob(j) {
  const r = await api('GET', `/api/job?id=${j.id}`);
  modal(`${j.company ? `${j.company} · ` : ''}${j.title}`, [j.summary, j.reason ? `AI 评价：${j.reason}` : '', (r.desc || '').trim() ? `\n—— 岗位描述 ——\n${r.desc.trim()}` : '\n（没有保存岗位描述）', r.applyUrl ? `\n申请页面：${r.applyUrl}` : '', r.url ? `\n岗位页面：${r.url}` : ''].filter(Boolean).join('\n'));
}
function illo() {
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 120 90'); svg.setAttribute('class', 'illo');
  for (const [tag, at] of [['rect', { x: 18, y: 22, width: 84, height: 54, rx: 8, class: 'il-a' }], ['rect', { x: 28, y: 12, width: 64, height: 12, rx: 6, class: 'il-b' }], ['circle', { cx: 42, cy: 46, r: 8, class: 'il-b' }], ['rect', { x: 56, y: 40, width: 34, height: 5, rx: 2.5, class: 'il-c' }], ['rect', { x: 56, y: 50, width: 24, height: 5, rx: 2.5, class: 'il-c' }], ['rect', { x: 32, y: 62, width: 56, height: 5, rx: 2.5, class: 'il-c' }]]) { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(at)) e.setAttribute(k, v); svg.append(e); }
  return svg;
}
const emptyState = (text, sub) => h('div', { class: 'empty' }, illo(), h('div', { text }), sub ? h('div', { class: 'faint sm', text: sub }) : null);
function statStrip(list, extra) {
  const scores = list.map((j) => j.score).filter((x) => x !== null); const avg = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : '—';
  const srcs = [...new Set(list.map((j) => SRC[j.source] || j.source).filter(Boolean))];
  return h('div', { class: 'strip' }, h('div', {}, h('b', { class: 'num', text: String(list.length) }), h('span', { text: ' 个岗位' })), h('div', {}, h('b', { class: 'num', text: avg }), h('span', { text: ' 平均匹配分' })), srcs.length ? h('div', {}, h('span', { text: '来自 ' }), h('b', { text: srcs.join('、') })) : null, extra || null);
}
async function act(j, action) {
  const r = await api('POST', '/api/jobs/action', { id: j.id, action }); if (!r.ok) return toast(r.message || '操作失败', true);
  toast({ reopen: r.status === 'manual' ? '已放回待投递' : '已撤销，恢复为原来的状态', applied: '已标记为我已投递', dismissed: '已忽略' }[action], false, action === 'reopen' ? undefined : () => act(j, 'reopen'));
  go(S.page, undefined, { keepScroll: true });
}

// ---------------------------------------------------------------- home ------------------------------------------
function countdown(iso) { const ms = new Date(iso) - Date.now(); if (ms <= 0) return '即将开始'; const m = Math.floor(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分钟后` : `${m} 分钟后`; }
async function pageHome() {
  const st = S.st; const c = S.jobs.counts; const root = h('div');
  root.append(h('h1', { text: '总览' }), h('p', { class: 'sub', text: '每天自动找职位；能发邮件的直接发，不能的列在「待投递」里，由你点开投递。' }));
  const todoHot = c.todo > 0;
  if (st.configErrors && st.configErrors.length) root.append(h('div', { class: 'banner' }, h('b', { text: '设置文件有看不懂的行' }), h('span', { text: `：config.local.env 第 ${st.configErrors.join('、')} 行无法识别，已忽略（那一项会被当作没有设置）。在设置页把它重新保存一次即可。` })));
  root.append(h('div', { class: 'grid' },
    stat(c.todo, '待你投递', () => go('todo'), todoHot), stat(c.sent, '已邮件投递', () => go('sent')), stat(c.attention, '需要留意', () => go('sent')), stat(c.skipped, '评分不够，已跳过', () => { S.filter = 'skipped'; go('all'); })));

  const card = h('div', { class: 'card' });
  if (!st.ready) {
    const left = st.checklist.filter((i) => !i.optional && !i.ok).length;
    card.append(h('div', { class: 'card-head' }, h('h2', { text: `还差 ${left} 步就能开始` }), h('span', { class: 'badge warn', text: '未就绪' })));
  } else {
    card.append(h('div', { class: 'card-head' }, h('h2', { text: '已就绪' }), h('span', { class: 'badge ok', text: st.schedule.installed ? `下次自动运行：${fmtTime(st.schedule.next)}（${countdown(st.schedule.next)}）` : '定时任务未安装' })));
  }
  for (const i of st.checklist) {
    card.append(h('div', { class: 'row' }, h('span', { class: `check ${i.ok ? 'ok' : ''}` }, i.ok ? icon('check') : null),
      h('div', { class: 'grow' }, h('b', { text: i.label }), i.optional ? h('span', { class: 'badge', text: '可选' }) : null, h('div', { class: 'muted sm', text: i.detail })),
      i.ok ? null : h('button', { class: 'btn', on: { click: () => go(i.page, i.anchor) } }, '去填写')));
  }
  card.append(h('div', { class: 'row' }, h('span', { class: `check ${st.schedule.installed ? 'ok' : ''}` }, st.schedule.installed ? icon('check') : null), h('div', { class: 'grow' }, h('b', { text: '每天定时运行' }), h('div', { class: 'muted sm', text: st.schedule.installed ? `每天 ${st.schedule.time} 自动运行（Mac 需要醒着或插电）` : '还没安装：到「运行时间」里点「保存时间」就会装上' })), h('button', { class: 'btn', on: { click: () => go('settings', 'schedule') } }, st.schedule.installed ? '改时间' : '去安装')));
  root.append(card);

  const run = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { text: '运行' }), h('span', { class: 'grow' }),
    h('button', { class: 'btn', id: 'run-dry', on: { click: () => startRun('dry') } }, icon('play'), '试运行（不发邮件）'),
    h('button', { class: 'btn primary', id: 'run-real', on: { click: () => { if (confirm('现在真的运行一次？有邮箱的岗位会直接发出投递邮件。')) startRun('real'); } } }, icon('play'), '立即运行')));
  const lr = st.lastRun;
  run.append(h('div', { class: 'muted sm', text: lr ? `上次：${fmtTime(lr.ts)} · ${{ ok: '成功', failed: '失败', unconfigured: '未配置' }[lr.result] || lr.result}${lr.result === 'ok' ? `（${lr.testMode ? '测试模式，没有真正发出：' : ''}投递 ${lr.sent}，待你投递 ${lr.listed}${lr.deferred ? `，留到明天 ${lr.deferred}` : ''}）` : lr.message ? `：${lr.message}` : ''}` : '还没运行过' }));
  const logBox = h('pre', { class: 'log', id: 'runlog', hidden: true }); const repBox = h('div', { id: 'runreport' });
  run.append(logBox, repBox);
  root.append(run);
  if (st.running) pollRun();
  else { // the page is not in the document yet: hand the boxes over instead of looking them up
    const last = await api('GET', '/api/run');
    if (last.ok !== false && last.lines && last.lines.length) { run.insertBefore(h('div', { class: 'muted sm', text: `${last.mode === 'dry' ? '上次试运行' : '上次手动运行'}的输出（${fmtTime(last.startedAt)}）：` }), logBox); showRunOutput(last.lines, logBox, repBox); }
  }

  if (c.todo) {
    const t = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { text: '最新的待投递' }), h('span', { class: 'grow' }), h('button', { class: 'btn ghost sm', on: { click: () => go('todo') } }, '查看全部')));
    for (const j of S.jobs.jobs.filter((x) => x.group === 'todo').slice(0, 4)) t.append(jobRow(j, 'todo'));
    root.append(t);
  }
  return root;
}
const stat = (n, label, onclick, hot) => h('button', { class: `stat${hot ? ' hot' : ''}`, on: { click: onclick } }, h('div', { class: 'n num', text: String(n || 0) }), h('div', { class: 'l', text: label }));

async function startRun(mode) {
  const r = await api('POST', '/api/run', { mode });
  if (!r.ok) return toast(r.message || '启动失败', true);
  pollRun();
}
function pollRun() {
  clearInterval(S.runTimer);
  let sawRun = false;
  const tick = async () => {
    if (S.page !== 'home') return clearInterval(S.runTimer);
    const r = await api('GET', '/api/run'); const box = $('#runlog');
    if (!r.ok && r.message) { clearInterval(S.runTimer); if (box) { box.hidden = false; box.textContent = r.message; } return; }
    const lines = r.lines || [];
    if (box) { box.hidden = false; box.textContent = lines.join('\n') || (r.external ? '定时任务正在运行（这里看不到它的输出，结束后会刷新）…' : '运行中…'); box.scrollTop = box.scrollHeight; }
    for (const id of ['run-dry', 'run-real']) { const b = $(`#${id}`); if (b) b.disabled = !!r.running; }
    if (r.running) { sawRun = true; return; }
    clearInterval(S.runTimer);
    if (!sawRun && r.code === null) return;
    if (r.code !== null && !r.external) toast(r.code === 0 ? '运行完成' : '运行结束（有提示，见下方）', r.code !== 0);
    await go('home', undefined, { keepScroll: true });                                           // fresh counts, checklist and 上次运行
    if (lines.length) showRunOutput(lines);
  };
  S.runTimer = setInterval(tick, 1000); tick();
}
// the progress lines go in the log box; the report at the end (Markdown) is rendered like on the 日报 page
function showRunOutput(lines, box = $('#runlog'), rep = $('#runreport')) {
  if (!box || !rep) return;
  let i = lines.length; while (i > 0 && !/^\[hunt\] /.test(lines[i - 1])) i -= 1;   // the report follows the last [hunt] line
  const log = lines.slice(0, i); const report = lines.slice(i).join('\n').trim();
  box.hidden = !log.length; box.textContent = log.map((l) => l.replace(/^\[hunt\] /, '')).join('\n'); box.scrollTop = box.scrollHeight;
  rep.replaceChildren(); if (report) rep.append(/^# /.test(report) ? renderMd(report) : h('pre', { class: 'log', text: report }));
}

// ---------------------------------------------------------------- job lists --------------------------------------
async function pageTodo() {
  const root = h('div', {}, h('h1', { text: '待投递' }), h('p', { class: 'sub', text: '这些岗位没找到可以发邮件的地址。点「前往投递」去岗位页面自己投递，投完点「我已投递」。' }));
  const list = S.jobs.jobs.filter((j) => j.group === 'todo'); const card = h('div', { class: 'card' });
  const old = list.filter((j) => Date.now() - Date.parse(j.ts) > 30 * 86400000).length;
  if (!list.length) card.append(emptyState('现在没有待投递的岗位', '没找到邮箱的岗位会出现在这里，附上投递页面的链接'));
  else root.append(statStrip(list, old ? h('button', { class: 'btn sm', on: { click: async () => { if (!confirm(`把 30 天前列出的 ${old} 个岗位标记为忽略？（可以在「已处理」里放回来）`)) return; const r = await api('POST', '/api/jobs/dismiss-older', { days: 30 }); if (!r.ok) return toast(r.message || '操作失败', true); toast(`已忽略 ${r.removed} 个`); go('todo'); } } }, `忽略 30 天前的（${old} 个）`) : null));
  for (const j of list) card.append(jobRow(j, 'todo'));
  root.append(card);
  const done = S.jobs.jobs.filter((j) => j.group === 'done');
  if (done.length) { const d = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { text: '已处理' }), h('span', { class: 'badge', text: String(done.length) }), h('span', { class: 'muted sm', text: '点错了？随时可以放回待投递' }))); for (const j of done) d.append(jobRow(j, 'done')); root.append(d); }
  return root;
}
async function pageSent() {
  const root = h('div', {}, h('h1', { text: '已投递' }), h('p', { class: 'sub', text: '已经用邮件发出的投递，以及需要你留意的发送问题。' }));
  const att = S.jobs.jobs.filter((j) => j.group === 'attention');
  if (att.length) { const c = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { text: '需要留意' }), h('span', { class: 'badge warn', text: String(att.length) }))); for (const j of att) c.append(jobRow(j, 'attention')); root.append(c); }
  const sent = S.jobs.jobs.filter((j) => j.group === 'sent'); const hasTest = S.jobs.jobs.some((j) => j.redirected);
  const card = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { text: '已发送' }), h('span', { class: 'badge', text: String(sent.length) }), h('span', { class: 'grow' }),
    hasTest ? h('button', { class: 'btn sm', title: '删除所有测试发送的记录，这些岗位以后可以正式处理', on: { click: async () => { if (!confirm('清除所有"测试发送"的记录？这些岗位以后可以重新正式处理。')) return; const r = await api('POST', '/api/jobs/clear-test'); if (!r.ok) return toast(r.message || '清除失败', true); toast(`已清除 ${r.removed} 个岗位的测试记录`); go('sent'); } } }, '清除测试记录') : null));
  if (!sent.length) card.append(emptyState('还没有发出过邮件', '岗位正文里写明投递邮箱的，会自动发出，并在这里留底')); else root.insertBefore(statStrip(sent, h('div', {}, h('b', { class: 'num', text: String(sent.filter((j) => j.redirected).length) }), h('span', { text: ' 封是测试发送' }))), att.length ? root.children[3] || null : root.children[2] || null); for (const j of sent) card.append(jobRow(j, 'sent'));
  root.append(card); return root;
}
async function pageAll() {
  const root = h('div', {}, h('h1', { text: '全部岗位' }), h('p', { class: 'sub', text: '程序看过的所有岗位和评分，包括被跳过的。' }));
  const sel = h('select', { on: { change: () => { S.filter = sel.value; fill(); } } }, ...[['all', '全部'], ['todo', '待投递'], ['sent', '已发送'], ['attention', '需留意'], ['done', '已处理'], ['skipped', '不合适']].map(([v, l]) => h('option', { value: v, text: l, ...(S.filter === v ? { selected: true } : {}) })));
  const card = h('div', { class: 'card' }); const fill = () => { card.replaceChildren(h('div', { class: 'card-head' }, sel)); const l = S.jobs.jobs.filter((j) => S.filter === 'all' || j.group === S.filter); if (!l.length) card.append(h('div', { class: 'empty', text: '没有符合的岗位。' })); for (const j of l.slice(0, 300)) card.append(jobRow(j, j.group === 'done' ? 'done' : 'all')); if (l.length > 300) card.append(h('div', { class: 'empty', text: `只显示最近 300 个，还有 ${l.length - 300} 个更早的（用上面的筛选缩小范围）` })); };
  fill(); root.append(card); return root;
}
// text with http(s) links turned into <a> elements (everything else stays a text node)
const linkify = (text) => String(text).split(/(https?:\/\/[^\s）)]+)/).map((part, i) => (i % 2 && safeUrl(part) ? h('a', { href: part, target: '_blank', rel: 'noopener noreferrer', text: part }) : part));
function renderMd(text) {
  const box = h('div', { class: 'md' }); let ul = null;
  for (const line of text.split('\n')) {
    if (/^- /.test(line) || /^\s+- /.test(line)) { if (!ul) { ul = h('ul'); box.append(ul); } ul.append(h('li', { class: /^\s+- /.test(line) ? 'sub' : undefined }, ...linkify(line.replace(/^\s*- (\[ \] )?/, '').replace(/\*\*/g, '')))); continue; }
    ul = null; const hd = line.match(/^(#{1,6}) (.*)$/);
    if (hd) box.append(h(hd[1].length === 1 ? 'h1' : hd[1].length === 2 ? 'h2' : 'h3', { text: hd[2] })); else if (line.trim()) box.append(h('p', {}, ...linkify(line.replace(/\*\*/g, ''))));
  }
  return box;
}
async function pageReports() {
  const root = h('div', {}, h('h1', { text: '日报' }), h('p', { class: 'sub', text: '每天运行后生成的总结。' }));
  const r = await api('GET', '/api/reports'); const card = h('div', { class: 'card' }); const body = h('div');
  if (!r.dates.length) card.append(h('div', { class: 'empty', text: '还没有日报（第一次运行后会出现）。' }));
  else { const sel = h('select', { on: { change: () => load(sel.value) } }, ...r.dates.map((d) => h('option', { value: d, text: d }))); card.append(h('div', { class: 'card-head' }, sel), body); const load = async (d) => { const x = await api('GET', `/api/report?date=${d}`); body.replaceChildren(x.ok ? renderMd(x.text) : h('p', { class: 'muted', text: x.message || '读取失败' })); }; load(r.dates[0]); }
  root.append(card);
  const lg = await api('GET', '/api/log'); if (lg.lines.length) root.append(h('div', { class: 'card' }, h('h2', { text: '定时任务日志' }), h('pre', { class: 'log', text: lg.lines.join('\n') })));
  return root;
}

// ---------------------------------------------------------------- settings ---------------------------------------
const PROFILE_FIELDS = [
  ['name', '姓名', 'text', true], ['email', '邮箱', 'text', true], ['phone', '电话', 'text'], ['city', '所在地', 'text'], ['links', '链接（LinkedIn / GitHub / 作品集）', 'text', false, true],
  ['role', '想找的岗位', 'text', true, false, '例：数据分析实习生 / 后端开发'], ['type', '工作类型', 'text', false, false, '例：实习 / 全职；最早到岗时间'], ['where', '地点', 'text', false, false, '例：上海，可远程'], ['salary', '薪资期望', 'text'], ['avoid', '不接受', 'text', false, true, '例：销售类、需要长期出差；没有就写"无"'],
  ['education', '教育', 'area', false, true, '学校、专业、学历、起止年份'], ['skills', '技能', 'area', false, true, '例：Python、SQL、Tableau；英语 CET-6'], ['experience', '经历', 'area', false, true, '每段：时间、单位、职位、做了什么、结果'], ['projects', '项目', 'area', false, true, '名称、你做的部分、用到的技术、结果'], ['other', '其他', 'area', false, true, '证书、奖项、语言等'],
];
function card(id, title, desc, ...kids) { return h('div', { class: 'card', id }, h('div', { class: 'card-head' }, h('h2', { text: title }), desc ? h('span', { class: 'muted sm', text: desc }) : null), ...kids); }
function resultBox() { const el = h('div', { class: 'result', hidden: true }); el.show = (ok, text) => { el.hidden = false; el.className = `result ${ok ? 'ok' : 'bad'}`; el.textContent = text; }; return el; }

function settingField(f, inputs) {
  const wrap = h('div', { class: `field${f.type === 'urls' ? ' wide' : ''}` }); let input;
  const id = `f-${f.key}`;
  if (f.type === 'bool') { input = h('input', { type: 'checkbox', id, checked: f.set ? f.value === 'on' : f.default === 'on' }); wrap.append(h('label', { class: 'check-inline', for: id }, input, h('span', { text: f.label }))); }
  else if (f.type === 'select') { input = h('select', { id }, ...f.options.map((o, i) => h('option', { value: o, text: f.labels[i], ...((f.value || f.default || '') === o ? { selected: true } : {}) }))); wrap.append(h('label', { text: f.label, for: id }), input); }
  else if (f.type === 'urls') { input = h('textarea', { id, placeholder: f.set ? `已设置（${f.hint}）；留空表示不修改` : '' }); wrap.append(h('label', { text: f.label, for: id }), input); }
  else { input = h('input', { id, type: f.secret ? 'password' : 'text', autocomplete: 'off', value: f.secret ? '' : (f.value || ''), placeholder: f.secret ? (f.set ? `已设置（${f.hint}）；留空表示不修改` : '') : (f.placeholder || '') }); wrap.append(h('label', { text: f.label, for: id }), input); }
  if (f.help) wrap.append(h('div', { class: 'help', text: f.help }));
  const err = h('div', { class: 'err' }); wrap.append(err);
  const clear = f.secret && f.set ? h('button', { class: 'btn ghost sm', type: 'button', on: { click: () => { clear.cleared = !clear.cleared; clear.textContent = clear.cleared ? '取消清除' : '清除已保存的值'; } } }, '清除已保存的值') : null;
  if (clear) wrap.append(clear);
  inputs[f.key] = { f, err, get: () => {
    if (f.type === 'bool') return input.checked ? 'on' : 'off';
    if (f.secret) return clear && clear.cleared ? null : (input.value.trim() === '' ? undefined : input.value);
    return input.value;
  } };
  return wrap;
}
async function saveGroup(inputs, keys) {
  const changes = {}; for (const k of keys) { const v = inputs[k].get(); if (v !== undefined) changes[k] = v; inputs[k].err.textContent = ''; }
  const r = await api('PUT', '/api/settings', { changes });
  if (!r.ok) { for (const [k, m] of Object.entries(r.errors || {})) if (inputs[k]) inputs[k].err.textContent = m; toast('有设置不对，请看红字', true); return false; }
  toast('已保存'); return true;
}
async function pageSettings() {
  const [pr, se] = await Promise.all([api('GET', '/api/profile'), api('GET', '/api/settings')]);
  S.profile = pr.profile; S.settings = se; const inputs = {}; const root = h('div');
  root.append(h('h1', { text: '设置' }), h('p', { class: 'sub', text: '填好之后，每天早上自动开始找职位。密钥只保存在这台电脑上，页面不会再显示它们。' }));

  // 1 profile
  const pin = {}; const pform = h('div', { class: 'form' }); const miss = h('div', { class: 'note' });
  for (const [k, label, type, req, wide, ph] of PROFILE_FIELDS) {
    const el = type === 'area' ? h('textarea', { id: `p-${k}`, placeholder: ph || '' }) : h('input', { id: `p-${k}`, type: 'text', placeholder: ph || '' }); el.value = S.profile[k] || ''; pin[k] = el;
    pform.append(h('div', { class: `field${wide ? ' wide' : ''}` }, h('label', { for: `p-${k}` }, label, req ? h('span', { class: 'faint', text: ' *' }) : null), el));
  }
  const showMiss = (m) => { miss.textContent = m.length ? `还差：${m.map((x) => `${x.label}（${x.message}）`).join('、')}` : ''; };
  showMiss(pr.missing);
  root.append(card('profile', '个人资料', '这些内容会发给 AI，用来给岗位打分和写投递邮件', h('p', { class: 'muted sm', text: '写真实的、你愿意发给招聘方的内容；不要写身份证号、密码等敏感信息。邮件里的事实只来自这里。' }), pform, miss,
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', on: { click: async () => { const p = {}; for (const k of Object.keys(pin)) p[k] = pin[k].value; const r = await api('PUT', '/api/profile', { profile: p }); if (!r.ok) return toast('保存失败', true); showMiss(r.missing); toast('个人资料已保存'); } } }, '保存个人资料'))));

  const byGroup = (g) => se.fields.filter((f) => f.group === g);
  const groupCard = (g, id, title, desc, extra) => {
    const fields = byGroup(g); const form = h('div', { class: 'form' }); for (const f of fields) form.append(settingField(f, inputs));
    const res = resultBox(); const acts = h('div', { class: 'actions' });
    acts.append(h('button', { class: 'btn primary', on: { click: () => saveGroup(inputs, fields.map((f) => f.key)) } }, '保存'));
    for (const [what, label, confirmText] of extra || []) acts.append(h('button', { class: 'btn', on: { click: async (e) => {
      if (confirmText && !confirm(confirmText)) return;
      const ok = await saveGroup(inputs, fields.map((f) => f.key)); if (!ok) return;
      e.target.disabled = true; res.show(true, '测试中…'); const r = await api('POST', '/api/test', { what }); e.target.disabled = false;
      res.show(!!r.ok, r.message + (r.items ? `\n${r.items.map((i) => `${i.ok ? '✓' : '✗'} ${i.name}：${i.message}`).join('\n')}` : ''));
    } } }, label));
    acts.append(res); return card(id, title, desc, form, acts);
  };
  root.append(groupCard('ai', 'ai', 'AI 接口', '用来评分和写信（任意 OpenAI 兼容接口，例如 DeepSeek）', [['ai', '测试连接']]));
  root.append(groupCard('sources', 'sources', '职位来源', '至少配一个', [['jobs', '测试来源']]));

  const mail = groupCard('mail', 'mail', '发信邮箱和简历', '岗位里能找到邮箱时，用它直接投递', [['smtp', '验证登录（不发邮件）'], ['mail', '给自己发一封测试邮件', '会真的发一封测试邮件到你自己的邮箱，确认吗？']]);
  const up = h('input', { type: 'file', accept: 'application/pdf,.pdf', hidden: true }); const cur = h('span', { class: 'muted sm', text: se.resume.set ? `当前：${se.resume.name}${se.resume.exists ? '' : '（文件找不到了）'}` : '还没有上传' });
  up.addEventListener('change', async () => { const f = up.files[0]; up.value = ''; if (!f) return; if (f.size > 8 * 1024 * 1024) return toast('文件超过 8 MB，请压缩后再上传', true); const r = await api('POST', '/api/resume', undefined, await f.arrayBuffer()); if (!r.ok) return toast(r.message || '上传失败', true); cur.textContent = `当前：${r.name}`; toast('简历已上传'); });
  mail.append(h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', { text: '简历 PDF' }), h('div', { class: 'muted sm', text: '随每封投递邮件作为附件发出（不超过 8 MB）' }), cur), h('button', { class: 'btn', on: { click: () => up.click() } }, '选择 PDF…'), up));
  root.append(mail);
  root.append(groupCard('rules', 'rules', '投递规则', '默认值比较保守，可以按需要调整'));
  const tm = groupCard('test', 'test', '测试模式', '先试试发邮件，又不想真的打扰招聘方');
  const sk = S.st.test.sink; const usingSink = (se.fields.find((f) => f.key === 'SMTP_HOST') || {}).value === '127.0.0.1' && String((se.fields.find((f) => f.key === 'SMTP_PORT') || {}).value) === String(sk.port);
  tm.append(h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', { text: '本机测试邮箱' }), h('div', { class: 'muted sm', text: `127.0.0.1:${sk.port}，控制台开着时可用，已收到 ${sk.count} 封。发到这里的邮件不会离开这台电脑，用来在没有真实邮箱账号时测试发信。${usingSink ? '（当前正在使用）' : ''}` })),
    h('button', { class: 'btn', on: { click: async () => { const r = await api('POST', '/api/sink/use'); if (!r.ok) return toast('设置失败', true); toast(`已把发信服务器设为本机测试邮箱，并开启测试模式（收件人改为 ${r.redirect}）`); go('settings', 'mail'); } } }, usingSink ? '重新套用' : '使用本机测试邮箱')));
  root.append(tm);
  root.append(groupCard('notify', 'notify', '通知', '每天的日报之外，是否也发到 Discord', [['discord', '发一条测试消息']]));

  // schedule
  const t = h('input', { type: 'time', id: 'hunt-time', value: S.st.schedule.time }); const res = resultBox();
  root.append(card('schedule', '运行时间', '每天自动运行', h('div', { class: 'field' }, h('label', { text: '每天几点', for: 'hunt-time' }), t, h('div', { class: 'help', text: `${S.st.schedule.retries && S.st.schedule.retries.length ? `到点后还会在 ${S.st.schedule.retries.join('、')} 各检查一次` : '太接近午夜，没有补跑时段'}：当天已经做完就什么都不做，只有失败（例如刚唤醒还没联网）才会重试；跨过午夜的补跑时段不安排。Mac 需要醒着或接着电源。` })),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', on: { click: async () => { const r = await api('POST', '/api/schedule', { time: t.value }); res.show(!!r.ok, r.ok ? `已设置：每天 ${t.value}${r.schedule && r.schedule.retries && r.schedule.retries.length ? `（补跑：${r.schedule.retries.join('、')}）` : '（太接近午夜，没有补跑时段）'}` : r.message); } } }, '保存时间'), res)));
  return root;
}

// ---------------------------------------------------------------- boot ------------------------------------------
function tickClock() {
  const c = $('#clock'); const sch = S.st && S.st.schedule; if (!sch) return;
  if (!S.st.ready) c.textContent = '尚未就绪';
  else if (!sch.installed) c.textContent = '定时任务未安装';
  else if (new Date(sch.next) - Date.now() <= 0) { c.textContent = '正在运行或刚运行过'; api('GET', '/api/state').then((st) => { if (st && st.schedule) { S.st = st; renderNav(); } }); }
  else c.textContent = `下次运行 ${countdown(sch.next)}`;
}
setInterval(tickClock, 30000);
go('home');
