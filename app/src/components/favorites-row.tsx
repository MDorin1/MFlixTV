'use client';

import Link from 'next/link';
import { useFavorites } from '@/lib/favorites';
import { cn } from '@/lib/utils';
import { Rail } from './rail';

/**
 * 首页「我的清单」：收藏过的资料页，横滑卡片。
 * 空清单时不占位置（不显示空状态，首页不需要多一块「还没有收藏」）。
 */
export function FavoritesRow({ className }: { className?: string }) {
  const favorites = useFavorites();
  if (favorites.length === 0) return null;

  return (
    <section className={cn('mb-8', className)} aria-label="我的清单">
      <h2 className="row-title mb-3.5 text-content">我的清单</h2>
      <Rail className="-mx-4 px-4 sm:mx-0 sm:px-0" ariaLabel="我的清单">
        {favorites.map((f) => (
          <Link key={f.key} href={f.href} className="group/f w-[104px] shrink-0 sm:w-[120px]" title={f.title}>
            <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-chip ring-1 ring-line/60 transition-transform duration-300 group-hover/f:-translate-y-1">
              {f.cover ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/proxy?url=${encodeURIComponent(f.cover)}`}
                  alt={f.title}
                  loading="lazy"
                  decoding="async"
                  referrerPolicy="no-referrer"
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="grid h-full w-full place-items-center px-1 text-center text-[11px] text-faint">
                  {f.title}
                </div>
              )}
              <div className="poster-scrim absolute inset-x-0 bottom-0 h-[55%]" />
              <p className="poster-title absolute inset-x-0 bottom-0 line-clamp-2 p-1.5 text-[12.5px] leading-tight">
                {f.title}
              </p>
            </div>
          </Link>
        ))}
      </Rail>
    </section>
  );
}
