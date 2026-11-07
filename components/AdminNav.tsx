import Link from 'next/link';
import { listBoxes } from '@/lib/engine.ts';

export function AdminNav({ here }: { here: string }) {
  const links: [string, string][] = [
    ['/admin', 'Overview'], ['/admin/inventory', 'Inventory'], ['/admin/photos', 'Photos'],
    ...listBoxes().map((b) => [`/admin/boxes/${b.slug}`, `Box ${b.numeral}`] as [string, string]),
    ['/admin/drops', 'Drops'], ['/admin/payouts', 'Payouts'], ['/admin/shipments', 'Shipping'], ['/admin/settings', 'Settings and affiliates'],
  ];
  return (
    <nav aria-label="Admin" className="row" style={{ gap: 8, borderBottom: '1px solid var(--rule)', paddingBottom: 14 }}>
      {links.map(([href, label]) => (
        <Link key={href} href={href} className={`pill ${here === href ? 'pill-brass' : ''}`} style={{ textDecoration: 'none' }}>{label}</Link>
      ))}
    </nav>
  );
}
