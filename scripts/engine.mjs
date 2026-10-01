// Runs the workflow's Code-node sources. Two engines, same code:
//   n8n    `n8n execute --id=...` against the job-hunter's own n8n folder (the normal path)
//   direct the stages in plain Node (used by tests, --direct, and as the fallback when n8n cannot execute at all)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { WORKFLOW_ID } from './lib/constants.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
export const STAGES = [['Fetch jobs', 'fetch-jobs.js'], ['Screen jobs', 'screen-jobs.js'], ['Find contacts', 'find-contacts.js'], ['Draft emails', 'draft-emails.js'], ['Make plan', 'make-plan.js']];

export function loadSource(name, srcDir = path.join(here, '..', 'workflows', 'src')) {
  return fs.readFileSync(path.join(srcDir, name), 'utf8').replace(/^\/\/@include (\S+)$/gm, (_, inc) => fs.readFileSync(path.join(srcDir, 'lib', inc), 'utf8'));
}

// A response body is read in chunks and given up on past MAX_BODY (a hostile feed or page must not fill memory).
export const MAX_BODY = 8 * 1024 * 1024;
async function readBody(res, ctl) {
  if (!res.body || typeof res.body.getReader !== 'function') return res.text();
  const reader = res.body.getReader(); const chunks = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    n += value.length; if (n > MAX_BODY) { ctl.abort(); throw Object.assign(new Error(`response larger than ${MAX_BODY} bytes`), { tooLarge: true }); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
// Same contract as n8n's `this.helpers.httpRequest` for the options the stages use.
export function makeHttp(fetchImpl = globalThis.fetch) {
  return async function httpRequest({ method = 'GET', url, headers = {}, body, json = false, timeout = 30000 }) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const init = { method, headers: { ...headers }, signal: ctl.signal, redirect: 'follow' };
      if (body !== undefined) { init.body = typeof body === 'string' ? body : JSON.stringify(body); if (!init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json'; }
      const res = await fetchImpl(url, init);
      const text = await readBody(res, ctl);
      if (!res.ok) throw Object.assign(new Error(`${res.status} ${text.slice(0, 200)}`), { httpCode: res.status });
      if (json) return JSON.parse(text);
      try { return JSON.parse(text); } catch (e) { return text; } // n8n parses JSON bodies automatically too
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error(`timeout of ${timeout}ms exceeded`);
      throw e;
    } finally { clearTimeout(timer); }
  };
}

export async function runDirect({ env, fetchImpl, srcDir, log = () => {} }) {
  const http = makeHttp(fetchImpl);
  const req = createRequire(import.meta.url);
  let data = {};
  for (const [name, file] of STAGES) {
    const t = Date.now();
    const fn = new AsyncFunction('require', '$env', '$input', loadSource(file, srcDir));
    const out = await fn.call({ helpers: { httpRequest: http } }, req, env, { first: () => ({ json: data }), all: () => [{ json: data }] });
    data = out[0].json; log(`${name}: ${Date.now() - t} ms`);
  }
  return data; // the plan
}

// Returns { plan } or throws. err.notExecuted = true when n8n never ran the workflow (so the direct engine may be tried).
export async function runN8n({ env, home, planFile, expectedBuild, timeoutMs = 30 * 60 * 1000, log = () => {} }) {
  fs.rmSync(planFile, { force: true });
  const e = {
    ...env, N8N_USER_FOLDER: path.join(home, 'data', 'n8n'), N8N_DIAGNOSTICS_ENABLED: 'false', N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
    N8N_BLOCK_ENV_ACCESS_IN_NODE: 'false', NODE_FUNCTION_ALLOW_BUILTIN: 'fs,path,os,crypto', N8N_HOST: '127.0.0.1', N8N_LISTEN_ADDRESS: '127.0.0.1',
    N8N_PORT: env.N8N_PORT || '5700', N8N_RUNNERS_BROKER_PORT: env.N8N_RUNNERS_BROKER_PORT || String(Number(env.N8N_PORT || 5700) + 1),
    N8N_RUNNERS_TASK_TIMEOUT: String(Math.ceil(timeoutMs / 1000)), EXECUTIONS_DATA_SAVE_ON_SUCCESS: 'none', JOBHUNT_PLAN_FILE: planFile, JOBHUNT_HOME: home,
  };
  fs.mkdirSync(e.N8N_USER_FOLDER, { recursive: true });
  const t0 = Date.now();
  const { stdout, code, killed } = await new Promise((resolve) => {
    const p = spawn('n8n', ['execute', `--id=${WORKFLOW_ID}`, '--rawOutput'], { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGTERM'); setTimeout(() => p.kill('SIGKILL'), 10000); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', () => {});
    p.on('error', (err) => { clearTimeout(timer); resolve({ stdout: '', code: -1, killed: false, err }); });
    p.on('close', (c) => { clearTimeout(timer); resolve({ stdout: out, code: c, killed: timedOut }); });
  });
  log(`n8n execute: ${Date.now() - t0} ms (exit ${code})`);
  if (killed) throw new Error('n8n 运行超时被终止');
  let exec = null;
  const i = stdout.indexOf('\n{'); const start = stdout.startsWith('{') ? 0 : i + 1;
  try { exec = JSON.parse(stdout.slice(start)); } catch (err) { /* not an execution record */ }
  if (!exec || !exec.data) throw Object.assign(new Error(`n8n 没有执行工作流（退出码 ${code}）：${stdout.split('\n').slice(-3).join(' ').slice(0, 200)}`), { notExecuted: true });
  const rd = exec.data.resultData || {};
  if (rd.error || exec.status === 'error' || !fs.existsSync(planFile)) {
    const msg = (rd.error && (rd.error.message || rd.error.description)) || '工作流没有产出计划';
    const where = rd.lastNodeExecuted ? `（在 ${rd.lastNodeExecuted}）` : '';
    throw new Error(`工作流失败${where}：${String(msg).slice(0, 300)}`);
  }
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  if (expectedBuild && plan.build !== expectedBuild) throw new Error(`n8n 里是旧版本工作流（build ${plan.build}，应为 ${expectedBuild}），请重新运行 install.sh`);
  return plan;
}

// n8n keeps an execution record (with the postings it saw) for every run. It only lives seconds, so its own clean-up timers
// never fire: delete records older than `days` after each run. n8n has exited by now, so the database is ours alone.
export function pruneExecutions(home, days = 3) {
  const db = path.join(home, 'data', 'n8n', '.n8n', 'database.sqlite');
  if (!fs.existsSync(db)) return;
  try { spawnSync('sqlite3', [db, `PRAGMA foreign_keys=ON; delete from execution_entity where datetime(startedAt) < datetime('now','-${Number(days)} day');`], { timeout: 15000 }); } catch (e) { /* housekeeping only */ }
}
