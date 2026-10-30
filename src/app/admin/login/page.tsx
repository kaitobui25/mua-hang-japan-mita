import { LoginForm } from '@/components/admin/login';

export default function LoginPage() {
  return <main className="admin-login"><a href="/" className="wordmark">mita japan</a><h1>Đăng nhập quản trị</h1><p>Owner hoặc nhân viên được cấp quyền trên máy này.</p><LoginForm/></main>;
}
