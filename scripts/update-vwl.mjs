#!/usr/bin/env node
/*
 * Erzeugt die VWL-Rohdatensnapshots für die BundesStat-App.
 *
 * Die Dateien sind unveränderte Eurostat-JSON-stat-Antworten. Die Historie
 * wird einmalig bis 2024 eingefroren; ab 2025 wird monatlich neu geladen.
 * Änderungen an bereits gespeicherten Beobachtungen werden in
 * `revisions.json` mit altem Wert, neuem Wert und Erkennungszeitpunkt
 * protokolliert. Es wird nichts interpoliert, geschätzt oder summiert.
 *
 * Aufruf:
 *   node scripts/update-vwl.mjs --out .
 *   node scripts/update-vwl.mjs --out . --refresh-history
 *
 * Die Definitionen spiegeln `src/core/services/economics.js` der App. Wenn
 * dort Reihen oder Filter geändert werden, müssen sie hier nachgezogen
 * werden; das Manifest beschreibt danach die neue Auswahl.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildManifestEntry,
  diffObservations,
  normalizeText,
  parseObservations,
  recordRevisions,
  yearBounds
} from './vwl-snapshot-core.mjs';

const BASE = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data';
const HISTORY_FROM = '2000';
const HISTORY_THROUGH = 2024;
const LATEST_FROM = 2025;
const USER_AGENT = 'BundesStat-data snapshot builder (+https://github.com/kai1973i/BundesStat-data)';
const MAX_ATTEMPTS = 4;

/*
 * Reihenfolge und Filter entsprechen den kuratierten VWL-Reihen der App:
 * elf Dashboard-Indikatoren, zwei BIP-Ausgangsreihen und drei zusätzliche
 * Mathematik-Reihen. `key` ist der Manifest-Schlüssel; bei den Mathematik-
 * Reihen weicht er bewusst vom Eurostat-Datensatzcode ab, weil derselbe
 * Datensatz mit unterschiedlichen Filtern mehrfach vorkommt.
 */
const DATASETS = [
  { key: 'nama_10_pc', code: 'nama_10_pc', indicators: ['gdpPerCapita'], label: 'BIP pro Kopf', filters: { unit: 'CP_EUR_HAB', na_item: 'B1GQ' } },
  { key: 'une_rt_a', code: 'une_rt_a', indicators: ['unemployment'], label: 'Arbeitslosenquote', filters: { age: 'Y15-74', unit: 'PC_ACT', sex: 'T' } },
  { key: 'prc_hicp_aind', code: 'prc_hicp_aind', indicators: ['inflation'], label: 'Inflation (HVPI)', filters: { unit: 'RCH_A_AVG', coicop: 'CP00' } },
  { key: 'gov_10dd_edpt1', code: 'gov_10dd_edpt1', indicators: ['debtRatio'], label: 'Staatsschuldenquote', filters: { unit: 'PC_GDP', sector: 'S13', na_item: 'GD' } },
  { key: 'lfsa_ergan', code: 'lfsa_ergan', indicators: ['employment'], label: 'Erwerbstätigenquote', filters: { unit: 'PC', sex: 'T', age: 'Y20-64', citizen: 'TOTAL' } },
  { key: 'demo_mlexpec', code: 'demo_mlexpec', indicators: ['lifeExpectancy'], label: 'Lebenserwartung', filters: { unit: 'YR', sex: 'T', age: 'Y_LT1' } },
  { key: 'ilc_di12', code: 'ilc_di12', indicators: ['gini'], label: 'Gini-Koeffizient', filters: { age: 'TOTAL', statinfo: 'GINI_HND' } },
  { key: 'edat_lfse_03', code: 'edat_lfse_03', indicators: ['tertiary'], label: 'Tertiärer Bildungsabschluss', filters: { sex: 'T', age: 'Y25-34', unit: 'PC', isced11: 'ED5-8' } },
  { key: 'env_air_gge', code: 'env_air_gge', indicators: ['emissions'], label: 'Treibhausgasemissionen', filters: { unit: 'MIO_T', airpol: 'GHG', src_crf: 'TOTXMEMO' } },
  { key: 'nrg_ind_ren', code: 'nrg_ind_ren', indicators: ['renewables'], label: 'Erneuerbare Energien', filters: { nrg_bal: 'REN', unit: 'PC' } },
  { key: 'rd_e_gerdtot', code: 'rd_e_gerdtot', indicators: ['rnd'], label: 'Forschung und Entwicklung', filters: { sectperf: 'TOTAL', unit: 'PC_GDP' } },
  { key: 'nama_10_gdp', code: 'nama_10_gdp', indicators: ['gdpTotal'], label: 'BIP zu Marktpreisen', filters: { unit: 'CP_MEUR', na_item: 'B1GQ' } },
  { key: 'nama_10_pe', code: 'nama_10_pe', indicators: ['population'], label: 'Bevölkerung (Nationalkonzept)', filters: { unit: 'THS_PER', na_item: 'POP_NC' } },
  {
    key: 'gdpComponents',
    code: 'nama_10_gdp',
    indicators: ['gdpComponents'],
    label: 'BIP-Verwendungskomponenten',
    filters: {
      unit: 'CP_MEUR',
      na_item: ['B1GQ', 'P31_S14_S15', 'P3_S13', 'P5G', 'P51G', 'P52_P53', 'P6', 'P7']
    }
  },
  { key: 'gdpReal', code: 'nama_10_gdp', indicators: ['gdpReal'], label: 'BIP, verkettete Volumen', filters: { unit: 'CLV20_MEUR', na_item: 'B1GQ' } },
  { key: 'gdpDeflator', code: 'nama_10_gdp', indicators: ['gdpDeflator'], label: 'BIP-Deflator', filters: { unit: 'PD20_EUR', na_item: 'B1GQ' } }
];

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('Aufruf: node scripts/update-vwl.mjs --out <datenrepo> [--refresh-history]');
  process.exit(0);
}
const outDir = path.resolve(args.out || process.cwd());
const vwlDir = path.join(outDir, 'data', 'eurostat', 'vwl');
const now = new Date().toISOString();

await fs.mkdir(vwlDir, { recursive: true });

const manifestPath = path.join(vwlDir, 'manifest.json');
const revisionsPath = path.join(vwlDir, 'revisions.json');
const oldManifest = await readJsonIfExists(manifestPath);
const revisions = (await readJsonIfExists(revisionsPath)) || {
  schemaVersion: 1,
  updatedAt: null,
  files: {}
};
if (!revisions.files || typeof revisions.files !== 'object') revisions.files = {};

let revisionsChanged = !(await exists(revisionsPath));
const manifestDatasets = {};

for (const [index, definition] of DATASETS.entries()) {
  const prefix = `[${String(index + 1).padStart(2, '0')}/${DATASETS.length}] ${definition.key}`;
  const oldEntry = oldManifest?.datasets?.[definition.key] || null;

  // Historie: einmalig bis 2024 einfrieren. Ein vorhandenes history.json wird
  // nicht erneut geladen, damit die historischen Werte unverändert bleiben.
  let history = null;
  let sourceUrl = oldEntry?.sourceUrl || null;
  const historyFile = `${definition.key}/history.json`;
  const historyPath = path.join(vwlDir, historyFile);
  if (!args.refreshHistory && oldEntry?.history?.file && (await exists(historyPath))) {
    history = {
      file: oldEntry.history.file,
      fromYear: oldEntry.history.fromYear,
      toYear: oldEntry.history.toYear,
      retrievedAt: oldEntry.history.retrievedAt
    };
    log(`${prefix}: Historie aus ${history.file} übernommen (${history.fromYear}–${history.toYear}).`);
  } else {
    const url = buildUrl(definition, HISTORY_FROM, String(HISTORY_THROUGH));
    const fetched = await fetchDataset(url);
    const observations = parseObservations(fetched.json);
    if (!observations.years.length) throw new Error(`${definition.key}: Historie enthält keine Werte.`);
    const old = await readJsonIfExists(historyPath);
    if (old) {
      const changes = diffObservations(parseObservations(old), observations);
      if (changes.length) {
        recordRevisions(revisions, historyFile, changes, now);
        revisionsChanged = true;
      }
    }
    await writeText(historyPath, normalizeText(fetched.text));
    history = {
      file: historyFile,
      fromYear: yearBounds(observations.years).from,
      toYear: yearBounds(observations.years).to,
      retrievedAt: now
    };
    sourceUrl = url;
    log(`${prefix}: Historie ${history.fromYear}–${history.toYear} geladen.`);
  }

  // Aktuelle Ergänzung: ab 2025 bei jedem Lauf neu laden. Neue Jahre sind
  // Ergänzungen, keine Revisionen; geänderte bestehende Werte werden
  // protokolliert.
  const latestFile = `${definition.key}/latest.json`;
  const latestPath = path.join(vwlDir, latestFile);
  const latestUrl = buildUrl(definition, String(LATEST_FROM), null);
  const fetchedLatest = await fetchDataset(latestUrl);
  const latestObservations = parseObservations(fetchedLatest.json);
  let latest = oldEntry?.latest || null;
  if (latestObservations.years.length) {
    const oldLatest = await readJsonIfExists(latestPath);
    if (oldLatest) {
      const changes = diffObservations(parseObservations(oldLatest), latestObservations);
      if (changes.length) {
        recordRevisions(revisions, latestFile, changes, now);
        revisionsChanged = true;
        log(`${prefix}: ${changes.length} geänderte Beobachtung(en) protokolliert.`);
      }
    }
    await writeText(latestPath, normalizeText(fetchedLatest.text));
    latest = {
      file: latestFile,
      fromYear: yearBounds(latestObservations.years).from,
      toYear: yearBounds(latestObservations.years).to,
      retrievedAt: now
    };
    log(`${prefix}: aktuelle Ergänzung ${latest.fromYear}–${latest.toYear} geladen.`);
  } else if (latest) {
    log(`${prefix}: keine Werte ab ${LATEST_FROM}; bisherige Ergänzung bleibt erhalten.`);
  } else {
    log(`${prefix}: keine Werte ab ${LATEST_FROM}; keine aktuelle Ergänzung.`);
  }

  manifestDatasets[definition.key] = buildManifestEntry(definition, history, latest, sourceUrl, revisions);
}

const manifest = {
  schemaVersion: 1,
  source: 'Eurostat',
  licence: 'Wiederverwendung mit Quellenangabe (Beschluss 2011/833/EU)',
  historyThrough: HISTORY_THROUGH,
  latestFrom: LATEST_FROM,
  generatedAt: now,
  datasets: manifestDatasets
};
await writeJson(manifestPath, manifest);

if (revisionsChanged || !(await exists(revisionsPath))) {
  revisions.schemaVersion = 1;
  revisions.updatedAt = now;
  await writeJson(revisionsPath, revisions);
}

const fileCount = (await listJsonFiles(vwlDir)).length;
log(`Fertig: ${Object.keys(manifestDatasets).length} Reihen, ${fileCount} JSON-Dateien in ${vwlDir}.`);

function buildUrl(definition, sinceTimePeriod, untilTimePeriod) {
  const params = new URLSearchParams();
  params.set('format', 'JSON');
  params.set('lang', 'DE');
  params.append('geo', 'DE');
  if (sinceTimePeriod) params.set('sinceTimePeriod', String(sinceTimePeriod));
  if (untilTimePeriod) params.set('untilTimePeriod', String(untilTimePeriod));
  for (const [dimension, values] of Object.entries(definition.filters)) {
    for (const value of Array.isArray(values) ? values : [values]) {
      if (value !== null && value !== undefined && value !== '') params.append(dimension, String(value));
    }
  }
  return `${BASE}/${encodeURIComponent(definition.code)}?${params.toString()}`;
}

async function fetchDataset(url) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(90_000)
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 180)}`);
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`Antwort ist kein JSON: ${text.slice(0, 180)}`);
      }
      if (json?.error) {
        throw new Error(`Eurostat meldet: ${json.error.label || json.error.id || 'unbekannt'}`);
      }
      if (!json?.value) throw new Error('Antwort enthält keine Werte.');
      return { text, json };
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        log(`  Abruf fehlgeschlagen (${error.message}); neuer Versuch in ${attempt * 2}s …`);
        await sleep(attempt * 2_000);
      }
    }
  }
  throw new Error(`Eurostat-Abruf endgültig fehlgeschlagen: ${lastError?.message || 'unbekannt'}\n${url}`);
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Kann ${file} nicht lesen: ${error.message}`);
  }
}

async function writeText(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
}

async function writeJson(file, value) {
  await writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function listJsonFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) return listJsonFiles(full);
      return entry.name.endsWith('.json') ? [full] : [];
    })
  );
  return nested.flat();
}

function parseArgs(argv) {
  const parsed = { out: null, refreshHistory: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') parsed.out = argv[++index] || null;
    else if (arg === '--refresh-history') parsed.refreshHistory = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else throw new Error(`Unbekanntes Argument: ${arg}`);
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message) {
  console.log(message);
}
