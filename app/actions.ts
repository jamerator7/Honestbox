'use server';
// Every form on the site posts to one of these. Each checks the session, then calls the engine.
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireUser, requireAdmin, signIn, signUp, signOut } from '@/lib/auth.ts';
import * as E from '@/lib/engine.ts';
import * as A from '@/lib/admin.ts';
import * as P from '@/lib/photos.ts';
import { attempt, attemptAsync, back, str, int } from '@/lib/act.ts';
import { dollarsToCents, usd } from '@/lib/money.ts';

const safeNext = (n: string) => (n.startsWith('/') && !n.startsWith('//') ? n : '/boxes');

// ---------- accounts ----------
export async function signInAction(f: FormData) {
  const next = safeNext(str(f, 'next'));
  await attemptAsync(`/signin?next=${encodeURIComponent(next)}`, () => signIn(str(f, 'email'), String(f.get('password') || '')));
  redirect(next);
}

export async function signUpAction(f: FormData) {
  const r = await attemptAsync(str(f, 'ref') ? `/signup?ref=${encodeURIComponent(str(f, 'ref'))}` : '/signup', () => signUp({
    email: str(f, 'email'), name: str(f, 'name'), password: String(f.get('password') || ''), state: str(f, 'state'), adult: f.get('adult') === 'on', ref: str(f, 'ref'),
  }));
  redirect(r.boxesBlocked ? '/drops?ok=' + encodeURIComponent('Welcome. Boxes are not open in your state yet, but drops are.') : '/boxes?ok=' + encodeURIComponent('Welcome to HonestBox.'));
}

export async function signOutAction() {
  await signOut();
  redirect('/');
}

export async function addTestCreditAction(f: FormData) {
  const u = await requireUser('/account');
  const cents = int(f, 'cents');
  attempt('/account', () => E.addTestCredit(u.id, cents));
  revalidatePath('/', 'layout');
  back('/account', 'ok', `Added ${usd(cents)} of test credit.`);
}

export async function rotateSeedAction(f: FormData) {
  const u = await requireUser('/fair');
  attempt('/fair', () => E.rotateSeed(u.id, str(f, 'client_seed')));
  back('/fair', 'ok', 'Your old server seed is revealed below, and a new seed pair is active.');
}

// ---------- boxes ----------
export async function openBoxAction(f: FormData) {
  const slug = str(f, 'slug');
  const u = await requireUser(`/boxes/${slug}`);
  const id = attempt(`/boxes/${slug}`, () => E.openBox(u.id, slug));
  revalidatePath('/', 'layout');
  redirect(`/pulls/${id}`);
}

/** Marks the pull revealed and returns its roll, so the wheel can stop exactly where the roll says. */
export async function revealAction(pullId: number): Promise<number> {
  const u = await requireUser();
  const p = E.getPull(u.id, pullId);
  if (!p) throw new Error('Not your pull');
  E.markRevealed(u.id, pullId);
  return p.roll_ppm;
}

export async function sellBackAction(f: FormData) {
  const id = int(f, 'pull');
  const method = str(f, 'method') === 'cash' ? 'cash' : 'credit';
  const u = await requireUser(`/pulls/${id}/sell`);
  const amt = attempt(`/pulls/${id}/sell`, () => E.sellBack(u.id, id, method));
  revalidatePath('/', 'layout');
  back(`/pulls/${id}`, 'ok', method === 'credit' ? `${usd(amt)} added to your credit.` : `${usd(amt)} cash payout requested. We'll confirm by email once it's approved.`);
}

export async function lockAction(f: FormData) {
  const id = int(f, 'pull');
  const u = await requireUser(`/pulls/${id}`);
  const v = attempt(`/pulls/${id}`, () => E.lockValue(u.id, id));
  back(`/pulls/${id}`, 'ok', `Locked at ${usd(v)}. Sell it back any time for the locked value minus 10%, even if the market falls.`);
}

export async function shipAction(f: FormData) {
  const id = int(f, 'pull');
  const u = await requireUser(`/pulls/${id}/ship`);
  attempt(`/pulls/${id}/ship`, () => E.requestShip(u.id, id, addr(f)));
  back(`/pulls/${id}`, 'ok', 'Shipping requested. Your watch ships insured, and we will email tracking.');
}

const addr = (f: FormData) => ({ name: str(f, 'name'), line1: str(f, 'line1'), line2: str(f, 'line2'), city: str(f, 'city'), state: str(f, 'state').toUpperCase(), zip: str(f, 'zip') });

// ---------- drops ----------
export async function holdAction(f: FormData) {
  const id = int(f, 'item');
  const u = await requireUser(`/drops/${id}`);
  attempt(`/drops/${id}`, () => E.holdDropItem(u.id, id));
  redirect(`/drops/${id}`);
}
export async function releaseAction(f: FormData) {
  const id = int(f, 'item');
  const u = await requireUser(`/drops/${id}`);
  E.releaseDropItem(u.id, id);
  redirect(`/drops/${id}`);
}
export async function buyAction(f: FormData) {
  const id = int(f, 'item');
  const u = await requireUser(`/drops/${id}`);
  attempt(`/drops/${id}`, () => E.buyDropItem(u.id, id, addr(f)));
  revalidatePath('/', 'layout');
  back('/vault', 'ok', 'Bought. Your watch ships insured, and we will email tracking.');
}

// ---------- admin ----------
export async function adminSaveBox(f: FormData) {
  const me = await requireAdmin();
  const boxId = int(f, 'box'); const slug = str(f, 'slug');
  const ids = f.getAll('band_id').map((x) => Number(x));
  const bands = ids.map((id, i) => ({
    id, label: String(f.getAll('label')[i] || ''), value_cents: dollarsToCents(String(f.getAll('value')[i] || '0')),
    odds_ppm: Math.round(parseFloat(String(f.getAll('odds')[i] || '0')) * 10000),
  }));
  attempt(`/admin/boxes/${slug}`, () => A.saveBox(me.id, boxId, dollarsToCents(str(f, 'price')), f.get('active') === 'on', bands));
  revalidatePath('/', 'layout');
  back(`/admin/boxes/${slug}`, 'ok', 'Saved. The new odds are live.');
}

export async function adminAddWatch(f: FormData) {
  const me = await requireAdmin();
  const n = (k: string) => (str(f, k) ? Number(str(f, k)) : null);
  const c = (k: string) => (str(f, k) ? dollarsToCents(str(f, k)) : null);
  attempt('/admin/inventory', () => A.addWatch(me.id, {
    brand: str(f, 'brand'), model: str(f, 'model'), reference: str(f, 'reference'), year: n('year'), size_mm: n('size_mm'),
    condition: str(f, 'condition') || 'Very good', papers: str(f, 'papers') || 'Box and papers',
    market_cents: c('market') || 0, cost_cents: c('cost') || 0, sales_count: n('sales_count') || 0,
    sales_low_cents: c('sales_low'), sales_high_cents: c('sales_high'), band_id: n('band'),
  }));
  revalidatePath('/', 'layout');
  back('/admin/inventory', 'ok', 'Watch added.');
}

export async function adminAssign(f: FormData) {
  const me = await requireAdmin();
  const band = str(f, 'band');
  attempt('/admin/inventory', () => A.assignWatch(me.id, int(f, 'watch'), band ? Number(band) : null));
  revalidatePath('/', 'layout');
  back('/admin/inventory', 'ok', 'Moved.');
}

export async function adminValue(f: FormData) {
  const me = await requireAdmin();
  attempt('/admin/inventory', () => A.updateMarketValue(me.id, int(f, 'watch'), dollarsToCents(str(f, 'market'))));
  back('/admin/inventory', 'ok', 'Market value updated.');
}

export async function adminPayout(f: FormData) {
  const me = await requireAdmin();
  const ok = str(f, 'decision') === 'approve';
  attempt('/admin/payouts', () => A.decidePayout(me.id, int(f, 'id'), ok));
  back('/admin/payouts', 'ok', ok ? 'Approved. Send the payment through the processor and keep its reference.' : 'Declined. The watch is back in the customer\'s vault.');
}

export async function adminShip(f: FormData) {
  const me = await requireAdmin();
  attempt('/admin/shipments', () => A.markShipped(me.id, int(f, 'id'), str(f, 'tracking')));
  back('/admin/shipments', 'ok', 'Marked shipped.');
}

export async function adminSettings(f: FormData) {
  const me = await requireAdmin();
  const v: Record<string, string> = {};
  for (const [k, val] of f.entries()) if (typeof val === 'string') v[k] = val;
  v.boxes_enabled = f.get('boxes_enabled') === 'on' ? '1' : '0';
  v.real_money = f.get('real_money') === 'on' ? '1' : '0';
  v.lock_enabled = f.get('lock_enabled') === 'on' ? '1' : '0';
  if (v.real_money === '1') back('/admin/settings', 'error', 'Real payments cannot be switched on until a payment processor is connected.');
  attempt('/admin/settings', () => A.saveSettings(me.id, v));
  revalidatePath('/', 'layout');
  back('/admin/settings', 'ok', 'Settings saved.');
}

export async function adminCredit(f: FormData) {
  const me = await requireAdmin();
  attempt('/admin/settings', () => A.grantCredit(me.id, str(f, 'email'), dollarsToCents(str(f, 'amount')), str(f, 'memo')));
  back('/admin/settings', 'ok', 'Credit posted.');
}

export async function adminVerify(f: FormData) {
  const me = await requireAdmin();
  attempt('/admin/settings', () => A.setIdVerified(me.id, str(f, 'email'), f.get('verified') === 'on'));
  back('/admin/settings', 'ok', 'ID status updated.');
}

export async function adminDropAdd(f: FormData) {
  const me = await requireAdmin();
  attempt('/admin/drops', () => A.addDropItem(me.id, int(f, 'watch'), dollarsToCents(str(f, 'price'))));
  revalidatePath('/', 'layout');
  back('/admin/drops', 'ok', 'Added to the drop.');
}

export async function adminDropStart(f: FormData) {
  const me = await requireAdmin();
  attempt('/admin/drops', () => A.startDrop(me.id, Math.max(1, int(f, 'days') || 7)));
  back('/admin/drops', 'ok', 'New drop started.');
}

// ---------- admin: photos ----------
export async function adminUploadPhotos(f: FormData) {
  const me = await requireAdmin();
  const reference = str(f, 'reference'), angle = str(f, 'angle') || 'dial';
  const piece = str(f, 'piece'); const watchId = piece ? Number(piece) : null;
  const files = f.getAll('photos').filter((x): x is File => typeof x === 'object' && 'arrayBuffer' in x && (x as File).size > 0);
  const to = `/admin/photos#ref-${encodeURIComponent(reference)}`;
  if (!files.length) back('/admin/photos', 'error', 'Choose at least one photo to upload.');
  if (files.length > 12) back('/admin/photos', 'error', 'Upload up to 12 photos at a time.');
  let n = 0;
  for (const file of files) {
    const bytes = Buffer.from(await file.arrayBuffer());
    try { await P.savePhoto(me.id, { reference, watchId, angle, bytes }); n++; }
    catch (e) { if (e instanceof E.UserError) back('/admin/photos', 'error', `${n} uploaded. ${file.name}: ${e.message}`); throw e; }
  }
  revalidatePath('/', 'layout');
  back(to.split('#')[0], 'ok', `${n} photo${n === 1 ? '' : 's'} added to ${reference}.`);
}

export async function adminPhotoPrimary(f: FormData) {
  const me = await requireAdmin();
  attempt('/admin/photos', () => P.makePrimary(me.id, int(f, 'photo')));
  revalidatePath('/', 'layout');
  back('/admin/photos', 'ok', 'Main photo set.');
}

export async function adminPhotoDelete(f: FormData) {
  const me = await requireAdmin();
  attempt('/admin/photos', () => P.deletePhoto(me.id, int(f, 'photo')));
  revalidatePath('/', 'layout');
  back('/admin/photos', 'ok', 'Photo removed.');
}
