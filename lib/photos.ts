// Watch photos. Model photos are keyed by exact reference number and shown wherever that model appears;
// piece photos belong to one physical watch and are shown for drops and for what a customer actually pulled.
// Every upload is auto-rotated, resized to 1600px on its long edge and saved as WebP, with a 480px thumbnail.
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { db, tx } from './db.ts';
import { audit, UserError } from './engine.ts';

export const ANGLES = [
  ['dial', 'Dial, straight on'], ['three-quarter', 'Three-quarter angle'], ['caseback', 'Caseback'],
  ['clasp', 'Clasp and bracelet'], ['wrist', 'On the wrist'], ['box-papers', 'Box and papers'],
] as const;
export type Angle = (typeof ANGLES)[number][0];
const ANGLE_IDS = new Set<string>(ANGLES.map(([a]) => a));

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const FILE_RE = /^[a-f0-9]{32}(-t)?\.webp$/;

export function uploadDir() {
  const dir = process.env.HB_UPLOAD_DIR
    || (process.env.HB_DB_PATH ? join(dirname(resolve(process.env.HB_DB_PATH)), 'uploads') : join(process.cwd(), 'data', 'uploads'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const photoUrl = (file: string) => `/media/${file}`;

export type Photo = { id: number; reference: string; watch_id: number | null; angle: string; file: string; thumb: string; width: number; height: number; sort: number; created_at: string };

export async function savePhoto(actorId: number, input: { reference: string; watchId?: number | null; angle: string; bytes: Buffer }) {
  const reference = input.reference.trim();
  if (!reference) throw new UserError('Pick the watch model the photo shows.');
  if (!ANGLE_IDS.has(input.angle)) throw new UserError('Pick which angle the photo shows.');
  if (!input.bytes.length) throw new UserError('That file is empty.');
  if (input.bytes.length > MAX_UPLOAD_BYTES) throw new UserError('Photos can be up to 25 MB each.');
  if (input.watchId) {
    const w = db().prepare('SELECT reference FROM watches WHERE id = ?').get(input.watchId) as { reference: string } | undefined;
    if (!w) throw new UserError('That watch is not in inventory.');
    if (w.reference !== reference) throw new UserError('That watch has a different reference number.');
  }
  let meta;
  try { meta = await sharp(input.bytes).metadata(); } catch { meta = null; }
  if (!meta || !['jpeg', 'png', 'webp', 'heif', 'tiff'].includes(String(meta.format))) {
    throw new UserError('Upload a JPEG, PNG or WebP photo. On an iPhone, set Camera > Formats to Most Compatible, or share the photo as JPEG.');
  }
  const id = randomBytes(16).toString('hex');
  const file = `${id}.webp`, thumb = `${id}-t.webp`, dir = uploadDir();
  let full;
  try {
    full = await sharp(input.bytes).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 84 }).toBuffer({ resolveWithObject: true });
    const small = await sharp(input.bytes).rotate().resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    writeFileSync(join(dir, file), full.data); writeFileSync(join(dir, thumb), small);
  } catch {
    throw new UserError('That photo could not be read. Try exporting it as a JPEG.');
  }
  return tx((d) => {
    const next = (d.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM photos WHERE reference = ? AND watch_id IS ?').get(reference, input.watchId ?? null) as { n: number }).n;
    const r = d.prepare(`INSERT INTO photos (reference, watch_id, angle, file, thumb, width, height, sort, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(reference, input.watchId ?? null, input.angle, file, thumb, full.info.width, full.info.height, next, actorId, new Date().toISOString());
    audit(d, actorId, 'photo.add', JSON.stringify({ id: Number(r.lastInsertRowid), reference, watchId: input.watchId ?? null, angle: input.angle }));
    return Number(r.lastInsertRowid);
  });
}

export function deletePhoto(actorId: number, photoId: number) {
  const p = db().prepare('SELECT * FROM photos WHERE id = ?').get(photoId) as Photo | undefined;
  if (!p) throw new UserError('That photo was already removed.');
  tx((d) => { d.prepare('DELETE FROM photos WHERE id = ?').run(photoId); audit(d, actorId, 'photo.delete', JSON.stringify({ id: photoId, reference: p.reference })); });
  for (const f of [p.file, p.thumb]) { const path = join(uploadDir(), f); if (existsSync(path)) unlinkSync(path); }
}

/** Puts this photo first for its model (or piece); it becomes the one shown on cards and in boxes. */
export function makePrimary(actorId: number, photoId: number) {
  const p = db().prepare('SELECT * FROM photos WHERE id = ?').get(photoId) as Photo | undefined;
  if (!p) throw new UserError('That photo was already removed.');
  tx((d) => {
    const rows = d.prepare('SELECT id FROM photos WHERE reference = ? AND watch_id IS ? ORDER BY sort, id').all(p.reference, p.watch_id) as { id: number }[];
    const order = [photoId, ...rows.map((r) => r.id).filter((id) => id !== photoId)];
    const u = d.prepare('UPDATE photos SET sort = ? WHERE id = ?');
    order.forEach((id, i) => u.run(i, id));
    audit(d, actorId, 'photo.primary', JSON.stringify({ id: photoId }));
  });
}

/** Every model in inventory (by exact reference), with its photos and pieces, for the admin photo page. */
export function photoModels() {
  const models = db().prepare(`SELECT reference, MIN(brand) AS brand, MIN(model) AS model, COUNT(*) AS pieces, MAX(market_cents) AS market_cents
    FROM watches WHERE reference <> '' GROUP BY reference ORDER BY MAX(market_cents) DESC`).all() as { reference: string; brand: string; model: string; pieces: number; market_cents: number }[];
  const photos = db().prepare('SELECT * FROM photos ORDER BY reference, watch_id IS NOT NULL, watch_id, sort, id').all() as Photo[];
  const pieces = db().prepare(`SELECT id, reference, condition, papers, status FROM watches WHERE reference <> '' ORDER BY id`).all() as { id: number; reference: string; condition: string; papers: string; status: string }[];
  return models.map((m) => ({
    ...m,
    modelPhotos: photos.filter((p) => p.reference === m.reference && p.watch_id === null),
    piecePhotos: photos.filter((p) => p.reference === m.reference && p.watch_id !== null),
    pieceList: pieces.filter((p) => p.reference === m.reference),
  }));
}

/** The main photo for a model, or for one piece (falling back to its model's). Thumbnail by default. */
export function mainPhoto(reference: string | null | undefined, watchId?: number | null, size: 'thumb' | 'full' = 'thumb'): string | null {
  if (!reference) return null;
  const q = 'SELECT file, thumb FROM photos WHERE reference = ? AND watch_id IS ? ORDER BY sort, id LIMIT 1';
  const p = (watchId ? db().prepare(q).get(reference, watchId) : undefined) || db().prepare(q).get(reference, null);
  if (!p) return null;
  const r = p as { file: string; thumb: string };
  return photoUrl(size === 'full' ? r.file : r.thumb);
}

/** All photos to show for one piece: its own first, then its model's. */
export function galleryFor(reference: string, watchId?: number | null) {
  const own = watchId ? db().prepare('SELECT * FROM photos WHERE reference = ? AND watch_id = ? ORDER BY sort, id').all(reference, watchId) as Photo[] : [];
  const model = db().prepare('SELECT * FROM photos WHERE reference = ? AND watch_id IS NULL ORDER BY sort, id').all(reference) as Photo[];
  return [...own, ...model];
}
