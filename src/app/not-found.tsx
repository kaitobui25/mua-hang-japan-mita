import Link from "next/link";
import { Icon } from "@/components/ui/icons";

export default function NotFound() { return <section className="container state-panel not-found"><h1>Trang này chưa có.</h1><p>Đường dẫn có thể đã thay đổi. Bạn có thể quay lại danh mục sản phẩm.</p><Link href="/san-pham" className="button button-primary">Xem sản phẩm <Icon name="arrow"/></Link></section>; }
