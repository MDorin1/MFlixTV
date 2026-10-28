'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * 横向 rail（Netflix / kanju.ai 那种一行）
 *
 * 从 kanju.ai 首页抄来的四个细节（见 kanju-research/REPORT-kanju-home.md §3.4）：
 *  1. 桌面用户根本不会想到「横向拖动」，所以必须有 ‹ › 两个箭头，到头自动置灰；
 *  2. `scroll-snap-type: x proximity`（不是 mandatory）——滑块能停在任意位置，手感更松；
 *  3. `overscroll-behavior-inline: contain` —— 滑到头不带动整页左右晃；
 *  4. 滚动条彻底隐藏：视觉上是「一排卡片」，不是一个带滚动条的盒子。
 */
export function Rail({
  children,
  className,
  arrows = true,
  ariaLabel,
}: {
  children: React.ReactNode;
  className?: string;
  arrows?: boolean;
  ariaLabel?: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  const measure = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setOverflowing(max > 8);
    setAtStart(el.scrollLeft <= 4);
    setAtEnd(el.scrollLeft >= max - 4);
  }, []);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      ro.disconnect();
    };
  }, [measure, children]);

  const nudge = (dir: 1 | -1) => {
    const el = trackRef.current;
    if (!el) return;
    // 一次翻「一屏的八成」，比翻整屏好找位置（kanju 的同款行为）
    el.scrollBy({ left: dir * Math.max(240, el.clientWidth * 0.8), behavior: 'smooth' });
  };

  return (
    <div className="group/rail relative">
      <div ref={trackRef} className={cn('rail-track', className)} role="list" aria-label={ariaLabel}>
        {children}
      </div>
      {arrows && overflowing && (
        <>
          <RailArrow dir="left" disabled={atStart} onClick={() => nudge(-1)} />
          <RailArrow dir="right" disabled={atEnd} onClick={() => nudge(1)} />
        </>
      )}
    </div>
  );
}

function RailArrow({ dir, disabled, onClick }: { dir: 'left' | 'right'; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={dir === 'left' ? '向左滑动' : '向右滑动'}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'absolute top-1/2 z-10 hidden h-9 w-9 -translate-y-1/2 place-items-center rounded-full',
        'border border-line bg-page/85 text-content shadow-lg backdrop-blur transition-opacity duration-200',
        'hover:bg-hover disabled:pointer-events-none disabled:opacity-0',
        'sm:grid',
        dir === 'left' ? '-left-3' : '-right-3'
      )}
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden>
        <path d={dir === 'left' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}
