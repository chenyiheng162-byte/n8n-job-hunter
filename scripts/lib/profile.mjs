// profile.md <-> a plain object. The console edits the object; the file stays human-readable Markdown, because it is sent
// verbatim to the AI. Reading is tolerant (old templates with "待填写" count as empty).
export const BASIC = [['name', '姓名'], ['email', '邮箱'], ['phone', '电话'], ['city', '所在地'], ['links', '链接']];
export const INTENT = [['role', '想找的岗位'], ['type', '工作类型'], ['where', '地点'], ['salary', '薪资期望'], ['avoid', '不接受']];
export const TEXTS = [['education', '教育'], ['skills', '技能'], ['experience', '经历'], ['projects', '项目'], ['other', '其他']];
const HEAD = { basic: '基本信息', intent: '求职意向' };
export const emptyProfile = () => Object.fromEntries([...BASIC, ...INTENT, ...TEXTS].map(([k]) => [k, '']));
const clean = (v) => String(v || '').replace(/\r/g, '').trim().replace(/^（[^）\n]*）$/, '').replace(/待填写[^\n]*/g, '').trim();

export function parseProfile(md) {
  const p = emptyProfile();
  const parts = String(md || '').split(/^## +/m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n'); const head = (nl < 0 ? part : part.slice(0, nl)).trim(); const body = nl < 0 ? '' : part.slice(nl + 1);
    const group = head === HEAD.basic ? BASIC : head === HEAD.intent ? INTENT : null;
    if (group) {
      for (const line of body.split('\n')) {
        const m = line.match(/^\s*[-*]?\s*([^：:]{1,12})[：:]\s*(.*)$/);
        const f = m && group.find(([, label]) => label === m[1].trim());
        if (f) p[f[0]] = clean(m[2]);
      }
    } else {
      const t = TEXTS.find(([, label]) => label === head);
      if (t) p[t[0]] = clean(body.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n'));
    }
  }
  return p;
}

export function renderProfile(p) {
  const L = ['# 个人资料', '', '> 这份文件由控制台生成，会原样发给 AI，用来给岗位打分和写投递邮件。邮件里的事实只来自这里。', ''];
  L.push(`## ${HEAD.basic}`); for (const [k, label] of BASIC) L.push(`${label}：${clean(p[k])}`); L.push('');
  L.push(`## ${HEAD.intent}`); for (const [k, label] of INTENT) L.push(`${label}：${clean(p[k])}`); L.push('');
  for (const [k, label] of TEXTS) { L.push(`## ${label}`, clean(p[k]), ''); }
  return `${L.join('\n').trimEnd()}\n`;
}

// Returns a list of {field, label, message}; empty = complete enough to run.
export function validateProfile(p) {
  const bad = [];
  const need = (k, label) => { if (!clean(p[k])) bad.push({ field: k, label, message: '必填' }); };
  need('name', '姓名'); need('email', '邮箱'); need('role', '想找的岗位');
  if (clean(p.email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(p.email))) bad.push({ field: 'email', label: '邮箱', message: '格式不对' });
  const body = ['education', 'skills', 'experience', 'projects'].map((k) => clean(p[k])).join('');
  if (body.length < 30) bad.push({ field: 'skills', label: '教育 / 技能 / 经历', message: '至少写一些（AI 靠它打分和写信，共 30 字以上）' });
  return bad;
}
