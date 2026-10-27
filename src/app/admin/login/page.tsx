import { LoginForm } from '@/components/admin/login';

export default function LoginPage() {
  return <main className="admin-login"><a href="/" className="wordmark">mita japan</a><h1>Đăng nhập chủ cửa hàng</h1><p>Quản trị nội bộ trên máy này.</p><LoginForm/></main>;
}
