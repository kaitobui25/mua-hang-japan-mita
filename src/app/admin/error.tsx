'use client';
export default function AdminError({ reset }: { reset: () => void }) {
  return <div className="admin-panel" role="alert"><h1>Không tải được Admin</h1><p>Kiểm tra backend và PostgreSQL đang bật, sau đó thử lại.</p><button onClick={reset}>Thử lại</button><a href="/admin/login">Đăng nhập lại</a></div>;
}
