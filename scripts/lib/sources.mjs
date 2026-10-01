// Which job sources a configuration can really use. ONE rule, shared by the runner's preflight (scripts/hunt.mjs) and the
// console's checklist (scripts/console.mjs), so the console never says "ready" for a setup the morning run would refuse.
export function sourceStatus(s = {}) {
  const usable = []; const warnings = [];
  if (s.JOOBLE_API_KEY) { if (s.JOB_KEYWORDS) usable.push('Jooble'); else warnings.push('Jooble 需要搜索关键词（JOB_KEYWORDS），填好之前不会用 Jooble 搜索'); }
  if (s.JOB_RSS_URLS) usable.push('RSS');
  if (s.REMOTIVE === 'on') usable.push('Remotive');
  return { usable, warnings, ok: usable.length > 0 };
}
