#!/usr/bin/env node
// Scans a folder that is about to be published or zipped for secrets and personal data.
//   * the REAL values from this machine's settings and profile (API keys, SMTP password, webhook, your e-mail, phone, name ...)
//   * well-known secret shapes (sk- keys, 32+ hex tokens, Discord webhooks, GitHub tokens, private keys, calendar secrets)
//   * this machine's user name and home path
// It prints HOW MANY values and patterns it checked (a scan that silently checks nothing is worse than none), and
// `--self-test` proves it really refuses by planting a fake secret.
// Usage: scan-release.mjs DIR [--self-test]      exit 0 = clean, 1 = findings
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, SECRET_KEYS, homeDir } from './lib/config.mjs';
import { parseProfile } from './lib/profile.mjs';

const PATTERNS = [
  ['sk- API key', /\bsk-[A-Za-z0-9]{16,}/], ['32+ hex token', /\b[0-9a-f]{32,}\b/i, { skip: /package-lock\.json$/ }], ['Discord webhook', /discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/i],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}/], ['AWS key', /\bAKIA[0-9A-Z]{16}\b/], ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Google calendar secret', /calendar\.google\.com\/calendar\/ical\/[^\s"']*private-[0-9a-f]+/i], ['home path', /\/Users\/[A-Za-z0-9._-]+\//, { allow: /\/Users\/(name|you|user|yourname|<[^>]*>)\// }],
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === '.DS_Store') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.isFile()) out.push(p);
  }
  return out;
}
const isText = (buf) => !buf.subarray(0, 4000).includes(0);

export function realValues() {
  const vals = new Set();
  const cfg = loadConfig().values;
  for (const k of SECRET_KEYS) for (const v of String(cfg[k] || '').split(/\s+/)) if (v.length >= 6) vals.add(v);
  for (const k of ['SMTP_USER', 'SMTP_FROM', 'REPLY_TO', 'MAIL_REDIRECT_TO']) if (cfg[k] && cfg[k].length >= 6 && !/@localhost\.test$/.test(cfg[k])) vals.add(cfg[k]);   // (the local test mailbox's own address is not personal)
  try { const p = parseProfile(fs.readFileSync(path.join(homeDir(), 'profile.md'), 'utf8')); for (const k of ['name', 'email', 'phone']) if (p[k] && p[k].length >= 2) vals.add(p[k]); } catch (e) { /* no profile */ }
  for (const v of [os.userInfo().username, os.homedir()]) if (v && v.length >= 3) vals.add(v);
  return [...vals];
}

export function scan(dir, values = realValues()) {
  const files = walk(dir); const findings = [];
  // the only long hex strings that belong in the repo: the pinned SHA-256 of the official Node tarballs in install.sh
  let pinned = new Set(); try { pinned = new Set([...fs.readFileSync(path.join(dir, 'install.sh'), 'utf8').matchAll(/NODE_SHA256_\w+="([0-9a-f]{64})"/g)].map((m) => m[1])); } catch (e) { /* no installer */ }
  for (const f of files) {
    const buf = fs.readFileSync(f); if (!isText(buf)) continue;
    const text = buf.toString('utf8'); const rel = path.relative(dir, f);
    for (const v of values) if (text.includes(v)) findings.push(`${rel}: contains a real value from this machine (${v.length} chars, starts with "${v.slice(0, 2)}…")`);
    for (const [name, re, o = {}] of PATTERNS) {
      if (o.skip && o.skip.test(rel)) continue;
      for (const m of text.matchAll(new RegExp(re.source, `${re.flags.replace('g', '')}g`))) { if (o.allow && o.allow.test(m[0])) continue; if (name === '32+ hex token' && rel === 'install.sh' && pinned.has(m[0])) continue; findings.push(`${rel}: looks like ${name}`); break; }
    }
  }
  return { findings, checked: { values: values.length, patterns: PATTERNS.length, files: files.length } };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  const dir = process.argv[2]; if (!dir || !fs.existsSync(dir)) { console.error('usage: scan-release.mjs DIR [--self-test]'); process.exit(2); }
  const r = scan(dir);
  console.log(`扫描了 ${r.checked.files} 个文件：${r.checked.values} 个本机真实值、${r.checked.patterns} 种密钥样式`);
  if (r.checked.values === 0) console.log('（提示：这台电脑上没有可比对的真实值；只检查了密钥样式和用户名/路径）');
  if (r.findings.length) { console.error(`发现 ${r.findings.length} 处问题，不能发布：\n${r.findings.map((x) => `  - ${x}`).join('\n')}`); process.exit(1); }
  if (process.argv.includes('--self-test')) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-selftest-')); fs.cpSync(dir, tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'planted.txt'), `key = sk-${'a1b2c3d4'.repeat(4)}\n`);
    const bad = scan(tmp, r.checked.values ? realValues() : ['planted-real-value']);
    fs.writeFileSync(path.join(tmp, 'planted2.txt'), `value = planted-real-value\n`);
    const bad2 = scan(tmp, ['planted-real-value']); fs.rmSync(tmp, { recursive: true, force: true });
    if (!bad.findings.length || !bad2.findings.length) { console.error('自检失败：故意放进去的假密钥没有被发现，扫描不可信'); process.exit(1); }
    console.log('自检通过：故意放进去的假密钥会被拒绝');
  }
}
