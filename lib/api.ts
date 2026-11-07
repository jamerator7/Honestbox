// HonestBox mobile API, version 1. Plain functions in, JSON out, so it can be tested without a web server.
// Auth: POST /auth/signin or /auth/signup returns a bearer token; send it as "Authorization: Bearer <token>".
import { db } from './db.ts';
import { pocketsOf } from './wheel.ts';
import { mainPhoto, galleryFor, photoUrl } from './photos.ts';

/** Photo paths are relative to the server ("/media/…"); the app prefixes its API host. */
function bandPhoto(bandId: number) {
  const w = db().prepare("SELECT reference FROM watches WHERE band_id = ? AND reference <> '' LIMIT 1").get(bandId) as { reference: string } | undefined;
  return mainPhoto(w?.reference);
}
import * as E from './engine.ts';
import { settleCommissions, affiliateSummary } from './affiliate.ts';
import { expectedValueCents, houseEdge } from './fair.ts';
import { issueToken, userByToken, revokeToken, checkCredentials, createAccount, US_STATES, type User } from './accounts.ts';

export type ApiResult = { status: number; body: unknown };
type Body = Record<string, unknown>;
type Ctx = { method: string; parts: string[]; body: Body; token: string | null; user: User | null; query: URLSearchParams };

const ok = (body: unknown, status = 200): ApiResult => ({ status, body });
const fail = (status: number, error: string, code?: string): ApiResult => ({ status, body: { error, code } });
const str = (b: Body, k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '');

// ---------- sign-in throttling: 10 failed tries per email per 15 minutes ----------
const tries = new Map<string, number[]>();
function throttled(email: string) {
  const k = email.trim().toLowerCase(); const t = Date.now();
  const list = (tries.get(k) || []).filter((x) => t - x < 15 * 60_000);
  tries.set(k, list);
  return list.length >= 10;
}
function noteFailure(email: string) { const k = email.trim().toLowerCase(); tries.set(k, [...(tries.get(k) || []), Date.now()]); }

// ---------- shapes sent to the app ----------
function boxSummary(b: E.Box, s: Record<string, string>) {
  const bands = E.bandsFor(b.id);
  const st = E.boxState(b, bands, s);
  return {
    slug: b.slug, name: b.name, numeral: b.numeral, tagline: b.tagline, priceCents: b.price_cents,
    expectedValueCents: expectedValueCents(bands), houseEdge: houseEdge(bands, b.price_cents),
    top: bands[0] ? { label: bands[0].label, valueCents: bands[0].value_cents, oddsPpm: bands[0].odds_ppm } : null,
    bigOddsPpm: bands.filter((x) => x.value_cents >= 350000).reduce((a, x) => a + x.odds_ppm, 0),
    openable: st.openable, closedReason: st.reason ?? null,
  };
}

const wheelOf = pocketsOf;

function pullShape(p: NonNullable<ReturnType<typeof E.getPull>>, s: Record<string, string>) {
  const q = E.buybackQuote(E.valueBasis(p), s);
  return {
    id: p.id, status: p.status, revealed: !!p.revealed, createdAt: p.created_at, holdUntil: p.hold_until,
    box: { slug: p.box_slug, name: p.box_name, priceCents: p.price_cents },
    band: p.revealed ? { label: p.band_label, oddsPpm: p.band_odds } : null,
    // Before the spin the app only learns that a pull exists and what is on the wheel; the result stays hidden.
    watch: p.revealed ? {
      brand: p.brand, model: p.model, reference: p.reference, year: p.year, sizeMm: p.size_mm, condition: p.condition, papers: p.papers,
      marketCents: p.market_cents, salesCount: p.sales_count, salesLowCents: p.sales_low_cents, salesHighCents: p.sales_high_cents,
      photo: mainPhoto(p.reference, p.watch_id, 'full'),
    } : null,
    valueAtPullCents: p.revealed ? p.value_cents : null,
    lockedCents: p.locked_cents, lockedAt: p.locked_at,
    buyback: p.revealed ? { creditCents: q.credit, cashCents: q.cash, creditPct: q.creditBp / 100, cashPct: q.cashBp / 100, basis: p.locked_cents != null ? 'locked' : 'market' } : null,
    shipFeeCents: p.revealed ? E.shipFee(p.market_cents, s) : null,
    // The wheel is the box's odds table at the moment of the pull, in wheel order. It is safe to send before the spin;
    // the roll that decides where the wheel stops is only sent once the customer spins.
    wheel: wheelOf(p.odds_snapshot),
    landedIndex: p.revealed ? wheelOf(p.odds_snapshot).findIndex((w) => w.bandId === p.band_id) : null,
    fair: {
      serverSeedHash: p.server_hash, clientSeed: p.client_seed, nonce: p.nonce, rollPpm: p.revealed ? p.roll_ppm : null,
      serverSeed: p.revealed_at ? p.server_seed : null, // the secret seed is only shown after the customer rotates it
    },
  };
}

function account(u: User) {
  const s = E.settings();
  return {
    user: { id: u.id, email: u.email, name: u.name, state: u.state, idVerified: !!u.id_verified, isAdmin: u.role === 'admin' },
    balanceCents: E.balance(u.id),
    testMode: !E.flag(s, 'real_money'),
    boxesAllowedInState: !E.excludedStates(s).includes(u.state),
    referral: { ...affiliateSummary(u.id), l1Pct: E.num(s, 'aff_l1_bp') / 100, l2Pct: E.num(s, 'aff_l2_bp') / 100,
      windowDays: E.num(s, 'aff_window_days'), clearDays: E.num(s, 'aff_clear_days'), monthlyCapCents: E.num(s, 'aff_monthly_cap_cents') },
  };
}

function address(b: Body): E.Address {
  return { name: str(b, 'name'), line1: str(b, 'line1'), line2: str(b, 'line2'), city: str(b, 'city'), state: str(b, 'state').toUpperCase(), zip: str(b, 'zip') };
}

// ---------- routes ----------
type Handler = (c: Ctx, ...params: string[]) => ApiResult;
type Route = { method: string; pattern: string[]; auth: boolean; run: Handler };
const R: Route[] = [];
const route = (method: string, path: string, auth: boolean, run: Handler) => R.push({ method, pattern: path.split('/').filter(Boolean), auth, run });

route('GET', 'config', false, () => {
  const s = E.settings();
  return ok({ testMode: !E.flag(s, 'real_money'), boxesEnabled: E.flag(s, 'boxes_enabled'), lockEnabled: E.flag(s, 'lock_enabled'),
    minAge: E.num(s, 'min_age'), states: US_STATES, excludedStates: E.excludedStates(s) });
});

route('POST', 'auth/signin', false, (c) => {
  const email = str(c.body, 'email');
  if (throttled(email)) return fail(429, 'Too many tries. Wait 15 minutes, then try again.', 'throttled');
  try {
    const id = checkCredentials(email, str(c.body, 'password'));
    const t = issueToken(id);
    return ok({ token: t.token, expiresAt: t.expires.toISOString() });
  } catch (e) { if (e instanceof E.UserError) noteFailure(email); throw e; }
});

route('POST', 'auth/signup', false, (c) => {
  const r = createAccount({ email: str(c.body, 'email'), name: str(c.body, 'name'), password: str(c.body, 'password'), state: str(c.body, 'state'), adult: c.body.adult === true, ref: str(c.body, 'ref') });
  const t = issueToken(r.userId);
  return ok({ token: t.token, expiresAt: t.expires.toISOString(), boxesBlocked: r.boxesBlocked }, 201);
});

route('POST', 'auth/signout', true, (c) => { revokeToken(c.token); return ok({ ok: true }); });

route('GET', 'me', true, (c) => ok(account(c.user!)));

route('POST', 'me/test-credit', true, (c) => {
  const cents = Number(c.body.cents);
  E.addTestCredit(c.user!.id, cents);
  return ok({ balanceCents: E.balance(c.user!.id) });
});

route('GET', 'me/ledger', true, (c) => {
  const rows = db().prepare('SELECT id, kind, amount_cents, memo, created_at FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(c.user!.id) as
    { id: number; kind: string; amount_cents: number; memo: string; created_at: string }[];
  return ok({ entries: rows.map((r) => ({ id: r.id, kind: r.kind, amountCents: r.amount_cents, memo: r.memo, createdAt: r.created_at })) });
});

route('GET', 'boxes', false, () => {
  const s = E.settings();
  return ok({ boxes: E.listBoxes().map((b) => boxSummary(b, s)) });
});

route('GET', 'boxes/:slug', false, (c, slug) => {
  const b = E.getBox(slug);
  if (!b) return fail(404, 'That box does not exist.');
  const s = E.settings();
  const bands = E.bandsFor(b.id);
  const seed = c.user ? E.activeSeed(c.user.id) : null; // the hash is on screen before the very first pull
  return ok({
    ...boxSummary(b, s),
    bands: bands.map((x) => ({ label: x.label, valueCents: x.value_cents, oddsPpm: x.odds_ppm, inStock: x.stock ?? 0, photo: bandPhoto(x.id) })),
    buyback: { creditPct: E.num(s, 'buyback_credit_bp') / 100, cashPct: E.num(s, 'buyback_cash_bp') / 100 },
    fair: seed ? { serverSeedHash: seed.server_hash, clientSeed: seed.client_seed, nextNonce: seed.next_nonce } : null,
  });
});

route('POST', 'boxes/:slug/open', true, (c, slug) => {
  const id = E.openBox(c.user!.id, slug);
  return ok({ pullId: id, balanceCents: E.balance(c.user!.id) }, 201);
});

route('GET', 'pulls', true, (c) => {
  const u = c.user!; const s = E.settings();
  const ids = db().prepare('SELECT id FROM pulls WHERE user_id = ? ORDER BY id DESC LIMIT 200').all(u.id) as { id: number }[];
  return ok({ pulls: ids.map((r) => pullShape(E.getPull(u.id, r.id)!, s)) });
});

route('GET', 'pulls/:id', true, (c, id) => {
  const p = E.getPull(c.user!.id, Number(id));
  return p ? ok(pullShape(p, E.settings())) : fail(404, 'We could not find that pull.');
});

route('POST', 'pulls/:id/reveal', true, (c, id) => {
  if (!E.getPull(c.user!.id, Number(id))) return fail(404, 'We could not find that pull.');
  E.markRevealed(c.user!.id, Number(id));
  return ok(pullShape(E.getPull(c.user!.id, Number(id))!, E.settings()));
});

route('POST', 'pulls/:id/sell', true, (c, id) => {
  const method = str(c.body, 'method') === 'cash' ? 'cash' : 'credit';
  const amount = E.sellBack(c.user!.id, Number(id), method);
  return ok({ method, amountCents: amount, pending: method === 'cash', balanceCents: E.balance(c.user!.id) });
});

route('POST', 'pulls/:id/lock', true, (c, id) => {
  const v = E.lockValue(c.user!.id, Number(id));
  return ok({ lockedCents: v, pull: pullShape(E.getPull(c.user!.id, Number(id))!, E.settings()) });
});

route('POST', 'pulls/:id/ship', true, (c, id) => {
  E.requestShip(c.user!.id, Number(id), address(c.body));
  return ok({ ok: true, balanceCents: E.balance(c.user!.id) });
});

function dropShape(it: E.DropItem, me: number | null) {
  return {
    id: it.item_id, brand: it.brand, model: it.model, reference: it.reference, year: it.year, sizeMm: it.size_mm, condition: it.condition, papers: it.papers,
    priceCents: it.price_cents, marketCents: it.market_cents, salesCount: it.sales_count, authenticated: !!it.authenticated,
    photos: galleryFor(it.reference, it.id).map((g) => ({ url: photoUrl(g.file), thumb: photoUrl(g.thumb), angle: g.angle })),
    status: it.item_status === 'held' ? (it.held_by === me ? 'held_by_you' : 'held') : it.item_status,
    heldUntil: it.held_by === me ? it.held_until : null, boughtByYou: !!me && it.sold_to === me,
  };
}

route('GET', 'drop', false, (c) => {
  const d = E.currentDrop();
  if (!d) return ok({ drop: null });
  return ok({ drop: { number: d.number, title: d.title, startsAt: d.starts_at, endsAt: d.ends_at, items: d.items.map((i) => dropShape(i, c.user?.id ?? null)) } });
});

route('GET', 'drop/items/:id', false, (c, id) => {
  const it = E.dropItem(Number(id));
  return it ? ok(dropShape(it, c.user?.id ?? null)) : fail(404, 'That piece is no longer in this drop.');
});

route('POST', 'drop/items/:id/hold', true, (c, id) => { E.holdDropItem(c.user!.id, Number(id)); return ok(dropShape(E.dropItem(Number(id))!, c.user!.id)); });
route('POST', 'drop/items/:id/release', true, (c, id) => { E.releaseDropItem(c.user!.id, Number(id)); return ok(dropShape(E.dropItem(Number(id))!, c.user!.id)); });
route('POST', 'drop/items/:id/buy', true, (c, id) => {
  E.buyDropItem(c.user!.id, Number(id), address(c.body));
  return ok({ ok: true, balanceCents: E.balance(c.user!.id) });
});

route('GET', 'ledger', false, (c) => {
  const m = c.query.get('month') || undefined;
  const L = E.honestLedger(m && /^\d{4}-\d{2}$/.test(m) ? m : undefined);
  return ok({
    boxes: L.boxes.map((r) => ({ slug: r.box.slug, name: r.box.name, priceCents: r.box.price_cents, pulls: r.pulls, houseEdge: r.edge,
      bands: r.bands.map((b) => ({ label: b.label, valueCents: b.value_cents, oddsPpm: b.odds_ppm, actual: b.actual })) })),
    buybacks: L.buybacks.map((b) => ({ method: b.method, count: Number(b.n), totalCents: Number(b.total) })),
  });
});

route('GET', 'fair', true, (c) => {
  const seed = E.activeSeed(c.user!.id);
  const old = db().prepare('SELECT server_seed, server_hash, client_seed, next_nonce, revealed_at FROM seeds WHERE user_id = ? AND active = 0 ORDER BY id DESC LIMIT 10').all(c.user!.id) as
    { server_seed: string; server_hash: string; client_seed: string; next_nonce: number; revealed_at: string }[];
  return ok({ active: { serverSeedHash: seed.server_hash, clientSeed: seed.client_seed, nextNonce: seed.next_nonce },
    revealed: old.map((o) => ({ serverSeed: o.server_seed, serverSeedHash: o.server_hash, clientSeed: o.client_seed, pulls: o.next_nonce, revealedAt: o.revealed_at })) });
});

route('POST', 'fair/rotate', true, (c) => { E.rotateSeed(c.user!.id, str(c.body, 'clientSeed')); return ok({ ok: true }); });

// ---------- dispatch ----------
export function handle(method: string, path: string, body: unknown, authHeader: string | null, query = new URLSearchParams()): ApiResult {
  const parts = path.split('/').filter(Boolean);
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  const user = userByToken(token);
  if (user) { settleCommissions(user.id); E.expireHolds(user.id); }
  const c: Ctx = { method, parts, body: (body && typeof body === 'object' ? body : {}) as Body, token, user, query };
  let pathMatched = false;
  for (const r of R) {
    if (r.pattern.length !== parts.length) continue;
    const params: string[] = [];
    if (!r.pattern.every((seg, i) => (seg.startsWith(':') ? (params.push(decodeURIComponent(parts[i])), true) : seg === parts[i]))) continue;
    pathMatched = true;
    if (r.method !== method) continue;
    if (r.auth && !user) return fail(401, 'Please sign in again.', 'unauthorized');
    try {
      return r.run(c, ...params);
    } catch (e) {
      if (e instanceof E.UserError) return fail(400, e.message, 'rejected');
      console.error('api error', method, path, e);
      return fail(500, 'Something went wrong on our side. Try again in a moment.', 'server');
    }
  }
  return pathMatched ? fail(405, 'Method not allowed.') : fail(404, 'Not found.');
}
