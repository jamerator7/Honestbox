// HonestBox data layer: one SQLite file, created and seeded on first use.
// Money is always stored in integer cents. Odds are stored in parts per million (ppm).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hashPassword } from './password.ts';
import { randomBytes } from 'node:crypto';

const DB_PATH = resolve(process.env.HB_DB_PATH || 'data/honestbox.db');

type G = { __hbdb?: DatabaseSync };
const g = globalThis as unknown as G;

export function db(): DatabaseSync {
  if (!g.__hbdb) {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    const d = new DatabaseSync(DB_PATH);
    d.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    migrate(d);
    seedIfEmpty(d);
    ensureAdmin(d);
    fillReferralCodes(d);
    g.__hbdb = d;
  }
  return g.__hbdb;
}

/** Run fn inside one write transaction; rolls back on any error. */
export function tx<T>(fn: (d: DatabaseSync) => T): T {
  const d = db();
  d.exec('BEGIN IMMEDIATE');
  try {
    const out = fn(d);
    d.exec('COMMIT');
    return out;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

export const now = () => new Date().toISOString();

function migrate(d: DatabaseSync) {
  d.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    state TEXT NOT NULL,
    id_verified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL
  );
  -- Every change to a user's HonestBox credit is one signed row. Balance = SUM(amount_cents).
  CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    memo TEXT NOT NULL,
    ref TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS boxes (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    numeral TEXT NOT NULL,
    tagline TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS bands (
    id INTEGER PRIMARY KEY,
    box_id INTEGER NOT NULL REFERENCES boxes(id),
    label TEXT NOT NULL,
    value_cents INTEGER NOT NULL,
    odds_ppm INTEGER NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS watches (
    id INTEGER PRIMARY KEY,
    brand TEXT NOT NULL,
    model TEXT NOT NULL,
    reference TEXT NOT NULL DEFAULT '',
    year INTEGER,
    size_mm INTEGER,
    condition TEXT NOT NULL DEFAULT 'Very good',
    papers TEXT NOT NULL DEFAULT 'Box and papers',
    market_cents INTEGER NOT NULL,
    cost_cents INTEGER NOT NULL,
    sales_count INTEGER NOT NULL DEFAULT 0,
    sales_low_cents INTEGER,
    sales_high_cents INTEGER,
    -- stock: in a box band, waiting in the vault, pulled by a customer, in a drop, shipped or sold
    status TEXT NOT NULL DEFAULT 'vault',
    band_id INTEGER REFERENCES bands(id),
    authenticated INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  -- Photos: model photos are keyed by exact reference number (watch_id NULL); piece photos belong to one watch.
  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY,
    reference TEXT NOT NULL,
    watch_id INTEGER REFERENCES watches(id),
    angle TEXT NOT NULL DEFAULT 'dial',
    file TEXT NOT NULL,
    thumb TEXT NOT NULL,
    width INTEGER, height INTEGER,
    sort INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS photos_ref ON photos(reference, watch_id, sort);
  -- Provably fair seeds: the server seed's SHA-256 hash is shown before any pull; the seed itself is revealed on rotation.
  CREATE TABLE IF NOT EXISTS seeds (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    server_seed TEXT NOT NULL,
    server_hash TEXT NOT NULL,
    client_seed TEXT NOT NULL,
    next_nonce INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    revealed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS pulls (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    box_id INTEGER NOT NULL REFERENCES boxes(id),
    band_id INTEGER NOT NULL REFERENCES bands(id),
    watch_id INTEGER NOT NULL REFERENCES watches(id),
    price_cents INTEGER NOT NULL,
    value_cents INTEGER NOT NULL,
    seed_id INTEGER NOT NULL REFERENCES seeds(id),
    nonce INTEGER NOT NULL,
    roll_ppm INTEGER NOT NULL,
    odds_snapshot TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'vault',
    hold_until TEXT NOT NULL,
    revealed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS buybacks (
    id INTEGER PRIMARY KEY,
    pull_id INTEGER NOT NULL UNIQUE REFERENCES pulls(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    method TEXT NOT NULL,
    rate_bp INTEGER NOT NULL,
    amount_cents INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE TABLE IF NOT EXISTS shipments (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    watch_id INTEGER NOT NULL REFERENCES watches(id),
    source TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    line1 TEXT NOT NULL,
    line2 TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL,
    state TEXT NOT NULL,
    zip TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'requested',
    tracking TEXT,
    created_at TEXT NOT NULL,
    shipped_at TEXT
  );
  CREATE TABLE IF NOT EXISTS drops (
    id INTEGER PRIMARY KEY,
    number INTEGER NOT NULL UNIQUE,
    title TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS drop_items (
    id INTEGER PRIMARY KEY,
    drop_id INTEGER NOT NULL REFERENCES drops(id),
    watch_id INTEGER NOT NULL UNIQUE REFERENCES watches(id),
    price_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'available',
    held_by INTEGER REFERENCES users(id),
    held_until TEXT,
    sold_to INTEGER REFERENCES users(id),
    sold_at TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY,
    actor_id INTEGER,
    action TEXT NOT NULL,
    detail TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  -- Two-level affiliate commissions. Held as pending until the clearing period ends, then posted to the ledger as credit.
  CREATE TABLE IF NOT EXISTS commissions (
    id INTEGER PRIMARY KEY,
    earner_id INTEGER NOT NULL REFERENCES users(id),
    buyer_id INTEGER NOT NULL REFERENCES users(id),
    pull_id INTEGER NOT NULL REFERENCES pulls(id),
    level INTEGER NOT NULL,
    rate_bp INTEGER NOT NULL,
    amount_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    available_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_comm_earner ON commissions(earner_id, status);
  CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id);
  CREATE INDEX IF NOT EXISTS idx_pulls_user ON pulls(user_id);
  CREATE INDEX IF NOT EXISTS idx_pulls_box ON pulls(box_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_watches_band ON watches(band_id, status);
  `);
  // Columns added after the first release.
  const cols = (d.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('referral_code')) d.exec(`ALTER TABLE users ADD COLUMN referral_code TEXT`);
  if (!cols.includes('referred_by')) d.exec(`ALTER TABLE users ADD COLUMN referred_by INTEGER REFERENCES users(id)`);
  d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_ref ON users(referral_code)`);
  const pcols = (d.prepare(`PRAGMA table_info(pulls)`).all() as { name: string }[]).map((c) => c.name);
  if (!pcols.includes('locked_cents')) d.exec(`ALTER TABLE pulls ADD COLUMN locked_cents INTEGER`);
  if (!pcols.includes('locked_at')) d.exec(`ALTER TABLE pulls ADD COLUMN locked_at TEXT`);
}

/**
 * Creates the admin account once. On a hosted server (Render sets RENDER) the password must come from
 * HB_ADMIN_PASSWORD; there is no default, so a public site never runs with the sample password.
 * Locally, without the variable, the sample password from the README is used.
 */
function ensureAdmin(d: DatabaseSync) {
  if (d.prepare(`SELECT 1 FROM users WHERE role = 'admin'`).get()) return;
  const pw = process.env.HB_ADMIN_PASSWORD || (process.env.RENDER ? '' : 'honest-abe-1860');
  if (pw.length < 12) {
    if (process.env.RENDER) console.warn('HonestBox: no admin account yet. Set HB_ADMIN_PASSWORD (12+ characters) in Render, then restart.');
    return;
  }
  d.prepare(`INSERT INTO users(email, name, pass_hash, role, state, id_verified, created_at) VALUES (?,?,?,?,?,?,?)`)
    .run('admin@honestbox.test', 'HonestBox Admin', hashPassword(pw), 'admin', 'TX', 1, now());
}

function fillReferralCodes(d: DatabaseSync) {
  const missing = d.prepare(`SELECT id FROM users WHERE referral_code IS NULL`).all() as { id: number }[];
  for (const u of missing) d.prepare(`UPDATE users SET referral_code = ? WHERE id = ?`).run(newReferralCode(d), u.id);
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newReferralCode(d: DatabaseSync): string {
  for (;;) {
    const bytes = randomBytes(6);
    const code = Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
    if (!d.prepare('SELECT 1 FROM users WHERE referral_code = ?').get(code)) return code;
  }
}

export const DEFAULT_SETTINGS: Record<string, string> = {
  boxes_enabled: '1',           // master switch for mystery boxes (attorney gate)
  real_money: '0',              // 0 = test mode: no real payments, "Add test credit" is available
  buyback_credit_bp: '9000',    // 90% of market value as HonestBox credit
  buyback_cash_bp: '8500',      // 85% of market value as cash
  cash_id_threshold_cents: '250000', // cash payouts over $2,500 need a verified ID
  hold_days: '180',             // days a pull can sit in a customer's vault; at the end it is sold back for credit at that day's value
  lock_enabled: '1',            // customers may lock in today's value instead of floating with the market
  drop_hold_minutes: '10',
  excluded_states: 'WA,ID,MI,NV,CT', // placeholder list until the attorney's opinion
  min_age: '18',
  ship_fee_cents: '1500',           // shipping fee charged on pulls worth less than the threshold below
  ship_fee_under_cents: '25000',    // pulls under $250 pay the fee; pulls at or above ship free
  aff_l1_bp: '500',                 // level 1: 5% of a referred customer's box purchases
  aff_l2_bp: '100',                 // level 2: 1% on customers referred by your referrals
  aff_window_days: '90',            // commissions only on a customer's first 90 days
  aff_clear_days: '30',             // commissions become spendable credit after 30 days
  aff_monthly_cap_cents: '250000',  // most any one affiliate can earn in a calendar month
};

function seedIfEmpty(d: DatabaseSync) {
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    d.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)').run(k, v);
  }
  const has = d.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  if (has.n > 0) return;
  const t = now();
  d.exec('BEGIN');
  try {
    const demo = d.prepare(`INSERT INTO users(email, name, pass_hash, role, state, id_verified, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run('demo@honestbox.test', 'Demo Collector', hashPassword('demo-1234'), 'user', 'TX', 0, t);
    d.prepare(`INSERT INTO ledger(user_id, kind, amount_cents, memo, created_at) VALUES (?,?,?,?,?)`)
      .run(demo.lastInsertRowid, 'test_credit', 250000, 'Test credit (no real money)', t);

    const box = d.prepare(`INSERT INTO boxes(slug, name, numeral, tagline, price_cents, sort) VALUES (?,?,?,?,?,?)`);
    const band = d.prepare(`INSERT INTO bands(box_id, label, value_cents, odds_ppm, sort) VALUES (?,?,?,?,?)`);
    const watch = d.prepare(`INSERT INTO watches(brand, model, reference, year, size_mm, condition, papers, market_cents, cost_cents, sales_count, sales_low_cents, sales_high_cents, status, band_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    // Watch catalog: sample pre-owned values in cents, placeholders until live market data is connected.
    const W: Record<string, [string, string, string, number, number, number]> = {
      scout: ["Timex", "Expedition Scout", "TW4B11900", 2024, 40, 5000],
      gshock: ["Casio", "G-Shock DW5600", "DW5600E-1V", 2024, 43, 6000],
      weekender: ["Timex", "Weekender Chronograph", "TW2R42600", 2023, 40, 7000],
      snk: ["Seiko", "5 SNK809", "SNK809", 2021, 37, 11000],
      kamasu: ["Orient", "Kamasu", "RA-AA0003R", 2023, 42, 15800],
      mako: ["Orient", "Mako III", "RA-AA0008L", 2023, 41, 17000],
      marlin: ["Timex", "Marlin Automatic", "TW2T23000", 2022, 40, 19000],
      seiko5: ["Seiko", "5 Sports", "SRPD55", 2023, 42, 22000],
      promaster: ["Citizen", "Promaster Dive", "BN0151-09L", 2022, 44, 22500],
      presage: ["Seiko", "Presage Cocktail Time", "SRPB43", 2022, 41, 29500],
      tsuyosa: ["Citizen", "Tsuyosa", "NJ0150-56W", 2023, 40, 32000],
      turtle: ["Seiko", "Prospex Turtle", "SRPE93", 2022, 45, 33000],
      orientstar: ["Orient Star", "Classic", "RE-AU0006S", 2022, 39, 38000],
      gent: ["Tissot", "Gentleman Powermatic 80", "T127.407.11.041.00", 2022, 40, 55500],
      alpinist: ["Seiko", "Prospex Alpinist", "SPB121", 2022, 39, 60000],
      khaki: ["Hamilton", "Khaki Field Auto", "H70455133", 2022, 38, 68000],
      prx: ["Tissot", "PRX Powermatic 80", "T137.407.11.041.00", 2023, 40, 70000],
      seastar: ["Tissot", "Seastar 2000 Professional", "T120.607.11.041.00", 2023, 46, 75000],
      c60: ["Christopher Ward", "C60 Trident Pro 300", "C60-40ADA3-S0KK0", 2023, 40, 90000],
      prxchrono: ["Tissot", "PRX Chronograph", "T137.427.11.041.00", 2023, 42, 115000],
      conquest: ["Longines", "Conquest Classic", "L2.386.4.72.6", 2021, 40, 120000],
      hydro: ["Longines", "HydroConquest", "L3.781.4.56.6", 2022, 41, 130000],
      sinn: ["Sinn", "556 I", "556.010", 2021, 38, 150000],
      aquis: ["Oris", "Aquis Date", "01 733 7766 4135", 2022, 41, 170000],
      carrera: ["TAG Heuer", "Carrera Calibre 5", "WBN2111.BA0639", 2022, 39, 190000],
      ranger: ["Tudor", "Ranger 39", "79950", 2022, 39, 260000],
      bb58: ["Tudor", "Black Bay 58", "79030N", 2021, 39, 350000],
      seamaster: ["Omega", "Seamaster Diver 300M", "210.30.42.20.03.001", 2021, 42, 420000],
      snowflake: ["Grand Seiko", "Snowflake", "SBGA211", 2021, 41, 520000],
      santos: ["Cartier", "Santos, medium", "WSSA0029", 2020, 35, 600000],
      speedy: ["Omega", "Speedmaster Professional", "310.30.42.50.01.001", 2021, 42, 600000],
      datejust: ["Rolex", "Datejust 41", "126300", 2022, 41, 1060000],
      sub: ["Rolex", "Submariner Date", "126610LN", 2022, 41, 1380000],
    };
    // Every pocket on a box's wheel is one watch model. Odds are in parts per million and add up to 1,000,000.
    // Pockets are listed in wheel order: rare and common watches alternate around the wheel, and the provably fair
    // roll is read around the wheel in this order. Each box publishes a house edge of about 20%, and no watch in a box is worth less than half its price.
    const BOXES: [string, string, string, string, number, [string, number][]][] = [
      ['railsplitter', 'The Railsplitter', 'I', "Casio and Timex, with a shot at a Tudor", 10000, [['bb58', 216], ['scout', 356570], ['aquis', 761], ['gshock', 259449], ['prx', 3575], ['weekender', 198289], ['presage', 16136], ['snk', 90150], ['seiko5', 26914], ['kamasu', 47940]]],
      ['postmaster', 'The Postmaster', 'II', "Nothing under $158. Top pull: Omega Speedmaster", 25000, [['speedy', 200], ['kamasu', 316646], ['bb58', 200], ['mako', 265461], ['conquest', 2362], ['marlin', 202904], ['prx', 8688], ['promaster', 134859], ['gent', 15223], ['turtle', 53457]]],
      ['counselor', 'The Counselor', 'III', "Nothing under $295. Top pull: Rolex Submariner", 50000, [['sub', 218], ['presage', 261896], ['seamaster', 1954], ['tsuyosa', 225412], ['bb58', 2735], ['turtle', 212976], ['sinn', 13051], ['orientstar', 164186], ['seastar', 46858], ['alpinist', 70714]]],
      ['statesman', 'The Statesman', 'IV', "Nothing under $555. Top pull: Rolex Submariner", 100000, [['sub', 1097], ['gent', 239094], ['santos', 4429], ['alpinist', 209815], ['bb58', 10928], ['khaki', 170122], ['carrera', 30413], ['prx', 162056], ['conquest', 65683], ['c60', 106363]]],
      ['president', 'The President', 'V', "Nothing under $1,150. 1 in 18 pulls is $3,500 or more", 200000, [['sub', 2830], ['prxchrono', 230774], ['datejust', 4516], ['conquest', 214018], ['snowflake', 15942], ['hydro', 185730], ['bb58', 32141], ['sinn', 144148], ['ranger', 54414], ['aquis', 115487]]],
    ];
    const units = (ppm: number) => (ppm < 20000 ? 1 : ppm < 100000 ? 2 : ppm < 200000 ? 4 : 6);
    BOXES.forEach(([slug, name, numeral, tagline, price, pockets], bi) => {
      const boxId = box.run(slug, name, numeral, tagline, price, bi + 1).lastInsertRowid;
      pockets.forEach(([key, ppm], pi) => {
        const [brand, model, ref, year, size, mkt] = W[key];
        const bandId = band.run(boxId, `${brand} ${model}`, mkt, ppm, pi + 1).lastInsertRowid;
        for (let n = 0; n < units(ppm); n++) {
          watch.run(brand, model, ref, year, size, 'Very good', 'Box and papers', mkt, Math.round(mkt * 0.92), 12,
            Math.round(mkt * 0.95), Math.round(mkt * 1.06), 'in_box', bandId, t);
        }
      });
    });

    // Drop No. VII
    const start = new Date(); const end = new Date(Date.now() + 1000 * 60 * 60 * 62);
    const drop = d.prepare(`INSERT INTO drops(number, title, starts_at, ends_at) VALUES (?,?,?,?)`).run(7, 'Drop No. VII', start.toISOString(), end.toISOString()).lastInsertRowid;
    const dropItem = d.prepare(`INSERT INTO drop_items(drop_id, watch_id, price_cents) VALUES (?,?,?)`);
    const dw = (brand: string, model: string, ref: string, year: number, size: number, mkt: number, price: number, papers: string, cond: string) => {
      const id = watch.run(brand, model, ref, year, size, cond, papers, mkt, Math.round(mkt * 0.9), 14, Math.round(mkt * 0.96), Math.round(mkt * 1.05), 'drop', null, t).lastInsertRowid;
      dropItem.run(drop, id, price);
    };
    dw('Rolex', 'Datejust 41', '126300', 2022, 41, 1060600, 1045000, 'Box and papers', 'Excellent');
    dw('Omega', 'Seamaster Diver 300M', '210.30.42.20.03.001', 2021, 42, 425000, 415000, 'Box and papers', 'Very good');
    dw('Cartier', 'Santos, medium', 'WSSA0029', 2020, 35, 600000, 590000, 'Papers only', 'Very good');

    d.prepare('INSERT INTO audit(actor_id, action, detail, created_at) VALUES (?,?,?,?)').run(null, 'seed', 'Sample data created', t);
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}
