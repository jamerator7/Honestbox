'use client';
// The HonestBox lever machine: an arcade big-wheel cabinet seen from the front.
// The drum is a cylinder turning toward the viewer. Every watch in the box is a panel on the drum, and each panel's
// height around the drum is its real share of the odds, so a 1-in-700 Rolex is a thin gold strip and a common Casio
// is a wide panel. The brass flappers mark the payline. The drum stops with the payline at exactly
// roll / 1,000,000 of a turn, the same cumulative walk pickBand() uses, so where it stops is the verifiable roll.
// It never overshoots or creeps past a boundary, so nothing is staged to look like a near miss.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { type Pocket, PPM, tierOf, landedIndex } from '@/lib/wheel.ts';
import { watchImageSrc } from '@/lib/watchArt.ts';
import { usd, oneIn } from '@/lib/money.ts';

type Mode = 'live' | 'preview' | 'rest';
type Phase = 'ready' | 'spinning' | 'landed';

const VIEW = (62 * Math.PI) / 180; // half of the drum's arc visible through the window
const VMAX = 1.5;                   // top speed, turns per second
const SPIN_UP = 0.9;                // seconds of spin before the drum starts to settle, however fast the server answers
const EASE = 2.6;                   // deceleration curve: P(u) = 1 - (1 - u)^EASE
const MIN_TURNS = 3;
const TAU = Math.PI * 2;
const frac = (x: number) => x - Math.floor(x);

// ---------- sound: synthesized, no files ----------
class Sfx {
  ctx: AudioContext | null = null;
  muted = false;
  last = 0;
  ensure() {
    if (this.muted) return null;
    try {
      if (!this.ctx) {
        const C = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!C) return null;
        this.ctx = new C();
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return this.ctx;
    } catch { return null; }
  }
  tone(freq: number, dur: number, type: OscillatorType, gain: number, delay = 0, slideTo?: number) {
    const c = this.ensure(); if (!c) return;
    const t = c.currentTime + delay;
    const o = c.createOscillator(); const g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
  }
  noise(dur: number, gain: number, freq: number) {
    const c = this.ensure(); if (!c) return;
    const b = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate); const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const s = c.createBufferSource(); s.buffer = b;
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq;
    const g = c.createGain(); g.gain.value = gain;
    s.connect(f).connect(g).connect(c.destination); s.start();
  }
  clunk() { this.noise(0.16, 0.5, 700); this.tone(110, 0.22, 'sine', 0.6, 0, 40); }
  ratchet() { this.tone(420, 0.03, 'square', 0.04); }
  tick(speed: number) {
    const now = performance.now(); if (now - this.last < 28) return; this.last = now;
    this.tone(1500 + speed * 500, 0.022, 'square', 0.05);
  }
  land() { this.tone(988, 0.3, 'triangle', 0.22); this.tone(1480, 0.45, 'triangle', 0.16, 0.09); }
  big() {
    [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => this.tone(f, 0.55, 'triangle', 0.17, i * 0.085));
    for (let i = 0; i < 14; i++) this.tone(2600 + (i % 4) * 420, 0.09, 'sine', 0.05, 0.55 + i * 0.055);
  }
}

// ---------- drum drawing ----------
type Geo = { s: number; e: number }[];

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function fitText(ctx: CanvasRenderingContext2D, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 3 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, max: number, maxLines: number): string[] {
  const words = text.split(' '); const lines: string[] = []; let cur = '';
  for (let i = 0; i < words.length; i++) {
    const next = cur ? `${cur} ${words[i]}` : words[i];
    if (ctx.measureText(next).width <= max || !cur) { cur = next; continue; }
    if (lines.length === maxLines - 1) { cur = `${cur} ${words.slice(i).join(' ')}`; break; }
    lines.push(cur); cur = words[i];
  }
  lines.push(fitText(ctx, cur, max));
  return lines;
}

// Panel colours keep the site's value tiers (copper, silver, gold, platinum) and alternate light and dark within a tier.
const PANELS: Record<string, { bg: [string, string]; ink: string }[]> = {
  copper: [{ bg: ['#E39A5F', '#B4672F'], ink: '#2A1406' }, { bg: ['#86431E', '#5A2A10'], ink: '#FCE6D0' }],
  silver: [{ bg: ['#EEF2F3', '#AAB6BA'], ink: '#13201B' }, { bg: ['#5F6D72', '#3B464A'], ink: '#F1F5F6' }],
  gold: [{ bg: ['#FFE8A3', '#C8932B'], ink: '#2A1C04' }, { bg: ['#F4D27A', '#A97A22'], ink: '#2A1C04' }],
  platinum: [{ bg: ['#FFFFFF', '#BFD6CE'], ink: '#0D2219' }, { bg: ['#F4FBF8', '#A9C6BC'], ink: '#0D2219' }],
};

function drawDrum(ctx: CanvasRenderingContext2D, w: number, h: number, pockets: Pocket[], geo: Geo, P: number,
  imgs: Map<string, HTMLImageElement>, landed: number | null, glow: number) {
  ctx.clearRect(0, 0, w, h);
  const cy = h / 2; const R = cy / Math.sin(VIEW);
  const rail = Math.max(12, w * 0.045); // brass side rails carry the pegs
  const x0 = rail, x1 = w - rail, inner = x1 - x0;
  const rows: { i: number; y1: number; y2: number; mid: number; arc: number }[] = [];

  for (let i = 0; i < pockets.length; i++) {
    let aS = (P - geo[i].s) * TAU, aE = (P - geo[i].e) * TAU;
    const k = Math.round((aS + aE) / 2 / TAU); aS -= k * TAU; aE -= k * TAU;
    const top = Math.max(aE, -VIEW), bot = Math.min(aS, VIEW);
    if (top >= bot) continue;
    const y1 = cy + R * Math.sin(top), y2 = cy + R * Math.sin(bot);
    const tid = tierOf(pockets[i].valueCents).id; const pal = PANELS[tid][i % 2];
    const g = ctx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, pal.bg[1]); g.addColorStop(0.5, pal.bg[0]); g.addColorStop(1, pal.bg[1]);
    ctx.fillStyle = g; ctx.fillRect(x0, y1, inner, y2 - y1 + 0.6);
    if (tid === 'gold' || tid === 'platinum') {
      // foil sheen on the rare panels
      ctx.save(); ctx.beginPath(); ctx.rect(x0, y1, inner, y2 - y1); ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,.28)';
      for (let sx = x0 - h; sx < x1; sx += 46) { ctx.beginPath(); ctx.moveTo(sx, y2); ctx.lineTo(sx + 14, y2); ctx.lineTo(sx + 14 + (y2 - y1), y1); ctx.lineTo(sx + (y2 - y1), y1); ctx.fill(); }
      ctx.restore();
    }
    rows.push({ i, y1, y2, mid: (aS + aE) / 2, arc: R * (aS - aE) });
  }

  // panel contents, laid out by the panel's true size so nothing reflows while it turns
  for (const r of rows) {
    const p = pockets[r.i]; const t = tierOf(p.valueCents);
    const ink = PANELS[t.id][r.i % 2].ink;
    if (Math.abs(r.mid) >= Math.PI / 2) continue;
    const sy = Math.cos(r.mid); const yc = cy + R * Math.sin(r.mid);
    ctx.save(); ctx.beginPath(); ctx.rect(x0, r.y1, inner, r.y2 - r.y1); ctx.clip();
    ctx.translate(0, yc); ctx.scale(1, sy);
    if (r.arc >= 54) {
      const size = Math.min(r.arc * 0.8, inner * 0.3, 132);
      const img = imgs.get(p.label);
      const ix = x0 + inner * 0.05;
      ctx.fillStyle = 'rgba(7,21,15,.16)'; roundRect(ctx, ix - 4, -size / 2 - 4, size + 8, size + 8, 12); ctx.fill();
      if (img?.complete) ctx.drawImage(img, ix, -size / 2, size, size);
      const tx = ix + size + inner * 0.05; const tw = x1 - tx - inner * 0.04;
      const fs = Math.max(13, Math.min(22, r.arc * 0.17, inner * 0.062));
      ctx.fillStyle = ink; ctx.textBaseline = 'alphabetic';
      ctx.font = `700 ${fs}px "Old Standard TT", Georgia, serif`;
      const lines = wrapText(ctx, p.label, tw, r.arc >= 96 ? 2 : 1);
      const lh = fs * 1.08; const block = lines.length * lh + fs * 1.05 + fs * 0.9;
      let y = -block / 2 + fs * 0.85;
      for (const ln of lines) { ctx.fillText(ln, tx, y); y += lh; }
      ctx.font = `500 ${fs * 0.95}px "IBM Plex Mono", ui-monospace, monospace`;
      y += fs * 0.12; ctx.fillText(usd(p.valueCents), tx, y);
      ctx.globalAlpha = 0.72; ctx.font = `500 ${fs * 0.6}px "IBM Plex Mono", ui-monospace, monospace`;
      ctx.fillText(oneIn(p.oddsPpm).toUpperCase(), tx, y + fs * 0.9); ctx.globalAlpha = 1;
    } else if (r.arc >= 15) {
      const fs = Math.max(10, Math.min(14, r.arc * 0.6));
      const img = imgs.get(p.label); const isz = Math.min(r.arc * 0.86, 30);
      if (img?.complete && r.arc >= 22) ctx.drawImage(img, x0 + 8, -isz / 2, isz, isz);
      ctx.fillStyle = ink; ctx.textBaseline = 'middle';
      const lx = x0 + (r.arc >= 22 ? isz + 16 : 10);
      ctx.font = `600 ${fs}px "IBM Plex Sans", system-ui, sans-serif`;
      const val = usd(p.valueCents);
      ctx.font = `500 ${fs}px "IBM Plex Mono", ui-monospace, monospace`; const vw = ctx.measureText(val).width;
      ctx.fillText(val, x1 - 10 - vw, 0);
      ctx.font = `600 ${fs}px "IBM Plex Sans", system-ui, sans-serif`;
      ctx.fillText(fitText(ctx, p.label, x1 - 22 - vw - lx), lx, 0);
    } else if (t.id === 'gold' || t.id === 'platinum') {
      // a sliver: the rare watches. A bright strip with a jewel so it flashes past.
      ctx.fillStyle = t.id === 'platinum' ? '#FFFFFF' : '#FFF1C4';
      ctx.globalAlpha = 0.85; ctx.fillRect(x0, -Math.max(0.8, r.arc / 2), inner, Math.max(1.6, r.arc)); ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  // panel boundaries and pegs
  for (const r of rows) {
    const ang = (P - geo[r.i].e) * TAU; const a = ang - Math.round(ang / TAU) * TAU;
    if (Math.abs(a) > VIEW) continue;
    const y = cy + R * Math.sin(a); const s = Math.cos(a);
    ctx.fillStyle = 'rgba(7,21,15,.55)'; ctx.fillRect(x0, y - 1, inner, 2);
    for (const px of [rail / 2, w - rail / 2]) {
      ctx.beginPath(); ctx.ellipse(px, y, rail * 0.26, rail * 0.26 * s, 0, 0, TAU);
      ctx.fillStyle = '#FFF1C4'; ctx.fill(); ctx.strokeStyle = '#7A5A1E'; ctx.lineWidth = 1; ctx.stroke();
    }
  }

  // the landed panel lights up
  if (landed != null) {
    const r = rows.find((x) => x.i === landed);
    if (r) {
      ctx.save(); ctx.globalAlpha = 0.08 + 0.16 * glow; ctx.fillStyle = '#FFF6DA'; ctx.fillRect(x0, r.y1, inner, r.y2 - r.y1);
      ctx.globalAlpha = 1; ctx.strokeStyle = '#FFF1C4'; ctx.lineWidth = 3; ctx.strokeRect(x0 + 1.5, r.y1 + 1.5, inner - 3, r.y2 - r.y1 - 3); ctx.restore();
    }
  }

  // cylinder shading: dark toward the top and bottom, a lamp highlight just above the payline
  const sh = ctx.createLinearGradient(0, 0, 0, h);
  sh.addColorStop(0, 'rgba(3,10,7,.9)'); sh.addColorStop(0.2, 'rgba(3,10,7,.22)'); sh.addColorStop(0.42, 'rgba(255,248,225,.10)');
  sh.addColorStop(0.5, 'rgba(255,248,225,0)'); sh.addColorStop(0.8, 'rgba(3,10,7,.22)'); sh.addColorStop(1, 'rgba(3,10,7,.9)');
  ctx.fillStyle = sh; ctx.fillRect(0, 0, w, h);

  // brass side rails
  for (const [rx, dir] of [[0, 1], [w - rail, -1]] as const) {
    const rg = ctx.createLinearGradient(rx, 0, rx + rail, 0);
    rg.addColorStop(dir > 0 ? 0 : 1, '#5E4516'); rg.addColorStop(0.5, '#E9CC80'); rg.addColorStop(dir > 0 ? 1 : 0, '#8F6B2B');
    ctx.globalCompositeOperation = 'destination-over'; ctx.fillStyle = rg; ctx.fillRect(rx, 0, rail, h); ctx.globalCompositeOperation = 'source-over';
  }

  // payline
  ctx.fillStyle = landed != null ? `rgba(255,241,196,${0.5 + 0.5 * glow})` : 'rgba(255,241,196,.55)';
  ctx.fillRect(x0, cy - 0.75, inner, 1.5);
}

// ---------- the lever ----------
function Lever({ pos, active, onGrab }: { pos: number; active: boolean; onGrab: (e: React.PointerEvent) => void }) {
  const th = Math.PI * Math.min(1, Math.max(0, pos));
  const pivot = 205, L = 150;
  const by = pivot - L * Math.cos(th);
  const r = 24 * (1 + 0.28 * Math.sin(th));
  return (
    <svg viewBox="0 0 80 400" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <defs>
        <linearGradient id="lv-chrome" x1="0" x2="1"><stop offset="0" stopColor="#7E8A8E" /><stop offset=".45" stopColor="#FFFFFF" /><stop offset="1" stopColor="#6B7679" /></linearGradient>
        <radialGradient id="lv-ball" cx="38%" cy="32%" r="70%"><stop offset="0" stopColor="#FF9B80" /><stop offset=".35" stopColor="#D8402F" /><stop offset="1" stopColor="#6E140E" /></radialGradient>
        <linearGradient id="lv-brass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#8F6B2B" /><stop offset=".4" stopColor="#F4DE9C" /><stop offset="1" stopColor="#9A7430" /></linearGradient>
      </defs>
      <rect x="30" y="40" width="20" height="330" rx="10" fill="#07150F" stroke="#24493A" />
      <rect x="35" y={Math.min(by, pivot)} width="10" height={Math.abs(pivot - by)} rx="5" fill="url(#lv-chrome)" />
      <circle cx="40" cy={pivot} r="19" fill="url(#lv-brass)" stroke="#5E4516" strokeWidth="2" />
      <circle cx="40" cy={pivot} r="7" fill="#07150F" />
      <g className={active ? 'lv-knob live' : 'lv-knob'} onPointerDown={onGrab}>
        <circle cx="40" cy={by} r={r + 14} fill="transparent" />
        <circle cx="40" cy={by + r * 0.12} r={r} fill="#000" opacity=".35" />
        <circle cx="40" cy={by} r={r} fill="url(#lv-ball)" />
        <ellipse cx={40 - r * 0.3} cy={by - r * 0.38} rx={r * 0.34} ry={r * 0.2} fill="#FFFFFF" opacity=".55" />
      </g>
    </svg>
  );
}

// ---------- confetti ----------
function Burst() {
  const flecks = Array.from({ length: 44 }, (_, i) => {
    const ang = (i / 44) * TAU + (i % 3) * 0.2; const dist = 130 + ((i * 37) % 110);
    return { x: Math.cos(ang) * dist, y: Math.sin(ang) * dist - 60, r: ((i * 53) % 540) - 270, d: (i % 6) * 0.05 };
  });
  return (
    <div className="burst" aria-hidden="true">
      {flecks.map((f, i) => <i key={i} style={{ ['--x' as string]: `${f.x}px`, ['--y' as string]: `${f.y}px`, ['--r' as string]: `${f.r}deg`, ['--d' as string]: `${f.d}s` }} />)}
    </div>
  );
}

// ---------- the machine ----------
export function LeverMachine({ pockets, mode, onSpin, roll, title, price }: {
  pockets: Pocket[]; mode: Mode; onSpin?: () => Promise<number>; roll?: number; title: string; price: number;
}) {
  const router = useRouter();
  const canvas = useRef<HTMLCanvasElement>(null);
  const bay = useRef<HTMLDivElement>(null);
  const readout = useRef<HTMLSpanElement>(null);
  const flapL = useRef<HTMLSpanElement>(null);
  const flapR = useRef<HTMLSpanElement>(null);
  const sfx = useRef<Sfx>(null as unknown as Sfx);
  if (!sfx.current) sfx.current = new Sfx();

  const geo = useMemo<Geo>(() => {
    let acc = 0;
    return pockets.map((p) => { const s = acc / PPM; acc += p.oddsPpm; return { s, e: acc / PPM }; });
  }, [pockets]);
  const imgs = useMemo(() => new Map<string, HTMLImageElement>(), []);

  const [phase, setPhase] = useState<Phase>(mode === 'rest' ? 'landed' : 'ready');
  const [landed, setLanded] = useState<number | null>(mode === 'rest' && roll != null ? landedIndex(pockets, roll) : null);
  const [lever, setLever] = useState(0);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const st = useRef({
    P: mode === 'rest' && roll != null ? roll / PPM : 0.385, v: 0, phase: (mode === 'rest' ? 'landed' : 'ready') as Phase,
    started: 0, roll: null as number | null, plan: null as null | { t0: number; P0: number; d: number; D: number },
    lastIdx: -1, flap: 0, landedAt: 0, landed: (mode === 'rest' && roll != null ? landedIndex(pockets, roll) : null) as number | null,
    dirty: true, size: { w: 0, h: 0, dpr: 1 }, reduce: false, readAt: 0,
  });

  useEffect(() => {
    try { const m = localStorage.getItem('hb-sound') === 'off'; setMuted(m); sfx.current.muted = m; } catch { /* storage blocked */ }
    st.current.reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  // load watch images
  useEffect(() => {
    for (const p of pockets) {
      if (imgs.has(p.label)) continue;
      const im = new Image(); im.onload = () => { st.current.dirty = true; }; im.src = watchImageSrc(p.label); imgs.set(p.label, im);
    }
  }, [pockets, imgs]);

  // size the canvas to its box
  useEffect(() => {
    const el = bay.current; const cv = canvas.current; if (!el || !cv) return;
    const fit = () => {
      const r = el.getBoundingClientRect(); const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
      st.current.size = { w: r.width, h: r.height, dpr }; st.current.dirty = true;
    };
    fit();
    const ro = new ResizeObserver(fit); ro.observe(el);
    document.fonts?.ready.then(() => { st.current.dirty = true; });
    return () => ro.disconnect();
  }, []);

  const setRead = (text: string) => { if (readout.current && readout.current.textContent !== text) readout.current.textContent = text; };

  const land = useCallback((idx: number) => {
    const s = st.current; s.phase = 'landed'; s.landed = idx; s.landedAt = performance.now();
    setPhase('landed'); setLanded(idx);
    const t = tierOf(pockets[idx].valueCents).id;
    const big = t === 'gold' || t === 'platinum';
    if (big) sfx.current.big(); else sfx.current.land();
    try { navigator.vibrate?.(big ? [40, 60, 40, 60, 120] : [30, 40, 60]); } catch { /* not supported */ }
    if (mode === 'live') setTimeout(() => router.refresh(), big ? 4200 : 3000);
  }, [pockets, mode, router]);

  // animation loop
  useEffect(() => {
    let raf = 0; let prev = performance.now();
    const frame = (now: number) => {
      const s = st.current; const dt = Math.min(0.05, (now - prev) / 1000); prev = now;
      if (s.phase === 'ready' && mode !== 'rest') { s.P += 0.018 * dt; s.dirty = true; }
      if (s.phase === 'spinning') {
        if (s.roll != null && s.reduce) {
          s.P = s.roll / PPM; land(landedIndex(pockets, s.roll));
        } else if (!s.plan) {
          s.v = Math.min(VMAX, s.v + VMAX * 1.6 * dt); s.P += s.v * dt;
          if (s.roll != null && now - s.started > SPIN_UP * 1000 && s.v > VMAX * 0.9) {
            const T = s.roll / PPM; let d = T - frac(s.P); if (d < 0) d += 1;
            while (d < MIN_TURNS) d += 1;
            s.plan = { t0: now, P0: s.P, d, D: (d * EASE) / s.v };
          }
        } else {
          const u = Math.min(1, (now - s.plan.t0) / 1000 / s.plan.D);
          const prevP = s.P;
          s.P = s.plan.P0 + s.plan.d * (1 - Math.pow(1 - u, EASE));
          s.v = (s.P - prevP) / Math.max(dt, 1e-3);
          if (u >= 1) { s.P = s.roll! / PPM; s.plan = null; s.v = 0; land(landedIndex(pockets, s.roll!)); }
        }
        s.dirty = true;
      }
      // flappers tick on every boundary
      const idx = landedIndex(pockets, Math.floor(frac(s.P) * PPM));
      if (idx !== s.lastIdx) {
        if (s.lastIdx !== -1 && s.phase === 'spinning') { s.flap = Math.min(28, 10 + s.v * 14); sfx.current.tick(s.v / VMAX); }
        s.lastIdx = idx;
        if (s.phase === 'spinning' && now - s.readAt > 70) { s.readAt = now; setRead(pockets[idx].label); }
      }
      if (s.flap > 0.2) {
        s.flap *= 0.8;
        const f = s.flap.toFixed(1);
        flapL.current?.style.setProperty('--flap', `${f}deg`); flapR.current?.style.setProperty('--flap', `${-Number(f)}deg`);
      }
      const glow = s.landed != null ? 0.5 + 0.5 * Math.sin((now - s.landedAt) / 160) : 0;
      if (s.landed != null) s.dirty = true;
      const cv = canvas.current;
      if (s.dirty && cv && s.size.w > 0) {
        const ctx = cv.getContext('2d');
        if (ctx) { ctx.setTransform(s.size.dpr, 0, 0, s.size.dpr, 0, 0); drawDrum(ctx, s.size.w, s.size.h, pockets, geo, s.P, imgs, s.landed, glow); }
        s.dirty = false;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [pockets, geo, imgs, mode, land]);

  const pull = useCallback(async () => {
    const s = st.current;
    if (s.phase !== 'ready') return;
    if (mode !== 'live' || !onSpin) {
      sfx.current.ensure(); sfx.current.ratchet();
      setRead('Open the box to pull'); setTimeout(() => setRead('Pull the lever'), 1800);
      return;
    }
    sfx.current.ensure(); sfx.current.clunk();
    setError(null); s.phase = 'spinning'; s.started = performance.now(); s.roll = null; s.v = 0.2; setPhase('spinning');
    try {
      s.roll = await onSpin();
    } catch {
      s.phase = 'ready'; s.v = 0; setPhase('ready'); setRead('Pull the lever');
      setError('The pull did not go through. Your credit is safe. Try the lever again.');
    }
  }, [mode, onSpin]);

  // lever: drag it down, or tap it and it throws itself
  const anim = useRef(0);
  const springBack = useCallback((from: number) => {
    cancelAnimationFrame(anim.current);
    const t0 = performance.now();
    const step = (now: number) => {
      const t = (now - t0) / 1000;
      const v = from * Math.exp(-6 * t) * Math.abs(Math.cos(11 * t));
      setLever(v);
      if (t < 1.1) anim.current = requestAnimationFrame(step); else setLever(0);
    };
    anim.current = requestAnimationFrame(step);
  }, []);
  const throwLever = useCallback(() => {
    if (st.current.phase !== 'ready') return;
    cancelAnimationFrame(anim.current);
    const t0 = performance.now();
    const step = (now: number) => {
      const u = Math.min(1, (now - t0) / 240); setLever(u * u);
      if (u < 1) anim.current = requestAnimationFrame(step); else { void pull(); springBack(1); }
    };
    anim.current = requestAnimationFrame(step);
  }, [pull, springBack]);

  const onGrab = (e: React.PointerEvent) => {
    if (mode === 'rest' || st.current.phase !== 'ready') return;
    e.preventDefault();
    const svg = (e.currentTarget as SVGGElement).ownerSVGElement!; const box = svg.getBoundingClientRect();
    const y0 = e.clientY; let moved = false; let pos = 0; let lastNotch = 0;
    const travel = box.height * 0.72;
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - y0; if (Math.abs(dy) > 4) moved = true;
      pos = Math.max(0, Math.min(1, dy / travel)); setLever(pos);
      const notch = Math.floor(pos * 8); if (notch > lastNotch) { sfx.current.ensure(); sfx.current.ratchet(); } lastNotch = notch;
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      if (!moved) { throwLever(); return; }
      if (pos > 0.72) void pull();
      springBack(pos);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  };

  const toggleSound = () => {
    const m = !muted; setMuted(m); sfx.current.muted = m;
    try { localStorage.setItem('hb-sound', m ? 'off' : 'on'); } catch { /* storage blocked */ }
  };

  const hit = landed != null ? pockets[landed] : null;
  const hitTier = hit ? tierOf(hit.valueCents) : null;
  const big = !!hitTier && (hitTier.id === 'gold' || hitTier.id === 'platinum');
  const legend = pockets.map((p, i) => ({ ...p, i })).sort((a, b) => b.valueCents - a.valueCents);

  return (
    <div className={`machine ${mode}${big && phase === 'landed' ? ' big' : ''}`} data-phase={phase}>
      <div className="mq">
        <span className="bulb-row top" aria-hidden="true" />
        <span className="bulb-row bottom" aria-hidden="true" />
        <span className="mq-kicker">{title}</span>
        <span className="mq-title">HONESTBOX</span>
        <span className="mq-sub">{usd(price)} a pull · panels sized to the odds</span>
      </div>

      <div className="cab">
        <div className="bay" ref={bay}>
          <canvas ref={canvas} role="img" aria-label={`Prize drum with ${pockets.length} watches. Each panel's height is its real share of the odds.`} />
          <span className="flap l" ref={flapL} aria-hidden="true" />
          <span className="flap r" ref={flapR} aria-hidden="true" />
        </div>
        {big && phase === 'landed' && <Burst />}
        <span className="bulb-col l" aria-hidden="true" />
        <div className={`lever${mode === 'live' && phase === 'ready' ? ' armed' : ''}`}>
          <Lever pos={lever} active={mode !== 'rest' && phase === 'ready'} onGrab={onGrab} />
        </div>
      </div>

      <div className="deck">
        <div className="readout" aria-live="polite">
          {phase === 'landed' && hit ? (
            <>
              {big && <span className="bigpull">{hitTier!.label} pull</span>}
              <span className="ro-main">{hit.label}</span>
              <span className="ro-sub">{usd(hit.valueCents)} · {oneIn(hit.oddsPpm)}</span>
            </>
          ) : (
            <span className={`ro-main${phase === 'ready' ? ' blink' : ''}`} ref={readout}>Pull the lever</span>
          )}
        </div>
        {mode === 'live' && phase !== 'landed' && (
          <button type="button" className="btn btn-gold btn-xl btn-block pull-btn" onClick={throwLever} disabled={phase !== 'ready'}>
            {phase === 'spinning' ? 'Spinning…' : 'Pull the lever'}
          </button>
        )}
        {mode === 'live' && phase === 'landed' && (
          <button type="button" className="btn btn-gold btn-xl btn-block" onClick={() => router.refresh()}>See your watch</button>
        )}
        {error && <p className="machine-error">{error}</p>}
        <div className="deck-foot">
          <span>Where the payline stops is your provably fair roll.</span>
          {mode !== 'rest' && (
            <button type="button" className="linkish" onClick={toggleSound} aria-pressed={!muted}>{muted ? 'Sound off' : 'Sound on'}</button>
          )}
        </div>
      </div>

      {mode !== 'rest' && (
        <details className="card machine-legend">
          <summary>The {pockets.length} watches on this drum</summary>
          <ul className="legend">
            {legend.map((p) => (
              <li key={p.i} className={landed === p.i && phase === 'landed' ? 'hit' : ''}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={watchImageSrc(p.label)} alt="" width={28} height={28} />
                <span className="name">{p.label}</span>
                <span className="mono">{usd(p.valueCents)}</span>
                <span className="mono muted">{oneIn(p.oddsPpm)}</span>
              </li>
            ))}
          </ul>
          <p className="quiet" style={{ fontSize: '0.8rem', marginTop: 8 }}>Watch drawings are placeholders until photos are added.</p>
        </details>
      )}
    </div>
  );
}
