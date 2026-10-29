'use client';

import { useRef, useState } from 'react';
import Image from 'next/image';
import { Icon } from '@/components/ui/icons';
import type { ReviewImage } from './review-images';

type Position = 'previous' | 'current' | 'next';

export function ReviewCarousel({ images }: { images: ReviewImage[] }) {
  const [current, setCurrent] = useState(0);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const count = images.length;

  if (count === 0) {
    return <p className="review-gallery-empty">Hiện chưa có ảnh phản hồi để hiển thị.</p>;
  }

  const selected = Math.min(current, count - 1);
  const move = (step: number) => setCurrent(previous => (previous + step + count) % count);
  const slots: { position: Position; index: number | null }[] = [
    { position: 'previous', index: count > 2 ? (selected - 1 + count) % count : null },
    { position: 'current', index: selected },
    { position: 'next', index: count > 1 ? (selected + 1) % count : null },
  ];

  return <div className="review-carousel" role="region" aria-label="Thư viện ảnh phản hồi" aria-roledescription="carousel">
    <div className="review-carousel-shell">
      <div className="review-carousel-stage" tabIndex={count > 1 ? 0 : undefined}
        aria-label={count > 1 ? 'Dùng phím mũi tên trái phải để chuyển ảnh' : undefined}
        onKeyDown={event => {
          if (count < 2) return;
          if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
          if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
          if (event.key === 'Home') { event.preventDefault(); setCurrent(0); }
          if (event.key === 'End') { event.preventDefault(); setCurrent(count - 1); }
        }}
        onTouchStart={event => {
          const point = event.changedTouches[0];
          touchStart.current = point ? { x: point.clientX, y: point.clientY } : null;
        }}
        onTouchCancel={() => { touchStart.current = null; }}
        onTouchEnd={event => {
          const start = touchStart.current;
          const end = event.changedTouches[0];
          touchStart.current = null;
          if (!start || !end || count < 2) return;
          const dx = end.clientX - start.x;
          const dy = end.clientY - start.y;
          if (Math.abs(dx) >= 45 && Math.abs(dx) > Math.abs(dy) * 1.2) move(dx < 0 ? 1 : -1);
        }}>
        {slots.map(({ position, index }) => {
          if (index === null) return <span key={position} className={`review-carousel-spacer review-position-${position}`} aria-hidden="true"/>;
          const item = images[index];
          const isCurrent = position === 'current';
          const image = <span className="review-photo-frame"><Image src={item.src}
            alt={isCurrent ? (item.isDemo ? 'Ảnh hội thoại giả lập, không phải phản hồi khách hàng thật.' : 'Ảnh phản hồi do cửa hàng cung cấp.') : ''}
            width={960} height={780} sizes={isCurrent ? '(max-width: 700px) 90vw, 42vw' : '25vw'}
            priority={isCurrent} unoptimized/></span>;
          return isCurrent
            ? <figure key={position} className="review-carousel-slide review-position-current" aria-roledescription="slide" aria-label={`Ảnh ${index + 1} trên ${count}`}>
                {image}<figcaption className="review-photo-caption">{item.isDemo ? 'MINH HỌA – HƯ CẤU' : 'Hình ảnh phản hồi'}</figcaption>
              </figure>
            : <button key={position} className={`review-carousel-slide review-carousel-neighbor review-position-${position}`}
                type="button" onClick={() => setCurrent(index)} aria-label={`Xem ảnh ${index + 1} trên ${count}`}>
                {image}<span className="review-neighbor-hint" aria-hidden="true">Xem ảnh này</span>
              </button>;
        })}
      </div>
      {count > 1 && <>
        <button type="button" className="review-carousel-arrow review-carousel-arrow-left" onClick={() => move(-1)} aria-label="Ảnh trước"><Icon name="arrow-left" size={23}/></button>
        <button type="button" className="review-carousel-arrow review-carousel-arrow-right" onClick={() => move(1)} aria-label="Ảnh tiếp theo"><Icon name="arrow" size={23}/></button>
      </>}
    </div>
    <div className="review-carousel-meta">
      <span aria-live="polite" aria-atomic="true">Ảnh {selected + 1} / {count}{images[selected].isDemo ? ' · Minh họa hư cấu' : ''}</span>
      {count > 1 && <span className="review-carousel-instruction">Chọn ảnh hai bên, dùng mũi tên hoặc vuốt để xem tiếp.</span>}
    </div>
    {count > 1 && <div className="review-carousel-dots" aria-label="Chọn ảnh">
      {images.map((item, index) => <button type="button" key={item.file} className={index === selected ? 'review-dot is-active' : 'review-dot'}
        onClick={() => setCurrent(index)} aria-label={`Đến ảnh ${index + 1}`} aria-current={index === selected ? 'true' : undefined}/>)}
    </div>}
  </div>;
}
