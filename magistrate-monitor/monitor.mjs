import { chromium } from 'playwright';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.dirname(__filename);
const TARGET_URL = 'https://www.oldhamcountyky.gov/magistratedocs2026';
const CURRENT_PATH = path.join(ROOT, 'current.json');
const STATUS_PATH = path.join(ROOT, 'status.json');
const RUNS_PATH = path.join(ROOT, 'runs.jsonl');
const CHANGES_PATH = path.join(ROOT, 'changes.jsonl');
const LATEST_LOG_PATH = path.join(ROOT, 'latest.log.txt');
const DIAGNOSTICS_DIR = path.join(ROOT, 'diagnostics');

const normalizeText = (value) => String(value ?? '')
  .normalize('NFKC')
  .replace(/\u00a0/g, ' ')
  .replace(/[\t\r\n ]+/g, ' ')
  .trim();

function canonicalHref(value) {
  if (!value) return null;
  try {
    const url = new URL(value, TARGET_URL);
    url.hash = '';
    const decodedPath = url.pathname
      .split('/')
      .map((part) => {
        try { return decodeURIComponent(part); } catch { return part; }
      })
      .join('/');
    return `${url.protocol}//${url.host}${decodedPath}${url.search}`;
  } catch {
    return normalizeText(value);
  }
}

function itemIdentity(item) {
  return canonicalHref(item.href) ?? `title:${normalizeText(item.title)}`;
}

function countInventory(inventory) {
  const sections = inventory.sections.length;
  const items = inventory.sections.reduce((sum, section) => sum + section.items.length, 0);
  const linked = inventory.sections.reduce(
    (sum, section) => sum + section.items.filter((item) => item.linked && item.href).length,
    0,
  );
  return { sections, items, linked };
}

function findBestSectionRename(oldSection, newSections, usedNew) {
  const oldIds = new Set(oldSection.items.map(itemIdentity));
  let best = null;
  for (let index = 0; index < newSections.length; index += 1) {
    if (usedNew.has(index)) continue;
    const candidate = newSections[index];
    const newIds = new Set(candidate.items.map(itemIdentity));
    const overlap = [...oldIds].filter((id) => newIds.has(id)).length;
    const denominator = Math.max(oldIds.size, newIds.size, 1);
    const score = overlap / denominator;
    if (!best || score > best.score) best = { index, score };
  }
  return best && best.score >= 0.5 ? best : null;
}

function compareItems(sectionTitle, oldItems, newItems) {
  const changes = [];
  const matchedOld = new Set();
  const matchedNew = new Set();

  for (let oldIndex = 0; oldIndex < oldItems.length; oldIndex += 1) {
    const oldItem = oldItems[oldIndex];
    const newIndex = newItems.findIndex((candidate, index) => (
      !matchedNew.has(index)
      && normalizeText(candidate.title) === normalizeText(oldItem.title)
    ));
    if (newIndex === -1) continue;
    matchedOld.add(oldIndex);
    matchedNew.add(newIndex);
    const newItem = newItems[newIndex];
    const oldHref = canonicalHref(oldItem.href);
    const newHref = canonicalHref(newItem.href);
    if (oldHref !== newHref || Boolean(oldItem.linked) !== Boolean(newItem.linked)) {
      changes.push({
        type: 'item_link_changed',
        section: sectionTitle,
        title: newItem.title,
        old_href: oldItem.href ?? null,
        new_href: newItem.href ?? null,
        old_linked: Boolean(oldItem.linked),
        new_linked: Boolean(newItem.linked),
      });
    }
  }

  for (let oldIndex = 0; oldIndex < oldItems.length; oldIndex += 1) {
    if (matchedOld.has(oldIndex)) continue;
    const oldItem = oldItems[oldIndex];
    const oldHref = canonicalHref(oldItem.href);
    if (!oldHref) continue;
    const newIndex = newItems.findIndex((candidate, index) => (
      !matchedNew.has(index) && canonicalHref(candidate.href) === oldHref
    ));
    if (newIndex === -1) continue;
    matchedOld.add(oldIndex);
    matchedNew.add(newIndex);
    changes.push({
      type: 'item_renamed',
      section: sectionTitle,
      old_title: oldItem.title,
      new_title: newItems[newIndex].title,
      href: newItems[newIndex].href,
    });
  }

  for (let oldIndex = 0; oldIndex < oldItems.length; oldIndex += 1) {
    if (matchedOld.has(oldIndex) || oldIndex >= newItems.length || matchedNew.has(oldIndex)) continue;
    matchedOld.add(oldIndex);
    matchedNew.add(oldIndex);
    changes.push({
      type: 'item_modified',
      section: sectionTitle,
      old_title: oldItems[oldIndex].title,
      new_title: newItems[oldIndex].title,
      old_href: oldItems[oldIndex].href ?? null,
      new_href: newItems[oldIndex].href ?? null,
    });
  }

  for (let oldIndex = 0; oldIndex < oldItems.length; oldIndex += 1) {
    if (matchedOld.has(oldIndex)) continue;
    changes.push({ type: 'item_removed', section: sectionTitle, item: oldItems[oldIndex] });
  }
  for (let newIndex = 0; newIndex < newItems.length; newIndex += 1) {
    if (matchedNew.has(newIndex)) continue;
    changes.push({ type: 'item_added', section: sectionTitle, item: newItems[newIndex] });
  }

  const oldOrder = oldItems.map(itemIdentity);
  const newOrder = newItems.map(itemIdentity);
  if (oldOrder.length === newOrder.length
      && oldOrder.every((id) => newOrder.includes(id))
      && oldOrder.some((id, index) => id !== newOrder[index])) {
    changes.push({ type: 'item_order_changed', section: sectionTitle });
  }

  return changes;
}

export function compareInventories(previous, current) {
  const changes = [];
  const oldSections = previous?.sections ?? [];
  const newSections = current?.sections ?? [];
  const matchedOld = new Set();
  const matchedNew = new Set();

  for (let oldIndex = 0; oldIndex < oldSections.length; oldIndex += 1) {
    const oldSection = oldSections[oldIndex];
    const newIndex = newSections.findIndex((candidate, index) => (
      !matchedNew.has(index)
      && normalizeText(candidate.title) === normalizeText(oldSection.title)
    ));
    if (newIndex === -1) continue;
    matchedOld.add(oldIndex);
    matchedNew.add(newIndex);
    changes.push(...compareItems(newSections[newIndex].title, oldSection.items, newSections[newIndex].items));
  }

  for (let oldIndex = 0; oldIndex < oldSections.length; oldIndex += 1) {
    if (matchedOld.has(oldIndex)) continue;
    const match = findBestSectionRename(oldSections[oldIndex], newSections, matchedNew);
    if (!match) continue;
    matchedOld.add(oldIndex);
    matchedNew.add(match.index);
    const oldSection = oldSections[oldIndex];
    const newSection = newSections[match.index];
    changes.push({ type: 'section_renamed', old_title: oldSection.title, new_title: newSection.title });
    changes.push(...compareItems(newSection.title, oldSection.items, newSection.items));
  }

  for (let oldIndex = 0; oldIndex < oldSections.length; oldIndex += 1) {
    if (!matchedOld.has(oldIndex)) changes.push({ type: 'section_removed', section: oldSections[oldIndex] });
  }
  for (let newIndex = 0; newIndex < newSections.length; newIndex += 1) {
    if (!matchedNew.has(newIndex)) changes.push({ type: 'section_added', section: newSections[newIndex] });
  }

  const oldOrder = oldSections.map((section) => normalizeText(section.title));
  const newOrder = newSections.map((section) => normalizeText(section.title));
  if (oldOrder.length === newOrder.length
      && oldOrder.every((title) => newOrder.includes(title))
      && oldOrder.some((title, index) => title !== newOrder[index])) {
    changes.push({ type: 'section_order_changed' });
  }

  return changes;
}

function formatLocalTime(date) {
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

function summarizeChanges(changes) {
  if (!changes.length) return 'no changes; no issues running.';
  const counts = changes.reduce((map, change) => {
    map[change.type] = (map[change.type] ?? 0) + 1;
    return map;
  }, {});
  return `changes detected: ${Object.entries(counts).map(([type, count]) => `${count} ${type}`).join(', ')}.`;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function appendJsonLine(filePath, value) {
  await appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

async function extractInventory(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value ?? '')
      .normalize('NFKC')
      .replace(/\u00a0/g, ' ')
      .replace(/[\t\r\n ]+/g, ' ')
      .trim();
    const sectionPattern = /^(?:[A-Z][a-z]+\s+\d{1,2},\s+\d{4}\s*[-–]\s*(?:REGULAR|SPECIAL).*MEETING|Past Fiscal Court Meetings)$/i;
    const all = [...document.body.querySelectorAll('*')];
    const marker = all.find((element) => normalize(element.innerText) === 'Magistrate Materials for Meetings');
    if (!marker) throw new Error('The Magistrate Materials for Meetings heading was not found.');
    const markerIndex = all.indexOf(marker);
    const footerIndex = all.findIndex((element, index) => (
      index > markerIndex && /^©\s*2026\s+Oldham County Fiscal Court/i.test(normalize(element.innerText))
    ));
    const endIndex = footerIndex === -1 ? all.length : footerIndex;

    const sectionMarkers = [];
    for (let index = markerIndex + 1; index < endIndex; index += 1) {
      const element = all[index];
      const text = normalize(element.innerText);
      if (!sectionPattern.test(text)) continue;
      const previous = sectionMarkers.at(-1);
      if (!previous || previous.title !== text) sectionMarkers.push({ title: text, index });
    }
    if (!sectionMarkers.length) throw new Error('No meeting sections were found after the materials heading.');

    const sections = sectionMarkers.map((section) => ({ title: section.title, items: [] }));
    const listItems = all
      .map((element, index) => ({ element, index }))
      .filter(({ element, index }) => element.tagName === 'LI' && index > markerIndex && index < endIndex);

    for (const { element, index } of listItems) {
      let sectionIndex = -1;
      for (let candidate = 0; candidate < sectionMarkers.length; candidate += 1) {
        if (sectionMarkers[candidate].index < index) sectionIndex = candidate;
        else break;
      }
      if (sectionIndex === -1) continue;
      const title = normalize(element.innerText);
      if (!title) continue;
      const anchor = element.querySelector('a[href]');
      const href = anchor ? new URL(anchor.getAttribute('href'), location.href).href : null;
      let filename = null;
      if (href) {
        const last = new URL(href).pathname.split('/').filter(Boolean).at(-1) ?? '';
        try { filename = decodeURIComponent(last); } catch { filename = last; }
      }
      sections[sectionIndex].items.push({ title, linked: Boolean(anchor), href, filename });
    }

    const nonEmptySections = sections.filter((section) => section.items.length > 0);
    const linkedCount = nonEmptySections.reduce(
      (sum, section) => sum + section.items.filter((item) => item.linked && item.href).length,
      0,
    );
    if (!nonEmptySections.length) throw new Error('Meeting sections were found, but no list items were extracted.');
    if (linkedCount < 5) throw new Error(`Only ${linkedCount} document links were extracted; the page may be incomplete.`);
    if (footerIndex === -1) throw new Error('The page footer was not found, so a complete page load could not be verified.');

    return {
      page_title: document.title,
      page_url: location.href,
      sections: nonEmptySections,
    };
  });
}

async function captureDiagnostics(page, label) {
  await mkdir(DIAGNOSTICS_DIR, { recursive: true });
  const safeLabel = label.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
  await Promise.allSettled([
    page.screenshot({ path: path.join(DIAGNOSTICS_DIR, `${safeLabel}.png`), fullPage: true }),
    page.content().then((html) => writeFile(path.join(DIAGNOSTICS_DIR, `${safeLabel}.html`), html, 'utf8')),
  ]);
}

async function runMonitor() {
  const checkedAt = new Date();
  const checkedAtUtc = checkedAt.toISOString();
  const checkedAtLocal = formatLocalTime(checkedAt);
  let browser;
  let page;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      locale: 'en-US',
      timezoneId: 'America/New_York',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 OldhamMagistrateMonitor/1.0',
    });
    page = await context.newPage();
    const response = await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (!response) throw new Error('Navigation returned no HTTP response.');
    if (!response.ok()) throw new Error(`The page returned HTTP ${response.status()} ${response.statusText()}.`);
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await page.waitForFunction(
      () => document.body?.innerText?.includes('Magistrate Materials for Meetings'),
      { timeout: 30_000 },
    );

    const extracted = await extractInventory(page);
    const inventory = {
      monitor: 'oldham-magistrate-documents',
      url: TARGET_URL,
      captured_at_utc: checkedAtUtc,
      source: 'GitHub Actions Playwright browser',
      page_title: extracted.page_title,
      final_url: extracted.page_url,
      sections: extracted.sections,
    };
    const previous = await readJson(CURRENT_PATH);
    const changes = compareInventories(previous, inventory);
    const changed = changes.length > 0;
    const counts = countInventory(inventory);
    const summary = summarizeChanges(changes);
    const logLine = `Ran at ${checkedAtLocal} — ${summary}`;
    const status = {
      monitor: inventory.monitor,
      url: TARGET_URL,
      success: true,
      changed,
      summary,
      log_entry: logLine,
      checked_at_utc: checkedAtUtc,
      checked_at_local: checkedAtLocal,
      counts,
      changes,
    };

    if (changed) await captureDiagnostics(page, `change-${checkedAtUtc}`);
    await writeJson(CURRENT_PATH, inventory);
    await writeJson(STATUS_PATH, status);
    await writeFile(LATEST_LOG_PATH, `${logLine}\n`, 'utf8');
    await appendJsonLine(RUNS_PATH, status);
    if (changed) await appendJsonLine(CHANGES_PATH, status);
    console.log(logLine);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (page) await captureDiagnostics(page, `failure-${checkedAtUtc}`);
    const summary = `check failed: ${message} Changes could not be determined.`;
    const logLine = `Ran at ${checkedAtLocal} — ${summary}`;
    const status = {
      monitor: 'oldham-magistrate-documents',
      url: TARGET_URL,
      success: false,
      changed: null,
      summary,
      log_entry: logLine,
      checked_at_utc: checkedAtUtc,
      checked_at_local: checkedAtLocal,
      counts: null,
      changes: null,
    };
    await writeJson(STATUS_PATH, status);
    await writeFile(LATEST_LOG_PATH, `${logLine}\n`, 'utf8');
    await appendJsonLine(RUNS_PATH, status);
    console.error(logLine);
    process.exitCode = 1;
  } finally {
    await browser?.close();
  }
}

async function selfTest() {
  const base = {
    sections: [
      { title: 'July 21, 2026 - REGULAR MEETING', items: [
        { title: 'Agenda', linked: true, href: 'https://example.test/agenda.pdf', filename: 'agenda.pdf' },
        { title: 'Minutes', linked: false, href: null, filename: null },
      ] },
    ],
  };
  const identical = structuredClone(base);
  const renamed = structuredClone(base);
  renamed.sections[0].items[0].title = 'Meeting Agenda';
  const added = structuredClone(base);
  added.sections[0].items.push({ title: 'Payables', linked: true, href: 'https://example.test/payables.pdf', filename: 'payables.pdf' });
  const linked = structuredClone(base);
  linked.sections[0].items[1] = { title: 'Minutes', linked: true, href: 'https://example.test/minutes.pdf', filename: 'minutes.pdf' };

  const assertions = [
    [compareInventories(base, identical).length === 0, 'identical inventories should have no changes'],
    [compareInventories(base, renamed).some((change) => change.type === 'item_renamed'), 'rename should be detected'],
    [compareInventories(base, added).some((change) => change.type === 'item_added'), 'addition should be detected'],
    [compareInventories(base, linked).some((change) => change.type === 'item_link_changed'), 'link addition should be detected'],
  ];
  const failed = assertions.filter(([pass]) => !pass).map(([, description]) => description);
  if (failed.length) throw new Error(`Self-test failed: ${failed.join('; ')}`);
  console.log('Self-test passed.');
}

if (process.argv.includes('--self-test')) await selfTest();
else await runMonitor();
