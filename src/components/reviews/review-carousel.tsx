'use client';

import { type CSSProperties, useRef, useState } from 'react';
import Image from 'next/image';
import { Icon } from '@/components/ui/icons';
import type { ReviewImage } from './review-images';

export function ReviewCarousel({ images }: { images: ReviewImage[] }) {
  const [current, setCurrent] = useState(0);
  const [dragX, setDragX] = useState(0);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const count = images.length;

  if (count === 0) {
    return <p className="review-gallery-empty">Hiện chưa có ảnh phản hồi để hiển thị.</p>;
  }

  const selected = Math.min(current, count - 1);
  const move = (step: number) => setCurrent(previous => (previous + step + count) % count);


  return <div className="review-carousel" role="region" aria-label="Thư viện ảnh phản hồi" aria-roledescription="carousel">
    <div className="review-carousel-shell">
      <div className={dragX === 0 ? "review-carousel-stage" : "review-carousel-stage is-dragging"}
        style={{ '--drag-offset': `${dragX}px` } as CSSProperties}
        tabIndex={count > 1 ? 0 : undefined}
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
        onTouchMove={event => {
          const start = touchStart.current;
          const point = event.changedTouches[0];
          if (!start || !point || count < 2) return;
          const dx = point.clientX - start.x;
          const dy = point.clientY - start.y;
          if (Math.abs(dx) > Math.abs(dy) * 1.2) setDragX(Math.max(-120, Math.min(120, dx)));
        }}
        onTouchCancel={() => { touchStart.current = null; setDragX(0); }}
        onTouchEnd={event => {
          const start = touchStart.current;
          const end = event.changedTouches[0];
          touchStart.current = null;
          setDragX(0);
          if (!start || !end || count < 2) return;
          const dx = end.clientX - start.x;
          const dy = end.clientY - start.y;
          if (Math.abs(dx) >= 45 && Math.abs(dx) > Math.abs(dy) * 1.2) move(dx < 0 ? 1 : -1);
        }}>
        {images.map((item, index) => {
          // Keep image identity and the element type stable as positions change.
          let offset = (index - selected + count) % count;
          if (offset > count / 2) offset -= count;
          const isCurrent = offset === 0;
          const isNeighbor = Math.abs(offset) === 1;
          return <figure key={index}
            className={`review-carousel-slide${isCurrent ? ' is-current' : ''}${isNeighbor ? ' is-neighbor' : ''}`}
            style={{ '--slide-offset': offset } as CSSProperties}
            aria-hidden={!isCurrent && !isNeighbor} inert={!isCurrent && !isNeighbor}
            aria-roledescription="slide" aria-label={`Ảnh ${index + 1} trên ${count}`}>
            <span className="review-photo-frame"><Image src={item.src}
              alt={isCurrent ? (item.isDemo ? 'Ảnh hội thoại mô phỏng tình huống tư vấn, không phải phản hồi khách hàng thật.' : 'Hình ảnh trao đổi do cửa hàng chia sẻ.') : ''}
              width={960} height={780} sizes="(max-width: 700px) 80vw, 40vw"
              priority={index === 0} unoptimized/></span>
            <figcaption className="review-photo-caption">{item.isDemo ? 'Ảnh mô phỏng' : 'Hình ảnh trao đổi'}</figcaption>
            {!isCurrent && isNeighbor && <button className="review-carousel-neighbor" type="button"
              onClick={() => setCurrent(index)} aria-label={`Xem ảnh ${index + 1} trên ${count}`}>
              <span className="review-neighbor-hint" aria-hidden="true">Xem ảnh này</span>
            </button>}
          </figure>;
        })}
      </div>
      {count > 1 && <>
        <button type="button" className="review-carousel-arrow review-carousel-arrow-left" onClick={() => move(-1)} aria-label="Ảnh trước"><Icon name="arrow-left" size={23}/></button>
        <button type="button" className="review-carousel-arrow review-carousel-arrow-right" onClick={() => move(1)} aria-label="Ảnh tiếp theo"><Icon name="arrow" size={23}/></button>
      </>}
    </div>
    <div className="review-carousel-meta">
      <span aria-live="polite" aria-atomic="true">Ảnh {selected + 1} / {count}</span>
      {count > 1 && <span className="review-carousel-instruction">Dùng mũi tên, chấm chọn hoặc vuốt để xem ảnh.</span>}
    </div>
    {count > 1 && <div className="review-carousel-dots" aria-label="Chọn ảnh">
      {images.map((item, index) => <button type="button" key={item.file} className={index === selected ? 'review-dot is-active' : 'review-dot'}
        onClick={() => setCurrent(index)} aria-label={`Đến ảnh ${index + 1}`} aria-current={index === selected ? 'true' : undefined}/>)}
    </div>}
  </div>;
}
