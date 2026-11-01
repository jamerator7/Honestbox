// Roulette-wheel geometry, mirrored from ../../../lib/wheel.ts on the server. Keep the two in step.
// Each pocket's slice is drawn to its real odds, in the box's wheel order, clockwise from the top.
// The pointer sits at the top; the wheel stops with the pointer exactly at roll / 1,000,000 of a turn,
// which is the same cumulative walk pickBand() uses. So where the pointer stops is the verifiable roll.

export type Pocket = { bandId: number; label: string; valueCents: number; oddsPpm: number };
export type Slice = Pocket & { index: number; start: number; end: number; mid: number; fill: string; ink: string; rank: number; tier: Tier };

export const PPM = 1_000_000;

export function pocketsOf(snapshot: string): Pocket[] {
  return (JSON.parse(snapshot) as { id: number; label: string; value_cents: number; odds_ppm: number }[])
    .filter((b) => b.odds_ppm > 0)
    .map((b) => ({ bandId: b.id, label: b.label, valueCents: b.value_cents, oddsPpm: b.odds_ppm }));
}

/** Metal tiers by value, the site's honest version of "rarity": the colour tells you what a slice is worth. */
export type Tier = 'copper' | 'silver' | 'gold' | 'platinum';
export const TIERS: { id: Tier; label: string; min: number; fill: [string, string]; ink: string }[] = [
  { id: 'platinum', label: 'Platinum', min: 1_000_000, fill: ['#E7EFEC', '#CBD8D3'], ink: '#0D2219' },
  { id: 'gold', label: 'Gold', min: 250_000, fill: ['#E2BF66', '#C9A04A'], ink: '#0D2219' },
  { id: 'silver', label: 'Silver', min: 50_000, fill: ['#A9B4B7', '#8E9A9E'], ink: '#0D2219' },
  { id: 'copper', label: 'Copper', min: 0, fill: ['#B9703F', '#9C5A30'], ink: '#FBF3E8' },
];
export function tierOf(valueCents: number) { return TIERS.find((t) => valueCents >= t.min)!; }

export function slices(pockets: Pocket[]): Slice[] {
  const order = [...pockets].map((p, i) => [p.valueCents, i] as const).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
  let acc = 0;
  return pockets.map((p, index) => {
    const start = (acc / PPM) * 360; acc += p.oddsPpm; const end = (acc / PPM) * 360;
    const t = tierOf(p.valueCents);
    return { ...p, index, start, end, mid: (start + end) / 2, rank: order.indexOf(index), tier: t.id,
      fill: t.fill[index % 2], ink: t.ink };
  });
}

export function landedIndex(pockets: Pocket[], rollPpm: number): number {
  let acc = 0;
  for (let i = 0; i < pockets.length; i++) { acc += pockets[i].oddsPpm; if (rollPpm < acc) return i; }
  return pockets.length - 1;
}

/** Clockwise rotation in degrees that brings the roll's angle under the top pointer, after `turns` full turns. */
export function landingRotation(rollPpm: number, turns = 6): number {
  return turns * 360 - (rollPpm / PPM) * 360;
}

const pt = (cx: number, cy: number, r: number, deg: number) => {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)] as const;
};

export function slicePath(cx: number, cy: number, r: number, start: number, end: number): string {
  if (end - start >= 359.999) return `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} Z`;
  const [x0, y0] = pt(cx, cy, r, start); const [x1, y1] = pt(cx, cy, r, end);
  return `M ${cx} ${cy} L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${end - start > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`;
}

export function pointAt(cx: number, cy: number, r: number, deg: number) { return pt(cx, cy, r, deg); }

/** Radial label placement: text runs outward from the hub, flipped on the left half so it never reads upside down. */
export function labelTransform(cx: number, cy: number, mid: number): { rotate: number; flip: boolean } {
  const flip = mid > 180;
  return { rotate: flip ? mid + 90 : mid - 90, flip };
}

export function shortLabel(label: string, max = 15): string {
  return label.length <= max ? label : `${label.slice(0, max - 1).trimEnd()}…`;
}
