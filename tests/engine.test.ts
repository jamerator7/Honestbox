import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HB_DB_PATH = join(mkdtempSync(join(tmpdir(), 'hb-')), 'test.db');

const { db } = await import('../lib/db.ts');
const fair = await import('../lib/fair.ts');
const E = await import('../lib/engine.ts');
const A = await import('../lib/admin.ts');
const { hashPassword } = await import('../lib/password.ts');

const demo = () => (db().prepare(`SELECT id FROM users WHERE email = 'demo@honestbox.test'`).get() as { id: number }).id;
const adminId = () => (db().prepare(`SELECT id FROM users WHERE role = 'admin'`).get() as { id: number }).id;
// Rare pockets hold a single watch; a lucky roll in one test must not seal a box for the next.
function restock() {
  const empty = db().prepare(`SELECT b.id FROM bands b WHERE b.odds_ppm > 0 AND NOT EXISTS (SELECT 1 FROM watches w WHERE w.band_id = b.id AND w.status = 'in_box')`).all() as { id: number }[];
  for (const { id } of empty) {
    db().prepare(`INSERT INTO watches(brand, model, reference, year, size_mm, condition, papers, market_cents, cost_cents, sales_count, sales_low_cents, sales_high_cents, status, band_id, created_at)
      SELECT brand, model, reference, year, size_mm, condition, papers, market_cents, cost_cents, sales_count, sales_low_cents, sales_high_cents, 'in_box', band_id, created_at FROM watches WHERE band_id = ? LIMIT 1`).run(id);
  }
}
function newUser(email: string, state = 'TX') {
  restock();
  const r = db().prepare(`INSERT INTO users(email, name, pass_hash, state, created_at) VALUES (?,?,?,?,?)`).run(email, 'T', hashPassword('x-123456'), state, new Date().toISOString());
  return Number(r.lastInsertRowid);
}

test('seeded boxes publish a 20% edge and odds that sum to 100%', () => {
  for (const box of E.listBoxes()) {
    const bands = E.bandsFor(box.id);
    assert.equal(bands.reduce((a, b) => a + b.odds_ppm, 0), fair.PPM, box.name);
    assert.ok(Math.abs(fair.houseEdge(bands, box.price_cents) - 0.2) < 0.03, `${box.name} edge ${fair.houseEdge(bands, box.price_cents)}`);
    assert.ok(E.boxState(box, bands, E.settings()).openable, `${box.name} should be openable`);
  }
});

test('every box has at least 15 watches on its wheel, each in stock, at about a 20% edge', () => {
  for (const box of E.listBoxes()) {
    const bands = E.bandsFor(box.id);
    assert.ok(bands.length >= 15, `${box.name} has ${bands.length} pockets`);
    assert.equal(new Set(bands.map((b) => b.label)).size, bands.length, `${box.name} pockets are distinct watches`);
    assert.ok(bands.every((b) => (b.stock ?? 0) >= 1), `${box.name} every pocket stocked`);
    const edge = fair.houseEdge(bands, box.price_cents);
    assert.ok(edge > 0.19 && edge < 0.21, `${box.name} edge ${edge}`);
    const live = bands.filter((b) => b.odds_ppm > 0);
    assert.ok(live.every((b) => b.value_cents * 2 >= box.price_cents), `${box.name}: every watch is worth at least half the box price`);
  }
});

test('the admin cannot save a box with a watch worth less than half its price', () => {
  const box = E.getBox('statesman')!;
  const bands = E.bandsFor(box.id).map((b) => ({ id: b.id, label: b.label, value_cents: b.value_cents, odds_ppm: b.odds_ppm }));
  const cheap = bands.map((b, i) => (i === 1 ? { ...b, value_cents: 40000 } : b));
  const admin = (db().prepare("SELECT id FROM users WHERE role = 'admin'").get() as { id: number }).id;
  assert.throws(() => A.saveBox(admin, box.id, box.price_cents, true, cheap), /at least half its price/);
});

test('rolls are deterministic and land in the right band', () => {
  const s = 'a'.repeat(64);
  assert.equal(fair.rollPpm(s, 'client', 0), fair.rollPpm(s, 'client', 0));
  assert.notEqual(fair.rollPpm(s, 'client', 0), fair.rollPpm(s, 'client', 1));
  const bands = [{ id: 1, odds_ppm: 4000 }, { id: 2, odds_ppm: 996000 }];
  assert.equal(fair.pickBand(bands, 0).id, 1);
  assert.equal(fair.pickBand(bands, 3999).id, 1);
  assert.equal(fair.pickBand(bands, 4000).id, 2);
  assert.equal(fair.pickBand(bands, 999999).id, 2);
  assert.throws(() => fair.pickBand([{ id: 1, odds_ppm: 10 }], 50));
});

test('over 200,000 rolls, each band appears close to its published odds', () => {
  const bands = [{ id: 1, odds_ppm: 4000 }, { id: 2, odds_ppm: 12000 }, { id: 3, odds_ppm: 40000 }, { id: 4, odds_ppm: 200000 }, { id: 5, odds_ppm: 744000 }];
  const seed = fair.newServerSeed(); const n = 200_000; const c = new Map<number, number>();
  for (let i = 0; i < n; i++) { const b = fair.pickBand(bands, fair.rollPpm(seed, 'c', i)); c.set(b.id, (c.get(b.id) || 0) + 1); }
  for (const b of bands) {
    const p = b.odds_ppm / fair.PPM; const sd = Math.sqrt(n * p * (1 - p));
    assert.ok(Math.abs((c.get(b.id) || 0) - n * p) < 5 * sd, `band ${b.id}: ${c.get(b.id)} vs ${n * p}`);
  }
});

test('opening a box charges the price, records a verifiable pull and moves the watch', () => {
  const uid = demo(); const before = E.balance(uid);
  const pid = E.openBox(uid, 'statesman');
  assert.equal(E.balance(uid), before - 100000);
  const p = E.getPull(uid, pid)!;
  assert.equal(p.status, 'vault');
  assert.equal(fair.hashSeed(p.server_seed), p.server_hash);
  assert.equal(fair.rollPpm(p.server_seed, p.client_seed, p.nonce), p.roll_ppm);
  const snap = JSON.parse(p.odds_snapshot);
  assert.equal(fair.pickBand(snap, p.roll_ppm).id, p.band_id);
  const w = db().prepare('SELECT status FROM watches WHERE id = ?').get(p.watch_id) as { status: string };
  assert.equal(w.status, 'pulled');
});

test('selling back for credit pays 90% and returns the watch to its band; it cannot be sold twice', () => {
  const uid = demo();
  const pid = E.openBox(uid, 'railsplitter');
  const p = E.getPull(uid, pid)!;
  const before = E.balance(uid);
  const paid = E.sellBack(uid, pid, 'credit');
  assert.equal(paid, Math.floor(p.market_cents * 0.9));
  assert.equal(E.balance(uid), before + paid);
  const w = db().prepare('SELECT status, band_id FROM watches WHERE id = ?').get(p.watch_id) as { status: string; band_id: number };
  assert.equal(w.status, 'in_box'); assert.equal(w.band_id, p.band_id);
  assert.throws(() => E.sellBack(uid, pid, 'credit'), E.UserError);
});

test('large cash payouts need a verified ID; smaller ones wait for approval', () => {
  const uid = newUser('cash@test.dev');
  E.addTestCredit(uid, 1_000_000);
  // Force a big pull by making the Submariner band certain for one open.
  const box = E.getBox('president')!; const bands = E.bandsFor(box.id);
  A.saveBox(adminId(), box.id, box.price_cents, true, bands.map((b, i) => ({ ...b, odds_ppm: i === 0 ? fair.PPM : 0 })));
  const pid = E.openBox(uid, 'president');
  assert.throws(() => E.sellBack(uid, pid, 'cash'), /verified ID/);
  A.setIdVerified(adminId(), 'cash@test.dev', true);
  E.sellBack(uid, pid, 'cash');
  const bb = db().prepare('SELECT status FROM buybacks WHERE pull_id = ?').get(pid) as { status: string };
  assert.equal(bb.status, 'pending');
  A.saveBox(adminId(), box.id, box.price_cents, true, bands);
});

test('a box with an empty band is sealed, and the switch and state rules are enforced', () => {
  const uid = demo();
  const box = E.getBox('statesman')!;
  const top = E.bandsFor(box.id)[0];
  db().prepare(`UPDATE watches SET status = 'vault' WHERE band_id = ? AND status = 'in_box'`).run(top.id);
  assert.equal(E.boxState(box, E.bandsFor(box.id), E.settings()).openable, false);
  assert.throws(() => E.openBox(uid, 'statesman'), /restock/);
  db().prepare(`UPDATE watches SET status = 'in_box' WHERE band_id = ? AND status = 'vault'`).run(top.id);

  A.saveSettings(adminId(), { boxes_enabled: '0' });
  assert.throws(() => E.openBox(uid, 'statesman'), /paused/);
  A.saveSettings(adminId(), { boxes_enabled: '1' });

  const wa = newUser('wa@test.dev', 'WA'); E.addTestCredit(wa, 100000);
  assert.throws(() => E.openBox(wa, 'railsplitter'), /not available in your state/);
});

test('odds that do not add up to 100% are refused', () => {
  const box = E.getBox('railsplitter')!; const bands = E.bandsFor(box.id);
  assert.throws(() => A.saveBox(adminId(), box.id, box.price_cents, true, bands.map((b, i) => ({ ...b, odds_ppm: i === 0 ? b.odds_ppm + 1 : b.odds_ppm }))), /100%/);
});

test('drop items are held for one buyer, then sold and queued to ship', () => {
  const a = newUser('a@test.dev'); const b = newUser('b@test.dev');
  E.addTestCredit(a, 1_000_000); E.addTestCredit(b, 1_000_000);
  const item = E.currentDrop()!.items.find((i) => i.model === 'Seamaster Diver 300M')!;
  const addr = { name: 'A', line1: '1 Main St', city: 'Austin', state: 'TX', zip: '78701' };
  assert.throws(() => E.buyDropItem(a, item.item_id, addr), /hold/);
  E.holdDropItem(a, item.item_id);
  assert.throws(() => E.holdDropItem(b, item.item_id), /checking out/);
  E.buyDropItem(a, item.item_id, addr);
  assert.equal(E.balance(a), 1_000_000 - item.price_cents);
  assert.throws(() => E.holdDropItem(b, item.item_id), /Sold/);
  const ship = db().prepare(`SELECT status FROM shipments WHERE source = 'drop' AND source_id = ?`).get(item.item_id) as { status: string };
  assert.equal(ship.status, 'requested');
});

test('the Honest Ledger counts every pull in its band', () => {
  const L = E.honestLedger();
  const total = L.boxes.reduce((a, b) => a + b.pulls, 0);
  const n = (db().prepare('SELECT COUNT(*) AS n FROM pulls').get() as { n: number }).n;
  assert.equal(total, Number(n));
});

test('two-level commissions: 5% to the referrer, 1% to theirs, cleared into credit later', async () => {
  const AF = await import('../lib/affiliate.ts');
  const a = newUser('aff-a@test.dev'); const b = newUser('aff-b@test.dev'); const c = newUser('aff-c@test.dev');
  db().prepare('UPDATE users SET referred_by = ? WHERE id = ?').run(a, b);
  db().prepare('UPDATE users SET referred_by = ? WHERE id = ?').run(b, c);
  E.addTestCredit(c, 500000);
  const pid = E.openBox(c, 'statesman');
  const rows = db().prepare('SELECT earner_id, level, amount_cents, status FROM commissions WHERE pull_id = ? ORDER BY level').all(pid) as { earner_id: number; level: number; amount_cents: number; status: string }[];
  assert.deepEqual(rows.map((r) => [r.earner_id, r.level, r.amount_cents, r.status]), [[b, 1, 5000, 'pending'], [a, 2, 1000, 'pending']]);
  const before = E.balance(b);
  AF.settleCommissions(b);
  assert.equal(E.balance(b), before, 'not spendable until the clearing period ends');
  db().prepare(`UPDATE commissions SET available_at = '2000-01-01' WHERE earner_id = ?`).run(b);
  AF.settleCommissions(b);
  assert.equal(E.balance(b), before + 5000);
  AF.settleCommissions(b);
  assert.equal(E.balance(b), before + 5000, 'settling twice pays once');
  // the referrer's own boxes earn nothing for themselves, and nobody above a (there is no one)
  E.addTestCredit(b, 100000);
  const own = E.openBox(b, 'railsplitter');
  const ownRows = db().prepare('SELECT earner_id, level FROM commissions WHERE pull_id = ?').all(own) as { earner_id: number; level: number }[];
  assert.deepEqual(ownRows.map((r) => [r.earner_id, r.level]), [[a, 1]]);
});

test('commissions respect the monthly cap and the 90-day window', () => {
  const a = newUser('cap-a@test.dev'); const b = newUser('cap-b@test.dev'); const old = newUser('cap-old@test.dev');
  db().prepare('UPDATE users SET referred_by = ? WHERE id IN (?, ?)').run(a, b, old);
  A.saveSettings(adminId(), { aff_monthly_cap_cents: '5000' });
  E.addTestCredit(b, 500000);
  E.openBox(b, 'statesman'); restock(); E.openBox(b, 'statesman');
  const total = Number((db().prepare('SELECT SUM(amount_cents) AS v FROM commissions WHERE earner_id = ?').get(a) as { v: number }).v);
  assert.equal(total, 5000);
  A.saveSettings(adminId(), { aff_monthly_cap_cents: '250000' });
  db().prepare(`UPDATE users SET created_at = ? WHERE id = ?`).run(new Date(Date.now() - 100 * 86400_000).toISOString(), old);
  E.addTestCredit(old, 100000);
  restock();
  const pid = E.openBox(old, 'railsplitter');
  assert.equal((db().prepare('SELECT COUNT(*) AS n FROM commissions WHERE pull_id = ?').get(pid) as { n: number }).n, 0);
});

test('five boxes at $100, $250, $500, $1,000 and $2,000', () => {
  assert.deepEqual(E.listBoxes().map((b) => [b.numeral, b.slug, b.price_cents]),
    [['I', 'railsplitter', 10000], ['II', 'postmaster', 25000], ['III', 'counselor', 50000], ['IV', 'statesman', 100000], ['V', 'president', 200000]]);
});

test('shipping a pull under $250 costs $15 from credit; $250 and up ships free', () => {
  const u = newUser('ship-fee@test.dev'); E.addTestCredit(u, 1_000_000);
  const addr = { name: 'S', line1: '1 Main St', city: 'Austin', state: 'TX', zip: '78701' };
  const box = E.getBox('railsplitter')!; const bands = E.bandsFor(box.id);
  const force = (i: number) => A.saveBox(adminId(), box.id, box.price_cents, true, bands.map((b, j) => ({ ...b, odds_ppm: j === i ? fair.PPM : 0 })));
  const cheapest = bands.reduce((m, b, i) => (b.value_cents < bands[m].value_cents ? i : m), 0);
  force(cheapest); // a watch worth under $250
  const cheap = E.openBox(u, 'railsplitter');
  let before = E.balance(u);
  E.requestShip(u, cheap, addr);
  assert.equal(E.balance(u), before - 1500);
  force(0); // the top pocket, worth far more than $250
  const dear = E.openBox(u, 'railsplitter');
  before = E.balance(u);
  E.requestShip(u, dear, addr);
  assert.equal(E.balance(u), before);
  A.saveBox(adminId(), box.id, box.price_cents, true, bands);
  // not enough credit for the fee: refused, nothing changes
  const poor = newUser('ship-poor@test.dev'); E.addTestCredit(poor, 10000);
  force(cheapest);
  const p2 = E.openBox(poor, 'railsplitter');
  assert.throws(() => E.requestShip(poor, p2, addr), /Shipping this watch costs \$15/);
  assert.equal(E.getPull(poor, p2)!.status, 'vault');
  A.saveBox(adminId(), box.id, box.price_cents, true, bands);
});

test('vault pulls float with the market: the buyback uses the market value on the day of sale', () => {
  const u = newUser('float@test.dev'); E.addTestCredit(u, 500_000);
  const pid = E.openBox(u, 'counselor');
  const p = E.getPull(u, pid)!;
  A.updateMarketValue(adminId(), p.watch_id, Math.round(p.market_cents * 1.2)); // the watch goes up 20%
  const before = E.balance(u);
  const paid = E.sellBack(u, pid, 'credit');
  assert.equal(paid, Math.floor(Math.round(p.market_cents * 1.2) * 0.9));
  assert.equal(E.balance(u), before + paid);
  A.updateMarketValue(adminId(), p.watch_id, p.market_cents);
});

test('a locked value is paid even if the market falls, gains nothing if it rises, and cannot be locked twice', () => {
  const u = newUser('lock@test.dev'); E.addTestCredit(u, 500_000);
  const a = E.openBox(u, 'counselor'); const pa = E.getPull(u, a)!;
  assert.equal(E.lockValue(u, a), pa.market_cents);
  assert.throws(() => E.lockValue(u, a), /already locked/);
  A.updateMarketValue(adminId(), pa.watch_id, Math.round(pa.market_cents * 0.5)); // price halves
  assert.equal(E.sellBack(u, a, 'credit'), Math.floor(pa.market_cents * 0.9));
  A.updateMarketValue(adminId(), pa.watch_id, pa.market_cents);

  const b = E.openBox(u, 'counselor'); const pb = E.getPull(u, b)!;
  E.lockValue(u, b);
  A.updateMarketValue(adminId(), pb.watch_id, pb.market_cents * 2); // price doubles
  assert.equal(E.sellBack(u, b, 'credit'), Math.floor(pb.market_cents * 0.9));
  A.updateMarketValue(adminId(), pb.watch_id, pb.market_cents);
});

test('when vault time runs out, the pull is sold back for credit at that day\'s value', () => {
  const u = newUser('expire@test.dev'); E.addTestCredit(u, 500_000);
  const pid = E.openBox(u, 'counselor'); const p = E.getPull(u, pid)!;
  db().prepare(`UPDATE pulls SET hold_until = '2000-01-01' WHERE id = ?`).run(pid);
  const before = E.balance(u);
  E.expireHolds(u);
  assert.equal(E.getPull(u, pid)!.status, 'sold_back');
  assert.equal(E.balance(u), before + Math.floor(p.market_cents * 0.9));
  E.expireHolds(u);
  assert.equal(E.balance(u), before + Math.floor(p.market_cents * 0.9), 'only once');
});
