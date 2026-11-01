import Link from 'next/link';
import { Shell } from '@/components/Shell.tsx';
import { Rosette, Ticker, Ticket } from '@/components/Showcase.tsx';
import { currentDrop, buybackQuote, settings, recentPulls } from '@/lib/engine.ts';
import { ticketBoxes } from '@/lib/showcase.ts';
import { TierScale } from '@/components/TierScale.tsx';
import { usd } from '@/lib/money.ts';

export const dynamic = 'force-dynamic';

export default async function Landing() {
  const s = settings();
  const tickets = ticketBoxes();
  // Feature the open box with the richest top prize; the one behind it is the next best.
  const ranked = [...tickets].sort((a, b) => Number(!!a.closed) - Number(!!b.closed) || b.top.valueCents - a.top.valueCents || b.priceCents - a.priceCents);
  const front = ranked[0];
  const back = ranked[1] || ranked[0];
  const topPrize = tickets.reduce((m, b) => (b.top.valueCents > m.top.valueCents ? b : m), tickets[0]).top;
  const edge = Math.round(front.edge * 100);
  const drop = currentDrop();
  const lead = drop?.items.find((i) => i.item_status !== 'sold') || drop?.items[0];
  const q = buybackQuote(100, s);

  return (
    <Shell>
      <Ticker pulls={recentPulls(14)} />

      <section className="hero">
        <Rosette />
        <div className="wrap hero-grid">
          <div className="stack" style={{ gap: 24, position: 'relative' }}>
            <h1 className="foil">Spin the wheel for a real Rolex.</h1>
            <p className="lede">
              Every box is a wheel of 15 or more authenticated watches, each slice drawn to its real odds. Values come from real sales,
              the house edge is printed on the box, and anything you pull can be sold back on the spot.
            </p>
            <div className="row" style={{ gap: 14 }}>
              <Link href="/boxes" className="btn btn-gold btn-xl">Spin your first box</Link>
              <Link href="/boxes" className="btn btn-xl">See every watch and its odds</Link>
            </div>
            <div className="row" style={{ gap: 10 }}>
              <span className="chip is-platinum"><span className="dot t-platinum" />Top prize <strong>{topPrize.label}</strong><span className="mono">{usd(topPrize.valueCents)}</span></span>
              <span className="chip"><span className="dot t-gold" />House edge printed: {edge}%</span>
              <span className="chip"><span className="dot t-silver" />Sell back any pull for {q.credit}% in credit</span>
            </div>
          </div>
          <div className="showcase">
            <Ticket b={back} back as="div" />
            <Ticket b={front} hot />
          </div>
        </div>
      </section>

      <section className="wrap stack" style={{ paddingBlock: '24px 72px', gap: 22 }}>
        <div className="between" style={{ alignItems: 'flex-end' }}>
          <div className="stack" style={{ gap: 6 }}>
            <h2 style={{ fontSize: 'clamp(2rem, 4vw, 2.8rem)' }}>Pick your wheel</h2>
            <p className="muted">Five boxes from $100 to $2,000. Every watch on every wheel is in our vault before the box can open.</p>
          </div>
          <TierScale />
        </div>
        <div className="tickets">{tickets.map((b) => <Ticket key={b.slug} b={b} hot={b.slug === front.slug} />)}</div>
      </section>

      <section className="engraved" style={{ background: 'var(--deep)', borderBlock: '1px solid var(--rule)' }}>
        <div className="wrap stack" style={{ paddingBlock: 64, gap: 36 }}>
          <h2 style={{ fontSize: 'clamp(2rem, 4vw, 2.8rem)' }}>A flashy wheel with honest math.</h2>
          <div className="grid">
            {[
              ['Prices from real sales', 'Every watch is valued at the average of recent verified sales, with the sales listed. No inflated retail prices.'],
              ['Every edge printed', `Each box shows its odds, its expected value and its house edge before you spin. Ours is ${edge}%, and we say so. Where the pointer stops is your verifiable roll.`],
              ['A fair buyback, any pull', `Don't want what you pulled? Sell it back for ${q.credit}% of market value in credit or ${q.cash}% in cash.`],
            ].map(([h, p]) => (
              <div key={h} className="stack" style={{ gap: 10, borderTop: '2px solid var(--brass)', paddingTop: 18 }}>
                <h3 style={{ fontSize: '1.45rem' }}>{h}</h3>
                <p className="muted" style={{ lineHeight: 1.6 }}>{p}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {lead && (
        <section style={{ background: 'var(--foil)', color: '#1A1407' }}>
          <div className="wrap" style={{ paddingBlock: 64, display: 'flex', flexWrap: 'wrap', gap: 32, alignItems: 'center', justifyContent: 'space-between' }}>
            <div className="stack" style={{ flex: '1 1 460px', gap: 12 }}>
              <span className="eyebrow" style={{ color: '#1A1407' }}>{drop!.title}</span>
              <h2 style={{ fontSize: 'clamp(2rem, 4vw, 2.6rem)' }}>{lead.brand} {lead.model}{lead.reference ? `, ref. ${lead.reference}` : ''}</h2>
              <p style={{ fontSize: '1.1rem', maxWidth: '34rem' }}>No wheel, no odds. Curated pieces at fixed prices, set at or under the average of recent sales.</p>
            </div>
            <div className="stack" style={{ flex: '0 1 320px', gap: 12 }}>
              <div className="between" style={{ borderBottom: '1px solid rgba(26,20,7,.4)', paddingBottom: 10 }}><span>Honest price</span><span className="mono" style={{ fontSize: '1.6rem' }}>{usd(lead.price_cents)}</span></div>
              <div className="between"><span>Recent sales average</span><span className="mono">{usd(lead.market_cents)}</span></div>
              <Link href="/drops" className="btn" style={{ background: '#0D2219', color: 'var(--ivory)', borderColor: '#0D2219' }}>View the drop</Link>
            </div>
          </div>
        </section>
      )}

      <section className="wrap" style={{ paddingBlock: 72, display: 'flex', flexWrap: 'wrap', gap: 40 }}>
        <div className="stack" style={{ flex: '1 1 360px' }}>
          <h2 style={{ fontSize: '2.5rem' }}>The Honest Ledger</h2>
          <p className="muted" style={{ fontSize: '1.1rem', lineHeight: 1.6 }}>Every pull counted against the published odds, every buyback we paid, live. And every pull can be re-checked with our provably fair math.</p>
          <div className="row"><Link href="/ledger" className="btn">Read the ledger</Link><Link href="/fair">How provably fair works</Link></div>
        </div>
        <figure className="stack" style={{ flex: '1 1 420px', margin: 0, justifyContent: 'center', gap: 14 }}>
          <blockquote className="italic" style={{ margin: 0, fontSize: '2.1rem', lineHeight: 1.25 }}>“Let us have faith that right makes might.”</blockquote>
          <figcaption className="eyebrow">Abraham Lincoln, Cooper Union, 1860</figcaption>
        </figure>
      </section>
    </Shell>
  );
}
