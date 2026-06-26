/**
 * One-time GeoNames import (slice 0038). Bulk-loads the cities1000 tier into the
 * geo_places table backing the area autocomplete. Data © GeoNames, CC-BY 4.0
 * (https://www.geonames.org/) — attribution surfaced in the UI.
 *
 * Setup (download + unzip once into env.GEONAMES_DATA_DIR, default ./data/geonames):
 *   https://download.geonames.org/export/dump/cities1000.zip        -> cities1000.txt
 *   https://download.geonames.org/export/dump/admin1CodesASCII.txt  (as-is)
 *
 * Run:
 *   docker compose exec server sh -c "cd /app/server && npx tsx src/scripts/importGeonames.ts"
 *
 * ponytail: reads pre-unzipped TSVs (operator unzips once); avoids a zip dep.
 */
import fs from 'fs';
import path from 'path';
import { sqlite } from '../db';
import { geoPlacesCount } from '../db/geo';
import { env } from '../env';

const dir = path.isAbsolute(env.GEONAMES_DATA_DIR)
  ? env.GEONAMES_DATA_DIR
  : path.resolve(__dirname, '../../..', env.GEONAMES_DATA_DIR);

const citiesPath = path.join(dir, 'cities1000.txt');
const admin1Path = path.join(dir, 'admin1CodesASCII.txt');

if (!fs.existsSync(citiesPath)) {
  console.error(`❌ Missing ${citiesPath}. Download + unzip cities1000.zip into ${dir}.`);
  process.exit(1);
}

// admin1CodesASCII.txt: "<country>.<admin1code>\t<name>\t<asciiName>\t<geonameid>"
// → map "US.FL" -> "Florida" so the autocomplete shows state/province names.
const admin1: Record<string, string> = {};
if (fs.existsSync(admin1Path)) {
  for (const line of fs.readFileSync(admin1Path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const [code, , asciiName] = line.split('\t');
    if (code && asciiName) admin1[code] = asciiName;
  }
  console.log(`Loaded ${Object.keys(admin1).length} admin1 names`);
} else {
  console.warn(`⚠ ${admin1Path} not found — admin1 will be the raw code.`);
}

// GeoNames main dump columns (tab-separated, no header):
// 0 geonameid 1 name 2 asciiname 3 alternatenames 4 lat 5 lon 6 fclass 7 fcode
// 8 country 9 cc2 10 admin1code 11 admin2 12 admin3 13 admin4 14 population ...
const insert = sqlite.prepare(`
  INSERT INTO geo_places (geoname_id, name, ascii_name, admin1, country, population, lat, lon)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(geoname_id) DO UPDATE SET
    name = excluded.name, ascii_name = excluded.ascii_name, admin1 = excluded.admin1,
    country = excluded.country, population = excluded.population,
    lat = excluded.lat, lon = excluded.lon
`);

const lines = fs.readFileSync(citiesPath, 'utf8').split('\n');
let n = 0;
const tx = sqlite.transaction(() => {
  for (const line of lines) {
    if (!line.trim()) continue;
    const c = line.split('\t');
    const geonameId = parseInt(c[0], 10);
    const lat = parseFloat(c[4]);
    const lon = parseFloat(c[5]);
    if (!Number.isFinite(geonameId) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const country = c[8] || null;
    const a1code = country && c[10] ? `${country}.${c[10]}` : '';
    const admin1Name = admin1[a1code] ?? c[10] ?? null;
    insert.run(
      geonameId,
      c[1] || c[2] || 'Unknown',
      c[2] || c[1] || 'unknown',
      admin1Name,
      country,
      parseInt(c[14], 10) || 0,
      lat,
      lon,
    );
    n++;
  }
});
tx();

console.log(`✓ Imported ${n} places. geo_places now holds ${geoPlacesCount()} rows.`);
