import 'server-only';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

export async function adminRead<T>(path: string): Promise<T> {
  const cookie = (await cookies()).get('mita_admin');
  if (!cookie) redirect('/admin/login');
  const response = await fetch(`http://127.0.0.1:${Number(process.env.API_PORT ?? 4000)}/api/admin/${path}`, {
    cache: 'no-store', headers: { Cookie: `mita_admin=${cookie.value}` },
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 401) redirect('/admin/login');
  if (response.status === 404) notFound();
  if (!response.ok) throw new Error('Không tải được dữ liệu quản trị. Kiểm tra backend rồi thử lại.');
  return response.json() as Promise<T>;
}
export type AdminSession = { actorId: number; csrfToken: string; expiresAt: string };
