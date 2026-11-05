// Watch images for the wheel, reveal and vault.
// Until real photos exist, every model gets a generated placeholder drawing: case shape, bezel, dial colour and
// complications are picked from the model name so the wheel reads as many different watches.
// When the photo system lands, watchImageSrc() is the one function that switches to the stored photo URL.

type Look = { dial: string; bezel: string; metal: [string, string]; strap: string };

const BRANDS: [string, Look][] = [
  ['TAG Heuer', { dial: '#1B2430', bezel: '#2A3340', metal: ['#E4E9EB', '#8E9A9E'], strap: '#B9C2C5' }],
  ['Rolex', { dial: '#0A1712', bezel: '#14532D', metal: ['#EEF2F3', '#9AA6AA'], strap: '#C4CDD0' }],
  ['Omega', { dial: '#0E0F12', bezel: '#1A2A55', metal: ['#E8ECEE', '#8E9A9E'], strap: '#BFC8CB' }],
  ['Tudor', { dial: '#111111', bezel: '#7E1E28', metal: ['#E8ECEE', '#8E9A9E'], strap: '#3A2A20' }],
  ['Cartier', { dial: '#F2EDE2', bezel: '#D9B868', metal: ['#F4E3B0', '#B98E3C'], strap: '#C9A85C' }],
  ['Longines', { dial: '#E9E6DE', bezel: '#BFC8CB', metal: ['#EEF2F3', '#9AA6AA'], strap: '#C4CDD0' }],
  ['Oris', { dial: '#0F2E4F', bezel: '#123A63', metal: ['#E8ECEE', '#8E9A9E'], strap: '#BFC8CB' }],
  ['Tissot', { dial: '#1C3B5A', bezel: '#C4CDD0', metal: ['#EEF2F3', '#9AA6AA'], strap: '#C4CDD0' }],
  ['Hamilton', { dial: '#2B3A22', bezel: '#AEB8BB', metal: ['#E4E9EB', '#8E9A9E'], strap: '#5A4630' }],
  ['Seiko', { dial: '#183A6B', bezel: '#1F2C44', metal: ['#E4E9EB', '#8E9A9E'], strap: '#BFC8CB' }],
  ['Citizen', { dial: '#14324A', bezel: '#1E5F8A', metal: ['#E4E9EB', '#8E9A9E'], strap: '#2B2B2B' }],
  ['Orient', { dial: '#EDE6D6', bezel: '#C4CDD0', metal: ['#EEF2F3', '#9AA6AA'], strap: '#6B4A2E' }],
  ['Casio', { dial: '#1A1A1A', bezel: '#2A2A2A', metal: ['#3A3A3A', '#141414'], strap: '#1E1E1E' }],
  ['Timex', { dial: '#EDE6D6', bezel: '#6F857A', metal: ['#D9DEE0', '#8E9A9E'], strap: '#4B5A3A' }],
];
const FALLBACK: Look = { dial: '#0B1D17', bezel: '#C9A85C', metal: ['#E4E9EB', '#8E9A9E'], strap: '#2E4C40' };

export function brandOf(label: string): string {
  return BRANDS.find(([b]) => label.startsWith(b))?.[0] ?? label.split(' ')[0];
}

function kind(label: string) {
  const l = label.toLowerCase();
  return {
    digital: /g-shock|dw5600/.test(l),
    square: /santos/.test(l),
    diver: /dive|submariner|seamaster|black bay|aquis|kamasu|duro|5 sports|promaster/.test(l),
    chrono: /chrono|speedmaster|carrera|weekender/.test(l),
  };
}

const polar = (r: number, deg: number, c = 100) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [(c + r * Math.cos(a)).toFixed(1), (c + r * Math.sin(a)).toFixed(1)];
};

export function placeholderWatchSvg(label: string): string {
  const look = BRANDS.find(([b]) => label.startsWith(b))?.[1] ?? FALLBACK;
  const k = kind(label);
  const parts: string[] = [];
  const defs = `<defs>
    <linearGradient id="m" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${look.metal[0]}"/><stop offset="1" stop-color="${look.metal[1]}"/></linearGradient>
    <radialGradient id="d" cx="40%" cy="35%" r="75%"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".22"/><stop offset=".55" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>
  </defs>`;
  // strap top and bottom
  parts.push(`<rect x="70" y="0" width="60" height="58" rx="8" fill="${look.strap}"/><rect x="70" y="142" width="60" height="58" rx="8" fill="${look.strap}"/>`);
  parts.push(`<rect x="70" y="0" width="60" height="58" rx="8" fill="#000" opacity=".18"/>`);

  if (k.digital) {
    parts.push(`<rect x="34" y="40" width="132" height="120" rx="26" fill="url(#m)"/>`);
    parts.push(`<rect x="52" y="62" width="96" height="76" rx="10" fill="#8C9A7A"/><rect x="52" y="62" width="96" height="76" rx="10" fill="url(#d)"/>`);
    parts.push(`<g fill="#1F2618"><rect x="66" y="88" width="10" height="26" rx="2"/><rect x="82" y="88" width="10" height="26" rx="2"/><rect x="104" y="88" width="10" height="26" rx="2"/><rect x="120" y="88" width="10" height="26" rx="2"/><rect x="96" y="94" width="4" height="4"/><rect x="96" y="106" width="4" height="4"/></g>`);
    parts.push(`<g fill="#C7362B"><circle cx="30" cy="70" r="5"/><circle cx="30" cy="130" r="5"/><circle cx="170" cy="70" r="5"/><circle cx="170" cy="130" r="5"/></g>`);
  } else {
    if (k.square) {
      parts.push(`<rect x="38" y="38" width="124" height="124" rx="22" fill="url(#m)"/>`);
      parts.push(`<rect x="50" y="50" width="100" height="100" rx="14" fill="${look.bezel}"/>`);
      for (const [x, y] of [[58, 58], [100, 54], [142, 58], [146, 100], [142, 142], [100, 146], [58, 142], [54, 100]]) parts.push(`<circle cx="${x}" cy="${y}" r="3" fill="#FFF6DA"/>`);
      parts.push(`<rect x="62" y="62" width="76" height="76" rx="8" fill="${look.dial}"/>`);
    } else {
      parts.push(`<circle cx="100" cy="100" r="66" fill="url(#m)"/>`);
      if (k.diver) {
        parts.push(`<circle cx="100" cy="100" r="60" fill="${look.bezel}"/>`);
        for (let i = 0; i < 60; i += 5) {
          const [x1, y1] = polar(57, i * 6); const [x2, y2] = polar(i === 0 ? 50 : 52, i * 6);
          parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#F1EDE3" stroke-width="${i % 15 === 0 ? 3 : 1.6}"/>`);
        }
        parts.push(`<path d="M100 44 L94 54 L106 54 Z" fill="#F1EDE3"/>`);
      } else {
        parts.push(`<circle cx="100" cy="100" r="58" fill="none" stroke="#FFFFFF" stroke-opacity=".35" stroke-width="2"/>`);
      }
      parts.push(`<circle cx="100" cy="100" r="${k.diver ? 47 : 53}" fill="${look.dial}"/>`);
    }
    parts.push(k.square ? `<rect x="62" y="62" width="76" height="76" rx="8" fill="url(#d)"/>` : `<circle cx="100" cy="100" r="${k.diver ? 47 : 53}" fill="url(#d)"/>`);
    const light = /^#(E|F|D)/i.test(look.dial);
    const ink = light ? '#1A1F1C' : '#F1EDE3';
    const rIdx = k.square ? 32 : k.diver ? 40 : 45;
    for (let h = 0; h < 12; h++) {
      const [x1, y1] = polar(rIdx, h * 30); const [x2, y2] = polar(rIdx - (h % 3 === 0 ? 9 : 5), h * 30);
      if (k.diver && h % 3 !== 0) { const [cx, cy] = polar(rIdx - 3, h * 30); parts.push(`<circle cx="${cx}" cy="${cy}" r="3.2" fill="${ink}"/>`); }
      else parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${ink}" stroke-width="${h % 3 === 0 ? 4 : 2.2}" stroke-linecap="round"/>`);
    }
    if (k.chrono) {
      for (const deg of [90, 180, 270]) {
        const [cx, cy] = polar(22, deg);
        parts.push(`<circle cx="${cx}" cy="${cy}" r="10" fill="none" stroke="${ink}" stroke-opacity=".7" stroke-width="1.5"/>`);
      }
    } else if (!k.square) {
      parts.push(`<rect x="${light ? 128 : 127}" y="95" width="12" height="10" rx="1.5" fill="#FFFFFF" stroke="${ink}" stroke-opacity=".4"/>`);
    }
    // hands at 10:10
    const [hx, hy] = polar(26, 305); const [mx, my] = polar(38, 60); const [sx, sy] = polar(42, 200);
    parts.push(`<line x1="100" y1="100" x2="${hx}" y2="${hy}" stroke="${ink}" stroke-width="5.5" stroke-linecap="round"/>`);
    parts.push(`<line x1="100" y1="100" x2="${mx}" y2="${my}" stroke="${ink}" stroke-width="3.8" stroke-linecap="round"/>`);
    parts.push(`<line x1="100" y1="100" x2="${sx}" y2="${sy}" stroke="#C7362B" stroke-width="1.6" stroke-linecap="round"/>`);
    parts.push(`<circle cx="100" cy="100" r="4" fill="#C9A85C"/>`);
    // crown
    parts.push(`<rect x="${k.square ? 161 : 164}" y="91" width="11" height="18" rx="3" fill="url(#m)"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">${defs}${parts.join('')}</svg>`;
}

const cache = new Map<string, string>();

/** The image for a watch model. Placeholder drawings today; stored photos once they exist. */
export function watchImageSrc(label: string): string {
  let src = cache.get(label);
  if (!src) {
    src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(placeholderWatchSvg(label))}`;
    cache.set(label, src);
  }
  return src;
}
