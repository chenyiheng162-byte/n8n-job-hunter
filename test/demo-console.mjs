// Starts a throw-away console with demo data (never touches ~/.n8n-job-hunter): node test/demo-console.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createServer, makeContext } from '../scripts/console.mjs';
import { applyChanges } from '../scripts/lib/config.mjs';
import { renderProfile } from '../scripts/lib/profile.mjs';
import { tmpdir, TEST_PROFILE } from './helpers.mjs';

const home = tmpdir('jh-demo-');
fs.writeFileSync(path.join(home, 'profile.md'), renderProfile(TEST_PROFILE));
applyChanges(home, { AI_BASE_URL: 'https://api.deepseek.com', AI_API_KEY: 'sk-demo-demo-demo-demo', AI_MODEL: 'deepseek-chat', JOB_KEYWORDS: '数据分析, 实习', JOOBLE_API_KEY: 'demo-demo-demo', HUNT_TIME: '08:00' });
const ctx = makeContext({ home, label: 'com.test.demo-never-installed' });
const ev = [
  { id: 'a1'.repeat(8), status: 'manual', title: '数据分析实习生', company: '星河科技', location: '上海', source: 'jooble', url: 'https://example.com/jobs/1', score: 9, reason: '技能与岗位要求高度吻合，地点符合。', note: '' },
  { id: 'a2'.repeat(8), status: 'manual', title: 'Junior Data Analyst', company: 'Northwind', location: 'Remote', source: 'remotive', url: 'https://example.com/jobs/2', score: 8, reason: '远程岗位，需要 SQL 和 Tableau。', to: 'hr@northwind.example', note: '邮件已写好但没有发送（未开启自动投递或没配好发信邮箱）' },
  { id: 'b1'.repeat(8), status: 'sent', title: '商业分析实习生', company: '云杉资本', location: '上海', source: 'rss', url: 'https://example.com/jobs/3', score: 8, reason: '专业对口。', to: 'careers@yunshan.example', subject: '应聘商业分析实习生' },
  { id: 'c1'.repeat(8), status: 'unknown', title: '数据运营实习', company: '澄海网络', url: 'https://example.com/jobs/4', score: 7, to: 'jobs@chenghai.example', note: '发送结果不确定，可能已发出，不会自动重发：ETIMEDOUT' },
  { id: 'd1'.repeat(8), status: 'skipped', title: '销售代表', company: '某某贸易', score: 2, reason: '属于"不接受"的销售类岗位。' },
];
for (const e of ev) ctx.appendEvent(e);
fs.mkdirSync(path.join(home, 'data', 'state'), { recursive: true });
fs.writeFileSync(path.join(home, 'data', 'state', 'last-run.json'), JSON.stringify({ ts: new Date().toISOString(), result: 'ok', sent: 1, listed: 2, skipped: 1, attention: 1 }));
fs.mkdirSync(path.join(home, 'data', 'reports'), { recursive: true });
fs.writeFileSync(path.join(home, 'data', 'reports', new Date().toLocaleDateString('sv-SE') + '.md'), '# 求职日报 demo\n\n新岗位 5 个 · **已邮件投递 1** · **需要你自己投递 2**\n\n## 📝 需要你自己投递\n- [ ] **星河科技 · 数据分析实习生**（9 分）https://example.com/jobs/1\n');
const token = 'd'.repeat(48);
const server = createServer(ctx, { token, port: Number(process.env.PORT || 5733) });
server.on('listening', () => console.log(`DEMO http://127.0.0.1:${server.address().port}/?t=${token}`));
