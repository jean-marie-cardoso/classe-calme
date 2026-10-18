#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeActivities } from './write-activities.mjs';

const relayDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsDirectory = path.join(relayDirectory, 'correction-assets');
const catalogPath = path.join(relayDirectory, 'src', 'corrections-catalog.js');
const maximumPdfBytes = 15 * 1024 * 1024;
const maximumTotalBytes = 60 * 1024 * 1024;

function containedPath(directory, relativePath, description) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\\') || path.isAbsolute(relativePath)) {
    throw new Error(`${description} : chemin relatif invalide.`);
  }
  const resolved = path.resolve(directory, relativePath);
  if (!resolved.startsWith(`${directory}${path.sep}`)) {
    throw new Error(`${description} : chemin hors du dossier autorisé.`);
  }
  return resolved;
}

function readCourseMetadata(html, route) {
  const assignment = /window\.course\s*=\s*/u.exec(html);
  if (!assignment) return null;
  const start = assignment.index + assignment[0].length;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(html.slice(start, index + 1));
    } else if (index === start && character !== '{') {
      break;
    }
  }
  throw new Error(`${route} : métadonnées JSON incomplètes.`);
}

async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function correctionDirectory(courseDirectory, metadata, route, grade, number, identifier, bonus) {
  if (metadata) {
    if (metadata.route !== `${route}/`) {
      throw new Error(`${route} : les métadonnées ne correspondent pas à la route.`);
    }
    const sourceMatches = typeof metadata.source === 'string' && metadata.source.endsWith(`_${identifier}.docx`);
    if (!sourceMatches && !bonus) {
      throw new Error(`${route} : la fiche source ne correspond pas à l'activité.`);
    }
    if (sourceMatches) {
      const sourcePath = containedPath(courseDirectory, metadata.source, route);
      const directory = await realpath(path.dirname(sourcePath));
      if (!directory.startsWith(`${courseDirectory}${path.sep}`)) {
        throw new Error(`${route} : dossier source hors du dossier des cours.`);
      }
      return directory;
    }
    console.warn(`${route} : ancienne métadonnée de fiche ignorée ; correction bonus ${identifier} exigée.`);
  }

  // Custom activity pages do not all expose window.course. Their exact PDF
  // identifier must match inside the corresponding sequence/bonus folder.
  const scope = bonus
    ? path.join(courseDirectory, `${grade}eme`, '00 Ressources', 'Projets bonus')
    : path.join(courseDirectory, `${grade}eme`);
  const candidates = [];
  for (const entry of await readdir(scope, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(`${number} `)) continue;
    const directory = path.join(scope, entry.name);
    const expectedFilename = `02_Corrige_eleve_Pronote_${identifier}.pdf`;
    const hasPdf = (await readdir(directory, { withFileTypes: true }))
      .some(file => file.isFile() && file.name === expectedFilename);
    if (hasPdf) candidates.push(directory);
  }
  if (candidates.length !== 1) throw new Error(`${route} : dossier de correction absent ou ambigu.`);
  return candidates[0];
}

async function main() {
  const courseArgument = process.argv[2] || process.env.COURSE_ROOT;
  const manifestArgument = process.argv[3] || process.env.CORRECTIONS_MANIFEST;
  if (!courseArgument || !manifestArgument || process.argv.length > 4) {
    throw new Error('Usage : node scripts/prepare-corrections.mjs <dossier-cours> <links.json> (ou COURSE_ROOT et CORRECTIONS_MANIFEST).');
  }
  const courseDirectory = await realpath(path.resolve(courseArgument));
  const activityDirectory = await realpath(path.join(courseDirectory, 'Site interactif', 'public'));
  const manifest = JSON.parse(await readFile(path.resolve(manifestArgument), 'utf8'));
  if (!Array.isArray(manifest) || manifest.length === 0) throw new Error('Manifest vide ou invalide.');

  const entries = [];
  const routes = new Set();
  let totalBytes = 0;
  for (const activity of manifest) {
    const routeWithSlash = activity?.path;
    if (typeof routeWithSlash !== 'string' || !/^(?:[345]\/\d{2}\/|bonus\/[345]-\d{2}\/)$/u.test(routeWithSlash)) {
      throw new Error('Manifest : route non autorisée.');
    }
    const route = routeWithSlash.slice(0, -1);
    if (routes.has(route)) throw new Error(`${route} : route en double.`);
    routes.add(route);
    if (typeof activity.title !== 'string' || !activity.title.trim() || activity.title.length > 300) {
      throw new Error(`${route} : titre absent ou invalide.`);
    }
    const bonus = route.startsWith('bonus/');
    const [grade, number] = bonus ? route.slice(6).split('-') : route.split('/');
    if (number === '00') throw new Error(`${route} : numéro d'activité invalide.`);
    const identifier = `${grade}${bonus ? 'B' : 'S'}${number}`;
    const activityPath = containedPath(activityDirectory, `${route}/index.html`, route);
    const metadata = readCourseMetadata(await readFile(activityPath, 'utf8'), route);
    const sourceDirectory = await correctionDirectory(courseDirectory, metadata, route, grade, number, identifier, bonus);
    const expectedFilename = `02_Corrige_eleve_Pronote_${identifier}.pdf`;
    const matches = (await readdir(sourceDirectory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name === expectedFilename);
    if (matches.length !== 1) throw new Error(`${route} : correction élève absente ou ambiguë.`);
    const bytes = await readFile(path.join(sourceDirectory, matches[0].name));
    if (bytes.length < 6 || bytes.length > maximumPdfBytes || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new Error(`${route} : PDF invalide ou supérieur à 15 Mio.`);
    }
    totalBytes += bytes.length;
    if (totalBytes > maximumTotalBytes) throw new Error('Les corrections dépassent 60 Mio.');
    entries.push({
      route,
      bytes,
      metadata: {
        file: `/${route}.pdf`,
        title: activity.title,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
      },
    });
  }

  // Validate every source before replacing any generated output.
  await privateDirectory(assetsDirectory);
  const stagingDirectory = path.join(assetsDirectory, `.prepare-${randomUUID()}`);
  await privateDirectory(stagingDirectory);
  const temporaryCatalogPath = `${catalogPath}.${randomUUID()}.tmp`;
  try {
    for (const entry of entries) {
      const destination = containedPath(stagingDirectory, entry.metadata.file.slice(1), entry.route);
      await privateDirectory(path.dirname(destination));
      await writeFile(destination, entry.bytes, { mode: 0o600 });
    }
    for (const entry of entries) {
      const destination = containedPath(assetsDirectory, entry.metadata.file.slice(1), entry.route);
      await privateDirectory(path.dirname(destination));
      await rename(containedPath(stagingDirectory, entry.metadata.file.slice(1), entry.route), destination);
      await chmod(destination, 0o600);
    }
    const lines = entries.map(entry => `  ${JSON.stringify(entry.route)}: Object.freeze(${JSON.stringify(entry.metadata)}),`);
    const catalog = '// Generated by scripts/prepare-corrections.mjs. PDF bytes stay in private assets.\n'
      + `export const CORRECTIONS = Object.freeze({\n${lines.join('\n')}\n});\n`;
    await writeFile(temporaryCatalogPath, catalog, 'utf8');
    await rename(temporaryCatalogPath, catalogPath);
    await writeActivities(entries.map(entry => ({ id: entry.route, title: entry.metadata.title })));
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
    await rm(temporaryCatalogPath, { force: true });
  }
  console.log(`${entries.length} corrections préparées (${totalBytes} octets). PDFs privés, catalogue sans contenu PDF.`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
