'use client';
import { useState, type FormEvent } from 'react';

export function LoginForm() {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const form = event.currentTarget;
    const formData = new FormData(form);
    const username = String(formData.get('username') ?? '').trim();
    const password = formData.get('password');
    try {
      const response = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: username || 'owner', password }) });
      form.reset();
      if (!response.ok) { const data = await response.json(); throw new Error(data.error ?? 'Không thể đăng nhập.'); }
      window.location.assign('/admin');
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return <form onSubmit={submit} className="admin-login-form"><label htmlFor="account-name">Tài khoản</label><input id="account-name" name="username" autoComplete="username" defaultValue="owner" required minLength={3} maxLength={32} pattern="[a-z][a-z0-9_-]{2,31}"/><label htmlFor="account-password">Mật khẩu</label><input id="account-password" name="password" type="password" autoComplete="current-password" required minLength={12} maxLength={128} autoFocus/><button className="admin-primary" disabled={busy}>{busy ? 'Đang đăng nhập…' : 'Đăng nhập'}</button>{error && <p role="alert">{error}</p>}</form>;
}
