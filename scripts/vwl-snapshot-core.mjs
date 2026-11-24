/*
 * Reine Kernfunktionen für den VWL-Snapshot-Generator.
 *
 * Sie werden vom monatlichen Lauf und von den Tests verwendet. Die Funktionen
 * verändern keine Werte: Sie lesen JSON-stat-Antworten, vergleichen
 * Beobachtungen und bauen die Revisionszusammenfassung für das Manifest.
 */

/**
 * Minimaler JSON-stat-Dekoder für Jahresvergleiche. Die App nutzt ihren
 * eigenen Parser; hier werden nur Serienkennung, Zeit und Wert benötigt.
 */
export function parseObservations(json) {
  if (!Array.isArray(json?.id) || !Array.isArray(json?.size) || json.id.length !== json.size.length) {
    throw new Error('JSON-stat: Dimensionsangaben fehlen oder passen nicht zusammen.');
  }
  const ids = json.id;
  const sizes = json.size;
  const codes = ids.map((id) => categoryCodes(json.dimension?.[id]));
  const strides = new Array(sizes.length).fill(1);
  for (let index = sizes.length - 2; index >= 0; index -= 1) {
    strides[index] = strides[index + 1] * sizes[index + 1];
  }
  const timeIndex = ids.indexOf('time');
  if (timeIndex < 0) throw new Error('JSON-stat: Zeitdimension fehlt.');
  const seriesIndices = ids.map((_, index) => index).filter((index) => index !== timeIndex);
  const values = Array.isArray(json.value)
    ? json.value.map((value, index) => [String(index), value])
    : Object.entries(json.value || {});
  const observations = new Map();
  const years = new Set();

  for (const [flatKey, rawValue] of values) {
    const flat = Number(flatKey);
    if (!Number.isInteger(flat) || flat < 0) continue;
    const numeric = rawValue === null || rawValue === undefined || rawValue === '' ? NaN : Number(rawValue);
    if (!Number.isFinite(numeric)) continue;
    const coordinates = {};
    for (let index = 0; index < ids.length; index += 1) {
      coordinates[ids[index]] = Math.floor(flat / strides[index]) % sizes[index];
    }
    const time = codes[timeIndex][coordinates[ids[timeIndex]]];
    if (time === undefined || time === null) continue;
    const series = seriesIndices
      .map((index) => `${ids[index]}=${codes[index][coordinates[ids[index]]] ?? coordinates[ids[index]]}`)
      .join('&');
    const observation = { series, time: String(time), value: numeric };
    observations.set(`${series}|${observation.time}`, observation);
    const year = Number(String(time).slice(0, 4));
    if (Number.isInteger(year)) years.add(year);
  }

  return { observations, years: [...years].sort((left, right) => left - right) };
}

export function categoryCodes(dimension) {
  const index = dimension?.category?.index;
  if (Array.isArray(index)) return index.map(String);
  if (index && typeof index === 'object') {
    const codes = [];
    for (const [code, position] of Object.entries(index)) codes[Number(position)] = String(code);
    return codes;
  }
  return [];
}

/**
 * Liefert nur geänderte, bereits vorhandene Beobachtungen. Ein neues Jahr ist
 * eine Ergänzung und keine Revision; verschwundene Werte werden ebenfalls
 * nicht als Revision ausgegeben.
 */
export function diffObservations(previous, next) {
  const changes = [];
  for (const [key, observation] of next.observations) {
    const before = previous.observations.get(key);
    if (!before) continue;
    if (before.value !== observation.value) {
      changes.push({
        series: observation.series,
        time: observation.time,
        oldValue: before.value,
        newValue: observation.value
      });
    }
  }
  return changes;
}

/**
 * Hängt Änderungen an das Revisionsprotokoll an. Der Zähler wird je Datei
 * geführt; die App bildet daraus eine sichtbare Revisionsmarke.
 */
export function recordRevisions(log, file, changes, detectedAt) {
  const entry = log.files[file] || {
    label: file,
    count: 0,
    lastDetectedAt: null,
    changes: []
  };
  for (const change of changes) {
    entry.changes.push({ ...change, detectedAt });
  }
  entry.count += changes.length;
  entry.lastDetectedAt = detectedAt;
  log.files[file] = entry;
}

/**
 * Baut den Manifest-Eintrag einer Reihe. Die Revisionszusammenfassung nennt
 * nur Dateien mit tatsächlichen Änderungen und niemals eine Quersumme über
 * mehrere Dateien.
 */
export function buildManifestEntry(definition, history, latest, sourceUrl, revisionLog) {
  const files = [history?.file, latest?.file].filter(Boolean);
  const entries = files
    .map((file) => [file, revisionLog.files[file]])
    .filter(([, info]) => Number(info?.count) > 0)
    .map(([file, info]) => ({ label: file, count: Number(info.count) }));
  const count = entries.reduce((sum, entry) => sum + entry.count, 0);
  const dates = files
    .map((file) => revisionLog.files[file]?.lastDetectedAt)
    .filter(Boolean)
    .sort();
  return {
    indicators: definition.indicators,
    code: definition.code,
    query: { filters: definition.filters },
    sourceUrl: sourceUrl || null,
    history: history || null,
    latest: latest || null,
    revisions: {
      file: 'revisions.json',
      count,
      lastDetectedAt: dates[dates.length - 1] || null,
      entries
    }
  };
}

export function yearBounds(years) {
  const sorted = [...new Set(years)].sort((left, right) => left - right);
  return { from: sorted[0], to: sorted[sorted.length - 1] };
}

export function normalizeText(text) {
  const trimmed = String(text).replace(/^\uFEFF/, '').trimEnd();
  return `${trimmed}\n`;
}
