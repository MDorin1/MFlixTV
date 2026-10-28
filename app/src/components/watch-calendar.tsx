'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import type { CalendarCard, CalendarDay, CalendarGroup, CalendarPayload } from '@/lib/calendar';
import { cn } from '@/lib/utils';
import { Rail } from './rail';

/**
 * 追剧日历（Netflix 配色版）
 *
 * 结构完全照 kanju.ai 的追剧周表抄，但配色仍是本站的 Netflix 红黑：
 *  日期条三行（周几 / 几号 / 部数）→ 选中日头部（周四 10月29日 · 43 部）
 *  → 分类条（全部/电视剧/电影/动漫/综艺/短剧，选中填红）→ 分组列表（每部一行）。
 *
 * 取舍说明：kanju 每个分类组是「一行 4 条横向滚动、一屏露 2 条」；
 * 桌面宽屏下那样会很空，所以这里分组内部用两列（手机）/四列（桌面）的行卡，
 * 一屏内能同时看清「四类各有什么」——这正是它这个模块的价值所在。
 */

export function detailHref(item: CalendarCard): string {
  const sp = new URLSearchParams({ name: item.name });
  if (item.pic) sp.set('pic', item.pic);
  if (item.sourceUrl) sp.set('su', item.sourceUrl);
  return `/detail/${encodeURIComponent(item.sourceKey)}/${encodeURIComponent(item.vodId)}?${sp.toString()}`;
}

/** 日期格：周几 → 几号 → 部数，字号递减（kanju 的原版就是这三行） */
export function WeekStrip({
  days,
  selected,
  onSelect,
  className,
}: {
  days: CalendarDay[];
  selected: string;
  onSelect: (date: string) => void;
  className?: string;
}) {
  return (
    <div className={cn('grid grid-cols-7 gap-1.5 sm:gap-2', className)} role="tablist" aria-label="按日期筛选">
      {days.map((d) => {
        const active = d.date === selected;
        return (
          <button
            key={d.date}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(d.date)}
            className={cn(
              'flex h-16 flex-col items-center justify-center rounded-md border transition-colors sm:h-[72px]',
              active
                ? 'border-accent bg-accent/15 text-content'
                : d.today
                  ? 'border-accent/45 bg-transparent text-content hover:bg-hover'
                  : 'border-line/70 bg-transparent text-content hover:border-line hover:bg-hover'
            )}
          >
            <span className={cn('text-[10px] leading-4 sm:text-[11px]', active ? 'text-accent' : 'text-muted')}>
              {d.weekdayLabel}
            </span>
            <span className="text-[13px] font-bold leading-5 sm:text-[15px]">{d.dayLabel}</span>
            <span className="text-[9.5px] leading-4 text-faint sm:text-[10.5px]">
              {d.totals.all > 0 ? `${d.totals.all}部` : '—'}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** 单条更新：封面 + 片名 + 「更新至 N 集」 */
export function CalendarItemRow({ item }: { item: CalendarCard }) {
  return (
    <Link
      href={detailHref(item)}
      className="group/cal flex items-center gap-2 rounded-lg p-1 transition-colors hover:bg-hover"
      title={`${item.name}${item.remarks ? ` · ${item.remarks}` : ''}`}
    >
      <span className="relative block h-[62px] w-[44px] shrink-0 overflow-hidden rounded bg-chip ring-1 ring-line/60">
        {item.pic ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/proxy?url=${encodeURIComponent(item.pic)}`}
            alt={item.name}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover transition-transform duration-300 group-hover/cal:scale-105"
          />
        ) : (
          <span className="grid h-full w-full place-items-center px-0.5 text-center text-[9px] text-faint">
            {item.name.slice(0, 4)}
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-1 text-[12.5px] font-medium text-content">{item.name}</span>
        <span className="line-clamp-1 text-[11px] text-faint">
          {item.remarks || (item.year ? `${item.year}` : '')}
          {item.at ? ` · ${item.at}` : ''}
        </span>
      </span>
    </Link>
  );
}

function GroupColumn({ group }: { group: CalendarGroup }) {
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-baseline justify-between">
        <h3 className="text-[13.5px] font-bold text-content">{group.label}</h3>
        <span className="text-[11px] text-faint">{group.total} 部</span>
      </div>
      <div className="space-y-0.5">
        {group.items.map((item) => (
          <CalendarItemRow key={`${item.date}-${item.sourceKey}-${item.vodId}`} item={item} />
        ))}
      </div>
    </div>
  );
}

function StripSkeleton() {
  return (
    <div className="grid grid-cols-7 gap-1.5 sm:gap-2">
      {Array.from({ length: 7 }).map((_, i) => (
        <div key={i} className="h-16 animate-pulse rounded-md border border-line/60 bg-chip sm:h-[72px]" />
      ))}
    </div>
  );
}

/**
 * 首页「本周追剧」模块。
 * 只在有可用源时请求；源全挂时安静地不占位置（首页不该因为一个模块报错）。
 */
export function WatchCalendarModule({
  sources,
  watchlist,
  limit = 4,
  className,
}: {
  sources: { key: string; name: string; url: string; isAdult?: boolean }[];
  watchlist?: string[];
  limit?: number;
  className?: string;
}) {
  const router = useRouter();
  const query = useQuery<CalendarPayload>({
    queryKey: ['watch-calendar-home', sources.map((s) => s.url).sort().join('|'), watchlist?.length ?? 0],
    queryFn: ({ signal }) =>
      api.calendar({ sources, week: 'current', kind: 'all', limit, watchlist }, signal),
    enabled: sources.length > 0,
    staleTime: 5 * 60_000,
  });

  const data = query.data;

  if (sources.length === 0) return null;
  if (query.isError) return null;

  return (
    <section className={cn('mb-8', className)} aria-label="本周追剧">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="row-title flex items-center gap-2 text-content">
          <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] text-accent" fill="none" stroke="currentColor" strokeWidth={1.9} aria-hidden>
            <rect x="3" y="5" width="18" height="16" rx="2.5" />
            <path d="M3 10h18M8 3v4M16 3v4" strokeLinecap="round" />
          </svg>
          本周追剧
          <span className="hidden text-[12px] font-normal text-faint sm:inline">按日期查看影片更新</span>
        </h2>
        <div className="flex items-baseline gap-3">
          {data && <span className="text-[12px] text-faint">{data.weekLabel}</span>}
          <Link href="/calendar" className="btn-ghost btn-sm">
            查看完整日历
          </Link>
        </div>
      </div>

      {!data ? (
        <StripSkeleton />
      ) : (
        <>
          <WeekStrip
            days={data.days}
            selected={data.selected.date}
            onSelect={(date) => router.push(`/calendar?date=${date}`)}
          />
          <div className="mt-3.5 flex items-baseline justify-between">
            <h3 className="text-[13.5px] font-semibold text-content">
              {data.selected.weekdayLabel} {data.selected.date.slice(5, 7)}月{Number(data.selected.date.slice(8, 10))}日
              {data.selected.today && <span className="ml-1.5 text-[11px] font-normal text-accent">今天</span>}
            </h3>
            <span className="text-[12px] text-faint">共 {data.selected.totals.all} 部有更新</span>
          </div>
          {data.groups.length === 0 ? (
            <p className="mt-2 rounded-lg border border-dashed border-line px-3 py-5 text-center text-[12.5px] text-faint">
              今天这几个源还没有更新记录——源站通常凌晨到上午陆续放出，晚点再看。
            </p>
          ) : (
            <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
              {data.groups.map((g) => (
                <GroupColumn key={g.key} group={g} />
              ))}
            </div>
          )}
          <p className="mt-3 text-[11px] leading-relaxed text-faint">{data.notice}</p>
        </>
      )}
    </section>
  );
}

/** 分类条：全部 + 有数据的分类，选中整块填红（kanju 用绿，这里用 Netflix 红） */
export function KindTabs({
  categories,
  active,
  onChange,
}: {
  categories: { key: string; label: string; total: number }[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="按分类筛选">
      {categories.map((c) => {
        const on = c.key === active;
        return (
          <button
            key={c.key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(c.key)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px] font-medium transition-colors',
              on
                ? 'border-accent bg-accent text-on-accent'
                : 'border-line bg-chip/60 text-muted hover:border-line hover:bg-hover hover:text-content'
            )}
          >
            {c.label}
            <span className={cn('text-[11px]', on ? 'text-on-accent/75' : 'text-faint')}>{c.total}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 整页周表里的一条（横版大卡，带来源与集数） */
export function CalendarWideCard({ item }: { item: CalendarCard }) {
  return (
    <Link
      href={detailHref(item)}
      className="group/wide flex items-center gap-2.5 overflow-hidden rounded-xl border border-line/70 bg-card p-1.5 transition-all duration-200 hover:-translate-y-0.5 hover:border-accent/45 hover:shadow-lg"
    >
      <span className="relative block h-[76px] w-[54px] shrink-0 overflow-hidden rounded-lg bg-chip">
        {item.pic ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/proxy?url=${encodeURIComponent(item.pic)}`}
            alt={item.name}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover transition-transform duration-300 group-hover/wide:scale-105"
          />
        ) : (
          <span className="grid h-full w-full place-items-center text-[9px] text-faint">无封面</span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-1 text-[13px] font-semibold text-content">{item.name}</span>
        <span className="mt-0.5 line-clamp-1 text-[11.5px] text-faint">
          {item.remarks || item.typeName || ''}
          {item.at ? ` · ${item.at}` : ''}
        </span>
        <span className="mt-1 inline-flex items-center gap-1 rounded bg-chip px-1.5 py-0.5 text-[10px] text-muted">
          {item.sourceName}
        </span>
      </span>
    </Link>
  );
}

/** 供整页复用：把分组渲染成 rail（一屏多列，箭头翻页） */
export function GroupRail({ group }: { group: CalendarGroup }) {
  return (
    <Rail className="-mx-1 px-1">
      {group.items.map((item) => (
        <div key={`${item.date}-${item.sourceKey}-${item.vodId}`} className="w-[168px] shrink-0 snap-start">
          <CalendarWideCard item={item} />
        </div>
      ))}
    </Rail>
  );
}
