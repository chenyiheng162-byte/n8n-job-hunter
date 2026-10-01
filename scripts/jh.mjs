#!/usr/bin/env node
// Command line for day-to-day use (via the `jobhunt` wrapper):
//   jobhunt run [--dry-run] [--direct] [--force]   run now (a dry run sends nothing and writes nothing)
//   jobhunt status                                  is everything configured? what happened lately?
//   jobhunt report [DATE]                           print a daily report
//   jobhunt todo                                    postings waiting for you to apply on their site
//   jobhunt console [--no-open]                     open the control console in your browser
//   jobhunt config show | config set KEY [VALUE]    VALUE omitted = typed hidden (for keys and passwords)
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homeDir, loadConfig, setConfig, KEYS, SECRET } from './lib/config.mjs';
import { resolveSettings, preflight, Store, runHunt } from './hunt.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [cmd, ...rest] = process.argv.slice(2);
const home = homeDir();

function hidden(q) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); };
    rl.question(q, (a) => { rl.output.write('\n'); rl.close(); res(a); });
  });
}
const mask = (k, v) => (!v ? '（未设置）' : SECRET.test(k) ? `已设置（${v.length} 字符）` : v);

if (cmd === 'console') {
  const r = spawnSync(process.execPath, [path.join(here, 'console.mjs'), ...rest], { stdio: 'inherit' });
  process.exit(r.status ?? 0);
} else if (cmd === 'run') {
  const r = await runHunt({ args: rest, log: (m) => process.stderr.write(`[hunt] ${m}\n`) });
  if (!rest.includes('--scheduled') || rest.includes('--dry-run')) process.stdout.write(`${r.report || r.message || ''}\n`); // launchd runs stay quiet; the report file is the record
  process.exit(r.code);
} else if (cmd === 'config' && rest[0] === 'show') {
  const c = loadConfig(home);
  if (!c.exists) console.log(`还没有 ${c.file}`);
  for (const k of KEYS.filter((k) => !/_API_BASE$/.test(k))) console.log(`${k.padEnd(26)} ${mask(k, c.values[k])}`);
  if (c.errors.length) console.log(`\n无法识别的行：${c.errors.join(', ')}`);
} else if (cmd === 'config' && rest[0] === 'set' && rest[1]) {
  let v = rest[2];
  if (v === undefined) v = SECRET.test(rest[1]) ? await hidden(`${rest[1]}（输入时不显示）: `) : await new Promise((r) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(`${rest[1]}: `, (a) => { rl.close(); r(a); }); });
  if (rest[1] === 'HUNT_TIME' && v.trim()) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v.trim())) { console.error('HUNT_TIME 的格式应为 HH:MM（24 小时制），例如 08:00'); process.exit(1); }
    // the time lives in the launchd job: (re)install it; schedule.sh records HUNT_TIME once that worked, so status never shows a time that is not installed
    const r = spawnSync('bash', [path.join(here, 'schedule.sh'), v.trim()], { stdio: 'inherit', env: { ...process.env, JOBHUNT_HOME: home } });
    process.exit(r.status ?? 1);
  }
  setConfig(home, rest[1], v.trim());
  console.log(`${rest[1]} 已保存`);
} else if (cmd === 'status') {
  const st = resolveSettings(); const store = new Store(home, { dryRun: true });
  const pf = preflight(st);
  console.log(`运行目录：${home}`);
  console.log(pf.problems.length ? `配置：还差 ${pf.problems.length} 项\n${pf.problems.map((p) => `  - ${p}`).join('\n')}` : '配置：必需项都已就绪');
  for (const w of pf.warnings) console.log(`  ! ${w}`);
  const byId = new Map(); for (const e of store.events()) byId.set(e.id, { ...(byId.get(e.id) || {}), ...e });   // one row per posting: its latest status
  const ev = [...byId.values()];
  const count = (s) => ev.filter((e) => e.status === s).length;
  console.log(`累计：已投递 ${count('sent')} · 待你投递 ${count('manual')} · 结果不确定 ${count('unknown')} · 跳过 ${count('skipped')}`);
  const reports = fs.existsSync(store.reports) ? fs.readdirSync(store.reports).filter((f) => f.endsWith('.md')).sort() : [];
  console.log(`最近一次日报：${reports.length ? reports[reports.length - 1].replace('.md', '') : '还没有'}`);
  const lc = spawnSync('launchctl', ['list'], { encoding: 'utf8' }).stdout || '';
  console.log(`定时任务：${/n8n-job-hunter/.test(lc) ? '已安装' : '未安装'}（每天 ${st.s.HUNT_TIME || '08:00'}）`);
} else if (cmd === 'report') {
  const d = rest[0] || new Date().toLocaleDateString('sv-SE');
  const f = path.join(home, 'data', 'reports', `${d}.md`);
  console.log(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : `没有 ${d} 的日报`);
} else if (cmd === 'todo') {
  const store = new Store(home, { dryRun: true });
  const last = new Map(); for (const e of store.events()) last.set(e.id, { ...(last.get(e.id) || {}), ...e });
  const todo = [...last.values()].filter((e) => e.status === 'manual');
  console.log(todo.length ? todo.map((e) => `- ${e.company ? `${e.company} · ` : ''}${e.title}（${e.score} 分）${e.url}`).join('\n') : '没有待投递的岗位');
} else {
  const lines = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1); // the comment block at the top is the usage text
  console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(cmd ? 1 : 0);
}
