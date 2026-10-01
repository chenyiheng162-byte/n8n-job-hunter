// Where is the Node/n8n runtime? Order: JOBHUNT_RUNTIME, the path install.sh recorded in JOBHUNT_HOME/runtime-path,
// the job hunter's own folder, and (older installs that shared it) the morning-brief project's runtime.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

export function runtimeCandidates(env = process.env, home = env.JOBHUNT_HOME || path.join(os.homedir(), '.n8n-job-hunter')) {
  let recorded = ''; try { recorded = fs.readFileSync(path.join(home, 'runtime-path'), 'utf8').trim(); } catch (e) { /* not recorded */ }
  return [env.JOBHUNT_RUNTIME, recorded, home, path.join(os.homedir(), '.n8n-morning-brief')].filter(Boolean);
}
export function loadNodemailer(env = process.env, home) {
  for (const c of runtimeCandidates(env, home)) {
    try { const r = createRequire(path.join(c, 'package.json')); r.resolve('nodemailer'); return r; } catch (e) { /* next */ }
  }
  return null;
}
