import Link from 'next/link';
import { Shell, Flash } from '@/components/Shell.tsx';
import { WatchPhoto } from '@/components/WatchPhoto.tsx';
import { mainPhoto } from '@/lib/photos.ts';
import { currentDrop } from '@/lib/engine.ts';
import { usd } from '@/lib/money.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Drops' };

function left(iso: string) {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return 'Ended';
  const d = Math.floor(ms / 86400_000), h = Math.floor((ms % 86400_000) / 3600_000);
  return d > 0 ? `Ends in ${d}d ${h}h` : `Ends in ${h}h ${Math.floor((ms % 3600_000) / 60_000)}m`;
}

export default async function Drops({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const drop = currentDrop();
  return (
    <Shell tab="drops">
      <div className="wrap page stack" style={{ gap: 22, maxWidth: 900 }}>
        <Flash sp={sp} />
        {!drop ? (
          <div className="card"><h1 style={{ fontSize: '2rem' }}>The next drop is on its way.</h1><p className="muted">Drops open weekly. Check back soon.</p></div>
        ) : (
          <>
            <div className="between" style={{ alignItems: 'flex-end' }}>
              <div className="stack" style={{ gap: 4 }}><span className="eyebrow">{drop.title} · Series {new Date(drop.starts_at).getFullYear()}</span><h1 style={{ fontSize: '2.4rem' }}>This week&apos;s drop</h1></div>
              <span className="pill mono">{left(drop.ends_at)}</span>
            </div>
            <p className="muted" style={{ maxWidth: '40rem' }}>No box, no odds. Each piece has one fixed honest price, set at or under the average of its recent sales. Hold a piece for 10 minutes while you check out.</p>
            <div className="grid">
              {drop.items.map((it) => {
                return (
                  <Link key={it.item_id} href={`/drops/${it.item_id}`} className="cert stack" style={{ textDecoration: 'none', color: 'var(--ivory)', gap: 12, opacity: it.item_status === 'sold' ? 0.6 : 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'center' }}><WatchPhoto src={mainPhoto(it.reference, it.id)} brand={it.brand} size={170} alt={`${it.brand} ${it.model}`} /></div>
                    <span className="serif" style={{ fontWeight: 700, fontSize: '1.4rem' }}>{it.brand} {it.model}</span>
                    <span className="muted" style={{ fontSize: '0.85rem' }}>{[it.reference && `Ref. ${it.reference}`, it.year, it.papers].filter(Boolean).join(' · ')}</span>
                    <div className="between"><span className="muted" style={{ fontSize: '0.85rem' }}>Honest price</span><span className="mono brass" style={{ fontSize: '1.4rem' }}>{usd(it.price_cents)}</span></div>
                    <div className="between"><span className="muted" style={{ fontSize: '0.85rem' }}>Recent sales average</span><span className="mono">{usd(it.market_cents)}</span></div>
                    <span className="pill" style={{ alignSelf: 'flex-start' }}>{it.item_status === 'sold' ? 'Sold' : it.item_status === 'held' ? 'Someone is checking out' : 'Available'}</span>
                  </Link>
                );
              })}
            </div>
          </>
        )}
      </div>
    </Shell>
  );
}
