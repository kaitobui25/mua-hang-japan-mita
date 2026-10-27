import { NextResponse, type NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  // Block untrusted Host headers even when a browser resolves a hostile domain to loopback.
  const host = request.headers.get('host') ?? '';
  if (!/^(localhost|127\.0\.0\.1):[0-9]+$/.test(host)) return new NextResponse('Admin chỉ dùng qua localhost.', { status: 403 });
  const response = NextResponse.next();
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}
export const config = { matcher: ['/admin/:path*', '/api/admin/:path*'] };
