// Target regions of the job search. The SAME table is written out in workflows/src/lib/common.js (the workflow code runs
// inside n8n and cannot import modules); test/lib.test.mjs checks that the two never drift apart.
//   en: what the job APIs get as the location (empty = no location filter)     zh: what the AI and the console show
export const REGIONS = { hk: { en: 'Hong Kong', zh: '香港' }, cn: { en: 'China', zh: '中国大陆' }, tw: { en: 'Taiwan', zh: '台湾' }, sg: { en: 'Singapore', zh: '新加坡' }, jp: { en: 'Japan', zh: '日本' }, us: { en: 'United States', zh: '美国' }, uk: { en: 'United Kingdom', zh: '英国' }, ca: { en: 'Canada', zh: '加拿大' }, au: { en: 'Australia', zh: '澳大利亚' }, global: { en: '', zh: '不限地区（只看可远程的岗位）' } };
export const DEFAULT_REGION = 'hk';
// the location string the real run searches with: a specific place (JOB_LOCATION) wins over the region's name
export const searchLocation = (s) => s.JOB_LOCATION || (REGIONS[s.JOB_REGION] || REGIONS[DEFAULT_REGION]).en;
