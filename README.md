# BundesStat-data

Rohdaten-Snapshots für die App **BundesStat – Statistik-Explorer und
Gesetzgebungsprognose**. Dieses Repository enthält keine eigenen Berechnungen
und keine Schätzwerte: Es transportiert unveränderte Antworten der amtlichen
Quellen und dokumentiert, wann sie abgerufen wurden.

## VWL-Snapshots

Die App liest die VWL-Werkstatt und die VWL-Mathematik zuerst aus diesem
Repository und fällt nur bei fehlendem oder ungültigem Snapshot sichtbar auf
den Live-Abruf bei Eurostat zurück.

Basis-URL:

```
https://raw.githubusercontent.com/kai1973i/BundesStat-data/main/data/eurostat/vwl/
```

Struktur:

```
data/eurostat/vwl/
├── manifest.json                  # Reihen, Filter, Dateien, Zeiträume, Revisionen
├── revisions.json                 # protokollierte geänderte Beobachtungen
├── <reihe>/history.json           # eingefrorene Historie bis 2024
└── <reihe>/latest.json            # monatlich aktualisierte Jahre ab 2025
```

Das Manifest hat `schemaVersion: 1`. Jeder Eintrag nennt den Eurostat-
Datensatzcode, die verwendeten Filter, die Quelldateien mit Jahresgrenzen und
Abrufzeitpunkt sowie die Revisionszusammenfassung. Mehrere Einträge dürfen
denselben Datensatzcode mit unterschiedlichen Filtern verwenden (z. B.
`gdpComponents`, `gdpReal` und `gdpDeflator` aus `nama_10_gdp`).

### Reihen

- **11 Dashboard-Indikatoren:** BIP pro Kopf (`nama_10_pc`), Arbeitslosenquote
  (`une_rt_a`), Inflation (`prc_hicp_aind`), Staatsschuldenquote
  (`gov_10dd_edpt1`), Erwerbstätigenquote (`lfsa_ergan`), Lebenserwartung
  (`demo_mlexpec`), Gini (`ilc_di12`), Tertiärbildung (`edat_lfse_03`),
  Treibhausgase (`env_air_gge`), Erneuerbare (`nrg_ind_ren`), FuE
  (`rd_e_gerdtot`).
- **2 BIP-Ausgangsreihen:** BIP gesamt (`nama_10_gdp`) und Bevölkerung nach
  Nationalkonzept (`nama_10_pe`).
- **3 Mathematik-Reihen:** BIP-Verwendungskomponenten, reales BIP (verkettete
  Volumen 2020) und BIP-Deflator aus `nama_10_gdp`.

Die Filter entsprechen `src/core/services/economics.js` der App. Änderungen an
Reihen oder Filtern müssen in `scripts/update-vwl.mjs` nachgezogen werden.

## Aktualisierung

Der Workflow `.github/workflows/update-vwl.yml` läuft am **1. jedes Monats um
06:00 UTC** und kann manuell über „Actions → VWL-Snapshots aktualisieren →
Run workflow“ gestartet werden.

- Die **Historie bis 2024 wird einmalig erzeugt und nicht mehr überschrieben**.
  Sie bleibt damit als Bezugspunkt stabil.
- Die **aktuelle Ergänzung ab 2025** wird bei jedem Lauf neu von Eurostat
  geladen. Neue Jahre sind Ergänzungen; geänderte bestehende Werte werden in
  `revisions.json` mit alter und neuer Beobachtung sowie Erkennungszeitpunkt
  protokolliert.
- Ein unveränderter Lauf erzeugt keine neue Revision. Es wird nichts
  interpoliert, geglättet oder stillschweigend ersetzt.
- Fehlt für eine Reihe ein Wert ab 2025, bleibt die bisherige Ergänzung
  erhalten; die Historie bleibt nutzbar.

Manuell:

```bash
node scripts/update-vwl.mjs --out .
# Historie bewusst neu erzeugen (protokolliert Änderungen):
node scripts/update-vwl.mjs --out . --refresh-history
```

Der Generator benötigt nur Node.js (≥ 20) und Netzwerkzugang; keine
zusätzlichen Pakete.

## Herkunft, Lizenz und Grenzen

- **Quelle:** Eurostat, `https://ec.europa.eu/eurostat`. Die Dateien sind
  unveränderte JSON-stat-Antworten der offiziellen API; Deutschland (`geo=DE`),
  Jahresdaten.
- **Lizenz:** Wiederverwendung mit Quellenangabe gemäß Beschluss 2011/833/EU.
  Attribution: „Quelle: Eurostat, Europäische Union“.
- **Abrufzeitpunkt:** steht je Datei im Manifest; das `updated`-Feld der
  JSON-stat-Antwort bleibt erhalten.
- **Grenzen:** Amtliche Werte können rückwirkend revidiert werden. Die
  eingefrorene Historie bildet den Stand ihrer Erzeugung ab. Fehlende Werte
  bleiben fehlend. Die Snapshots ersetzen keine Eurostat-Metadaten und keine
  eigenen Berechnungen der App.
