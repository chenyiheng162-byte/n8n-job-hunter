// n8n Code node "Draft e-mails": writes the application e-mail for every posting routed to "email".
// A draft that still contains a placeholder (or fails twice) is NOT sent: that posting falls back to "site" with a note.
//@include common.js
const input = $input.first().json;
const profile = readProfile();
const maxChars = Number(E('MAIL_MAX_CHARS', '900'));
const system = `你替求职者本人写一封投递邮件，会不经修改直接发出。${UNTRUSTED}
硬性要求：
1. 只能使用【个人资料】里出现的事实，不得编造经历、学历、证书、公司、数字；资料里没有的就不写。
2. 不得出现任何占位符或需要本人补全的内容（如 [姓名]、XX、{{ }}、（此处填写））。
3. 纯文本，不用 emoji、markdown、项目符号以外的格式；正文长度：中文不超过 ${maxChars} 字，英文不超过约 ${Math.round(maxChars / 5)} 个单词；开头先说应聘的岗位名称。
4. 语言与岗位描述一致（岗位用中文就写中文，否则写英文）；语气诚恳简洁，不夸张。
5. 简历已作为附件，可在正文里提一句"简历见附件"。
6. 结尾署名用资料里的姓名，并附上资料里的邮箱和电话（有就附，没有就不附）。
只输出 JSON：{"subject": "邮件主题", "body": "邮件正文"}

【个人资料】
${profile}`;
// What a placeholder looks like. [ ... ] and < ... > are always suspicious unless they clearly are not blanks (a citation like
// [1], a comparison like "<2 years"); 【 ... 】 is a normal Chinese subject prefix (【求职申请】) and only counts with a blank-like
// word inside; （请…） only when it asks to fill something in.
const BLANK = '(?:姓名|名字|公司|职位|岗位|学校|专业|日期|电话|邮箱|此处|填写|输入|补充|待定|name|company|position|title|date|school|university|phone|email|insert|fill|your|xx)';
const BLANK_CJK = '(?:姓名|名字|此处|填写|输入|补充|待定|xx|name|your|insert|fill)'; // in 【…】 subjects 公司/岗位/职位 are ordinary words (【应聘贵公司数据分析师岗位】)
const BAD = new RegExp(`\\[(?![\\d\\s.,;:-]*\\])[^\\]\\n]{0,30}\\]|【[^】\\n]{0,30}${BLANK_CJK}[^】\\n]{0,30}】|\\{\\{|\\}\\}|<(?![\\d\\s=])[^>\\n]{0,40}>|\\bXX+\\b|（\\s*(?:此处|请\\s*(?:填写|补充|输入|填|写))[^）]*）|\\(\\s*(?:insert|your|fill)[^)]*\\)|\\byour (?:name|company)\\b|_{3,}|＿{2,}`, 'i');
const maxBody = (lang) => (lang === 'en' ? maxChars * 2.5 : maxChars * 1.4); // the model counts 字 / words, the check counts characters
const valid = (d, lang) => d && typeof d.subject === 'string' && typeof d.body === 'string'
  && d.subject.trim().length > 0 && d.subject.length <= 140 && d.body.trim().length >= 60 && d.body.length <= maxBody(lang)
  && !BAD.test(d.subject) && !BAD.test(d.body);

for (const j of input.jobs) {
  if (j.route !== 'email') continue;
  if (overBudget()) { j.route = 'site'; j.note = '写信阶段超时，请自己投递'; continue; }
  let draft = null; let why = '';
  for (let a = 0; a < 2 && !draft; a++) {
    try {
      const r = await ai(system, `请为这个岗位写投递邮件：\n<job>\n标题：${j.title}\n公司：${j.company}\n描述：\n${j.description.slice(0, 3500)}\n</job>`);
      if (valid(r, j.language)) draft = { subject: r.subject.trim(), body: r.body.trim() }; else why = '草稿含占位符或长度不合格';
    } catch (e) { why = safe(e.message); }
  }
  if (draft) { j.subject = draft.subject; j.body = draft.body; } else { j.route = 'site'; j.note = `邮件没写好（${why}），请自己投递${j.to ? `（投递邮箱：${j.to}）` : ''}`; }
  await sleep(Number(E('AI_DELAY_MS', '400')));
}
return [{ json: input }];
