#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORRECTIONS } from '../src/corrections-catalog.js';

const scriptPath = fileURLToPath(import.meta.url);
const outputPath = path.resolve(path.dirname(scriptPath), '../../../public/activities.js');

export async function writeActivities(activities) {
  if (!Array.isArray(activities) || !activities.length) throw new Error('Liste des activités vide.');
  const seen = new Set();
  const entries = activities.map(({ id, title }) => {
    if (typeof id !== 'string' || !/^(?:[345]\/\d{2}|bonus\/[345]-\d{2})$/.test(id) || seen.has(id)) throw new Error('Activité invalide.');
    if (typeof title !== 'string' || !title.trim() || title.length > 300) throw new Error('Titre d’activité invalide.');
    seen.add(id);
    return { id, title };
  });
  const source = '// Generated from the activity catalog. No PDF or private data.\n'
    + 'window.ClasseCalmeActivities = Object.freeze([\n'
    + entries.map(entry => `  Object.freeze(${JSON.stringify(entry).replace(/</g, '\\u003c')}),`).join('\n')
    + '\n]);\n';
  try { if (await readFile(outputPath, 'utf8') === source) return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, source, { mode: 0o644 });
    await rename(temporaryPath, outputPath);
  } finally { await rm(temporaryPath, { force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await writeActivities(Object.entries(CORRECTIONS).map(([id, entry]) => ({ id, title: entry.title })));
}
