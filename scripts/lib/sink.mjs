// A local "test mailbox": a tiny SMTP server on 127.0.0.1 that accepts any mail and just stores it as a file.
// Mail sent to it never leaves this computer. It lets you test the whole sending path (real SMTP client, attachments, the
// "who was this meant for" banner) without a real mail account. Started by the console while it is open.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export function startSink({ dir, port = 5725 }) {
  fs.mkdirSync(dir, { recursive: true });
  const server = net.createServer((sock) => {
    let data = false; let buf = ''; let raw = ''; let rcpt = []; let authStep = 0;
    sock.write('220 job-hunter test mailbox\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      for (;;) {
        if (data) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) { const keep = Math.max(0, buf.length - 4); raw += buf.slice(0, keep); buf = buf.slice(keep); return; } // the terminator can be split across chunks
          raw += buf.slice(0, end); buf = buf.slice(end + 5); data = false;
          const name = `${new Date().toISOString().replace(/[:.]/g, '-')}.eml`;
          try { fs.writeFileSync(path.join(dir, name), `X-Original-Rcpt: ${rcpt.join(', ')}\r\n${raw}`, { mode: 0o600 }); } catch (e) { /* the SMTP answer below still tells the truth about what we did */ }
          raw = ''; rcpt = []; sock.write('250 stored\r\n'); continue;
        }
        const nl = buf.indexOf('\r\n'); if (nl < 0) return;
        const line = buf.slice(0, nl); buf = buf.slice(nl + 2); const u = line.toUpperCase();
        if (u.startsWith('EHLO') || u.startsWith('HELO')) sock.write('250-test mailbox\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        else if (authStep) { authStep -= 1; sock.write(authStep ? '334 UGFzc3dvcmQ6\r\n' : '235 ok\r\n'); }   // AUTH LOGIN: any user name, any password
        else if (u === 'AUTH LOGIN') { authStep = 2; sock.write('334 VXNlcm5hbWU6\r\n'); }
        else if (u.startsWith('RCPT TO')) { const m = line.match(/<([^>]*)>/); if (m) rcpt.push(m[1]); sock.write('250 ok\r\n'); }
        else if (u === 'DATA') { data = true; sock.write('354 go\r\n'); }
        else if (u === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); return; }
        else if (u.startsWith('AUTH')) sock.write('235 ok\r\n');
        else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => {});
  });
  server.listen(port, '127.0.0.1');
  return server;
}
export const sinkCount = (dir) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.eml')).length; } catch (e) { return 0; } };
