import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildManifestEntry,
  diffObservations,
  parseObservations,
  recordRevisions
} from '../scripts/vwl-snapshot-core.mjs';

const DETECTED_AT = '2026-12-01T06:00:00.000Z';
const LATER_DETECTED_AT = '2027-01-01T06:00:00.000Z';
const LATEST_FILE = 'nama_10_pc/latest.json';
const SERIES_KEY = 'freq=A&unit=CP_EUR_HAB&na_item=B1GQ&geo=DE';
const DEFINITION = {
  key: 'nama_10_pc',
  code: 'nama_10_pc',
  indicators: ['gdpPerCapita'],
  filters: { unit: 'CP_EUR_HAB', na_item: 'B1GQ' }
};
const HISTORY = {
  file: 'nama_10_pc/history.json',
  fromYear: 2000,
  toYear: 2024,
  retrievedAt: '2026-11-24T15:12:00.353Z'
};
const LATEST = {
  file: LATEST_FILE,
  fromYear: 2025,
  toYear: 2025,
  retrievedAt: DETECTED_AT
};

function jsonStat({ value = 54240, time = '2025', geo = 'DE' } = {}) {
  return {
    version: '2.0',
    class: 'dataset',
    label: 'BIP pro Kopf – Test',
    id: ['freq', 'unit', 'na_item', 'geo', 'time'],
    size: [1, 1, 1, 1, 1],
    dimension: {
      freq: { category: { index: { A: 0 } } },
      unit: { category: { index: { CP_EUR_HAB: 0 } } },
      na_item: { category: { index: { B1GQ: 0 } } },
      geo: { category: { index: { [geo]: 0 } } },
      time: { category: { index: { [time]: 0 } } }
    },
    value: { 0: value }
  };
}

test('parseObservations liest die 2025-Beobachtung samt Serienkennung', () => {
  const { observations, years } = parseObservations(jsonStat({ value: 54240 }));
  assert.deepEqual(years, [2025]);
  assert.deepEqual([...observations.values()], [
    { series: SERIES_KEY, time: '2025', value: 54240 }
  ]);
});

test('künstlich geänderte 2025-Beobachtung erzeugt Revision und sichtbare Manifest-Marke', () => {
  const before = parseObservations(jsonStat({ value: 54240 }));
  const after = parseObservations(jsonStat({ value: 54250 }));

  const changes = diffObservations(before, after);
  assert.deepEqual(changes, [
    { series: SERIES_KEY, time: '2025', oldValue: 54240, newValue: 54250 }
  ]);

  const revisions = { schemaVersion: 1, files: {} };
  recordRevisions(revisions, LATEST_FILE, changes, DETECTED_AT);

  assert.equal(revisions.files[LATEST_FILE].count, 1);
  assert.equal(revisions.files[LATEST_FILE].lastDetectedAt, DETECTED_AT);
  assert.deepEqual(revisions.files[LATEST_FILE].changes, [
    {
      series: SERIES_KEY,
      time: '2025',
      oldValue: 54240,
      newValue: 54250,
      detectedAt: DETECTED_AT
    }
  ]);

  const entry = buildManifestEntry(DEFINITION, HISTORY, LATEST, 'https://example.test/manifest.json', revisions);
  assert.equal(entry.revisions.file, 'revisions.json');
  assert.equal(entry.revisions.count, 1);
  assert.equal(entry.revisions.lastDetectedAt, DETECTED_AT);
  assert.deepEqual(entry.revisions.entries, [{ label: LATEST_FILE, count: 1 }]);
});

test('unveränderte Beobachtung und neues Jahr erzeugen keine Revision', () => {
  const unchanged = diffObservations(
    parseObservations(jsonStat({ value: 54240 })),
    parseObservations(jsonStat({ value: 54240 }))
  );
  assert.deepEqual(unchanged, []);

  const newYear = diffObservations(
    parseObservations(jsonStat({ value: 52530, time: '2024' })),
    parseObservations(jsonStat({ value: 54240, time: '2025' }))
  );
  assert.deepEqual(newYear, []);

  const revisions = { schemaVersion: 1, files: {} };
  const entry = buildManifestEntry(DEFINITION, HISTORY, LATEST, 'https://example.test/manifest.json', revisions);
  assert.equal(entry.revisions.count, 0);
  assert.equal(entry.revisions.lastDetectedAt, null);
  assert.deepEqual(entry.revisions.entries, []);
});

test('Revisionen werden je Datei gezählt und nicht über Dateien quersummiert', () => {
  const revisions = { schemaVersion: 1, files: {} };
  recordRevisions(
    revisions,
    'gdpComponents/latest.json',
    [{ series: SERIES_KEY, time: '2025', oldValue: 1, newValue: 2 }],
    DETECTED_AT
  );
  recordRevisions(
    revisions,
    'gdpReal/latest.json',
    [{ series: SERIES_KEY, time: '2025', oldValue: 1, newValue: 2 }],
    LATER_DETECTED_AT
  );

  const entry = buildManifestEntry(
    { ...DEFINITION, key: 'gdpComponents', code: 'nama_10_gdp' },
    { file: 'gdpComponents/history.json', fromYear: 2000, toYear: 2024, retrievedAt: DETECTED_AT },
    { file: 'gdpComponents/latest.json', fromYear: 2025, toYear: 2025, retrievedAt: DETECTED_AT },
    'https://example.test/manifest.json',
    revisions
  );

  assert.equal(entry.revisions.count, 1);
  assert.equal(entry.revisions.lastDetectedAt, DETECTED_AT);
  assert.deepEqual(entry.revisions.entries, [{ label: 'gdpComponents/latest.json', count: 1 }]);
  // Die zweite Datei gehört zu einem anderen Manifest-Eintrag und darf hier
  // weder als Zahl noch als Eintrag auftauchen.
  assert.equal(entry.revisions.entries.some((revision) => revision.label === 'gdpReal/latest.json'), false);
});
