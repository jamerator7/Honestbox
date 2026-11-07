import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Shell, Flash } from '@/components/Shell.tsx';
import { WatchPhoto } from '@/components/WatchPhoto.tsx';
import { mainPhoto } from '@/lib/photos.ts';
import { Roulette, WheelFace } from '@/components/Roulette.tsx';
import { pocketsOf, landedIndex } from '@/lib/wheel.ts';
import { requireUser } from '@/lib/auth.ts';
import { getPull, buybackQuote, settings, shipFee, valueBasis, flag } from '@/lib/engine.ts';
import { usd, oneIn } from '@/lib/money.ts';
import { revealAction, lockAction } from '../../actions.ts';

export const dynamic = 'force-dynamic';

export default async function PullPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { id } = await params; const sp = await searchParams;
  const user = await requireUser(`/pulls/${id}`);
  const p = getPull(user.id, Number(id));
  if (!p) notFound();
  const s = settings();
  const q = buybackQuote(valueBasis(p), s);
  const change = p.market_cents - p.value_cents;
  const changePct = p.value_cents ? (change / p.value_cents) * 100 : 0;
  const daysLeft = Math.max(0, Math.ceil((Date.parse(p.hold_until) - Date.now()) / 86400_000));
  const reveal = revealAction.bind(null, p.id);
  const pockets = pocketsOf(p.odds_snapshot);

  return (
    <Shell tab="vault">
      <div className="narrow page stack" style={{ gap: 20 }}>
        <span className="eyebrow">{p.box_name} · {usd(p.price_cents)} · pull #{p.id}</span>
        <Flash sp={sp} />
        {!p.revealed ? <Roulette pockets={pockets} onSpin={reveal} /> : (
          <div className="stack rise" style={{ gap: 18 }}>
            <div style={{ display: 'grid', placeItems: 'center' }}>
              <WheelFace pockets={pockets} rotation={-(p.roll_ppm / 1_000_000) * 360} spinning={false} size={230} highlight={landedIndex(pockets, p.roll_ppm)} />
            </div>
            <div className="cert stack" style={{ alignItems: 'center', gap: 14, textAlign: 'center', padding: '24px 20px' }}>
              <span className="pill pill-brass">{p.band_odds >= 500_000 ? 'Most common pull' : `${oneIn(p.band_odds)} pull`}</span>
              <WatchPhoto src={mainPhoto(p.reference, p.watch_id, 'full')} brand={p.brand} size={220} alt={`${p.brand} ${p.model}, reference ${p.reference}`} />
              <div className="stack" style={{ gap: 4 }}>
                <h1 style={{ fontSize: '2rem' }}>{p.brand} {p.model}</h1>
                <span className="muted" style={{ fontSize: '0.9rem' }}>{[p.reference && `Ref. ${p.reference}`, p.size_mm && `${p.size_mm} mm`, p.year, p.condition, p.papers].filter(Boolean).join(' · ')}</span>
              </div>
              <div className="stack" style={{ gap: 2 }}>
                <span className="mono brass" style={{ fontSize: '1.9rem' }}>{usd(p.market_cents)}</span>
                <span className="muted" style={{ fontSize: '0.85rem' }}>
                  {p.sales_count ? `Today's value: average of ${p.sales_count} recent sales, ${usd(p.sales_low_cents!)} to ${usd(p.sales_high_cents!)}` : "Today's market value"}
                </span>
                {change !== 0 && (
                  <span className="mono" style={{ fontSize: '0.85rem', color: change > 0 ? 'var(--good)' : 'var(--bad)' }}>
                    {change > 0 ? '▲' : '▼'} {usd(Math.abs(change))} ({changePct > 0 ? '+' : ''}{changePct.toFixed(1)}%) since you pulled it at {usd(p.value_cents)}
                  </span>
                )}
              </div>
            </div>

            {p.status === 'vault' && (
              <div className="stack" style={{ gap: 10 }}>
                <Link href={`/pulls/${p.id}/sell`} className="btn btn-gold btn-block" style={{ justifyContent: 'space-between' }}><span>Sell it back now</span><span className="mono">{usd(q.credit)}</span></Link>
                <Link href={`/pulls/${p.id}/ship`} className="btn btn-block" style={{ justifyContent: 'space-between' }}><span>Ship it to me</span><span className="muted" style={{ fontWeight: 400, fontSize: '0.9rem' }}>{shipFee(p.market_cents, s) ? `${usd(shipFee(p.market_cents, s))} · insured` : 'Free · insured, 3–5 days'}</span></Link>

                <div className="card stack" style={{ gap: 10 }}>
                  <span className="serif" style={{ fontWeight: 700, fontSize: '1.2rem' }}>Keep it in your vault</span>
                  {p.locked_cents == null ? (
                    <>
                      <p className="muted" style={{ fontSize: '0.9rem', lineHeight: 1.55 }}>
                        Its buyback follows the market. Whenever you sell, you get the market value that day minus 10%. If the watch goes up, so does your payout. You have {daysLeft} days; after that we buy it back for credit at that day&apos;s value.
                      </p>
                      {flag(s, 'lock_enabled') && (
                        <form action={lockAction} className="stack" style={{ gap: 6 }}>
                          <input type="hidden" name="pull" value={p.id} />
                          <button className="btn btn-block" style={{ justifyContent: 'space-between' }}><span>Lock in today&apos;s value</span><span className="mono">{usd(p.market_cents)}</span></button>
                          <span className="quiet" style={{ fontSize: '0.8rem' }}>Locking is permanent: you&apos;re protected if the price falls, but you won&apos;t gain if it rises.</span>
                        </form>
                      )}
                      <Link href="/vault" className="btn btn-block" style={{ border: 0, color: 'var(--muted)', minHeight: 40 }}>Keep it floating</Link>
                    </>
                  ) : (
                    <p className="muted" style={{ fontSize: '0.9rem', lineHeight: 1.55 }}>
                      <span className="pill pill-brass" style={{ marginRight: 8 }}>Locked</span>
                      Value locked at <span className="mono" style={{ color: 'var(--ivory)' }}>{usd(p.locked_cents)}</span> on {new Date(p.locked_at!).toLocaleDateString('en-US', { dateStyle: 'medium' })}. Sell it back any time in the next {daysLeft} days for {usd(q.credit)} in credit, whatever the market does.
                    </p>
                  )}
                </div>
              </div>
            )}
            {p.status === 'sold_back' && <p className="card">You sold this pull back. <Link href="/account">See your credit</Link></p>}
            {p.status === 'ship_requested' && <p className="card">Shipping requested. We will email tracking when it leaves the vault.</p>}
            {p.status === 'shipped' && <p className="card">Shipped. Check your email for tracking.</p>}

            <details className="card" style={{ fontSize: '0.85rem' }}>
              <summary style={{ cursor: 'pointer' }}>Verify this pull</summary>
              <div className="stack" style={{ gap: 6, marginTop: 10, wordBreak: 'break-all' }}>
                <span>Server seed hash: <span className="mono">{p.server_hash}</span></span>
                <span>Client seed: <span className="mono">{p.client_seed}</span> · Nonce: <span className="mono">{p.nonce}</span></span>
                <span>Roll: <span className="mono">{p.roll_ppm.toLocaleString('en-US')}</span> of 1,000,000, so the pointer stopped {((p.roll_ppm / 1_000_000) * 360).toFixed(2)}° clockwise from the start of the first slice · Watch: {p.band_label}</span>
                {p.revealed_at
                  ? <span>Server seed (revealed): <span className="mono">{p.server_seed}</span></span>
                  : <span className="muted">The server seed is revealed when you rotate your seed on the <Link href="/fair">provably fair</Link> page.</span>}
              </div>
            </details>
          </div>
        )}
      </div>
    </Shell>
  );
}
