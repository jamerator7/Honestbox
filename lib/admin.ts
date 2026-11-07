// Owner-only operations. Each one is logged to the audit table.
import { db, tx, now, DEFAULT_SETTINGS } from './db.ts';
import { PPM } from './fair.ts';
import { UserError, audit, settings } from './engine.ts';

const DEFAULT_SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS);

export function dashboard() {
  const d = db();
  const one = (sql: string, ...a: unknown[]) => Number((d.prepare(sql).get(...(a as never[])) as { v: number }).v || 0);
  const s = settings(d);
  const credit = Number(s.buyback_credit_bp) / 10000;
  return {
    sales30: one(`SELECT COALESCE(SUM(-amount_cents),0) AS v FROM ledger WHERE kind IN ('box_purchase','drop_purchase') AND created_at >= ?`, new Date(Date.now() - 30 * 86400_000).toISOString()),
    pulls30: one(`SELECT COUNT(*) AS v FROM pulls WHERE created_at >= ?`, new Date(Date.now() - 30 * 86400_000).toISOString()),
    creditOutstanding: one(`SELECT COALESCE(SUM(amount_cents),0) AS v FROM ledger`),
    vaultExposure: Math.round(one(`SELECT COALESCE(SUM(COALESCE(p.locked_cents, w.market_cents)),0) AS v FROM pulls p JOIN watches w ON w.id = p.watch_id WHERE p.status = 'vault'`) * credit),
    lockedGap: one(`SELECT COALESCE(SUM(p.locked_cents - w.market_cents),0) AS v FROM pulls p JOIN watches w ON w.id = p.watch_id WHERE p.status = 'vault' AND p.locked_cents IS NOT NULL`),
    lockedCount: one(`SELECT COUNT(*) AS v FROM pulls WHERE status = 'vault' AND locked_cents IS NOT NULL`),
    pendingPayouts: one(`SELECT COUNT(*) AS v FROM buybacks WHERE status = 'pending'`),
    pendingPayoutCents: one(`SELECT COALESCE(SUM(amount_cents),0) AS v FROM buybacks WHERE status = 'pending'`),
    toShip: one(`SELECT COUNT(*) AS v FROM shipments WHERE status = 'requested'`),
    inventoryCost: one(`SELECT COALESCE(SUM(cost_cents),0) AS v FROM watches WHERE status IN ('in_box','vault','drop')`),
    users: one(`SELECT COUNT(*) AS v FROM users WHERE role = 'user'`),
  };
}

export function listWatches(filter?: string) {
  const d = db();
  const where = filter ? `WHERE w.status = ?` : '';
  return d.prepare(`SELECT w.*, b.label AS band_label, bx.name AS box_name FROM watches w
    LEFT JOIN bands b ON b.id = w.band_id LEFT JOIN boxes bx ON bx.id = b.box_id ${where} ORDER BY w.id DESC LIMIT 500`)
    .all(...(filter ? [filter] : [])) as Record<string, unknown>[];
}

export function allBands() {
  return db().prepare(`SELECT b.id, b.label, b.value_cents, bx.name AS box_name FROM bands b JOIN boxes bx ON bx.id = b.box_id ORDER BY bx.sort, b.sort`).all() as
    { id: number; label: string; value_cents: number; box_name: string }[];
}

export type NewWatch = { brand: string; model: string; reference: string; year: number | null; size_mm: number | null; condition: string; papers: string;
  market_cents: number; cost_cents: number; sales_count: number; sales_low_cents: number | null; sales_high_cents: number | null; band_id: number | null };

export function addWatch(actorId: number, w: NewWatch) {
  if (!w.brand || !w.model || !(w.market_cents > 0) || !(w.cost_cents > 0)) throw new UserError('Brand, model, market value and cost are required.');
  return tx((d) => {
    const r = d.prepare(`INSERT INTO watches(brand, model, reference, year, size_mm, condition, papers, market_cents, cost_cents, sales_count, sales_low_cents, sales_high_cents, status, band_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(w.brand, w.model, w.reference, w.year, w.size_mm, w.condition, w.papers, w.market_cents, w.cost_cents,
      w.sales_count, w.sales_low_cents, w.sales_high_cents, w.band_id ? 'in_box' : 'vault', w.band_id, now());
    audit(d, actorId, 'watch.add', `#${r.lastInsertRowid} ${w.brand} ${w.model}`);
  });
}

/** Move a vault watch into a band, or take an unpulled watch out of its band. */
export function assignWatch(actorId: number, watchId: number, bandId: number | null) {
  return tx((d) => {
    const w = d.prepare('SELECT status FROM watches WHERE id = ?').get(watchId) as { status: string } | undefined;
    if (!w) throw new UserError('Watch not found.');
    if (!['in_box', 'vault'].includes(w.status)) throw new UserError('Only watches in the vault or in a box can be moved.');
    d.prepare('UPDATE watches SET band_id = ?, status = ? WHERE id = ?').run(bandId, bandId ? 'in_box' : 'vault', watchId);
    audit(d, actorId, 'watch.assign', `#${watchId} -> band ${bandId ?? 'vault'}`);
  });
}

export function updateMarketValue(actorId: number, watchId: number, cents: number) {
  if (!(cents > 0)) throw new UserError('Enter a market value above zero.');
  tx((d) => {
    // A hand-entered value replaces the sales-based one, so the old sales range no longer applies.
    d.prepare('UPDATE watches SET market_cents = ?, sales_count = 0, sales_low_cents = NULL, sales_high_cents = NULL WHERE id = ?').run(cents, watchId);
    audit(d, actorId, 'watch.value', `#${watchId} = ${cents}`);
  });
}

export function saveBox(actorId: number, boxId: number, price: number, active: boolean, bands: { id: number; label: string; value_cents: number; odds_ppm: number }[]) {
  const total = bands.reduce((a, b) => a + b.odds_ppm, 0);
  if (total !== PPM) throw new UserError(`Odds must add up to exactly 100%. They add up to ${(total / 10000).toFixed(4)}%.`);
  if (bands.some((b) => b.odds_ppm < 0 || b.value_cents <= 0 || !b.label.trim())) throw new UserError('Every band needs a name, a value above zero and odds of zero or more.');
  if (!(price > 0)) throw new UserError('Enter a box price above zero.');
  // House rule: every watch that can be pulled is worth at least half the box price.
  const floor = Math.ceil(price / 2);
  const under = bands.filter((b) => b.odds_ppm > 0 && b.value_cents < floor);
  if (under.length) throw new UserError(`Every watch in a box must be worth at least half its price (${'$'}${(floor / 100).toLocaleString('en-US')}). Raise or set to zero odds: ${under.map((b) => b.label).join(', ')}.`);
  return tx((d) => {
    d.prepare('UPDATE boxes SET price_cents = ?, active = ? WHERE id = ?').run(price, active ? 1 : 0, boxId);
    const u = d.prepare('UPDATE bands SET label = ?, value_cents = ?, odds_ppm = ? WHERE id = ? AND box_id = ?');
    for (const b of bands) u.run(b.label.trim(), b.value_cents, b.odds_ppm, b.id, boxId);
    audit(d, actorId, 'box.save', JSON.stringify({ boxId, price, active, bands }));
  });
}

export function listPayouts() {
  return db().prepare(`SELECT bb.*, u.email, u.name, u.id_verified, w.brand, w.model FROM buybacks bb JOIN users u ON u.id = bb.user_id
    JOIN pulls p ON p.id = bb.pull_id JOIN watches w ON w.id = p.watch_id WHERE bb.method = 'cash' ORDER BY bb.status = 'pending' DESC, bb.id DESC LIMIT 200`).all() as Record<string, unknown>[];
}

export function decidePayout(actorId: number, buybackId: number, approve: boolean) {
  return tx((d) => {
    const b = d.prepare(`SELECT * FROM buybacks WHERE id = ? AND status = 'pending'`).get(buybackId) as { id: number; user_id: number; pull_id: number; amount_cents: number } | undefined;
    if (!b) throw new UserError('That payout was already decided.');
    if (approve) {
      d.prepare(`UPDATE buybacks SET status = 'approved', decided_at = ? WHERE id = ?`).run(now(), buybackId);
    } else {
      // Declined: the customer keeps the pull in their vault and can choose again.
      d.prepare(`DELETE FROM buybacks WHERE id = ?`).run(buybackId);
      d.prepare(`UPDATE pulls SET status = 'vault' WHERE id = ?`).run(b.pull_id);
      d.prepare(`UPDATE watches SET status = 'pulled' WHERE id = (SELECT watch_id FROM pulls WHERE id = ?)`).run(b.pull_id);
    }
    audit(d, actorId, approve ? 'payout.approve' : 'payout.decline', `buyback ${buybackId} ${b.amount_cents}`);
  });
}

export function listShipments() {
  return db().prepare(`SELECT s.*, u.email, w.brand, w.model, w.reference, w.market_cents FROM shipments s JOIN users u ON u.id = s.user_id JOIN watches w ON w.id = s.watch_id
    ORDER BY s.status = 'requested' DESC, s.id DESC LIMIT 200`).all() as Record<string, unknown>[];
}

export function markShipped(actorId: number, shipmentId: number, tracking: string) {
  if (!tracking.trim()) throw new UserError('Enter the tracking number.');
  return tx((d) => {
    const s = d.prepare(`SELECT * FROM shipments WHERE id = ? AND status = 'requested'`).get(shipmentId) as { watch_id: number; source: string; source_id: number } | undefined;
    if (!s) throw new UserError('That shipment was already marked shipped.');
    d.prepare(`UPDATE shipments SET status = 'shipped', tracking = ?, shipped_at = ? WHERE id = ?`).run(tracking.trim(), now(), shipmentId);
    d.prepare(`UPDATE watches SET status = 'shipped' WHERE id = ?`).run(s.watch_id);
    if (s.source === 'pull') d.prepare(`UPDATE pulls SET status = 'shipped' WHERE id = ?`).run(s.source_id);
    audit(d, actorId, 'ship', `shipment ${shipmentId} ${tracking}`);
  });
}

export function saveSettings(actorId: number, values: Record<string, string>) {
  return tx((d) => {
    const u = d.prepare('UPDATE settings SET value = ? WHERE key = ?');
    for (const k of DEFAULT_SETTINGS_KEYS) if (k in values) u.run(String(values[k]).trim(), k);
    audit(d, actorId, 'settings', JSON.stringify(values));
  });
}

export function grantCredit(actorId: number, email: string, cents: number, memo: string) {
  return tx((d) => {
    const u = d.prepare('SELECT id FROM users WHERE email = ?').get(email.trim().toLowerCase()) as { id: number } | undefined;
    if (!u) throw new UserError('No account with that email.');
    if (!cents) throw new UserError('Enter an amount.');
    d.prepare('INSERT INTO ledger(user_id, kind, amount_cents, memo, created_at) VALUES (?,?,?,?,?)').run(u.id, 'adjustment', cents, memo || 'Adjustment by HonestBox', now());
    audit(d, actorId, 'credit.grant', `${email} ${cents} ${memo}`);
  });
}

export function setIdVerified(actorId: number, email: string, verified: boolean) {
  return tx((d) => {
    const r = d.prepare('UPDATE users SET id_verified = ? WHERE email = ?').run(verified ? 1 : 0, email.trim().toLowerCase());
    if (!r.changes) throw new UserError('No account with that email.');
    audit(d, actorId, 'user.id_verified', `${email} ${verified}`);
  });
}

export function addDropItem(actorId: number, watchId: number, priceCents: number) {
  return tx((d) => {
    const drop = d.prepare('SELECT id FROM drops WHERE ends_at > ? ORDER BY starts_at DESC LIMIT 1').get(now()) as { id: number } | undefined;
    if (!drop) throw new UserError('Start a drop first.');
    const w = d.prepare(`SELECT status FROM watches WHERE id = ?`).get(watchId) as { status: string } | undefined;
    if (!w || w.status !== 'vault') throw new UserError('Only a watch waiting in the vault can go into a drop.');
    d.prepare(`UPDATE watches SET status = 'drop', band_id = NULL WHERE id = ?`).run(watchId);
    d.prepare('INSERT INTO drop_items(drop_id, watch_id, price_cents) VALUES (?,?,?)').run(drop.id, watchId, priceCents);
    audit(d, actorId, 'drop.add', `watch ${watchId} at ${priceCents}`);
  });
}

export function startDrop(actorId: number, days: number) {
  return tx((d) => {
    const last = d.prepare('SELECT COALESCE(MAX(number),0) AS n FROM drops').get() as { n: number };
    const n = Number(last.n) + 1;
    d.prepare(`UPDATE drops SET ends_at = ? WHERE ends_at > ?`).run(now(), now());
    d.prepare('INSERT INTO drops(number, title, starts_at, ends_at) VALUES (?,?,?,?)').run(n, `Drop No. ${roman(n)}`, now(), new Date(Date.now() + days * 86400_000).toISOString());
    audit(d, actorId, 'drop.start', `#${n}`);
  });
}

export function roman(n: number) {
  const m: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = '';
  for (const [v, r] of m) while (n >= v) { s += r; n -= v; }
  return s;
}

export function recentAudit() {
  return db().prepare(`SELECT a.*, u.email FROM audit a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 50`).all() as Record<string, unknown>[];
}
