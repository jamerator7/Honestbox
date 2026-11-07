import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HB_DB_PATH = join(mkdtempSync(join(tmpdir(), 'hb-api-')), 'api.db');
const { handle } = await import('../lib/api.ts');

type J = Record<string, any>;
const call = (method: string, path: string, body?: unknown, token?: string) => {
  const r = handle(method, path, body ?? {}, token ? `Bearer ${token}` : null);
  return { status: r.status, body: r.body as J };
};

test('sign in, read the account, sign out', () => {
  const bad = call('POST', 'auth/signin', { email: 'demo@honestbox.test', password: 'wrong' });
  assert.equal(bad.status, 400);
  const r = call('POST', 'auth/signin', { email: 'demo@honestbox.test', password: 'demo-1234' });
  assert.equal(r.status, 200); assert.match(r.body.token, /^[0-9a-f]{64}$/);
  const me = call('GET', 'me', undefined, r.body.token);
  assert.equal(me.body.user.email, 'demo@honestbox.test');
  assert.equal(me.body.balanceCents, 250000);
  assert.equal(me.body.testMode, true);
  call('POST', 'auth/signout', {}, r.body.token);
  assert.equal(call('GET', 'me', undefined, r.body.token).status, 401);
});

test('sign-up enforces age, state and referral code', () => {
  assert.equal(call('POST', 'auth/signup', { email: 'x@y.dev', name: 'X', password: 'longenough', state: 'TX', adult: false }).status, 400);
  assert.equal(call('POST', 'auth/signup', { email: 'x@y.dev', name: 'X', password: 'longenough', state: 'ZZ', adult: true }).status, 400);
  assert.equal(call('POST', 'auth/signup', { email: 'x@y.dev', name: 'X', password: 'longenough', state: 'TX', adult: true, ref: 'NOPE00' }).status, 400);
  const r = call('POST', 'auth/signup', { email: 'x@y.dev', name: 'X', password: 'longenough', state: 'WA', adult: true });
  assert.equal(r.status, 201); assert.equal(r.body.boxesBlocked, true);
  const me = call('GET', 'me', undefined, r.body.token);
  assert.equal(me.body.boxesAllowedInState, false);
});

test('repeated wrong passwords are throttled', () => {
  for (let i = 0; i < 10; i++) call('POST', 'auth/signin', { email: 'throttle@x.dev', password: 'nope' });
  assert.equal(call('POST', 'auth/signin', { email: 'throttle@x.dev', password: 'nope' }).status, 429);
});

test('the full box flow: list, odds, open, hidden until revealed, reveal, lock, sell', () => {
  const t = call('POST', 'auth/signup', { email: 'flow@y.dev', name: 'Flow', password: 'longenough', state: 'TX', adult: true }).body.token;
  call('POST', 'me/test-credit', { cents: 500000 }, t);
  const boxes = call('GET', 'boxes').body.boxes;
  assert.deepEqual(boxes.map((b: J) => b.priceCents), [10000, 25000, 50000, 100000, 200000]);
  const box = call('GET', 'boxes/counselor', undefined, t).body;
  assert.equal(box.bands.reduce((a: number, b: J) => a + b.oddsPpm, 0), 1_000_000);
  assert.match(box.fair.serverSeedHash, /^[0-9a-f]{64}$/);

  const opened = call('POST', 'boxes/counselor/open', {}, t);
  assert.equal(opened.status, 201); assert.equal(opened.body.balanceCents, 450000);
  const sealed = call('GET', `pulls/${opened.body.pullId}`, undefined, t).body;
  assert.equal(sealed.revealed, false);
  assert.equal(sealed.watch, null, 'the watch stays hidden before the reveal');
  assert.equal(sealed.fair.serverSeed, null, 'the secret seed is never sent before rotation');
  assert.equal(sealed.fair.rollPpm, null, 'the roll is not sent before the spin');
  assert.equal(sealed.landedIndex, null);
  assert.equal(sealed.band, null, 'the landed slice is not sent before the spin');
  assert.equal(sealed.wheel.length, 10, 'the wheel shows every watch in the box');
  assert.equal(sealed.wheel.reduce((a: number, w: J) => a + w.oddsPpm, 0), 1_000_000);

  const shown = call('POST', `pulls/${opened.body.pullId}/reveal`, {}, t).body;
  assert.ok(shown.watch.brand); assert.equal(shown.buyback.basis, 'market');
  // the wheel stops exactly at the roll: the landed pocket is the one whose cumulative range contains it
  let edge = 0; let idx = -1;
  for (let i = 0; i < shown.wheel.length; i++) { edge += shown.wheel[i].oddsPpm; if (shown.fair.rollPpm < edge) { idx = i; break; } }
  assert.equal(shown.landedIndex, idx);
  assert.equal(`${shown.watch.brand} ${shown.watch.model}`, shown.wheel[idx].label);
  const locked = call('POST', `pulls/${opened.body.pullId}/lock`, {}, t).body;
  assert.equal(locked.lockedCents, shown.watch.marketCents); assert.equal(locked.pull.buyback.basis, 'locked');
  const sold = call('POST', `pulls/${opened.body.pullId}/sell`, { method: 'credit' }, t);
  assert.equal(sold.status, 200); assert.equal(sold.body.amountCents, Math.floor(shown.watch.marketCents * 0.9));
  assert.equal(call('POST', `pulls/${opened.body.pullId}/sell`, { method: 'credit' }, t).status, 400, 'cannot sell twice');
});

test("other people's pulls are invisible, and protected routes need a token", () => {
  const a = call('POST', 'auth/signup', { email: 'a@y.dev', name: 'A', password: 'longenough', state: 'TX', adult: true }).body.token;
  const b = call('POST', 'auth/signup', { email: 'b@y.dev', name: 'B', password: 'longenough', state: 'TX', adult: true }).body.token;
  call('POST', 'me/test-credit', { cents: 100000 }, a);
  const id = call('POST', 'boxes/railsplitter/open', {}, a).body.pullId;
  assert.equal(call('GET', `pulls/${id}`, undefined, b).status, 404);
  assert.equal(call('POST', `pulls/${id}/sell`, { method: 'credit' }, b).status, 400);
  assert.equal(call('GET', 'pulls').status, 401);
  assert.equal(call('POST', 'boxes/railsplitter/open', {}).status, 401);
});

test('drops: hold, buy, and the fair page after rotation shows the old seed', () => {
  const t = call('POST', 'auth/signup', { email: 'drop@y.dev', name: 'D', password: 'longenough', state: 'TX', adult: true }).body.token;
  for (let i = 0; i < 2; i++) call('POST', 'me/test-credit', { cents: 1_000_000 }, t);
  const drop = call('GET', 'drop', undefined, t).body.drop;
  const item = drop.items.find((i: J) => i.status === 'available');
  assert.equal(call('POST', `drop/items/${item.id}/hold`, {}, t).body.status, 'held_by_you');
  const addr = { name: 'D', line1: '1 Main', city: 'Austin', state: 'TX', zip: '78701' };
  assert.equal(call('POST', `drop/items/${item.id}/buy`, addr, t).status, 200);
  assert.equal(call('GET', `drop/items/${item.id}`, undefined, t).body.boughtByYou, true);

  call('POST', 'boxes/railsplitter/open', {}, t);
  call('POST', 'fair/rotate', { clientSeed: 'abe-1860' }, t);
  const fair = call('GET', 'fair', undefined, t).body;
  assert.equal(fair.active.clientSeed, 'abe-1860');
  assert.equal(fair.revealed.length, 1); assert.match(fair.revealed[0].serverSeed, /^[0-9a-f]{64}$/);
});

test('unknown routes and wrong methods', () => {
  assert.equal(call('GET', 'nope').status, 404);
  assert.equal(call('POST', 'boxes').status, 405);
  assert.equal(call('GET', 'ledger').status, 200);
});
