import { WatchArt, artFor } from './Mark.tsx';

/** A real photo when we have one, otherwise the drawn watch. */
export function WatchPhoto({ src, brand, size, alt }: { src: string | null | undefined; brand: string; size: number; alt: string }) {
  if (src) return <img className="wphoto" src={src} alt={alt} width={size} height={size} style={{ width: size, height: size }} loading="lazy" />;
  const art = artFor(brand);
  return <WatchArt size={size} dial={art.dial} bezel={art.bezel} />;
}
