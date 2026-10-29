import Link from 'next/link';
import { adminRead } from '@/lib/admin-server';
import type { AdminIssueReport } from '@/types/admin';
import { date } from '@/components/admin/shared';

export default async function IssueLogPage({
  searchParams
}: { searchParams: Promise<{ asin?: string | string[] }> }) {
  const value = (await searchParams).asin;
  const requested = typeof value === 'string' ? value.trim().toUpperCase() : undefined;
  const asin = requested && /^[A-Z0-9]{10}$/.test(requested) ? requested : undefined;
  const report = await adminRead<AdminIssueReport>('issues' + (asin ? '?asin=' + asin : ''));
  return <>
    <header>
      <p className="overline">Nhật ký riêng cho owner</p>
      <h1>Cảnh báo dịch và Amazon</h1>
      <p>Chỉ xem được qua Admin localhost. Nhật ký không phải là xác nhận độ chính xác bản dịch.</p>
      {asin && <p>ASIN: <strong>{asin}</strong> · <Link href="/admin/nhat-ky-loi">Xem tất cả</Link></p>}
    </header>
    <section className="admin-panel">
      <h2>Nhật ký bản dịch</h2>
      <p>Nhật ký cục bộ trên máy chạy API này: <code>{report.logLocation}</code>. {report.logAvailable ? 'Đã đọc các sự kiện gần nhất.' : 'Không tìm thấy file trên máy chạy API; nhật ký từ Windows chưa được đồng bộ tự động lên VPS.'}</p>
      {report.translations.length ? <ul>{report.translations.map((issue, index) => <li key={issue.asin + issue.field + index}>
        <p><strong>{issue.asin}</strong> · {issue.field} · {date(issue.timestamp)} · {issue.result} · {issue.issues?.join(', ')}</p>
        {issue.original && <p>Nguồn: {issue.original}</p>}
        {issue.candidate && <p>Bản dịch: {issue.candidate}</p>}
      </li>)}</ul> : <p>Không có bản ghi phù hợp trong phần nhật ký đọc được.</p>}
    </section>
    <section className="admin-panel">
      <h2>Nhật ký Amazon</h2>
      {report.amazon.length ? <ul>{report.amazon.map(issue => <li key={issue.id}>
        <strong>{issue.asin || 'Trang danh mục'}</strong> · {date(issue.created_at)} · {issue.state} · {issue.message}
      </li>)}</ul> : <p>Không có lỗi phù hợp.</p>}
    </section>
  </>;
}
