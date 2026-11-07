import { Shell, Flash } from '@/components/Shell.tsx';
import { AdminNav } from '@/components/AdminNav.tsx';
import { requireAdmin } from '@/lib/auth.ts';
import { ANGLES, photoModels, photoUrl } from '@/lib/photos.ts';
import { usd } from '@/lib/money.ts';
import { adminUploadPhotos, adminPhotoPrimary, adminPhotoDelete } from '../../actions.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Photos' };

const ANGLE_LABEL: Record<string, string> = Object.fromEntries(ANGLES);

function Thumbs({ photos, pieceLabel }: { photos: ReturnType<typeof photoModels>[number]['modelPhotos']; pieceLabel?: (id: number) => string }) {
  if (!photos.length) return null;
  return (
    <div className="photo-grid">
      {photos.map((p, i) => (
        <figure key={p.id} className="photo-card">
          <a href={photoUrl(p.file)} target="_blank" rel="noreferrer"><img src={photoUrl(p.thumb)} alt={`${ANGLE_LABEL[p.angle] || p.angle}`} loading="lazy" width={160} height={160} /></a>
          <figcaption>
            <span>{ANGLE_LABEL[p.angle] || p.angle}{pieceLabel && p.watch_id ? ` · ${pieceLabel(p.watch_id)}` : ''}</span>
            {i === 0 || (pieceLabel && photos.findIndex((x) => x.watch_id === p.watch_id) === i) ? <span className="pill pill-brass" style={{ fontSize: '0.7rem' }}>Main</span> : (
              <form action={adminPhotoPrimary}><input type="hidden" name="photo" value={p.id} /><button className="linkish">Make main</button></form>
            )}
            <form action={adminPhotoDelete}><input type="hidden" name="photo" value={p.id} /><button className="linkish danger">Remove</button></form>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

export default async function Photos({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  await requireAdmin();
  const sp = await searchParams;
  const models = photoModels();
  const done = models.filter((m) => m.modelPhotos.length).length;
  return (
    <Shell>
      <div className="wrap page stack" style={{ gap: 20 }}>
        <AdminNav here="/admin/photos" />
        <div className="between" style={{ alignItems: 'flex-end' }}>
          <div className="stack" style={{ gap: 6 }}>
            <h1 style={{ fontSize: '2.2rem' }}>Photos</h1>
            <p className="muted" style={{ maxWidth: '44rem' }}>Model photos show wherever that reference appears: box contents, the reveal, the vault. Piece photos belong to one physical watch and show for drops and for the exact watch a customer pulled. The first photo is the main one.</p>
          </div>
          <span className="pill">{done} of {models.length} models have photos</span>
        </div>
        <Flash sp={sp} />
        <details className="card">
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>How to shoot them</summary>
          <ul className="muted" style={{ lineHeight: 1.7, marginBottom: 0 }}>
            <li>Same plain background and soft, even light for every watch, so the site looks consistent.</li>
            <li>For each model: the dial straight on (this becomes the main photo), a three-quarter angle, the caseback and the clasp. Add box and papers when included.</li>
            <li>Fill the frame, keep it sharp, and wipe off fingerprints and dust. Phone photos are fine; up to 12 at a time, 25 MB each.</li>
            <li>Only photos you took or have the rights to. Never brand or dealer images from the web.</li>
          </ul>
        </details>

        {models.map((m) => (
          <section key={m.reference} id={`ref-${m.reference}`} className="card stack" style={{ gap: 14 }}>
            <div className="between" style={{ alignItems: 'flex-start' }}>
              <div className="stack" style={{ gap: 2 }}>
                <h2 style={{ fontSize: '1.35rem' }}>{m.brand} {m.model}</h2>
                <span className="mono quiet" style={{ fontSize: '0.85rem' }}>Ref. {m.reference} · {usd(m.market_cents)} · {m.pieces} in inventory</span>
              </div>
              <span className={`pill ${m.modelPhotos.length ? 'pill-brass' : ''}`}>{m.modelPhotos.length ? `${m.modelPhotos.length} model photo${m.modelPhotos.length === 1 ? '' : 's'}` : 'No photos yet'}</span>
            </div>
            <Thumbs photos={m.modelPhotos} />
            {m.piecePhotos.length > 0 && (
              <div className="stack" style={{ gap: 8 }}>
                <span className="eyebrow">Photos of individual pieces</span>
                <Thumbs photos={m.piecePhotos} pieceLabel={(id) => `#${id}`} />
              </div>
            )}
            <form action={adminUploadPhotos} className="row" style={{ gap: 10, alignItems: 'flex-end' }}>
              <input type="hidden" name="reference" value={m.reference} />
              <label htmlFor={`f-${m.reference}`} style={{ flex: '1 1 240px' }}>Photos
                <input id={`f-${m.reference}`} name="photos" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple required />
              </label>
              <label htmlFor={`a-${m.reference}`}>Angle
                <select id={`a-${m.reference}`} name="angle" defaultValue={m.modelPhotos.length ? 'three-quarter' : 'dial'}>{ANGLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              </label>
              <label htmlFor={`p-${m.reference}`}>Photos of
                <select id={`p-${m.reference}`} name="piece" defaultValue="">
                  <option value="">This model (all pieces)</option>
                  {m.pieceList.map((p) => <option key={p.id} value={p.id}>Piece #{p.id}, {p.condition}, {p.papers}</option>)}
                </select>
              </label>
              <button className="btn btn-gold">Upload</button>
            </form>
          </section>
        ))}
      </div>
    </Shell>
  );
}
