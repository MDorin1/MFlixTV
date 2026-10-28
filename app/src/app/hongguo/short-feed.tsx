'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 短剧「刷剧」流（竖向整屏翻页）
 *
 * 这套手感来自 kanju.ai 的短剧 feed（见 kanju-research/REPORT-kanju-impl.md §3.1），
 * 三个数字是它踩出来的，照抄：
 *  - 滚轮阈值 48px：滤掉触控板惯性微动；
 *  - 翻页锁 450ms：一次甩动不会连翻三页；
 *  - scroll → rAF → 180ms 沉降：翻页动画没结束前不切状态。
 * 另外只在 (pointer:fine) 才接管滚轮——手机上走原生 scroll-snap，不劫持 touch。
 *
 * 与原站的差别：它的每一屏直接自动播放视频（因为 feed 里带一次性播放 token），
 * 我们的短剧内核要按集去解密转码，一屏自动播 N 路会把手机/内网带宽打爆。
 * 所以这里的一屏是「剧照 + 信息 + 一个播放入口」，点了才真正进播放器——
 * 手感是刷，成本是看。
 */

export interface ShortFeedItem {
  series_id: string;
  title: string;
  cover?: string;
  abstract?: string;
  episode_cnt?: number;
  hot?: string;
  score?: string;
  tags?: string[];
  copyright?: string;
}

export interface ShortFeedProgress {
  lastEp: number;
  lastPos: number;
}

const WHEEL_THRESHOLD = 48;
const WHEEL_LOCK_MS = 450;
const SETTLE_MS = 180;

export function ShortFeed({
  items,
  imgBase,
  startIndex = 0,
  onClose,
  onPlay,
  onDetail,
  progressOf,
}: {
  items: ShortFeedItem[];
  imgBase: string;
  startIndex?: number;
  onClose: () => void;
  onPlay: (item: ShortFeedItem) => void;
  onDetail: (item: ShortFeedItem) => void;
  progressOf: (seriesId: string) => ShortFeedProgress | undefined;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(startIndex);
  const settleRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const lockRef = useRef(0);

  const goTo = useCallback(
    (next: number) => {
      const el = viewportRef.current;
      if (!el) return;
      const clamped = Math.max(0, Math.min(items.length - 1, next));
      el.scrollTo({ top: el.clientHeight * clamped, behavior: 'smooth' });
      setIndex(clamped);
    },
    [items.length]
  );

  // 首帧定位到 startIndex（不做平滑，避免打开就先滑一段）
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || startIndex <= 0) return;
    el.scrollTop = el.clientHeight * startIndex;
    setIndex(startIndex);
  }, [startIndex]);

  // scroll → rAF 节流 → 180ms 沉降（翻页动画结束再认位置）
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onScroll = () => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const raw = Math.round(el.scrollTop / Math.max(1, el.clientHeight));
        if (raw === index) return;
        if (settleRef.current) window.clearTimeout(settleRef.current);
        settleRef.current = window.setTimeout(() => setIndex(raw), SETTLE_MS);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (settleRef.current) window.clearTimeout(settleRef.current);
    };
  }, [index]);

  // 桌面滚轮接管（只在有精确指针的设备上）
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    if (typeof window === 'undefined') return;
    if (!window.matchMedia('(pointer:fine)').matches) return;
    const onWheel = (e: WheelEvent) => {
      const now = performance.now();
      if (now < lockRef.current) {
        e.preventDefault();
        return;
      }
      const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
      if (Math.abs(d) < WHEEL_THRESHOLD) return;
      e.preventDefault();
      lockRef.current = now + WHEEL_LOCK_MS;
      goTo(index + Math.sign(d));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [index, goTo]);

  // 键盘 ↑↓ / Esc
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown' || e.key === 'PageDown') {
        e.preventDefault();
        goTo(index + 1);
      } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
        e.preventDefault();
        goTo(index - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, goTo, onClose]);

  if (items.length === 0) return null;

  return (
    <div className="fixed inset-0 z-[80] bg-black">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-between px-4 py-3">
        <span className="pointer-events-auto rounded-full bg-black/55 px-2.5 py-1 text-[11.5px] text-white/80 backdrop-blur">
          刷剧 · {index + 1}/{items.length}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="pointer-events-auto rounded-full bg-black/55 p-1.5 text-white/80 backdrop-blur transition-colors hover:bg-black/75 hover:text-white"
          aria-label="退出刷剧"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div
        ref={viewportRef}
        className="h-full snap-y snap-mandatory overflow-y-scroll overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {items.map((it, i) => {
          const prog = progressOf(it.series_id);
          const active = i === index;
          return (
            <section key={it.series_id} className="relative h-full w-full snap-start overflow-hidden">
              {/* 剧照铺满 + 上下压暗：一屏一张图，信息压在底部（和原站同一构图） */}
              {it.cover ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`${imgBase}/img?url=${encodeURIComponent(it.cover)}`}
                  alt={it.title}
                  loading={Math.abs(i - index) <= 1 ? 'eager' : 'lazy'}
                  className="absolute inset-0 h-full w-full object-cover"
                />
              ) : (
                <div className="absolute inset-0 bg-gradient-to-br from-chip to-black" />
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-black via-black/45 to-black/25" />

              {/* 右侧上下切换 + 位置计数（原站就是这个位置） */}
              <div className="absolute right-3 top-1/2 z-10 flex -translate-y-1/2 flex-col items-center gap-2">
                <button
                  type="button"
                  onClick={() => goTo(index - 1)}
                  disabled={index === 0}
                  className="grid h-9 w-9 place-items-center rounded-full border border-white/25 bg-black/45 text-white/85 backdrop-blur transition-colors hover:bg-black/70 disabled:opacity-25"
                  aria-label="上一部"
                >
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
                    <path d="M6 15l6-6 6 6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <span className="text-[11px] tabular-nums text-white/70">
                  {index + 1}/{items.length}
                </span>
                <button
                  type="button"
                  onClick={() => goTo(index + 1)}
                  disabled={index === items.length - 1}
                  className="grid h-9 w-9 place-items-center rounded-full border border-white/25 bg-black/45 text-white/85 backdrop-blur transition-colors hover:bg-black/70 disabled:opacity-25"
                  aria-label="下一部"
                >
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
                    <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>

              <div className="absolute inset-x-0 bottom-0 z-10 px-5 pb-8 pr-16 sm:px-8">
                <h2 className="text-[22px] font-black leading-tight text-white drop-shadow-[0_2px_10px_rgba(0,0,0,.85)] sm:text-[26px]">
                  {it.title}
                </h2>
                <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[11.5px] text-white/70">
                  {it.episode_cnt ? <span>共 {it.episode_cnt} 集</span> : null}
                  {it.hot ? <span>· {it.hot}</span> : null}
                  {it.score ? <span className="text-rating">· ★ {it.score}</span> : null}
                  {it.tags?.slice(0, 2).map((t) => (
                    <span key={t} className="rounded-full bg-white/12 px-1.5 py-0.5 text-[10.5px]">
                      {t}
                    </span>
                  ))}
                </p>
                <p className="mt-2 line-clamp-2 text-[12.5px] leading-relaxed text-white/65">
                  {it.abstract || '暂无简介'}
                </p>
                <div className="mt-3.5 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onPlay(it)}
                    className="inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-on-accent transition-colors hover:bg-accent-hover"
                  >
                    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.4-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14z" />
                    </svg>
                    {prog && prog.lastEp > 0 ? `继续第 ${prog.lastEp} 集` : '看第 1 集'}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDetail(it)}
                    className="nf-btn-ghost !px-3.5 !py-2 !text-[12.5px]"
                  >
                    详情与选集
                  </button>
                </div>
              </div>

              {/* 只在当前这一屏做渐显，避免一次挂载几十张图同时动画 */}
              {!active && <span className="pointer-events-none absolute inset-0 bg-black/25" aria-hidden />}
            </section>
          );
        })}
      </div>
    </div>
  );
}
