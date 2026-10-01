// Assembles workflows/job-hunter.json (and workflows/BUILD) from the Code-node sources in workflows/src/.
// BUILD is a hash of the whole workflow; the first node stamps it into its output and hunt.mjs refuses a plan whose
// build differs from the deployed one, so a stale workflow in n8n can never act.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
import { WORKFLOW_ID } from './lib/constants.mjs';
const src = (f) => fs.readFileSync(path.join(root, 'workflows', 'src', f), 'utf8')
  .replace(/^\/\/@include (\S+)$/gm, (_, inc) => fs.readFileSync(path.join(root, 'workflows', 'src', 'lib', inc), 'utf8'));
const PH = '@@BUILD@@';
const stages = [
  ['Fetch jobs', 'fetch-jobs.js'],
  ['Screen jobs', 'screen-jobs.js'],
  ['Find contacts', 'find-contacts.js'],
  ['Draft emails', 'draft-emails.js'],
  ['Make plan', 'make-plan.js'],
];
const nodes = [{ id: 'c1a00000-0000-4000-8000-000000000001', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }];
const connections = {};
let prev = 'Start';
stages.forEach(([name, file], i) => {
  nodes.push({ id: `c1a00000-0000-4000-8000-00000000001${i}`, name, type: 'n8n-nodes-base.code', typeVersion: 2, position: [240 * (i + 1), 0], parameters: { jsCode: src(file) } });
  connections[prev] = { main: [[{ node: name, type: 'main', index: 0 }]] };
  prev = name;
});
const wf = { id: WORKFLOW_ID, name: 'Job Hunter', active: false, nodes, connections, settings: { executionOrder: 'v1' } };
const build = crypto.createHash('sha256').update(JSON.stringify(wf)).digest('hex').slice(0, 12);
fs.writeFileSync(path.join(root, 'workflows', 'job-hunter.json'), JSON.stringify(wf, null, 2).split(PH).join(build) + '\n');
fs.writeFileSync(path.join(root, 'workflows', 'BUILD'), `${build}\n`);
console.log(`wrote workflows/job-hunter.json (build ${build})`);
