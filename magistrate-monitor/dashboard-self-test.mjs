import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');

const requiredMarkers = [
  'runs.jsonl',
  'archive/runs.jsonl',
  'monitor-history-body',
  'archive-history-body',
  'Latest successful inventory',
  'Complete browser run log',
  'Complete archive run log',
];

for (const marker of requiredMarkers) {
  if (!html.includes(marker)) throw new Error(`Dashboard is missing required marker: ${marker}`);
}

const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/i);
if (!scriptMatch) throw new Error('Dashboard inline script was not found.');

try {
  new Function(scriptMatch[1]);
} catch (error) {
  throw new Error(`Dashboard JavaScript syntax check failed: ${error.message}`);
}

console.log('Dashboard self-test passed.');
