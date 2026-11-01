import { TIERS } from '@/lib/wheel.ts';

const RANGE: Record<string, string> = { copper: 'under $500', silver: '$500 to $2,499', gold: '$2,500 to $9,999', platinum: '$10,000 and up' };

/** Legend for the metal colours used on wheels, tickets and the live feed. */
export function TierScale() {
  return (
    <div className="tier-scale" aria-label="Slice colours by watch value">
      {[...TIERS].reverse().map((t) => <span key={t.id}><i className={`t-${t.id}`} />{t.label}, {RANGE[t.id]}</span>)}
    </div>
  );
}
