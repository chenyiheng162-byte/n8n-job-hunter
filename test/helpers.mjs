// Local fakes for end-to-end tests: one HTTP server (job API, AI, job pages, Discord) and one SMTP server.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

export const tmpdir = (p = 'jh-test-') => fs.mkdtempSync(path.join(os.tmpdir(), p));

export function findNodemailer() {
  for (const d of [process.env.JOBHUNT_RUNTIME, path.join(os.homedir(), '.n8n-morning-brief')].filter(Boolean)) {
    try { const r = createRequire(path.join(d, 'package.json')); r.resolve('nodemailer'); return { dir: d, req: r }; } catch (e) { /* next */ }
  }
  return null;
}

import { renderProfile, emptyProfile } from '../scripts/lib/profile.mjs';
export const TEST_PROFILE = { ...emptyProfile(), name: '测试同学', email: 'tester@example.org', phone: '13900001111', city: '上海', role: '数据分析实习生', type: '实习', where: '上海或远程', avoid: '销售类、需要驻外的岗位',
  education: '某某大学 统计学 本科在读，2027 届，GPA 3.8。', skills: 'Python, SQL, Tableau, 机器学习基础，数据清洗与可视化，A/B 测试。', experience: '数据分析实习生，负责报表自动化。' };
const PROFILE = renderProfile(TEST_PROFILE);
export function writeProfile(home) { fs.mkdirSync(home, { recursive: true }); const f = path.join(home, 'profile.md'); fs.writeFileSync(f, PROFILE); return f; }

// jobs: [{ title, company, link, snippet, page? , score, draft? }]; AI answers by looking for [score:N] / [draft:bad] markers in the posting.
// feeds: { '/feed/x.xml': xml }  aiReply(kind, user, sys): a raw completion text ('score' | 'draft'), or undefined for the default answer
export async function startFakeWorld({ jobs, aiDown = false, feeds = {}, aiReply = null }) {
  const log = { ai: [], sys: [], discord: [], jooble: 0, joobleBodies: [], remotive: [], pages: [] };
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const send = (code, obj, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
      if (req.url.startsWith('/jooble-echo/')) return send(400, { error: `bad key ${decodeURIComponent(req.url.slice(13))}` });   // an upstream that echoes the secret in its error
      if (req.url.startsWith('/jooble/')) { log.jooble += 1; try { log.joobleBodies.push(JSON.parse(body)); } catch (e) { /* none */ } return send(200, { jobs: jobs.map((j) => ({ title: j.title, company: j.company, location: 'Shanghai', snippet: j.snippet, link: typeof j.link === 'function' ? j.link(log.jooble) : j.link || `${base}/job/${encodeURIComponent(j.title)}`, updated: new Date().toISOString(), salary: j.salary || '', type: j.type || '' })) }); }
      if (req.url.startsWith('/remotive')) { log.remotive.push(req.url); return send(200, { jobs: jobs.map((j) => ({ title: j.title, company_name: j.company, candidate_required_location: 'Worldwide', description: j.snippet, url: `${base}/job/${encodeURIComponent(j.title)}`, publication_date: new Date().toISOString(), job_type: 'full_time', tags: ['sql'] })) }); }
      if (req.url === '/ai/models') return send(200, { data: [{ id: 'm' }, { id: 'other-model' }] });
      if (req.url === '/ai/chat/completions') {
        if (aiDown) return send(500, { error: 'down' });
        const b = JSON.parse(body); const user = b.messages[1].content; const sys = b.messages[0].content;
        log.ai.push(user); log.sys.push(sys);
        const kind = /只输出 JSON：\{"score"/.test(sys) ? 'score' : 'draft';
        if (aiReply) { const c = aiReply(kind, user, sys); if (c !== undefined) return send(200, { choices: [{ message: { content: c } }] }); }
        if (kind === 'score') { const m = user.match(/\[score:(\d+)\]/); return send(200, { choices: [{ message: { content: JSON.stringify({ score: m ? Number(m[1]) : 5, reason: '测试理由', summary: '测试摘要：负责数据报表', highlights: ['SQL 匹配', 'Tableau 匹配', '远程', '多余第四条'], concerns: ['需要英语'], language: 'zh', company: '' }) } }] }); }
        const bad = /\[draft:bad\]/.test(user); const explicit = user.match(/\[body:([^\]]*(?:\][^\]]*)*?)\] hr/);
        if (explicit) return send(200, { choices: [{ message: { content: JSON.stringify({ subject: '应聘数据分析实习生', body: explicit[1] }) } }] });
        const good = '您好，我是测试同学，应聘贵公司的数据分析实习岗位。我熟悉 Python、SQL 和 Tableau，做过报表自动化。简历见附件，期待与您联系。\n\n测试同学\n13900001111';
        const draft = { subject: '应聘数据分析实习生', body: bad ? `您好，我是[姓名]，应聘贵公司岗位。${'内容'.repeat(40)}` : good };
        return send(200, { choices: [{ message: { content: JSON.stringify(draft) } }] });
      }
      if (req.url.startsWith('/job/')) { log.pages.push(req.url); const t = decodeURIComponent(req.url.slice(5)); const j = jobs.find((x) => x.title === t); return send(200, (j && j.page) || '<html><body>no contact here <img src="logo@2x.png"></body></html>', 'text/html'); }
      if (req.url.startsWith('/feed/')) { const x = feeds[req.url]; return x ? send(200, typeof x === 'function' ? x(base) : x, 'application/xml; charset=utf-8') : send(404, 'no feed', 'text/plain'); }
      if (req.url.startsWith('/discord')) { log.discord.push(body); return send(204, ''); }
      send(404, 'not found', 'text/plain');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, log, close: () => new Promise((r) => server.close(r)) };
}

// A tiny SMTP server. mode: 'ok' | 'drop-after-data' (closes the connection without answering DATA) | 'refuse-rcpt'
export async function startFakeSmtp({ mode = 'ok' } = {}) {
  const mails = [];
  const server = net.createServer((sock) => {
    let data = false; let buf = ''; let cur = { to: [], raw: '' };
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      for (;;) {
        if (data) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) { const keep = Math.max(0, buf.length - 4); cur.raw += buf.slice(0, keep); buf = buf.slice(keep); return; } // keep a tail: the terminator can be split across chunks
          cur.raw += buf.slice(0, end); buf = buf.slice(end + 5); data = false;
          if (mode === 'drop-after-data') { sock.destroy(); return; }
          mails.push(cur); cur = { to: [], raw: '' }; sock.write('250 queued\r\n'); continue;
        }
        const nl = buf.indexOf('\r\n'); if (nl < 0) return;
        const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
        const u = line.toUpperCase();
        if (u.startsWith('EHLO') || u.startsWith('HELO')) sock.write('250-fake\r\n250 8BITMIME\r\n');
        else if (u.startsWith('MAIL FROM')) sock.write('250 ok\r\n');
        else if (u.startsWith('RCPT TO')) { if (mode === 'refuse-rcpt') sock.write('550 no such user\r\n'); else { cur.to.push(line.match(/<([^>]+)>/)[1]); sock.write('250 ok\r\n'); } }
        else if (u === 'DATA') { data = true; sock.write('354 go\r\n'); }
        else if (u === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); return; }
        else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, mails, close: () => new Promise((r) => server.close(r)) };
}

export function baseEnv(home, world, smtp, extra = {}) {
  const resume = path.join(home, 'resume.pdf'); fs.writeFileSync(resume, '%PDF-1.4 fake resume');
  return {
    JOBHUNT_HOME: home, JOBHUNT_PROFILE_FILE: path.join(home, 'profile.md'),
    AI_BASE_URL: `${world.base}/ai`, AI_API_KEY: 'test-key', AI_MODEL: 'm', AI_DELAY_MS: '0',
    JOB_KEYWORDS: '数据分析', JOOBLE_API_KEY: 'k', JOOBLE_API_BASE: `${world.base}/jooble`, MIN_SCORE: '7', JOBHUNT_ALLOW_LOCAL_FETCH: 'on',   // (the fake job pages live on 127.0.0.1)
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURE: 'off', SMTP_FROM: 'tester@example.org', RESUME_FILE: resume,
    ...extra,
  };
}
