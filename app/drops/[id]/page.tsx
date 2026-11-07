import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Shell, Flash } from '@/components/Shell.tsx';
import { WatchPhoto } from '@/components/WatchPhoto.tsx';
import { galleryFor, photoUrl } from '@/lib/photos.ts';
import { AddressFields } from '@/components/AddressFields.tsx';
import { currentUser } from '@/lib/auth.ts';
import { dropItem, balance } from '@/lib/engine.ts';
import { usd } from '@/lib/money.ts';
import { holdAction, releaseAction, buyAction } from '../../actions.ts';

export const dynamic = 'force-dynamic';

export default async function DropItemPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { id } = await params; const sp = await searchParams;
  const it = dropItem(Number(id));
  if (!it) notFound();
  const user = await currentUser();
  const mine = user && it.item_status === 'held' && it.held_by === user.id;
  const mins = it.held_until ? Math.max(0, Math.ceil((Date.parse(it.held_until) - Date.now()) / 60_000)) : 0;
  const gallery = galleryFor(it.reference, it.id);
  const bal = user ? balance(user.id) : 0;
  const under = it.market_cents - it.price_cents;

  return (
    <Shell tab="drops">
      <div className="narrow page stack" style={{ gap: 20 }}>
        <Link href="/drops" className="muted" style={{ textDecoration: 'none' }}>← This week&apos;s drop</Link>
        <Flash sp={sp} />
        <div className="cert stack" style={{ gap: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'center' }}><WatchPhoto src={gallery[0] ? photoUrl(gallery[0].file) : null} brand={it.brand} size={260} alt={`${it.brand} ${it.model}, reference ${it.reference}`} /></div>
          {gallery.length > 1 && <div className="row" style={{ justifyContent: 'center', gap: 8 }}>{gallery.slice(1, 7).map((g) => <a key={g.id} href={photoUrl(g.file)} target="_blank" rel="noreferrer"><img className="wphoto" src={photoUrl(g.thumb)} alt={`${it.brand} ${it.model}, ${g.angle.replace('-', ' ')}`} width={72} height={72} style={{ width: 72, height: 72, borderRadius: 10 }} loading="lazy" /></a>)}</div>}
          <div className="stack" style={{ gap: 4 }}>
            <h1 style={{ fontSize: '2rem' }}>{it.brand} {it.model}</h1>
            <span className="muted">{[it.reference && `Ref. ${it.reference}`, it.size_mm && `${it.size_mm} mm`, it.year].filter(Boolean).join(' · ')}</span>
          </div>
          <div className="between" style={{ alignItems: 'flex-end' }}>
            <div className="stack" style={{ gap: 2 }}><span className="muted" style={{ fontSize: '0.85rem' }}>Honest price</span><span className="mono brass" style={{ fontSize: '1.9rem' }}>{usd(it.price_cents)}</span></div>
            <div className="stack" style={{ gap: 2, textAlign: 'right' }}><span className="muted" style={{ fontSize: '0.85rem' }}>Average of {it.sales_count} recent sales</span><span className="mono">{usd(it.market_cents)}</span></div>
          </div>
          {under > 0 && <span className="italic brass">{usd(under)} under the recent sales average.</span>}
          <div className="row" style={{ gap: 8 }}>
            <span className="pill">{it.condition} condition</span><span className="pill">{it.papers}</span>{it.authenticated ? <span className="pill">Authenticated</span> : null}
          </div>
        </div>

        {it.item_status === 'sold' ? (
          <p className="card">{it.sold_to === user?.id ? 'You bought this piece. It is on its way.' : 'Sold. Another collector got there first.'}</p>
        ) : !user ? (
          <Link href={`/signin?next=/drops/${it.item_id}`} className="btn btn-gold btn-block">Sign in to buy</Link>
        ) : mine ? (
          <div className="stack">
            <p className="card"><strong className="brass">Held for you for {mins} more minute{mins === 1 ? '' : 's'}.</strong> Enter your shipping address to buy with your credit ({usd(bal)} available).</p>
            <form action={buyAction} className="stack">
              <input type="hidden" name="item" value={it.item_id} />
              <AddressFields name={user.name} state={user.state} />
              <button className="btn btn-gold btn-block" disabled={bal < it.price_cents}>Buy for {usd(it.price_cents)}</button>
              {bal < it.price_cents && <p className="muted">You need {usd(it.price_cents - bal)} more credit. <Link href="/account">Add credit</Link></p>}
            </form>
            <form action={releaseAction}><input type="hidden" name="item" value={it.item_id} /><button className="linkish" style={{ width: '100%' }}>Release it</button></form>
          </div>
        ) : it.item_status === 'held' ? (
          <p className="card">Someone is checking out with this piece. If they don&apos;t buy it within a few minutes, it comes back.</p>
        ) : (
          <form action={holdAction}><input type="hidden" name="item" value={it.item_id} /><button className="btn btn-gold btn-block">Hold it for 10 minutes</button></form>
        )}
      </div>
    </Shell>
  );
}
