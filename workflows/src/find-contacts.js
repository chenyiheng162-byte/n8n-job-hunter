// n8n Code node "Find contacts": for postings that passed screening, look for an application e-mail address.
// 1) the posting text, 2) the posting page, 3) (opt-in, HR_EMAIL_SEARCH=on) a web search for the company's HR address.
// The address is picked by plain code (a regex), never by the AI, so a poisoned posting cannot pick the recipient by instruction.
//@include common.js
const input = $input.first().json;
const state = loadState();
const searchOn = E('HR_EMAIL_SEARCH', 'off') === 'on' && E('SERPER_API_KEY');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const ok = (e) => !state.recipients.has(e); // an address already written to is not used again (cooldown is enforced again when sending)

async function verify(email) { // MailboxLayer: mailbox must exist and not be disposable
  if (!E('MAILBOXLAYER_API_KEY')) return false;
  const r = await http({ method: 'GET', url: `${E('MAILBOXLAYER_API_BASE', 'http://apilayer.net/api/check')}?access_key=${encodeURIComponent(E('MAILBOXLAYER_API_KEY'))}&email=${encodeURIComponent(email)}`, json: true, timeout: 20000 });
  return !!(r && r.mx_found && r.smtp_check && !r.disposable);
}

// Resolve a link against the page it was found on. (No `URL` class: n8n's Code-node sandbox does not provide it.)
function absUrl(href, base) {
  const h = decodeEntities(href).trim();
  if (/^https?:\/\//i.test(h)) return h;
  const m = String(base).match(/^(https?:)\/\/([^\/?#]+)([^?#]*)/i); if (!m) return '';
  if (h.startsWith('//')) return `${m[1]}${h}`;
  if (h.startsWith('/')) return `${m[1]}//${m[2]}${h}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return '';                       // some other scheme (mailto:, javascript:, tel: ...)
  return `${m[1]}//${m[2]}${m[3].replace(/[^\/]*$/, '')}${h}`;
}
// The link behind an "Apply" button on the posting page (so "前往投递" opens the application itself, not just the listing).
function applyLinkIn(html, base) {
  const best = []; let m; const re = /<a\b[^>]*?href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
  const text0 = String(html).slice(0, 300000);
  while ((m = re.exec(text0))) {
    const text = htmlToText(m[2]); const href = m[1].trim();
    if (!/apply|application|申请|投递|应聘|立即申请/i.test(`${text} ${href}`) || /^(mailto:|javascript:|tel:)/i.test(href)) continue;
    if (/share|linkedin\.com\/shareArticle|facebook|twitter|whatsapp|tracking|unsubscribe/i.test(href)) continue;
    const u = absUrl(href, base);
    if (!u || u === base) continue;
    best.push({ url: u, strong: /^\s*(apply|apply now|apply for this (job|position|role)|apply here|立即申请|申请职位|投递简历)\s*$/i.test(text) });
  }
  const pick = best.find((b) => b.strong) || best[0];
  return pick ? pick.url.slice(0, 500) : '';
}

for (const j of input.jobs) {
  if (j.route !== 'pending') continue;
  if (overBudget()) { input.warnings.push('找邮箱阶段超时，剩余岗位按网站投递处理'); j.route = 'site'; continue; }
  let found = emailsIn(j.description).filter(ok);
  let source = 'posting';
  if (!found.length) {
    try {
      const page = await http({ method: 'GET', url: j.url, headers: { 'User-Agent': UA }, timeout: 15000 });
      const html = typeof page === 'string' ? page.slice(0, 300000) : JSON.stringify(page).slice(0, 300000);
      found = emailsIn(html).filter(ok);
      source = 'page';
      j.applyUrl = applyLinkIn(html, j.url);
    } catch (e) { /* the page is optional */ }
  }
  if (!found.length && searchOn && j.company) {
    try {
      const r = await http({ method: 'POST', url: E('SERPER_API_BASE', 'https://google.serper.dev/search'), headers: { 'X-API-KEY': E('SERPER_API_KEY') }, body: { q: `${j.company} HR recruiter hiring email` }, json: true, timeout: 20000 });
      const cands = emailsIn(JSON.stringify(r.organic || []).slice(0, 20000)).filter(ok).slice(0, 2);
      for (const c of cands) { if (await verify(c)) { found = [c]; source = 'search'; break; } }
    } catch (e) { input.warnings.push(`邮箱搜索失败（${j.company}）：${safe(e.message)}`); }
  }
  // An address found on the posting's web page (not in the posting text itself) is often a site-wide contact, not an
  // application address (a careers index page lists the company's general mailbox). Unless the user opted in
  // (PAGE_EMAILS=on) it is only shown as a hint and the posting is listed for the user to apply on the site.
  if (found.length && source === 'page' && E('PAGE_EMAILS', 'off') !== 'on') { j.route = 'site'; j.note = `岗位网页上有个邮箱 ${found[0]}，但不确定是不是专门的投递邮箱，没有自动发送，请自己决定`; }
  else if (found.length) { j.to = found[0]; j.contactSource = source; j.route = 'email'; } else { j.route = 'site'; }
  await sleep(200);
}
return [{ json: input }];
