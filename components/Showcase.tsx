import Link from 'next/link';
import { WatchArt, artFor } from './Mark.tsx';
import { tierOf } from '@/lib/wheel.ts';
import { usd, oneIn } from '@/lib/money.ts';

/** Banknote-style guilloché rosette: rotated copies of a wavy ring, drawn as engraving lines. */
export function Rosette({ className = 'rosette' }: { className?: string }) {
  const C = 300; const rings: string[] = [];
  for (let ring = 0; ring < 3; ring++) {
    const R = 120 + ring * 52, a = 16 + ring * 4, k = 12 + ring * 6, copies = 14;
    for (let c = 0; c < copies; c++) {
      const off = (c / copies) * ((2 * Math.PI) / k);
      let d = '';
      for (let i = 0; i <= 360; i++) {
        const t = (i / 360) * 2 * Math.PI;
        const r = R + a * Math.sin(k * t + off * k);
        d += `${i ? 'L' : 'M'}${(C + r * Math.cos(t)).toFixed(1)} ${(C + r * Math.sin(t)).toFixed(1)}`;
      }
      rings.push(d + 'Z');
    }
  }
  return (
    <svg className={className} viewBox="0 0 600 600" aria-hidden="true">
      <defs>
        <radialGradient id="ros-fade" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#E2BF66" stopOpacity="0.55" /><stop offset="100%" stopColor="#E2BF66" stopOpacity="0.08" />
        </radialGradient>
      </defs>
      <g fill="none" stroke="url(#ros-fade)" strokeWidth="0.6">{rings.map((d, i) => <path key={i} d={d} />)}</g>
    </svg>
  );
}

export type Pull = { id: number; who: string; watch: string; valueCents: number; box: string; slug: string; at: string };

function ago(iso: string) {
  const m = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}

/** Live feed of real, revealed pulls. Hidden until there are enough to be worth showing. */
export function Ticker({ pulls }: { pulls: Pull[] }) {
  if (pulls.length < 3) return null;
  const chips = (copy: number) => pulls.map((p) => {
    const t = tierOf(p.valueCents);
    return (
      <Link key={`${copy}-${p.id}`} href={`/boxes/${p.slug}`} className={`chip is-${t.id}`} tabIndex={copy ? -1 : 0} aria-hidden={copy ? true : undefined}>
        <span className={`dot t-${t.id}`} />
        <span>{p.who} pulled <strong>{p.watch}</strong></span>
        <span className="mono">{usd(p.valueCents)}</span>
        <span className="quiet">{p.box} · {ago(p.at)}</span>
      </Link>
    );
  });
  return (
    <section className="ticker" aria-label="Latest pulls">
      <span className="ticker-live">Live pulls</span>
      <div className="ticker-track" style={{ paddingLeft: 120 }}>{chips(0)}{chips(1)}</div>
    </section>
  );
}

export type TicketBox = {
  slug: string; name: string; numeral: string; priceCents: number; watches: number;
  top: { label: string; valueCents: number; oddsPpm: number }; bigPpm: number; evCents: number; edge: number;
  closed?: string | null;
};

const TIER_BAND: Record<string, string> = {
  platinum: 'linear-gradient(90deg, #BFD3CC, #FFFFFF, #9EF0CF, #FFFFFF, #BFD3CC)',
  gold: 'var(--foil)',
  silver: 'linear-gradient(90deg, #8E9A9E, #F1F5F6, #8E9A9E)',
  copper: 'linear-gradient(90deg, #9C5A30, #E9A77A, #9C5A30)',
};

export function Ticket({ b, hot, back, as = 'link' }: { b: TicketBox; hot?: boolean; back?: boolean; as?: 'link' | 'div' }) {
  const t = tierOf(b.top.valueCents);
  const art = artFor(b.top.label.split(' ')[0]);
  const body = (
    <>
      <span className="seal">{b.numeral}</span>
      <span className="name">{b.name}</span>
      <span className="price">{usd(b.priceCents)}</span>
      <span className="prize">
        <WatchArt size={36} dial={art.dial} bezel={art.bezel} />
        <span className="stack" style={{ gap: 0, minWidth: 0 }}>
          <span style={{ fontSize: '0.78rem', color: 'var(--muted)' }}>Top prize</span>
          <span style={{ fontWeight: 600, lineHeight: 1.25 }}>{b.top.label}</span>
          <span className="mono" style={{ color: t.id === 'platinum' ? '#9EF0CF' : 'var(--brass-hi)', fontSize: '0.9rem' }}>{usd(b.top.valueCents)} · {oneIn(b.top.oddsPpm)}</span>
        </span>
      </span>
      <span className="facts">
        <span>Watches</span><b>{b.watches}</b>
        <span>$3,500 or more</span><b>{b.bigPpm ? oneIn(b.bigPpm) : 'None'}</b>
        <span>Expected value</span><b>{usd(b.evCents)}</b>
        <span>House edge</span><b>{(b.edge * 100).toFixed(0)}%</b>
      </span>
      {b.closed ? <span className="pill" style={{ alignSelf: 'flex-start' }}>{b.closed}</span>
        : <span className={`btn ${hot ? 'btn-gold' : ''} btn-block go`}>Spin for {usd(b.priceCents)}</span>}
    </>
  );
  const cls = `ticket engraved${hot ? ' hot' : ''}${back ? ' back' : ''}`;
  const style = { ['--tier' as string]: TIER_BAND[t.id] } as React.CSSProperties;
  if (as === 'div') return <div className={cls} style={style} aria-hidden={back || undefined}>{body}</div>;
  return <Link href={`/boxes/${b.slug}`} className={cls} style={style} aria-label={`${b.name}, ${usd(b.priceCents)}, top prize ${b.top.label}`}>{body}</Link>;
}
