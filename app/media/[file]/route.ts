import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FILE_RE, uploadDir } from '@/lib/photos.ts';

// Serves processed watch photos. File names are random and never reused, so they can be cached forever.
export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  if (!FILE_RE.test(file)) return new Response('Not found', { status: 404 });
  try {
    const body = await readFile(join(uploadDir(), file));
    return new Response(new Uint8Array(body), { headers: { 'content-type': 'image/webp', 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
