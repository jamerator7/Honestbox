import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Shell, Flash } from '@/components/Shell.tsx';
import { currentUser } from '@/lib/auth.ts';
import { getBox, bandsFor, boxState, settings, balance, activeSeed, buybackQuote, excludedStates } from '@/lib/engine.ts';
import { expectedValueCents, houseEdge } from '@/lib/fair.ts';
import { usd, oneIn, pct } from '@/lib/money.ts';
import { openBoxAction } from '../../actions.ts';
import { LeverMachine } from '@/components/LeverMachine.tsx';

export const dynamic = 'force-dynamic';

export default async function BoxPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string>> }) {
  const { slug } = await params; const sp = await searchParams;
  const box = getBox(slug);
  if (!box) notFound();
  const s = settings();
  const bands = bandsFor(box.id);
  const st = boxState(box, bands, s);
  const ev = expectedValueCents(bands);
  const edge = houseEdge(bands, box.price_cents);
  const user = await currentUser();
  const bal = user ? balance(user.id) : 0;
  // Creating the seed pair here means the hash is on screen before the very first pull.
  const seed = user ? activeSeed(user.id) : undefined;
  const blockedState = user && excludedStates(s).includes(user.state);
  const q = buybackQuote(10000, s);
  const pockets = bands.filter((b) => b.odds_ppm > 0).map((b) => ({ bandId: b.id, label: b.label, valueCents: b.value_cents, oddsPpm: b.odds_ppm }));
  const byValue = [...bands].sort((a, b) => b.value_cents - a.value_cents);

  return (
    <Shell tab="boxes">
      <div className="wrap page stack" style={{ gap: 22, maxWidth: 760 }}>
        <Link href="/boxes" className="muted" style={{ textDecoration: 'none' }}>← All boxes</Link>
        <Flash sp={sp} />
        <div className="between" style={{ alignItems: 'flex-end' }}>
          <div className="stack" style={{ gap: 4 }}>
            <span className="eyebrow">Box {box.numeral}</span>
            <h1 className="foil" style={{ fontSize: "2.8rem" }}>{box.name}</h1>
          </div>
          <span className="mono" style={{ fontSize: '2rem' }}>{usd(box.price_cents)}</span>
        </div>

        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
          <div className="card stack" style={{ gap: 2, padding: 14 }}><span className="muted" style={{ fontSize: '0.8rem' }}>Expected value</span><span className="mono" style={{ fontSize: '1.3rem' }}>{usd(ev)}</span></div>
          <div className="card stack" style={{ gap: 2, padding: 14 }}><span className="muted" style={{ fontSize: '0.8rem' }}>House edge</span><span className="mono brass" style={{ fontSize: '1.3rem' }}>{(edge * 100).toFixed(1)}%</span></div>
          <div className="card stack" style={{ gap: 2, padding: 14 }}><span className="muted" style={{ fontSize: '0.8rem' }}>Sell back any pull</span><span className="mono" style={{ fontSize: '1.05rem', lineHeight: 1.35 }}>{q.credit / 100}% as credit<br />{q.cash / 100}% as cash</span></div>
        </div>

        <h2 className="eyebrow" style={{ fontFamily: 'var(--sans)' }}>The drum: {pockets.length} watches</h2>
        <div className="stack" style={{ alignItems: 'center', gap: 8 }}>
          <LeverMachine mode="preview" pockets={pockets} title={box.name} price={box.price_cents} />
          <p className="muted" style={{ fontSize: '0.9rem', textAlign: 'center', maxWidth: 440 }}>Every watch in the box is a panel on the drum, and each panel&apos;s height is its real share of the odds. The rarest pieces are the thin bright strips. Where the payline stops is your roll, and you can verify it.</p>
        </div>
        <h2 className="eyebrow" style={{ fontFamily: 'var(--sans)' }}>What&apos;s inside, highest value first</h2>
        <div className="stack" style={{ gap: 0, borderTop: '1px solid var(--rule)' }}>
          {byValue.map((b) => (
            <div key={b.id} className="stack" style={{ gap: 6, padding: '12px 0', borderBottom: '1px solid var(--rule)' }}>
              <div className="between"><span style={{ fontWeight: 600 }}>{b.label}</span><span className="mono">{usd(b.value_cents)}</span></div>
              <div className="row" style={{ gap: 12, flexWrap: 'nowrap' }}>
                <div className="bar" style={{ flex: 1 }}><span style={{ width: `${Math.max(1.5, Math.min(100, (b.odds_ppm / bands.reduce((m, x) => Math.max(m, x.odds_ppm), 1)) * 100))}%` }} /></div>
                <span className="mono muted" style={{ fontSize: '0.85rem', minWidth: 150, textAlign: 'right' }}>{pct(b.odds_ppm)} · {oneIn(b.odds_ppm)}</span>
              </div>
              <span className="quiet" style={{ fontSize: '0.8rem' }}>{b.stock} in the vault</span>
            </div>
          ))}
        </div>
        <p className="italic brass" style={{ fontSize: '1.05rem' }}>Nothing hidden. That&apos;s the Honest Abe rule.</p>
        <p className="muted" style={{ fontSize: '0.9rem' }}>Values are the average of recent verified sales. Every prize on this table is authenticated and in our insured vault before the box can be opened.</p>

        <div className="card stack" style={{ gap: 12 }}>
          {!user ? (
            <Link href={`/signin?next=/boxes/${box.slug}`} className="btn btn-gold btn-block">Sign in to open</Link>
          ) : !st.openable ? (
            <p>{st.reason}</p>
          ) : blockedState ? (
            <p>Boxes are not available in your state yet. <Link href="/drops">Drops are open.</Link></p>
          ) : (
            <form action={openBoxAction} className="stack" style={{ gap: 10 }}>
              <input type="hidden" name="slug" value={box.slug} />
              <button className="btn btn-gold btn-block" disabled={bal < box.price_cents}>Open for {usd(box.price_cents)}</button>
              {bal < box.price_cents && <p className="muted" style={{ fontSize: '0.9rem' }}>You have {usd(bal)} in credit. <Link href="/account">Add credit</Link></p>}
            </form>
          )}
          {seed && (
            <p className="quiet" style={{ fontSize: '0.8rem', wordBreak: 'break-all' }}>
              Provably fair. Your next pull uses server seed hash <span className="mono">{seed.server_hash.slice(0, 16)}…</span>, client seed <span className="mono">{seed.client_seed}</span>, nonce {seed.next_nonce}. <Link href="/fair">How to verify</Link>
            </p>
          )}
          <Link href="/legal/free-entry" className="quiet" style={{ fontSize: '0.85rem', textAlign: 'center' }}>No purchase necessary. Free entry rules</Link>
        </div>
      </div>
    </Shell>
  );
}
