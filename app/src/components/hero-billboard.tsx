'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import type { DoubanItem } from '@/lib/types';

/**
 * 首页头图（Netflix 的 billboard）。
 *
 * 复用的是推荐区同一个 react-query key（['douban','movie','热门']），
 * 所以不会多发一次请求：推荐网格拉回来的数据，这里直接取前三张当主推。
 * 排版按 Netflix 的层次来：大标题 → 一行元信息 → 白底「播放」+ 半透明「更多信息」，
 * 右侧竖排三张候选封面，点任意一张切到那部的资料页。
 */
export function HeroBillboard() {
  const query = useQuery({
    queryKey: ['douban', 'movie', '热门'],
    queryFn: ({ signal }) => api.douban('movie', '热门', 0, 50, signal),
    staleTime: 600_000,
  });

  const picks = (query.data?.items ?? []).filter((i) => i.cover).slice(0, 3);
  const hero: DoubanItem | undefined = picks[0];

  if (!hero) {
    // 骨架：高度与真实头图一致，避免数据回来时整页往下跳
    return <div className="mb-8 h-[300px] w-full animate-pulse rounded-2xl bg-chip sm:h-[360px]" />;
  }

  return (
    <section aria-label="本周推荐" className="mb-9">
      <div className="relative overflow-hidden rounded-2xl bg-[#111] ring-1 ring-line/60">
        {/*
          背景只用「同一张海报放大 + 重模糊 + 压黑」，不当主视觉用：
          豆瓣给的是 2:3 竖版海报，铺到 21:9 的横幅上等于把脸怼到屏幕上，越清晰越难看。
          真正的视觉锚点是左边那张正常比例的海报。
        */}
        <div className="absolute inset-0">
          <img
            src={`/api/proxy?url=${encodeURIComponent(hero.cover)}`}
            alt=""
            aria-hidden
            className="h-full w-full scale-110 object-cover opacity-60 blur-xl"
          />
          <div className="absolute inset-0 bg-gradient-to-r from-black/95 via-black/70 to-black/30" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-black/40" />
        </div>

        <div className="relative flex flex-col gap-5 p-5 sm:min-h-[300px] sm:flex-row sm:items-center sm:gap-7 sm:p-7">
          <img
            src={`/api/proxy?url=${encodeURIComponent(hero.cover)}`}
            alt={hero.title}
            className="w-28 shrink-0 rounded-xl shadow-[0_18px_40px_-16px_rgba(0,0,0,.9)] ring-1 ring-white/15 sm:w-36"
          />

          <div className="min-w-0 flex-1">
            <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.18em] text-white/55">
              本周推荐
            </p>
            <h2 className="text-[26px] font-bold leading-tight text-white sm:text-[38px]">{hero.title}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] text-white/70">
              {hero.rating && hero.rating !== '0' && (
                <span className="font-semibold text-amber-300">★ {hero.rating}</span>
              )}
              <span>{hero.isTv ? '剧集' : '电影'}</span>
              <span className="text-white/30">·</span>
              <span>豆瓣热门榜</span>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2.5">
              <Link
                href={`/title/${hero.id}`}
                className="inline-flex items-center gap-2 rounded-lg bg-white px-6 py-2.5 text-[15px] font-bold text-black transition hover:bg-white/85"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
                  <path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.4-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14z" />
                </svg>
                播放
              </Link>
              <Link
                href={`/title/${hero.id}`}
                className="inline-flex items-center gap-2 rounded-lg bg-white/20 px-5 py-2.5 text-[15px] font-semibold text-white backdrop-blur transition hover:bg-white/30"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 11v5M12 8h.01" strokeLinecap="round" />
                </svg>
                更多信息
              </Link>
            </div>
          </div>

          {/* 右侧候选：和主推同一批数据，点一张就切过去 */}
          <div className="hidden shrink-0 gap-2 sm:flex">
            {picks.map((p) => (
              <Link
                key={p.id}
                href={`/title/${p.id}`}
                title={p.title}
                className="block w-[66px] overflow-hidden rounded-lg ring-1 ring-white/20 transition-transform duration-300 hover:-translate-y-1 hover:ring-white/60"
              >
                <img
                  src={`/api/proxy?url=${encodeURIComponent(p.cover)}`}
                  alt={p.title}
                  loading="lazy"
                  className="aspect-[2/3] w-full object-cover"
                />
              </Link>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
