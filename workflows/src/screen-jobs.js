// n8n Code node "Screen jobs": one AI call per posting scores how well it fits the profile (0-10).
// Postings below MIN_SCORE are marked "skip" (and recorded, so they are not scored again tomorrow).
//@include common.js
const input = $input.first().json;
const profile = readProfile();
const system = `你是求职者本人的求职助手，判断一个岗位和 TA 的匹配度。${UNTRUSTED}
只依据下面的【个人资料】（含求职意向和不接受的条件）打分，不要编造。
目标地区：${REGION.zh}${E('JOB_LOCATION') ? `（具体到：${E('JOB_LOCATION')}）` : ''}。${E('JOB_REGION', 'hk') === 'global' ? '任何可以远程的岗位都算符合；若明确要求必须居住在某地（例如"仅限美国"），把它写进 concerns 并适当扣分，但不要因此封顶。' : '岗位应当位于目标地区，或明确允许身处该地区远程工作；要求只能在其他地区居住/工作的岗位（例如"仅限美国"）最高 3 分；地点不明确时按资料里的地点意向判断。'}
评分 0-10：技能/专业匹配、经验层级是否合适、地点/远程是否符合意向和目标地区、是否触犯"不接受"条件（触犯则最高 3 分）。
只输出 JSON：{"score": 整数, "reason": "一句话理由，中文", "summary": "一句话说明这个岗位具体做什么，中文，不超过 60 字", "highlights": ["和求职者相符的点，每条不超过 20 字，最多 3 条"], "concerns": ["需要求职者留意的点（要求偏高、地点/时区、合同类型等），每条不超过 20 字，最多 2 条，没有就给空数组"], "language": "zh 或 en（岗位描述的主要语言）", "company": "公司名，岗位里没有就留空"}

【个人资料】
${profile}`;
const listOf = (v, n) => (Array.isArray(v) ? v : []).map((x) => String(x || '').trim().slice(0, 60)).filter(Boolean).slice(0, n);
const items = [];
let errors = 0; let streak = 0;
for (const j of input.jobs) {
  if (overBudget()) { input.warnings.push('评分阶段超时，剩余岗位明天再看'); break; }
  try {
    const r = await ai(system, `<job>\n标题：${j.title}\n公司：${j.company}\n地点：${j.location}\n来源：${j.source}\n描述：\n${j.description}\n</job>`);
    const score = Math.max(0, Math.min(10, Math.round(Number(r.score))));
    if (!Number.isFinite(score)) throw new Error('bad score');
    streak = 0;
    items.push({ ...j, company: j.company || String(r.company || '').slice(0, 120), score, reason: String(r.reason || '').slice(0, 300), summary: String(r.summary || '').slice(0, 160), highlights: listOf(r.highlights, 3), concerns: listOf(r.concerns, 2), language: r.language === 'en' ? 'en' : 'zh', route: score >= MIN_SCORE ? 'pending' : 'skip' });
  } catch (e) {
    errors += 1; streak += 1; input.warnings.push(`评分失败（${j.title.slice(0, 40)}）：${safe(e.message)}`);
    if (streak >= 3) throw new Error(`AI 连续 3 次失败，停止评分：${safe(e.message)}`); // the service is down: do not burn through every posting
  }
  await sleep(Number(E('AI_DELAY_MS', '400')));
}
if (errors && !items.length) throw new Error(`AI 评分全部失败：${input.warnings.slice(-1)[0]}`);
return [{ json: { ...input, jobs: items } }];
