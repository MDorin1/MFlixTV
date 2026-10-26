'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Item {
  id: string;
  title: string;
  cover: string;
  rating?: string;
}

function proxied(url: string) {
  if (!url) return '';
  if (url.startsWith('/')) return url;
  return `/api/proxy?url=${encodeURIComponent(url)}`;
}

/**
 * Netflix 式「TOP 10」行：大数字 + 海报，点进去是资料页（/title/[id]）。
 * 手机横向滑动（一屏约 2.5 张），平板/桌面一屏 4-5 张。
 */
export function RankRow({ id = 'douban_movie_weekly', title = '本周 TOP 10' }: { id?: string; title?: string }) {
  const [items, setItems] = useState<Item[]>([]);

  useEffect(() => {
    let alive = true;
    fetch(`/api/hot-list?id=${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !Array.isArray(d?.items)) return;
        setItems(d.items.slice(0, 10));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id]);

  if (items.length === 0) return null;

  return (
    <section aria-label={title} className="mb-8">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="row-title text-content">{title}</h2>
        <span className="text-[13px] text-faint">按豆瓣周榜</span>
      </div>

      <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:gap-4 sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((it, i) => (
          <Link
            key={it.id}
            href={`/title/${it.id}`}
            className="group relative flex w-[136px] shrink-0 items-end gap-1 sm:w-[180px]"
          >
            {/* 大数字排名 */}
            <span
              className="select-none pb-1 text-[64px] font-black leading-none text-transparent sm:text-[86px]"
              style={{ WebkitTextStroke: '2px rgba(255,255,255,0.28)' }}
            >
              {i + 1}
            </span>
            <div className="relative -ml-2 aspect-[2/3] w-full overflow-hidden rounded-lg bg-chip ring-1 ring-line">
              {it.cover ? (
                <img
                  src={proxied(it.cover)}
                  alt={it.title}
                  loading="lazy"
                  className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                />
              ) : (
                <div className="grid h-full w-full place-items-center px-1 text-center text-[10px] text-faint">
                  {it.title}
                </div>
              )}
              {it.rating && (
                <span className="absolute left-1 top-1 rounded bg-black/70 px-1 py-[1px] text-[10px] font-medium text-amber-300">
                  ★ {it.rating}
                </span>
              )}
              <span className="poster-scrim absolute bottom-0 left-0 right-0 px-1.5 pb-1.5 pt-6 text-[12px] font-semibold leading-tight text-white">
                <span className="line-clamp-1">{it.title}</span>
              </span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
