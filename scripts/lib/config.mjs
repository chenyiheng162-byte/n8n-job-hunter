// Strict settings loader. config.local.env is never executed: only KEY='value' / KEY="value" / bare KEY=value lines
// with a known key are accepted; anything else is reported by line number and skipped.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const KEYS = [
  'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL', 'AI_JSON_MODE', 'AI_DELAY_MS',
  'JOB_KEYWORDS', 'JOB_REGION', 'JOB_LOCATION', 'JOB_RSS_URLS', 'JOB_MAX_AGE_DAYS', 'JOOBLE_API_KEY', 'REMOTIVE',
  'MIN_SCORE', 'MAX_JOBS_PER_RUN', 'MAX_APPLICATIONS_PER_DAY', 'RECIPIENT_COOLDOWN_DAYS', 'MAIL_MAX_CHARS', 'AUTO_SEND',
  'HR_EMAIL_SEARCH', 'MAIL_REDIRECT_TO', 'PAGE_EMAILS', 'SERPER_API_KEY', 'MAILBOXLAYER_API_KEY',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'MAIL_FROM_NAME', 'REPLY_TO', 'RESUME_FILE',
  'DISCORD_WEBHOOK_URL', 'HUNT_TIME',
  // endpoints that tests point at local fakes
  'JOOBLE_API_BASE', 'REMOTIVE_API_BASE', 'SERPER_API_BASE', 'MAILBOXLAYER_API_BASE',
];
export const SECRET = /KEY|PASS|WEBHOOK|TOKEN|RSS/;
// values the console must never send to the browser (it only learns "set" and a harmless hint)
export const SECRET_KEYS = KEYS.filter((k) => SECRET.test(k) && !/_API_BASE$/.test(k));
export const homeDir = (env = process.env) => env.JOBHUNT_HOME || path.join(os.homedir(), '.n8n-job-hunter');

export function parseConfig(text) {
  const values = {}; const errors = [];
  const single = /^([A-Za-z_][A-Za-z0-9_]*)='([^']*)'$/;
  const double = /^([A-Za-z_][A-Za-z0-9_]*)="((?:[^"$`\\]|\\[^"$`\\])*)"$/;
  const bare = /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./:@%+,=?-]*)$/;
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '').replace(/^export /, '');
    if (!line.trim() || /^\s*#/.test(line)) return;
    const m = line.match(single) || line.match(double) || line.match(bare);
    if (!m) { errors.push(i + 1); return; }
    if (!KEYS.includes(m[1])) { errors.push(i + 1); return; }
    values[m[1]] = m[2];
  });
  return { values, errors };
}
export function loadConfig(home = homeDir()) {
  const file = path.join(home, 'config.local.env');
  if (!fs.existsSync(file)) return { values: {}, errors: [], file, exists: false };
  return { ...parseConfig(fs.readFileSync(file, 'utf8')), file, exists: true };
}
// Replaces / removes keys (value null = remove), keeps every other line as it was. Values are written single-quoted, so
// a value may not contain quotes or newlines. The file is written atomically (temp file, mode 600, rename), with a .bak.
export function applyChanges(home, changes) {
  for (const [k, v] of Object.entries(changes)) {
    if (!KEYS.includes(k)) throw new Error(`unknown setting ${k}`);
    if (v !== null && /['\n\r]/.test(v)) throw new Error(`${k}: value must not contain quotes or newlines`);
  }
  const file = path.join(home, 'config.local.env');
  fs.mkdirSync(home, { recursive: true });
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const keys = new Set(Object.keys(changes));
  const kept = old.split('\n').filter((raw) => { const m = /^(?:export )?([A-Za-z_][A-Za-z0-9_]*)=/.exec(raw.replace(/\r$/, '')); return !(m && keys.has(m[1])); });
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  for (const [k, v] of Object.entries(changes)) if (v !== null && v !== '') kept.push(`${k}='${v}'`);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${kept.join('\n')}\n`, { mode: 0o600 }); fs.chmodSync(tmp, 0o600);
  if (old) { try { fs.writeFileSync(`${file}.bak`, old, { mode: 0o600 }); } catch (e) { /* the backup is a courtesy */ } }
  fs.renameSync(tmp, file);
}
export function setConfig(home, key, value) { applyChanges(home, { [key]: value }); }
