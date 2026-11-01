import { listBoxes, bandsFor, boxState, settings } from './engine.ts';
import { expectedValueCents, houseEdge } from './fair.ts';
import type { TicketBox } from '@/components/Showcase.tsx';

/** Box summaries for the ticket cards: top prize by value, odds of a $3,500+ watch, EV and edge. */
export function ticketBoxes(): TicketBox[] {
  const s = settings();
  return listBoxes().map((b) => {
    const bands = bandsFor(b.id).filter((x) => x.odds_ppm > 0);
    const top = bands.reduce((m, x) => (x.value_cents > m.value_cents ? x : m), bands[0]);
    const st = boxState(b, bandsFor(b.id), s);
    return {
      slug: b.slug, name: b.name, numeral: b.numeral, priceCents: b.price_cents, watches: bands.length,
      top: { label: top.label, valueCents: top.value_cents, oddsPpm: top.odds_ppm },
      bigPpm: bands.filter((x) => x.value_cents >= 350000).reduce((a, x) => a + x.odds_ppm, 0),
      evCents: expectedValueCents(bands), edge: houseEdge(bands, b.price_cents), closed: st.openable ? null : st.reason?.startsWith('Sealed') ? 'Sealed while we restock' : st.reason,
    };
  });
}
