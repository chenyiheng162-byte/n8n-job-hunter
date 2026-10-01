// A throw-away job feed (RSS) with two DEMO postings that contain an application e-mail address, so the e-mail path can be
// exercised for real. The addresses use the reserved ".example" TLD: nothing can ever be delivered to them.
import http from 'node:http';
const jobs = [
  { n: 1, title: 'Junior Data Analyst (DEMO)', company: 'Demo Acme', mail: 'hr@demo-acme.example', text: 'Demo Acme is looking for a Junior Data Analyst intern. You will build dashboards in Tableau, write SQL queries, clean data with Python and support A/B tests. Remote friendly, Shanghai or remote. To apply, send your CV to hr@demo-acme.example.' },
  { n: 2, title: 'Data Analysis Intern (DEMO)', company: 'Demo Northwind', mail: 'talent@demo-northwind.example', text: 'Demo Northwind hires a Data Analysis Intern for 6 months. Skills: SQL, Python, Tableau, statistics. Fully remote. Please email your resume and a short cover letter to talent@demo-northwind.example.' },
];
// Postings WITHOUT an e-mail address: the console lists them under "待投递" with a "前往投递" link (a real public page, so the click works).
const noMail = [
  { n: 3, title: 'Data Analyst Intern - Apply on our website (DEMO)', company: 'Demo Python Software Co', url: 'https://www.python.org/jobs/', text: 'Demo Python Software Co is hiring a Data Analyst Intern. You will work with SQL and Python (pandas) on product metrics and build Tableau dashboards. Remote friendly. Applications are accepted only through our careers website.' },
  { n: 4, title: '数据分析实习生（远程）- 请在官网投递 (DEMO)', company: '演示数据科技', url: 'https://remotive.com/remote-jobs/data', text: '演示数据科技招聘数据分析实习生：熟悉 SQL、Python、Tableau，做过 A/B 测试者优先，上海或远程均可。请通过公司招聘官网提交申请，不接受邮件投递。' },
  { n: 5, title: 'Junior BI Analyst - Intern (DEMO)', company: 'Demo Product Labs', url: 'https://remotive.com/remote-jobs/product', text: 'Demo Product Labs seeks a Junior BI Analyst intern: SQL, Tableau, Excel and basic statistics. Remote. Please apply through the form on our job page.' },
];
const port = Number(process.env.PORT || 5740);
http.createServer((req, res) => {
  if (req.url === '/feed.xml') {
    res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
    return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>demo</title>${jobs.map((j) => `<item><title>${j.title}</title><link>${j.url || `http://127.0.0.1:${port}/jobs/${j.n}`}</link><description><![CDATA[${j.company}: ${j.text}]]></description><pubDate>${new Date().toUTCString()}</pubDate></item>`).join('')}</channel></rss>`);
  }
  const m = req.url.match(/^\/jobs\/(\d)$/); const j = m && jobs[Number(m[1]) - 1];
  res.writeHead(j ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(j ? `<html><body><h1>${j.title}</h1><p>${j.text}</p></body></html>` : 'not found');
}).listen(port, '127.0.0.1', () => console.log(`demo feed on http://127.0.0.1:${port}/feed.xml`));
