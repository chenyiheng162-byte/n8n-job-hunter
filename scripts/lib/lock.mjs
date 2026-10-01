// Run lock: the operating system's own file lock, held by a guard process. The guard is `cat` reading our stdin: when this
// process ends in ANY way (exit, crash, kill) its end of the pipe closes, cat ends, and the system releases the lock. So the
// lock can never be left behind and there is no "is it stale?" guessing (hand-made directory locks were a source of races
// in the morning-brief project).
// macOS has /usr/bin/lockf, Linux has flock(1); both are driven the same way (no wait, exit 75 when somebody else holds it).
// acquireLock(stateDir, tag) -> Promise<{ ok: true, release(): Promise } | { ok: false, holder, error? }>
//   ok:false + error:true means the lock could not be taken for a reason OTHER than "held by someone else" (no lock tool,
//   spawn failure): callers must treat that as a failure, never as "another run is in progress".
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export const lockFile = (stateDir) => path.join(stateDir, 'run.lockf');
const holderOf = (file) => { try { const [pid, , tag] = fs.readFileSync(file, 'utf8').trim().split(/\s+/); return `${pid || '?'} ${tag || ''}`.trim(); } catch (e) { return 'unknown'; } };
const HELD = 75; // EX_TEMPFAIL: lockf's own code; flock is told to use the same one
const exists = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch (e) { return false; } };
const TOOL = process.env.JOBHUNT_LOCK_TOOL || ['/usr/bin/lockf', '/usr/bin/flock', '/bin/flock'].find(exists) || '';
// the command line that runs `cmd` while holding the lock on `file`, without waiting
export const lockCommand = (file, cmd, tool = TOOL) => (/lockf$/.test(tool) ? [tool, '-k', '-s', '-t', '0', file, ...cmd] : [tool, '-n', '-E', String(HELD), file, ...cmd]);

export function acquireLock(stateDir, tag = '') {
  const file = lockFile(stateDir);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.closeSync(fs.openSync(file, 'a'));
  if (!TOOL) return Promise.resolve({ ok: false, holder: 'error', error: true, message: 'no lock tool (lockf/flock) on this system' });
  return new Promise((resolve) => {
    const [bin, ...args] = lockCommand(file, ['/bin/sh', '-c', 'echo locked; exec cat >/dev/null']);
    const guard = spawn(bin, args, { stdio: ['pipe', 'pipe', 'ignore'] });
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
    guard.on('exit', (code) => { if (!locked) finish(code === HELD ? { ok: false, holder: holderOf(file) } : { ok: false, holder: 'error', error: true, message: `lock guard exited with ${code}` }); });
    guard.on('error', (e) => finish({ ok: false, holder: 'error', error: true, message: e.message }));
  });
}

// Is the lock held right now (by anyone)? For status screens only.
export function lockBusy(stateDir) {
  const file = lockFile(stateDir);
  if (!TOOL || !fs.existsSync(file)) return false;
  const [bin, ...args] = lockCommand(file, ['/bin/sh', '-c', ':']);
  return spawnSync(bin, args).status === HELD;
}
export const lockHolder = (stateDir) => holderOf(lockFile(stateDir));
