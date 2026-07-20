import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.dirname(__filename);
const TARGET_URL = 'https://www.oldhamcountyky.gov/magistratedocs2026';
const CURRENT_PATH = path.join(ROOT, 'current.json');
const ARCHIVE_ROOT = path.join(ROOT, 'archive');
const FILES_ROOT = path.join(ARCHIVE_ROOT, 'files');
const MANIFEST_PATH = path.join(ARCHIVE_ROOT, 'manifest.json');
const STATUS_PATH = path.join(ARCHIVE_ROOT, 'status.json');
const RUNS_PATH = path.join(ARCHIVE_ROOT, 'runs.jsonl');
const MAX_FILE_BYTES = 95 * 1024 * 1024;
const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000;

const normalizeText = (value) => String(value ?? '')
  .normalize('NFKC')
  .replace(/\u00a0/g, ' ')
  .replace(/[\t\r\n ]+/g, ' ')
  .trim();

function safeSegment(value, fallback = 'untitled') {
  const cleaned = normalizeText(value)
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/[^a-zA-Z0-9._ -]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-. ]+|[-. ]+$/g, '')
    .toLowerCase();
  return cleaned || fallback;
}

function safeFilename(value, fallback = 'document.pdf') {
  const original = normalizeText(value) || fallback;
  const extension = path.extname(original).toLowerCase() || '.pdf';
  const basename = path.basename(original, path.extname(original));
  return `${safeSegment(basename, 'document')}${extension === '.pdf' ? '.pdf' : extension}`;
}

function localTime(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function appendJsonLine(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function flattenInventory(inventory) {
  const documents = [];
  for (const section of inventory.sections ?? []) {
    for (const item of section.items ?? []) {
      if (!item.linked || !item.href) continue;
      documents.push({
        section: section.title,
        title: item.title,
        source_url: item.href,
        source_filename: item.filename || path.basename(new URL(item.href).pathname) || 'document.pdf',
      });
    }
  }
  return documents;
}

function latestForUrl(manifest, sourceUrl) {
  return [...(manifest.documents ?? [])]
    .filter((entry) => entry.source_url === sourceUrl)
    .sort((a, b) => String(b.first_seen_utc).localeCompare(String(a.first_seen_utc)))[0] ?? null;
}

function shouldRecheck(entry, now) {
  if (!entry) return true;
  if (!entry.last_verified_utc) return true;
  const checked = Date.parse(entry.last_verified_utc);
  return !Number.isFinite(checked) || now.getTime() - checked >= RECHECK_AFTER_MS;
}

async function downloadWithBrowser(context, sourceUrl) {
  const headers = {
    accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8',
    referer: TARGET_URL,
  };

  const response = await context.request.get(sourceUrl, {
    headers,
    timeout: 60_000,
    failOnStatusCode: false,
  });

  if (!response.ok()) {
    const page = await context.newPage();
    try {
      const navigation = await page.goto(sourceUrl, { waitUntil: 'commit', timeout: 60_000 });
      if (!navigation || !navigation.ok()) {
        const status = navigation?.status() ?? response.status();
        throw new Error(`download returned HTTP ${status}`);
      }
      return {
        body: await navigation.body(),
        status: navigation.status(),
        headers: navigation.headers(),
        final_url: navigation.url(),
      };
    } finally {
      await page.close();
    }
  }

  return {
    body: await response.body(),
    status: response.status(),
    headers: response.headers(),
    final_url: response.url(),
  };
}

function validatePdf(body, headers, sourceUrl) {
  if (!body?.length) throw new Error('download was empty');
  if (body.length > MAX_FILE_BYTES) {
    throw new Error(`file is ${(body.length / 1024 / 1024).toFixed(1)} MB, above the 95 MB GitHub archive limit`);
  }
  const contentType = String(headers['content-type'] ?? '').toLowerCase();
  const pdfMagic = body.subarray(0, 5).toString('ascii') === '%PDF-';
  if (!pdfMagic && !contentType.includes('application/pdf')) {
    throw new Error(`response was not a PDF (${contentType || 'unknown content type'}) from ${sourceUrl}`);
  }
}

async function uniqueArchivePath(document, sha256, firstSeen) {
  const sectionFolder = safeSegment(document.section, 'unknown-section');
  const dateFolder = firstSeen.slice(0, 10);
  const filename = safeFilename(document.source_filename || document.title);
  const extension = path.extname(filename) || '.pdf';
  const basename = path.basename(filename, extension);
  const folder = path.join(FILES_ROOT, sectionFolder, dateFolder);
  await mkdir(folder, { recursive: true });

  let candidate = path.join(folder, filename);
  try {
    const existing = await readFile(candidate);
    const existingHash = createHash('sha256').update(existing).digest('hex');
    if (existingHash === sha256) return candidate;
    candidate = path.join(folder, `${basename}__${sha256.slice(0, 10)}${extension}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return candidate;
}

async function main() {
  const started = new Date();
  const startedUtc = started.toISOString();
  const inventory = await readJson(CURRENT_PATH, null);
  if (!inventory?.sections?.length) throw new Error('current.json does not contain a successful inventory');

  const manifest = await readJson(MANIFEST_PATH, {
    version: 1,
    archive_root: 'magistrate-monitor/archive/files',
    documents: [],
  });
  const currentDocuments = flattenInventory(inventory);
  const archived = [];
  const unchanged = [];
  const failures = [];

  await mkdir(FILES_ROOT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      locale: 'en-US',
      timezoneId: 'America/New_York',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 OldhamMagistrateArchive/1.0',
    });
    const landing = await context.newPage();
    const landingResponse = await landing.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (!landingResponse?.ok()) {
      throw new Error(`source page returned HTTP ${landingResponse?.status() ?? 'unknown'}`);
    }
    await landing.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    for (const document of currentDocuments) {
      const previous = latestForUrl(manifest, document.source_url);
      if (previous && !shouldRecheck(previous, started)) {
        previous.last_seen_utc = startedUtc;
        unchanged.push({ title: document.title, source_url: document.source_url, reason: 'already archived' });
        continue;
      }

      try {
        const downloaded = await downloadWithBrowser(context, document.source_url);
        validatePdf(downloaded.body, downloaded.headers, document.source_url);
        const sha256 = createHash('sha256').update(downloaded.body).digest('hex');

        if (previous?.sha256 === sha256) {
          previous.last_seen_utc = startedUtc;
          previous.last_verified_utc = startedUtc;
          previous.http = {
            status: downloaded.status,
            content_type: downloaded.headers['content-type'] ?? null,
            etag: downloaded.headers.etag ?? null,
            last_modified: downloaded.headers['last-modified'] ?? null,
          };
          unchanged.push({ title: document.title, source_url: document.source_url, reason: 'content hash unchanged' });
          continue;
        }

        const archivePath = await uniqueArchivePath(document, sha256, startedUtc);
        await writeFile(archivePath, downloaded.body);
        const relativePath = path.relative(ROOT, archivePath).split(path.sep).join('/');
        const entry = {
          id: sha256.slice(0, 16),
          section: document.section,
          title: document.title,
          source_url: document.source_url,
          final_url: downloaded.final_url,
          source_filename: document.source_filename,
          archive_path: `magistrate-monitor/${relativePath}`,
          public_url: `https://ocdeez.github.io/magistrate-monitor/${relativePath}`,
          sha256,
          bytes: downloaded.body.length,
          first_seen_utc: startedUtc,
          first_seen_local: localTime(started),
          last_seen_utc: startedUtc,
          last_verified_utc: startedUtc,
          supersedes_id: previous?.id ?? null,
          http: {
            status: downloaded.status,
            content_type: downloaded.headers['content-type'] ?? null,
            etag: downloaded.headers.etag ?? null,
            last_modified: downloaded.headers['last-modified'] ?? null,
          },
        };
        manifest.documents.push(entry);
        archived.push(entry);
      } catch (error) {
        failures.push({
          section: document.section,
          title: document.title,
          source_url: document.source_url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await browser.close();
  }

  manifest.updated_at_utc = startedUtc;
  manifest.updated_at_local = localTime(started);
  manifest.current_link_count = currentDocuments.length;
  manifest.unique_archived_files = manifest.documents.length;
  await writeJson(MANIFEST_PATH, manifest);

  const status = {
    success: failures.length === 0,
    checked_at_utc: startedUtc,
    checked_at_local: localTime(started),
    current_link_count: currentDocuments.length,
    archived_this_run: archived.length,
    unchanged_this_run: unchanged.length,
    failed_this_run: failures.length,
    total_archived_files: manifest.documents.length,
    archived,
    failures,
  };
  await writeJson(STATUS_PATH, status);
  await appendJsonLine(RUNS_PATH, status);

  console.log(`PDF archive ran at ${status.checked_at_local}: ${archived.length} archived, ${unchanged.length} already current, ${failures.length} failed.`);
  if (failures.length) {
    for (const failure of failures) console.error(`${failure.title}: ${failure.error}`);
    process.exitCode = 1;
  }
}

await main();
