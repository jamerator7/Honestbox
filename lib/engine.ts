// Business rules. Every function that moves money or stock runs inside one transaction.
import type { DatabaseSync } from 'node:sqlite';
import { db, tx, now } from './db.ts';
import { PPM, hashSeed, newClientSeed, newServerSeed, pickBand, rollPpm, unitIndex } from './fair.ts';
import { usd } from './money.ts';
import { accrueCommissions } from './affiliate.ts';

export class UserError extends Error {}

export type Box = { id: number; slug: string; name: string; numeral: string; tagline: string; price_cents: number; active: number; sort: number };
export type Band = { id: number; box_id: number; label: string; value_cents: number; odds_ppm: number; sort: number; stock?: number };
export type Watch = {
  id: number; brand: string; model: string; reference: string; year: number | null; size_mm: number | null;
  condition: string; papers: string; market_cents: number; cost_cents: number; sales_count: number;
  sales_low_cents: number | null; sales_high_cents: number | null; status: string; band_id: number | null; authenticated: number;
};
export type Pull = {
  id: number; user_id: number; box_id: number; band_id: number; watch_id: number; price_cents: number; value_cents: number;
  seed_id: number; nonce: number; roll_ppm: number; odds_snapshot: string; status: string; hold_until: string; revealed: number; created_at: string;
  locked_cents: number | null; locked_at: string | null;
};

/** The value a vault pull is bought back against: the locked value if the customer locked it, otherwise today's market value. */
export const valueBasis = (p: { locked_cents: number | null; market_cents: number }) => p.locked_cents ?? p.market_cents;

// ---------- settings ----------
export function settings(d: DatabaseSync = db()): Record<string, string> {
  const rows = d.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
export const flag = (s: Record<string, string>, k: string) => s[k] === '1';
export const num = (s: Record<string, string>, k: string) => Number(s[k]);
export function excludedStates(s: Record<string, string>): string[] {
  return (s.excluded_states || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
}

export function audit(d: DatabaseSync, actorId: number | null, action: string, detail: string) {
  d.prepare('INSERT INTO audit(actor_id, action, detail, created_at) VALUES (?,?,?,?)').run(actorId, action, detail, now());
}

// ---------- credit ----------
export function balance(userId: number, d: DatabaseSync = db()): number {
  const r = d.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS b FROM ledger WHERE user_id = ?').get(userId) as { b: number };
  return Number(r.b);
}
function post(d: DatabaseSync, userId: number, kind: string, amount: number, memo: string, ref?: string) {
  d.prepare('INSERT INTO ledger(user_id, kind, amount_cents, memo, ref, created_at) VALUES (?,?,?,?,?,?)').run(userId, kind, amount, memo, ref ?? null, now());
}

export function addTestCredit(userId: number, cents: number) {
  return tx((d) => {
    if (flag(settings(d), 'real_money')) throw new UserError('Test credit is turned off while real payments are live.');
    if (cents <= 0 || cents > 1_000_000) throw new UserError('Choose an amount up to $10,000.');
    post(d, userId, 'test_credit', cents, 'Test credit (no real money)');
  });
}

// ---------- boxes ----------
export function listBoxes(d: DatabaseSync = db()): Box[] {
  return d.prepare('SELECT * FROM boxes ORDER BY sort').all() as Box[];
}
export function getBox(slug: string, d: DatabaseSync = db()): Box | undefined {
  return d.prepare('SELECT * FROM boxes WHERE slug = ?').get(slug) as Box | undefined;
}
export function bandsFor(boxId: number, d: DatabaseSync = db()): Band[] {
  return d.prepare(`SELECT b.*, (SELECT COUNT(*) FROM watches w WHERE w.band_id = b.id AND w.status = 'in_box') AS stock
    FROM bands b WHERE b.box_id = ? ORDER BY b.sort`).all(boxId) as Band[];
}

export type BoxState = { openable: boolean; reason?: string };
export function boxState(box: Box, bands: Band[], s: Record<string, string>): BoxState {
  if (!flag(s, 'boxes_enabled')) return { openable: false, reason: 'Boxes are paused while we finish our legal review. Drops are open.' };
  if (!box.active) return { openable: false, reason: 'This box is closed for now.' };
  const total = bands.reduce((a, b) => a + b.odds_ppm, 0);
  if (total !== PPM) return { openable: false, reason: 'This box is sealed while its odds are being updated.' };
  const empty = bands.find((b) => b.odds_ppm > 0 && (b.stock ?? 0) < 1);
  if (empty) return { openable: false, reason: 'Sealed while we restock. We never sell a box unless every prize on its odds table is in the vault.' };
  return { openable: true };
}

// ---------- seeds ----------
export type Seed = { id: number; user_id: number; server_seed: string; server_hash: string; client_seed: string; next_nonce: number; active: number; created_at: string; revealed_at: string | null };
export function activeSeed(userId: number, d: DatabaseSync = db()): Seed {
  let s = d.prepare('SELECT * FROM seeds WHERE user_id = ? AND active = 1').get(userId) as Seed | undefined;
  if (!s) {
    const server = newServerSeed();
    d.prepare('INSERT INTO seeds(user_id, server_seed, server_hash, client_seed, created_at) VALUES (?,?,?,?,?)')
      .run(userId, server, hashSeed(server), newClientSeed(), now());
    s = d.prepare('SELECT * FROM seeds WHERE user_id = ? AND active = 1').get(userId) as Seed;
  }
  return s;
}
/** Reveals the current server seed and starts a new pair. */
export function rotateSeed(userId: number, clientSeed?: string) {
  return tx((d) => {
    const cur = activeSeed(userId, d);
    d.prepare('UPDATE seeds SET active = 0, revealed_at = ? WHERE id = ?').run(now(), cur.id);
    const server = newServerSeed();
    const cs = (clientSeed || '').trim().slice(0, 64) || newClientSeed();
    if (!/^[\w\-.:]+$/.test(cs)) throw new UserError('Use letters, numbers, dashes or dots in your client seed.');
    d.prepare('INSERT INTO seeds(user_id, server_seed, server_hash, client_seed, created_at) VALUES (?,?,?,?,?)').run(userId, server, hashSeed(server), cs, now());
  });
}

// ---------- opening a box ----------
export function openBox(userId: number, slug: string): number {
  return tx((d) => {
    const s = settings(d);
    const user = d.prepare('SELECT * FROM users WHERE id = ?').get(userId) as { state: string } | undefined;
    if (!user) throw new UserError('Please sign in again.');
    if (excludedStates(s).includes(user.state)) throw new UserError('Boxes are not available in your state yet. Drops are.');
    const box = getBox(slug, d);
    if (!box) throw new UserError('That box does not exist.');
    const bands = bandsFor(box.id, d);
    const st = boxState(box, bands, s);
    if (!st.openable) throw new UserError(st.reason!);
    const bal = balance(userId, d);
    if (bal < box.price_cents) throw new UserError(`You need ${usd(box.price_cents - bal)} more credit to open this box.`);

    const seed = activeSeed(userId, d);
    const nonce = seed.next_nonce;
    const roll = rollPpm(seed.server_seed, seed.client_seed, nonce);
    const band = pickBand(bands, roll);
    const units = d.prepare(`SELECT id FROM watches WHERE band_id = ? AND status = 'in_box' ORDER BY id`).all(band.id) as { id: number }[];
    const unit = units[unitIndex(seed.server_seed, seed.client_seed, nonce, units.length)];
    const w = d.prepare('SELECT * FROM watches WHERE id = ?').get(unit.id) as Watch;

    d.prepare('UPDATE seeds SET next_nonce = next_nonce + 1 WHERE id = ?').run(seed.id);
    d.prepare(`UPDATE watches SET status = 'pulled' WHERE id = ?`).run(w.id);
    const holdUntil = new Date(Date.now() + num(s, 'hold_days') * 86400_000).toISOString();
    const snapshot = JSON.stringify(bands.map((b) => ({ id: b.id, label: b.label, value_cents: b.value_cents, odds_ppm: b.odds_ppm })));
    const r = d.prepare(`INSERT INTO pulls(user_id, box_id, band_id, watch_id, price_cents, value_cents, seed_id, nonce, roll_ppm, odds_snapshot, hold_until, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(userId, box.id, band.id, w.id, box.price_cents, w.market_cents, seed.id, nonce, roll, snapshot, holdUntil, now());
    const pullId = Number(r.lastInsertRowid);
    post(d, userId, 'box_purchase', -box.price_cents, `${box.name} box`, `pull:${pullId}`);
    accrueCommissions(d, s, userId, pullId, box.price_cents);
    return pullId;
  });
}

export function getPull(userId: number, pullId: number, d: DatabaseSync = db()) {
  return d.prepare(`SELECT p.*, w.brand, w.model, w.reference, w.year, w.size_mm, w.condition, w.papers, w.market_cents,
      w.sales_count, w.sales_low_cents, w.sales_high_cents, bx.name AS box_name, bx.slug AS box_slug, bd.label AS band_label, bd.odds_ppm AS band_odds,
      s.server_hash, s.client_seed, s.server_seed, s.revealed_at
    FROM pulls p JOIN watches w ON w.id = p.watch_id JOIN boxes bx ON bx.id = p.box_id JOIN bands bd ON bd.id = p.band_id JOIN seeds s ON s.id = p.seed_id
    WHERE p.id = ? AND p.user_id = ?`).get(pullId, userId) as (Pull & Watch & { box_name: string; box_slug: string; band_label: string; band_odds: number; server_hash: string; client_seed: string; server_seed: string; revealed_at: string | null }) | undefined;
}

export function markRevealed(userId: number, pullId: number) {
  db().prepare('UPDATE pulls SET revealed = 1 WHERE id = ? AND user_id = ?').run(pullId, userId);
}

export function buybackQuote(marketCents: number, s: Record<string, string>) {
  return {
    credit: Math.floor((marketCents * num(s, 'buyback_credit_bp')) / 10000),
    cash: Math.floor((marketCents * num(s, 'buyback_cash_bp')) / 10000),
    creditBp: num(s, 'buyback_credit_bp'),
    cashBp: num(s, 'buyback_cash_bp'),
  };
}

/** Freezes the buyback value at today's market value. One-way: a locked pull no longer follows the market up or down. */
export function lockValue(userId: number, pullId: number) {
  return tx((d) => {
    const s = settings(d);
    if (!flag(s, 'lock_enabled')) throw new UserError('Locking a value is not available right now.');
    const p = getPull(userId, pullId, d);
    if (!p) throw new UserError('We could not find that pull.');
    if (p.status !== 'vault') throw new UserError('Only a watch in your vault can be locked.');
    if (p.locked_cents != null) throw new UserError('This watch is already locked.');
    d.prepare('UPDATE pulls SET locked_cents = ?, locked_at = ? WHERE id = ?').run(p.market_cents, now(), pullId);
    audit(d, userId, 'pull.lock', `pull ${pullId} at ${p.market_cents}`);
    return p.market_cents;
  });
}

/** Pulls whose vault time has run out are sold back for credit at that day's value. Called on page views. */
export function expireHolds(userId: number) {
  const due = db().prepare(`SELECT id FROM pulls WHERE user_id = ? AND status = 'vault' AND hold_until < ?`).all(userId, now()) as { id: number }[];
  for (const p of due) {
    try { sellBack(userId, p.id, 'credit', { expired: true }); } catch (e) { if (!(e instanceof UserError)) throw e; }
  }
}

export function sellBack(userId: number, pullId: number, method: 'credit' | 'cash', opts: { expired?: boolean } = {}) {
  return tx((d) => {
    const s = settings(d);
    const p = getPull(userId, pullId, d);
    if (!p) throw new UserError('We could not find that pull.');
    if (p.status !== 'vault') throw new UserError('This pull has already been sold back or shipped.');
    const q = buybackQuote(valueBasis(p), s);
    const user = d.prepare('SELECT id_verified FROM users WHERE id = ?').get(userId) as { id_verified: number };
    let status = 'paid';
    if (method === 'credit') {
      post(d, userId, 'buyback_credit', q.credit, `Sold back ${p.brand} ${p.model} for credit${opts.expired ? ' (vault time ended)' : ''}`, `pull:${pullId}`);
    } else {
      if (q.cash > num(s, 'cash_id_threshold_cents') && !user.id_verified) {
        throw new UserError(`Cash payouts over ${usd(num(s, 'cash_id_threshold_cents'))} need a verified ID. Verify your ID in Account, or take credit.`);
      }
      status = 'pending'; // every cash payout waits for an owner's approval
    }
    d.prepare('INSERT INTO buybacks(pull_id, user_id, method, rate_bp, amount_cents, status, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(pullId, userId, method, method === 'credit' ? q.creditBp : q.cashBp, method === 'credit' ? q.credit : q.cash, status, now());
    d.prepare(`UPDATE pulls SET status = 'sold_back' WHERE id = ?`).run(pullId);
    // The watch goes straight back into the band it came from, so the published odds stay backed by stock.
    d.prepare(`UPDATE watches SET status = 'in_box' WHERE id = ?`).run(p.watch_id);
    return method === 'credit' ? q.credit : q.cash;
  });
}

export type Address = { name: string; line1: string; line2?: string; city: string; state: string; zip: string };
function checkAddress(a: Address) {
  if (!a.name?.trim() || !a.line1?.trim() || !a.city?.trim() || !/^[A-Z]{2}$/.test(a.state || '') || !/^\d{5}(-\d{4})?$/.test(a.zip || '')) {
    throw new UserError('Enter a full US address: name, street, city, 2-letter state and ZIP code.');
  }
}

/** Shipping fee for a pull: charged only on low-value watches, where free insured shipping would cost more than the watch earns. */
export function shipFee(marketCents: number, s: Record<string, string>): number {
  return marketCents < num(s, 'ship_fee_under_cents') ? num(s, 'ship_fee_cents') : 0;
}

export function requestShip(userId: number, pullId: number, a: Address) {
  checkAddress(a);
  return tx((d) => {
    const p = getPull(userId, pullId, d);
    if (!p) throw new UserError('We could not find that pull.');
    if (p.status !== 'vault') throw new UserError('This pull has already been sold back or shipped.');
    const fee = shipFee(p.market_cents, settings(d));
    if (fee > 0) {
      const bal = balance(userId, d);
      if (bal < fee) throw new UserError(`Shipping this watch costs ${usd(fee)}, and you have ${usd(bal)} in credit. Add credit, or sell it back instead.`);
      post(d, userId, 'shipping_fee', -fee, `Insured shipping, ${p.brand} ${p.model}`, `pull:${pullId}`);
    }
    d.prepare(`UPDATE pulls SET status = 'ship_requested' WHERE id = ?`).run(pullId);
    d.prepare(`UPDATE watches SET status = 'ship_pending' WHERE id = ?`).run(p.watch_id);
    d.prepare(`INSERT INTO shipments(user_id, watch_id, source, source_id, name, line1, line2, city, state, zip, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(userId, p.watch_id, 'pull', pullId, a.name.trim(), a.line1.trim(), (a.line2 || '').trim(), a.city.trim(), a.state, a.zip, now());
  });
}

// ---------- drops ----------
export type DropItem = Watch & { item_id: number; drop_id: number; price_cents: number; item_status: string; held_by: number | null; held_until: string | null; sold_to: number | null };

function releaseExpiredHolds(d: DatabaseSync) {
  d.prepare(`UPDATE drop_items SET status = 'available', held_by = NULL, held_until = NULL WHERE status = 'held' AND held_until < ?`).run(now());
}

export function currentDrop(d: DatabaseSync = db()) {
  releaseExpiredHolds(d);
  const drop = d.prepare('SELECT * FROM drops WHERE ends_at > ? ORDER BY starts_at DESC LIMIT 1').get(now()) as
    { id: number; number: number; title: string; starts_at: string; ends_at: string } | undefined;
  if (!drop) return null;
  const items = d.prepare(`SELECT w.*, i.id AS item_id, i.drop_id, i.price_cents, i.status AS item_status, i.held_by, i.held_until, i.sold_to
    FROM drop_items i JOIN watches w ON w.id = i.watch_id WHERE i.drop_id = ? ORDER BY i.price_cents DESC`).all(drop.id) as DropItem[];
  return { ...drop, items };
}

export function dropItem(itemId: number, d: DatabaseSync = db()): DropItem | undefined {
  releaseExpiredHolds(d);
  return d.prepare(`SELECT w.*, i.id AS item_id, i.drop_id, i.price_cents, i.status AS item_status, i.held_by, i.held_until, i.sold_to
    FROM drop_items i JOIN watches w ON w.id = i.watch_id WHERE i.id = ?`).get(itemId) as DropItem | undefined;
}

export function holdDropItem(userId: number, itemId: number) {
  return tx((d) => {
    const it = dropItem(itemId, d);
    if (!it) throw new UserError('That piece is no longer in this drop.');
    if (it.item_status === 'sold') throw new UserError('Sold. Another collector got there first.');
    if (it.item_status === 'held' && it.held_by !== userId) throw new UserError('Someone is checking out with this piece. Try again in a few minutes.');
    const mins = num(settings(d), 'drop_hold_minutes');
    d.prepare(`UPDATE drop_items SET status = 'held', held_by = ?, held_until = ? WHERE id = ?`)
      .run(userId, new Date(Date.now() + mins * 60_000).toISOString(), itemId);
  });
}

export function releaseDropItem(userId: number, itemId: number) {
  db().prepare(`UPDATE drop_items SET status = 'available', held_by = NULL, held_until = NULL WHERE id = ? AND held_by = ? AND status = 'held'`).run(itemId, userId);
}

export function buyDropItem(userId: number, itemId: number, a: Address) {
  checkAddress(a);
  return tx((d) => {
    const it = dropItem(itemId, d);
    if (!it) throw new UserError('That piece is no longer in this drop.');
    if (it.item_status === 'sold') throw new UserError('Sold. Another collector got there first.');
    if (it.item_status !== 'held' || it.held_by !== userId) throw new UserError('Your 10-minute hold ran out. Hold the piece again to buy it.');
    const bal = balance(userId, d);
    if (bal < it.price_cents) throw new UserError(`You need ${usd(it.price_cents - bal)} more credit to buy this piece.`);
    post(d, userId, 'drop_purchase', -it.price_cents, `${it.brand} ${it.model} (drop)`, `drop_item:${itemId}`);
    d.prepare(`UPDATE drop_items SET status = 'sold', sold_to = ?, sold_at = ?, held_by = NULL, held_until = NULL WHERE id = ?`).run(userId, now(), itemId);
    d.prepare(`UPDATE watches SET status = 'ship_pending' WHERE id = ?`).run(it.id);
    d.prepare(`INSERT INTO shipments(user_id, watch_id, source, source_id, name, line1, line2, city, state, zip, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(userId, it.id, 'drop', itemId, a.name.trim(), a.line1.trim(), (a.line2 || '').trim(), a.city.trim(), a.state, a.zip, now());
  });
}

// ---------- the Honest Ledger ----------
export type LedgerRow = { box: Box; bands: { label: string; value_cents: number; odds_ppm: number; actual: number }[]; pulls: number; edge: number };
export function honestLedger(month?: string, d: DatabaseSync = db()) {
  const range = month ? [`${month}-01`, nextMonth(month)] : ['0000', '9999'];
  const out: LedgerRow[] = [];
  for (const box of listBoxes(d)) {
    const bands = bandsFor(box.id, d);
    const counts = d.prepare(`SELECT band_id, COUNT(*) AS n FROM pulls WHERE box_id = ? AND created_at >= ? AND created_at < ? GROUP BY band_id`)
      .all(box.id, range[0], range[1]) as { band_id: number; n: number }[];
    const by = new Map(counts.map((c) => [c.band_id, Number(c.n)]));
    const pulls = counts.reduce((a, c) => a + Number(c.n), 0);
    const ev = bands.reduce((a, b) => a + (b.value_cents * b.odds_ppm) / PPM, 0);
    out.push({ box, pulls, edge: 1 - ev / box.price_cents, bands: bands.map((b) => ({ label: b.label, value_cents: b.value_cents, odds_ppm: b.odds_ppm, actual: by.get(b.id) || 0 })) });
  }
  const bb = d.prepare(`SELECT method, COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS total FROM buybacks WHERE status IN ('paid','approved') AND created_at >= ? AND created_at < ? GROUP BY method`)
    .all(range[0], range[1]) as { method: string; n: number; total: number }[];
  return { boxes: out, buybacks: bb };
}
function nextMonth(m: string) {
  const [y, mo] = m.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo, 1));
  return dt.toISOString().slice(0, 10);
}

/** Recent revealed pulls for the live feed. Only revealed pulls (never spoils a spin), first name and last initial only. */
export function recentPulls(limit = 12, d: DatabaseSync = db()) {
  const rows = d.prepare(`SELECT p.id, p.value_cents, p.created_at, w.brand, w.model, bx.name AS box_name, bx.slug AS box_slug, u.name AS user_name
    FROM pulls p JOIN watches w ON w.id = p.watch_id JOIN boxes bx ON bx.id = p.box_id JOIN users u ON u.id = p.user_id
    WHERE p.revealed = 1 ORDER BY p.id DESC LIMIT ?`).all(limit) as { id: number; value_cents: number; created_at: string; brand: string; model: string; box_name: string; box_slug: string; user_name: string }[];
  return rows.map((r) => {
    const parts = (r.user_name || 'A collector').trim().split(/\s+/);
    const who = parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
    return { id: r.id, who, watch: `${r.brand} ${r.model}`, valueCents: r.value_cents, box: r.box_name, slug: r.box_slug, at: r.created_at };
  });
}
