'use client';
import { useState, type FormEvent } from 'react';

export function LoginForm() {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const form = event.currentTarget;
    const password = new FormData(form).get('password');
    try {
      const response = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      form.reset();
      if (!response.ok) { const data = await response.json(); throw new Error(data.error ?? 'Không thể đăng nhập.'); }
      window.location.assign('/admin');
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return <form onSubmit={submit} className="admin-login-form"><label htmlFor="owner-password">Mật khẩu owner</label><input id="owner-password" name="password" type="password" autoComplete="current-password" required minLength={12} maxLength={128} autoFocus/><button className="admin-primary" disabled={busy}>{busy ? 'Đang đăng nhập…' : 'Đăng nhập'}</button>{error && <p role="alert">{error}</p>}</form>;
}
