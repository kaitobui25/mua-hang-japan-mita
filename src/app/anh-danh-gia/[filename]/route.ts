import { readReviewImage } from '@/components/reviews/review-images';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ filename: string }> }) {
  const { filename } = await params;
  const image = await readReviewImage(filename);
  if (!image) {
    return new Response('Không tìm thấy ảnh', {
      status: 404,
      headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    });
  }

  return new Response(new Uint8Array(image.bytes), {
    status: 200,
    headers: {
      'Content-Type': image.contentType,
      'Content-Length': String(image.bytes.length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
