'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { db, type HistoryEntry } from '@/lib/db';
import { buildWatchUrl, cn } from '@/lib/utils';
import { SmartImage } from './smart-image';
import { useAppStore } from '@/lib/store';

/**
 * 首页「继续观看」。
 *
 * Netflix 的首屏第一行就是这个，作用很实在：上次看到第 3 集 12:30，点一下接着看，
 * 不用重新搜片名再选集。数据直接读 IndexedDB 的观看记录（换源/换集都会更新）。
 * 看完的（≥95%）不进这一行——用户已经看完了，再推一遍只是噪音。
 */

const MAX_ITEMS = 12;

export function ContinueWatchingRow({ className }: { className?: string }) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const [items, setItems] = useState<HistoryEntry[]>([]);
  const [failed, setFailed] = useState<Set<string>>(new Set());

  // 只在客户端读 IndexedDB：服务端渲染没有这个库
  useEffect(() => {
    let alive = true;
    const load = () => {
      db.history
        .orderBy('timestamp')
        .reverse()
        .limit(MAX_ITEMS * 2)
        .toArray()
        .then((rows) => {
          if (!alive) return;
          setItems(
            rows
              .filter((r) => {
                if (!r.title) return false;
                const ratio = r.duration > 0 ? r.playbackPosition / r.duration : 0;
                return ratio < 0.95;
              })
              .slice(0, MAX_ITEMS)
          );
        })
        .catch(() => {
          /* 读取失败就不显示这一行，不影响首页其它内容 */
        });
    };
    load();
    // 从播放页返回首页时进度已变：重新聚焦页面就刷新一次，避免显示旧进度
    const onVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <section className={cn('mb-8', className)} aria-label="继续观看">
      <h2 className="row-title mb-3.5 text-content">继续观看</h2>
      <div className="-mx-4 flex gap-2.5 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((it) => {
          const ratio = it.duration > 0 ? Math.min(1, Math.max(0, it.playbackPosition / it.duration)) : 0;
          const left = Math.max(0, Math.round((it.duration - it.playbackPosition) / 60));
          const showImg = !!it.pic && !failed.has(it.id);
          return (
            <Link
              key={it.id}
              href={buildWatchUrl({
                sourceKey: it.sourceKey,
                vodId: it.vodId,
                index: it.episodeIndex,
                title: it.title,
                sourceUrl: it.sourceUrl,
                position: it.playbackPosition,
              })}
              className="group/w w-[104px] shrink-0 sm:w-[124px]"
            >
              <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-chip ring-1 ring-line/60">
                {showImg ? (
                  <SmartImage
                    url={it.pic}
                    mode={imageProxyMode}
                    customProxy={customImageProxy}
                    alt={it.title}
                    className="h-full w-full object-cover transition-transform duration-500 group-hover/w:scale-[1.05]"
                    onExhausted={() => setFailed((prev) => new Set(prev).add(it.id))}
                  />
                ) : (
                  <div className="grid h-full w-full place-items-center bg-gradient-to-br from-chip to-line/40 text-[11px] text-faint">
                    无封面
                  </div>
                )}
                {/* 悬停播放 */}
                <span className="pointer-events-none absolute inset-0 grid place-items-center opacity-0 transition-opacity duration-300 group-hover/w:opacity-100">
                  <span className="grid h-9 w-9 place-items-center rounded-full bg-white/25 text-white ring-1 ring-white/40 backdrop-blur-md">
                    <svg viewBox="0 0 24 24" className="h-4 w-4 translate-x-[1px]" fill="currentColor" aria-hidden>
                      <path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.4-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14z" />
                    </svg>
                  </span>
                </span>
                {/* 底部进度条：Netflix 那种细红条 */}
                <div className="absolute inset-x-0 bottom-0 h-[3px] bg-white/25">
                  <div className="h-full bg-accent" style={{ width: `${Math.round(ratio * 100)}%` }} />
                </div>
              </div>
              <p className="mt-1.5 line-clamp-1 text-[13px] font-medium text-content" title={it.title}>
                {it.title}
              </p>
              <p className="line-clamp-1 text-[11px] text-faint">
                {it.totalEpisodes > 1 ? `第 ${it.episodeIndex + 1} 集 · ` : ''}
                {left > 0 ? `剩余约 ${left} 分钟` : '快看完了'}
              </p>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
