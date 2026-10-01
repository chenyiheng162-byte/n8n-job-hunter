// n8n Code node "Make plan": the final result of the workflow. Nothing is sent from here: the runner (scripts/hunt.mjs)
// reads this plan and does the sending, the bookkeeping and the report outside n8n.
//@include common.js
const input = $input.first().json;
const plan = {
  build: input.build, date: new Date().toLocaleDateString('sv-SE'), startedAt: input.startedAt, finishedAt: new Date().toISOString(),
  fetched: input.fetched, sourcesOk: input.sourcesOk, overflow: input.overflow, warnings: input.warnings,
  items: input.jobs.map((j) => ({ id: j.id, title: j.title, company: j.company, location: j.location, url: j.url, source: j.source, score: j.score, reason: j.reason, route: j.route, salary: j.salary || '', jobType: j.jobType || '', tags: j.tags || [], category: j.category || '', logo: j.logo || '', postedAt: j.postedAt || 0, summary: j.summary || '', highlights: j.highlights || [], concerns: j.concerns || [], applyUrl: j.applyUrl || '', desc: String(j.description || '').slice(0, 1500), to: j.to || '', contactSource: j.contactSource || '', subject: j.subject || '', body: j.body || '', note: j.note || '' })),
};
const out = E('JOBHUNT_PLAN_FILE');
if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(plan, null, 2)); }
return [{ json: plan }];
