const Database = require('better-sqlite3');
const db = new Database('data/scraper.db');

const cols = db.prepare("PRAGMA table_info(businesses)").all().map(c => c.name).filter(c => c.startsWith('loc_'));
console.log('loc_ columns:', cols);

const enriched = db.prepare("SELECT COUNT(*) as n FROM businesses WHERE location_enriched=1").get();
console.log('Enriched rows:', enriched);

const hasLatLon = db.prepare("SELECT COUNT(*) as n FROM businesses WHERE latitude IS NOT NULL AND longitude IS NOT NULL").get();
console.log('Has lat/lon:', hasLatLon);