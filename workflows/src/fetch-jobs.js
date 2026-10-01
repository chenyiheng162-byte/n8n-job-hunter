// n8n Code node "Fetch jobs": collects postings from every configured source, drops the ones already handled before,
// and returns at most MAX_JOBS_PER_RUN new ones (newest first). A failing source becomes a warning, never an error.
//@include common.js
const keywords = E('JOB_KEYWORDS').split(/[,，;；\n]+/).map((s) => s.trim()).filter(Boolean);
const location = SEARCH_LOCATION;
const maxAgeMs = Number(E('JOB_MAX_AGE_DAYS', '30')) * 86400000;
const cap = Number(E('MAX_JOBS_PER_RUN', '40'));
const warnings = [];
const raw = [];
let sourcesOk = 0; // requests that got an answer (a source with zero postings still counts)
const asDate = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : 0; };
const httpUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u).slice(0, 500) : '');
const tagList = (t) => (Array.isArray(t) ? t : String(t || '').split(/[,;，；]/)).map((x) => String(x).trim()).filter(Boolean).slice(0, 6);

// Jooble (needs a free API key)
if (E('JOOBLE_API_KEY') && keywords.length) {
  for (const kw of keywords) {
    try {
      const r = await http({ method: 'POST', url: `${E('JOOBLE_API_BASE', 'https://jooble.org/api')}/${E('JOOBLE_API_KEY')}`, body: { keywords: kw, location }, json: true, timeout: 30000 });
      for (const j of (r && r.jobs) || []) raw.push({ title: j.title, company: j.company, location: j.location, description: htmlToText(j.snippet), url: j.link, postedAt: asDate(j.updated), source: 'jooble', salary: j.salary, jobType: j.type });
      sourcesOk += 1;
    } catch (e) { warnings.push(`Jooble(${kw}): ${safe(e.message)}`); }
    await sleep(300);
  }
}
// Remotive (free, no key; remote jobs only). Its public API returns the same newest postings whatever the search term, and
// the site asks for very few requests per day: ONE request, with the first keyword as a hint, also when there are no keywords.
if (E('REMOTIVE', 'off') === 'on') {
  try {
    const r = await http({ method: 'GET', url: `${E('REMOTIVE_API_BASE', 'https://remotive.com/api/remote-jobs')}?limit=50${keywords.length ? `&search=${encodeURIComponent(keywords[0])}` : ''}`, json: true, timeout: 30000 });
    for (const j of (r && r.jobs) || []) raw.push({ title: j.title, company: j.company_name, location: j.candidate_required_location, description: htmlToText(j.description), url: j.url, postedAt: asDate(j.publication_date), source: 'remotive', salary: j.salary, jobType: String(j.job_type || '').replace(/_/g, ' '), tags: j.tags, category: j.category, logo: j.company_logo || j.company_logo_url });
    sourcesOk += 1;
  } catch (e) { warnings.push(`Remotive: ${safe(e.message)}`); }
}
// Any RSS/Atom feed (for example a LinkedIn search turned into a feed by rss.app)
for (const feed of E('JOB_RSS_URLS').split(/[\s,]+/).filter(Boolean)) {
  try {
    const xml = String(await http({ method: 'GET', url: feed, timeout: 30000 }));
    const items = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/g) || [];
    const tag = (s, n) => { const m = s.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`, 'i')); return m ? decodeEntities(m[1]).trim() : ''; };
    for (const it of items) {
      const link = tag(it, 'link') || (it.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || '';
      const title = htmlToText(tag(it, 'title'));
      const img = (it.match(/<(?:media:content|media:thumbnail|enclosure)[^>]*?url="([^"]+)"/i) || [])[1];
      raw.push({ title, company: '', location: '', description: htmlToText(tag(it, 'content:encoded') || tag(it, 'description') || tag(it, 'summary') || tag(it, 'content')), url: link, postedAt: asDate(tag(it, 'pubDate') || tag(it, 'published') || tag(it, 'updated')), source: 'rss', logo: img });
    }
    sourcesOk += 1;
  } catch (e) { warnings.push(`RSS: ${safe(e.message)}`); }
}
if (!E('JOOBLE_API_KEY') && E('REMOTIVE', 'off') !== 'on' && !E('JOB_RSS_URLS')) warnings.push('没有配置任何职位来源（JOOBLE_API_KEY / JOB_RSS_URLS / REMOTIVE）');

const state = loadState();
const seen = new Set();
const jobs = [];
for (const j of raw.sort((a, b) => b.postedAt - a.postedAt)) {
  if (!j.title || !j.url) continue;
  if (j.postedAt && Date.now() - j.postedAt > maxAgeMs) continue;
  const id = jobIdOf(j.url, j.title, j.company);
  const dupKey = `${String(j.title).toLowerCase()}|${String(j.company).toLowerCase()}`;
  if (seen.has(id) || (j.company && seen.has(dupKey)) || state.handled(id)) continue;
  seen.add(id); if (j.company) seen.add(dupKey);
  jobs.push({ id, title: String(j.title).slice(0, 200), company: String(j.company || '').slice(0, 120), location: String(j.location || '').slice(0, 120), description: String(j.description || '').slice(0, 5000), url: j.url, source: j.source, postedAt: j.postedAt || 0, salary: String(j.salary || '').slice(0, 80), jobType: String(j.jobType || '').slice(0, 40), tags: tagList(j.tags), category: String(j.category || '').slice(0, 60), logo: httpUrl(j.logo) });
}
return [{ json: { build: '@@BUILD@@', startedAt: new Date(runStartedAt).toISOString(), fetched: raw.length, sourcesOk, jobs: jobs.slice(0, cap), overflow: Math.max(0, jobs.length - cap), warnings } }];
