// Run lock: the operating system's own file lock (/usr/bin/lockf), held by a guard process. The guard is `cat` reading our
// stdin: when this process ends in ANY way (exit, crash, kill) its end of the pipe closes, cat ends, and the system releases
// the lock. So the lock can never be left behind and there is no "is it stale?" guessing (hand-made directory locks were
// a source of races in the morning-brief project).
// acquireLock(stateDir, tag) -> Promise<{ ok: true, release(): Promise } | { ok: false, holder }>
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export const lockFile = (stateDir) => path.join(stateDir, 'run.lockf');
const holderOf = (file) => { try { const [pid, , tag] = fs.readFileSync(file, 'utf8').trim().split(/\s+/); return `${pid || '?'} ${tag || ''}`.trim(); } catch (e) { return 'unknown'; } };

export function acquireLock(stateDir, tag = '') {
  const file = lockFile(stateDir);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.closeSync(fs.openSync(file, 'a'));
  return new Promise((resolve) => {
    const guard = spawn('/usr/bin/lockf', ['-k', '-s', '-t', '0', file, '/bin/sh', '-c', 'echo locked; exec cat >/dev/null'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let done = false; let locked = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    guard.stdout.on('data', (d) => {
      if (locked || !String(d).includes('locked')) return;
      locked = true;
      fs.writeFileSync(file, `${process.pid} ${Math.floor(Date.now() / 1000)} ${tag}\n`);
      // The guard must not keep this process alive; releasing waits (at most 3 s) until it has really gone.
      guard.unref(); if (guard.stdout.unref) guard.stdout.unref(); if (guard.stdin.unref) guard.stdin.unref();
      const release = () => new Promise((r) => {
        if (guard.exitCode !== null) return r();
        guard.ref(); const t = setTimeout(r, 3000); guard.once('exit', () => { clearTimeout(t); r(); }); guard.stdin.end();
      });
      finish({ ok: true, release });
    });
    guard.on('exit', (code) => { if (!locked) finish({ ok: false, holder: code === 75 ? holderOf(file) : 'error' }); }); // 75 = held by someone else
    guard.on('error', () => finish({ ok: false, holder: 'error' }));
  });
}

// Is the lock held right now (by anyone)? For status screens only.
export function lockBusy(stateDir) {
  const file = lockFile(stateDir);
  return fs.existsSync(file) && spawnSync('/usr/bin/lockf', ['-k', '-s', '-t', '0', file, '/usr/bin/true']).status === 75;
}
export const lockHolder = (stateDir) => holderOf(lockFile(stateDir));
