import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const dir = mkdtempSync(join(tmpdir(), 'hb-photos-'));
process.env.HB_DB_PATH = join(dir, 'p.db');
process.env.HB_UPLOAD_DIR = join(dir, 'uploads');
const { db } = await import('../lib/db.ts');
const P = await import('../lib/photos.ts');

const admin = () => (db().prepare("SELECT id FROM users WHERE role = 'admin'").get() as { id: number }).id;
const jpeg = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: '#0D2219' } }).jpeg().toBuffer();
const ref = () => (db().prepare("SELECT reference FROM watches WHERE reference <> '' LIMIT 1").get() as { reference: string }).reference;

test('an upload is resized to 1600px, thumbnailed, stored and becomes the main photo', async () => {
  const r = ref();
  const id = await P.savePhoto(admin(), { reference: r, angle: 'dial', bytes: await jpeg(3000, 2000) });
  const p = db().prepare('SELECT * FROM photos WHERE id = ?').get(id) as P.Photo;
  assert.equal(p.width, 1600); assert.equal(p.height, 1067);
  assert.ok(existsSync(join(P.uploadDir(), p.file)) && existsSync(join(P.uploadDir(), p.thumb)));
  assert.match(p.file, P.FILE_RE);
  assert.equal(P.mainPhoto(r), P.photoUrl(p.thumb));
});

test('make main reorders; a piece photo wins for that piece only; delete removes the files', async () => {
  const r = ref();
  const second = await P.savePhoto(admin(), { reference: r, angle: 'caseback', bytes: await jpeg(800, 800) });
  P.makePrimary(admin(), second);
  const main = db().prepare('SELECT thumb FROM photos WHERE id = ?').get(second) as { thumb: string };
  assert.equal(P.mainPhoto(r), P.photoUrl(main.thumb));
  const piece = (db().prepare('SELECT id FROM watches WHERE reference = ? LIMIT 1').get(r) as { id: number }).id;
  const own = await P.savePhoto(admin(), { reference: r, watchId: piece, angle: 'dial', bytes: await jpeg(900, 900) });
  const ownRow = db().prepare('SELECT * FROM photos WHERE id = ?').get(own) as P.Photo;
  assert.equal(P.mainPhoto(r, piece), P.photoUrl(ownRow.thumb));
  assert.equal(P.mainPhoto(r), P.photoUrl(main.thumb), 'the model photo is unchanged');
  assert.equal(P.galleryFor(r, piece)[0].id, own);
  P.deletePhoto(admin(), own);
  assert.ok(!existsSync(join(P.uploadDir(), ownRow.file)));
});

test('bad uploads are refused with a clear message', async () => {
  const r = ref();
  await assert.rejects(P.savePhoto(admin(), { reference: r, angle: 'dial', bytes: Buffer.from('not an image') }), /JPEG, PNG or WebP/);
  await assert.rejects(P.savePhoto(admin(), { reference: '', angle: 'dial', bytes: await jpeg(10, 10) }), /Pick the watch model/);
  await assert.rejects(P.savePhoto(admin(), { reference: r, angle: 'selfie', bytes: await jpeg(10, 10) }), /which angle/);
  const other = (db().prepare('SELECT id FROM watches WHERE reference <> ? AND reference <> \'\' LIMIT 1').get(r) as { id: number }).id;
  await assert.rejects(P.savePhoto(admin(), { reference: r, watchId: other, angle: 'dial', bytes: await jpeg(10, 10) }), /different reference/);
});
