import Link from 'next/link';
import { Shell, Flash } from '@/components/Shell.tsx';
import { Ticker, Ticket } from '@/components/Showcase.tsx';
import { TierScale } from '@/components/TierScale.tsx';
import { recentPulls } from '@/lib/engine.ts';
import { ticketBoxes } from '@/lib/showcase.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Boxes' };

export default async function Boxes({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const tickets = ticketBoxes();
  return (
    <Shell tab="boxes">
      <Ticker pulls={recentPulls(14)} />
      <div className="wrap page stack" style={{ gap: 22 }}>
        <Flash sp={sp} />
        <div className="between" style={{ alignItems: 'flex-end' }}>
          <div className="stack" style={{ gap: 6 }}>
            <h1 className="foil" style={{ fontSize: 'clamp(2.2rem, 5vw, 3.4rem)' }}>Pick your wheel</h1>
            <p className="muted">Every value from real sales. Every house edge printed. Slice colours show what a watch is worth.</p>
          </div>
          <TierScale />
        </div>
        <div className="tickets">{tickets.map((b) => <Ticket key={b.slug} b={b} hot={b.slug === 'president'} />)}</div>
        <Link href="/drops" className="ticket engraved" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <span className="stack" style={{ gap: 2 }}>
            <span className="eyebrow">This week&apos;s drop</span>
            <span className="serif" style={{ fontWeight: 700, fontSize: '1.4rem' }}>No wheel, no odds. Fixed honest prices.</span>
          </span>
          <span className="btn">View the drop</span>
        </Link>
      </div>
    </Shell>
  );
}
