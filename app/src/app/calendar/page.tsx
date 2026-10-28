'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Header } from '@/components/header';
import { SiteFooter } from '@/components/site-footer';
import { api } from '@/lib/client-api';
import { db } from '@/lib/db';
import { useFavorites } from '@/lib/favorites';
import { useSelectedSources } from '@/lib/use-selected-sources';
import type { CalendarPayload } from '@/lib/calendar';
import {
  CalendarWideCard,
  KindTabs,
  WeekStrip,
} from '@/components/watch-calendar';
import { cn } from '@/lib/utils';

/**
 * 追剧日历（整页周表）
 *
 * 与首页「本周追剧」是同一份数据、同一个接口，区别只是这里能翻周、切分类、翻页。
 * 「本周」被默认选中、今天被默认选中——用户从首页点进来不需要再选一次。
 */

const PAGE_SIZE = 24;

export default function CalendarPage() {
  return (
    <Suspense>
      <CalendarContent />
    </Suspense>
  );
}

function CalendarContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sources = useSelectedSources();
  const favorites = useFavorites();

  const [date, setDate] = useState<string>(searchParams.get('date') || '');
  const [kind, setKind] = useState<string>('all');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [watchOnly, setWatchOnly] = useState(false);
  const [watchTitles, setWatchTitles] = useState<string[]>([]);

  // 追剧清单：看过的 + 收藏的片名（「只看我追的剧」就是按这份名单过滤）
  useEffect(() => {
    let alive = true;
    const load = () => {
      db.history
        .toArray()
        .then((rows) => {
          if (!alive) return;
          setWatchTitles(rows.map((r) => r.title).filter(Boolean) as string[]);
        })
        .catch(() => {});
    };
    load();
    return () => {
      alive = false;
    };
  }, []);

  const watchlist = useMemo(() => {
    const set = new Set<string>();
    for (const t of watchTitles) if (t && t.trim().length >= 2) set.add(t.trim());
    for (const f of favorites) if (f.title && f.title.trim().length >= 2) set.add(f.title.trim());
    return [...set];
  }, [watchTitles, favorites]);

  const query = useQuery<CalendarPayload>({
    queryKey: [
      'watch-calendar',
      date || 'current',
      kind,
      limit,
      watchOnly,
      sources.map((s) => s.url).sort().join('|'),
    ],
    queryFn: ({ signal }) =>
      api.calendar(
        {
          sources,
          week: date || 'current',
          kind,
          limit,
          watchOnly,
          watchlist: watchOnly ? watchlist : undefined,
        },
        signal
      ),
    enabled: sources.length > 0,
    staleTime: 5 * 60_000,
  });

  const data = query.data;

  // 翻周：以当前周为基准前后挪 7 天（服务端会再归一到周一）
  const shiftWeek = (delta: number) => {
    const base = data?.weekStart;
    if (!base) return;
    const [y, m, d] = base.split('-').map(Number);
    const ts = Date.UTC(y, m - 1, d) + delta * 7 * 86400000;
    const nd = new Date(ts);
    const next = `${nd.getUTCFullYear()}-${String(nd.getUTCMonth() + 1).padStart(2, '0')}-${String(
      nd.getUTCDate()
    ).padStart(2, '0')}`;
    setDate(next);
    setLimit(PAGE_SIZE);
  };

  const pickDay = (d: string) => {
    setDate(d);
    setLimit(PAGE_SIZE);
    router.replace(`/calendar?date=${d}`, { scroll: false });
  };

  const groups = data?.groups ?? [];
  const activeGroup = kind === 'all' ? null : groups[0];

  return (
    <div className="flex min-h-screen flex-col">
      <Header showSearch />
      <div className="mx-auto w-full max-w-[1240px] px-4 py-4 sm:px-6">
        <main className="min-w-0 flex-1">
          <div className="mb-4 flex items-center gap-2">
            <button type="button" className="btn-ghost btn-sm" onClick={() => router.back()} aria-label="返回">
              ‹ 返回
            </button>
            <h1 className="text-[19px] font-bold text-content sm:text-[22px]">追剧日历</h1>
            {data && <span className="text-[12.5px] text-faint">{data.weekLabel}</span>}
          </div>

          {sources.length === 0 ? (
            <div className="rounded-xl border border-dashed border-line p-10 text-center">
              <h3 className="mb-2 font-medium text-content">还没有可用点播源</h3>
              <p className="text-[13px] leading-relaxed text-muted">
                追剧日历的更新记录来自你勾选的点播源。点右上角「设置」添加并勾选一个采集站后再来。
              </p>
            </div>
          ) : (
            <>
              {/* 控制条：上一周 / 日期选择 / 下一周 / 本周 */}
              <div className="mb-3 flex flex-wrap items-center gap-1.5">
                <button type="button" className="btn-ghost btn-sm" onClick={() => shiftWeek(-1)}>
                  ‹ 上一周
                </button>
                <input
                  type="date"
                  className="input h-8 px-2 py-0 text-[12.5px]"
                  value={data?.weekStart || ''}
                  onChange={(e) => {
                    if (e.target.value) pickDay(e.target.value);
                  }}
                  aria-label="选择日期"
                />
                <button type="button" className="btn-ghost btn-sm" onClick={() => shiftWeek(1)}>
                  下一周 ›
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={() => {
                    setDate('');
                    setLimit(PAGE_SIZE);
                  }}
                >
                  本周
                </button>
                <span className="ml-auto flex items-center gap-2 text-[11.5px] text-faint">
                  {data && (
                    <>
                      <span>本周共 {data.weekTotal} 部有更新</span>
                      <span className="hidden sm:inline">·</span>
                      <span className="hidden sm:inline">
                        快照 {new Date(data.generatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </>
                  )}
                </span>
              </div>

              <p className="mb-3 text-[11.5px] leading-relaxed text-faint">
                {data?.notice || '按各点播源最近更新记录统计，实际更新可能延迟。'}
              </p>

              {query.isLoading ? (
                <div className="grid grid-cols-7 gap-1.5 sm:gap-2">
                  {Array.from({ length: 7 }).map((_, i) => (
                    <div key={i} className="h-16 animate-pulse rounded-md border border-line/60 bg-chip sm:h-[72px]" />
                  ))}
                </div>
              ) : query.isError ? (
                <div className="rounded-xl border border-dashed border-line p-10 text-center text-[13px] text-muted">
                  取数失败：{query.error instanceof Error ? query.error.message : '请稍后重试'}
                </div>
              ) : data ? (
                <>
                  <WeekStrip days={data.days} selected={data.selected.date} onSelect={pickDay} />

                  <div className="mt-4 flex items-baseline justify-between border-b border-line pb-2">
                    <h2 className="text-[15px] font-bold text-content">
                      {data.selected.weekdayLabel}{' '}
                      {Number(data.selected.date.slice(5, 7))}月{Number(data.selected.date.slice(8, 10))}日
                      {data.selected.today && <span className="ml-2 text-[11.5px] font-normal text-accent">今天</span>}
                    </h2>
                    <span className="text-[12.5px] text-faint">{data.selected.totals.all} 部</span>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <KindTabs
                      categories={data.categories}
                      active={kind}
                      onChange={(k) => {
                        setKind(k);
                        setLimit(PAGE_SIZE);
                      }}
                    />
                    <label
                      className={cn(
                        'ml-auto inline-flex cursor-pointer items-center gap-2 rounded-full border px-2.5 py-1.5 text-[12px] transition-colors',
                        watchOnly
                          ? 'border-accent/60 bg-accent/12 text-content'
                          : 'border-line bg-chip/60 text-muted hover:text-content',
                        watchlist.length === 0 && 'cursor-not-allowed opacity-45'
                      )}
                      title={watchlist.length === 0 ? '还没有观看记录或收藏' : `按 ${watchlist.length} 部在追的剧过滤`}
                    >
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-[rgb(var(--c-accent))]"
                        checked={watchOnly}
                        disabled={watchlist.length === 0}
                        onChange={(e) => {
                          setWatchOnly(e.target.checked);
                          setLimit(PAGE_SIZE);
                        }}
                      />
                      只看我追的剧
                      {watchlist.length > 0 && <span className="text-faint">{watchlist.length}</span>}
                    </label>
                  </div>

                  {data.failures.length > 0 && (
                    <p className="mt-2 text-[11.5px] text-faint">
                      {data.failures.length} 个源没取到更新列表：{data.failures.map((f) => f.sourceKey).join('、')}
                    </p>
                  )}

                  {groups.length === 0 || (activeGroup && activeGroup.items.length === 0) ? (
                    <div className="mt-6 rounded-xl border border-dashed border-line p-12 text-center text-[13px] text-muted">
                      {watchOnly
                        ? '你追的剧今天没有更新记录（追剧清单只按片名匹配，改名/多季的剧可能匹配不到）。'
                        : '这一天还没有更新记录。'}
                    </div>
                  ) : kind === 'all' ? (
                    <div className="mt-4 space-y-6">
                      {groups.map((g) => (
                        <section key={g.key} aria-label={g.label}>
                          <div className="mb-2 flex items-baseline justify-between">
                            <h3 className="text-[14px] font-bold text-content">
                              {g.label}
                              <span className="ml-1.5 text-[12px] font-normal text-faint">{g.total} 部</span>
                            </h3>
                            {g.total > g.items.length && (
                              <button
                                type="button"
                                className="text-[12px] text-accent hover:underline"
                                onClick={() => {
                                  setKind(g.key);
                                  setLimit(PAGE_SIZE);
                                }}
                              >
                                查看全部 {g.total} 部 →
                              </button>
                            )}
                          </div>
                          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                            {g.items.map((item) => (
                              <CalendarWideCard key={`${item.date}-${item.sourceKey}-${item.vodId}`} item={item} />
                            ))}
                          </div>
                        </section>
                      ))}
                    </div>
                  ) : (
                    activeGroup && (
                      <>
                        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                          {activeGroup.items.map((item) => (
                            <CalendarWideCard key={`${item.date}-${item.sourceKey}-${item.vodId}`} item={item} />
                          ))}
                        </div>
                        <div className="mt-4 flex items-center justify-center gap-3">
                          <span className="text-[12px] text-faint">
                            已显示 {activeGroup.items.length} / {activeGroup.total} 部
                          </span>
                          {activeGroup.hasMore && (
                            <button type="button" className="btn-ghost btn-sm" onClick={() => setLimit((v) => v + PAGE_SIZE)}>
                              加载更多
                            </button>
                          )}
                        </div>
                      </>
                    )
                  )}
                </>
              ) : null}

              <p className="mt-8 text-[11.5px] leading-relaxed text-faint">
                为什么没有「周几几点更新」？采集源只给出「已更新的日期」，没有排播时刻表。
                这一页展示的是已经发生的更新，所以它不会骗你；想看某部剧更新到第几集，点开资料页即可。
              </p>
            </>
          )}
        </main>
      </div>
      <SiteFooter />
    </div>
  );
}
