'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Mark } from './Mark.tsx';
import { type Pocket, slices, slicePath, pointAt, shortLabel, landedIndex, landingRotation, tierOf } from '@/lib/wheel.ts';

const usd = (c: number) => `$${Math.round(c / 100).toLocaleString('en-US')}`;
const odds = (ppm: number) => (ppm >= 100_000 ? `${(ppm / 10_000).toFixed(0)}%` : ppm >= 10_000 ? `${(ppm / 10_000).toFixed(1)}%` : `${(ppm / 10_000).toFixed(2)}%`);

const BULBS = 28;

export function WheelFace({ pockets, rotation, spinning, size = 340, highlight, state = 'idle' }: {
  pockets: Pocket[]; rotation: number; spinning: boolean; size?: number; highlight?: number | null; state?: 'idle' | 'lit' | 'won';
}) {
  const S = slices(pockets); const C = 160; const CY = 180; const R = 140;
  return (
    <div className={`wheel ${state}`} style={{ width: size, maxWidth: '100%' }}>
      <svg viewBox="0 0 320 340" role="img" aria-label={`Roulette wheel with ${pockets.length} watches, each slice sized to its odds and coloured by value`}>
        <defs>
          <linearGradient id="rim-foil" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#8F6B2B" /><stop offset=".3" stopColor="#F4DE9C" /><stop offset=".5" stopColor="#B98E3C" />
            <stop offset=".7" stopColor="#FFF1C4" /><stop offset="1" stopColor="#9A7430" />
          </linearGradient>
          <radialGradient id="hub-glow" cx="50%" cy="40%" r="60%"><stop offset="0" stopColor="#1E4A39" /><stop offset="1" stopColor="#07150F" /></radialGradient>
        </defs>
        {/* fixed lit frame */}
        <circle cx={C} cy={CY} r={R + 16} fill="#07150F" stroke="url(#rim-foil)" strokeWidth="3" />
        <g>{Array.from({ length: BULBS }, (_, i) => { const [x, y] = pointAt(C, CY, R + 10, (i / BULBS) * 360 + 360 / BULBS / 2); return <circle key={i} className="bulb" cx={x} cy={y} r="2.6" />; })}</g>
        <g className={spinning ? 'wheel-rotor spinning' : 'wheel-rotor'} style={{ transform: `rotate(${rotation}deg)`, transformBox: 'view-box', transformOrigin: `${C}px ${CY}px` }}>
          <circle cx={C} cy={CY} r={R + 3} fill="url(#rim-foil)" />
          {S.map((s) => (
            <path key={s.index} d={slicePath(C, CY, R, s.start, s.end)} fill={s.fill}
              stroke={highlight === s.index ? '#FFFFFF' : '#07150F'} strokeWidth={highlight === s.index ? 3 : 0.9} />
          ))}
          {S.map((s) => {
            const span = s.end - s.start;
            if (span < 7) {
              const [x, y] = pointAt(C, CY, R - 5, s.mid);
              return <circle key={`t${s.index}`} cx={x} cy={y} r="3.4" fill="#FFF1C4" stroke="#07150F" strokeWidth="1" />;
            }
            // Labels run radially from the rim toward the hub, like the numbers on a real wheel.
            const fs = span > 30 ? 10.5 : span > 14 ? 9.5 : 8;
            return (
              <text key={`l${s.index}`} transform={`rotate(${s.mid - 90} ${C} ${CY})`} x={C + R - 10} y={CY + fs * 0.35}
                textAnchor="end" fontSize={fs} fill={s.ink} fontFamily="IBM Plex Sans, sans-serif" fontWeight={s.rank < 3 ? 700 : 600}>
                {shortLabel(s.label, span > 14 ? 17 : 13)}
              </text>
            );
          })}
          <circle cx={C} cy={CY} r="40" fill="url(#hub-glow)" stroke="url(#rim-foil)" strokeWidth="3" />
        </g>
        <foreignObject x={C - 30} y={CY - 30} width="60" height="60"><div style={{ display: 'grid', placeItems: 'center', width: 60, height: 60 }}><Mark size={56} /></div></foreignObject>
        {/* pointer */}
        <path d="M 160 50 L 147 18 Q 160 10 173 18 Z" fill="url(#rim-foil)" stroke="#07150F" strokeWidth="1.5" />
        <circle cx="160" cy="20" r="4" fill="#07150F" />
      </svg>
    </div>
  );
}

function Burst() {
  const flecks = Array.from({ length: 36 }, (_, i) => {
    const ang = (i / 36) * Math.PI * 2 + (i % 3) * 0.2;
    const dist = 120 + ((i * 37) % 90);
    return { x: Math.cos(ang) * dist, y: Math.sin(ang) * dist - 40, r: ((i * 53) % 540) - 270, d: (i % 6) * 0.04 };
  });
  return (
    <div className="burst" aria-hidden="true">
      {flecks.map((f, i) => <i key={i} style={{ ['--x' as string]: `${f.x}px`, ['--y' as string]: `${f.y}px`, ['--r' as string]: `${f.r}deg`, ['--d' as string]: `${f.d}s` }} />)}
    </div>
  );
}

export function Roulette({ pockets, onSpin }: { pockets: Pocket[]; onSpin: () => Promise<number> }) {
  const router = useRouter();
  const [rotation, setRotation] = useState(0);
  const [phase, setPhase] = useState<'ready' | 'spinning' | 'landed'>('ready');
  const [landed, setLanded] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);
  useEffect(() => { window.scrollTo(0, 0); }, []);

  const finish = () => {
    if (done.current) return; done.current = true;
    setPhase('landed');
    try { navigator.vibrate?.([30, 40, 60]); } catch { /* not supported */ }
    setTimeout(() => router.refresh(), 2200);
  };

  useEffect(() => {
    if (phase !== 'spinning') return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const t = setTimeout(finish, reduce ? 700 : 6200); // fallback if transitionend never fires
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const spin = async () => {
    setError(null); setPhase('spinning');
    try {
      const roll = await onSpin();
      setLanded(landedIndex(pockets, roll));
      setRotation(landingRotation(roll));
    } catch {
      setPhase('ready'); setError('Something went wrong. Your pull is safe; try again.');
    }
  };

  const legend = slices(pockets).sort((a, b) => b.valueCents - a.valueCents);
  const hit = landed != null ? pockets[landed] : null;
  const hitTier = hit ? tierOf(hit.valueCents) : null;
  const big = phase === 'landed' && !!hitTier && (hitTier.id === 'gold' || hitTier.id === 'platinum');

  return (
    <div className="stack" style={{ alignItems: 'center', gap: 18, textAlign: 'center' }}>
      <div style={{ position: 'relative' }} onTransitionEnd={(e) => { if (e.propertyName === 'transform' && landed != null) finish(); }}>
        <WheelFace pockets={pockets} rotation={rotation} spinning={phase !== 'ready'} highlight={phase === 'landed' ? landed : null}
          state={phase === 'spinning' ? 'lit' : phase === 'landed' ? 'won' : 'idle'} />
        {big && <Burst />}
      </div>
      <div aria-live="polite" className="stack" style={{ gap: 6, alignItems: 'center', minHeight: 64 }}>
        {phase === 'landed' && hit ? (
          <>
            {big ? <span className="bigpull">{hitTier!.label} pull</span> : <span className="eyebrow">The pointer stopped on</span>}
            <span className="serif" style={{ fontSize: '1.8rem', fontWeight: 700 }}>{hit.label}</span>
            <span className="mono brass">{usd(hit.valueCents)}</span>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-gold btn-xl" style={{ minWidth: 240 }} disabled={phase !== 'ready'} onClick={spin}>
              {phase === 'spinning' ? 'Spinning…' : 'Spin the wheel'}
            </button>
            <span className="muted" style={{ fontSize: '0.88rem', maxWidth: 340 }}>Every watch in this box is on the wheel. Slices are drawn to the real odds, and where the pointer stops is your verifiable roll.</span>
          </>
        )}
        {error && <span style={{ color: 'var(--bad)' }}>{error}</span>}
      </div>
      <details className="card" style={{ width: '100%', textAlign: 'left' }}>
        <summary style={{ cursor: 'pointer' }}>The {pockets.length} watch{pockets.length === 1 ? "" : "es"} on this wheel</summary>
        <ul className="legend">
          {legend.map((s) => (
            <li key={s.index} className={landed === s.index && phase === 'landed' ? 'hit' : ''}>
              <span className="swatch" style={{ background: s.fill }} />
              <span className="name">{s.label}</span>
              <span className="mono">{usd(s.valueCents)}</span>
              <span className="mono muted">{odds(s.oddsPpm)}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
