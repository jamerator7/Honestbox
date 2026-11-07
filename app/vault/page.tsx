import Link from 'next/link';
import { Shell, Flash } from '@/components/Shell.tsx';
import { WatchPhoto } from '@/components/WatchPhoto.tsx';
import { mainPhoto } from '@/lib/photos.ts';
import { requireUser } from '@/lib/auth.ts';
import { db } from '@/lib/db.ts';
import { usd } from '@/lib/money.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'My vault' };

const LABEL: Record<string, string> = { vault: 'In your vault', sold_back: 'Sold back', ship_requested: 'Shipping requested', shipped: 'Shipped' };

export default async function Vault({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const user = await requireUser('/vault');
  const pulls = db().prepare(`SELECT p.id, p.status, p.revealed, p.hold_until, p.created_at, p.value_cents, p.locked_cents, p.watch_id, w.brand, w.model, w.reference, w.market_cents, b.name AS box_name
    FROM pulls p JOIN watches w ON w.id = p.watch_id JOIN boxes b ON b.id = p.box_id WHERE p.user_id = ? ORDER BY p.id DESC LIMIT 100`).all(user.id) as
    { id: number; status: string; revealed: number; hold_until: string; created_at: string; value_cents: number; locked_cents: number | null; watch_id: number; brand: string; model: string; reference: string; market_cents: number; box_name: string }[];
  const orders = db().prepare(`SELECT s.id, s.status, s.tracking, s.created_at, w.brand, w.model, i.price_cents FROM shipments s JOIN watches w ON w.id = s.watch_id
    JOIN drop_items i ON i.id = s.source_id WHERE s.user_id = ? AND s.source = 'drop' ORDER BY s.id DESC`).all(user.id) as
    { id: number; status: string; tracking: string | null; brand: string; model: string; price_cents: number }[];
  const held = pulls.filter((p) => p.status === 'vault');
  const value = held.reduce((a, p) => a + (p.locked_cents ?? p.market_cents), 0);

  return (
    <Shell tab="vault">
      <div className="wrap page stack" style={{ gap: 22, maxWidth: 820 }}>
        <Flash sp={sp} />
        <div className="between" style={{ alignItems: 'flex-end' }}>
          <h1 style={{ fontSize: '2.4rem' }}>My vault</h1>
          {held.length > 0 && <span className="muted">{held.length} watch{held.length === 1 ? '' : 'es'} worth <span className="mono" style={{ color: 'var(--ivory)' }}>{usd(value)}</span></span>}
        </div>
        {pulls.length === 0 && orders.length === 0 && (
          <div className="card stack" style={{ alignItems: 'flex-start' }}>
            <p>Nothing here yet. Watches you pull or buy will show up in your vault.</p>
            <Link href="/boxes" className="btn btn-gold">Open your first box</Link>
          </div>
        )}
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }}>
          {pulls.map((p) => {
            const days = Math.max(0, Math.ceil((Date.parse(p.hold_until) - Date.now()) / 86400_000));
            return (
              <Link key={p.id} href={`/pulls/${p.id}`} className={p.status === 'vault' ? 'cert stack' : 'card stack'} style={{ textDecoration: 'none', color: 'var(--ivory)', alignItems: 'center', textAlign: 'center', gap: 8 }}>
                {p.revealed ? <WatchPhoto src={mainPhoto(p.reference, p.watch_id)} brand={p.brand} size={110} alt={`${p.brand} ${p.model}`} /> : <span className="numeral" style={{ width: 90, height: 90, fontSize: '0.8rem' }}>Sealed</span>}
                <span className="serif" style={{ fontWeight: 700, fontSize: '1.1rem' }}>{p.revealed ? `${p.brand} ${p.model}` : 'Not revealed yet'}</span>
                <span className="mono brass">{p.revealed ? usd(p.locked_cents ?? p.market_cents) : '—'}</span>
                {p.revealed && p.status === 'vault' ? (
                  p.locked_cents != null
                    ? <span className="pill pill-brass" style={{ fontSize: '0.7rem' }}>Locked</span>
                    : p.market_cents !== p.value_cents
                      ? <span className="mono" style={{ fontSize: '0.8rem', color: p.market_cents > p.value_cents ? 'var(--good)' : 'var(--bad)' }}>{p.market_cents > p.value_cents ? '▲' : '▼'} {(((p.market_cents - p.value_cents) / p.value_cents) * 100).toFixed(1)}% since pulled</span>
                      : <span className="quiet" style={{ fontSize: '0.8rem' }}>Floating with the market</span>
                ) : null}
                <span className="muted" style={{ fontSize: '0.8rem' }}>{p.box_name} · {LABEL[p.status] || p.status}{p.status === 'vault' ? ` · ${days} days left` : ''}</span>
              </Link>
            );
          })}
        </div>
        {orders.length > 0 && (
          <section className="stack">
            <h2 style={{ fontSize: '1.6rem' }}>Drop purchases</h2>
            <div className="scroll"><table className="data">
              <thead><tr><th>Watch</th><th className="num">Price</th><th>Status</th></tr></thead>
              <tbody>{orders.map((o) => (
                <tr key={o.id}><td>{o.brand} {o.model}</td><td className="num">{usd(o.price_cents)}</td><td>{o.status === 'shipped' ? `Shipped · ${o.tracking}` : 'Preparing to ship'}</td></tr>
              ))}</tbody>
            </table></div>
          </section>
        )}
      </div>
    </Shell>
  );
}
