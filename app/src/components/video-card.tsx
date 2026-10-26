'use client';

import { useEffect, useMemo, useState } from 'react';
import type { SearchResultItem, SourceConfig } from '@/lib/types';
import { useAppStore } from '@/lib/store';
import { qualityKey } from '@/lib/quality';
import { compactRemarks, inferGroupRemarks } from '@/lib/remarks';
import { cn } from '@/lib/utils';
import { SmartImage } from './smart-image';
import { QualityBadge } from './quality-badge';
import { useQualityProbe } from './use-quality-probe';
import { useInView } from './use-in-view';

// —— 跨源同名聚合 ——

export interface AggregatedGroup {
  key: string;
  name: string;
  year?: string;
  typeName?: string;
  pic?: string;
  remarks?: string;
  items: SearchResultItem[];
}

function buildGroup(name: string, year: string | undefined, items: SearchResultItem[]): AggregatedGroup {
  return {
    key: `${name}|${year ?? ''}|${items.map((i) => `${i.sourceKey}_${i.vodId}`).join(',')}`,
    name,
    year,
    typeName: items.find((i) => i.typeName)?.typeName,
    pic: items.find((i) => i.pic)?.pic,
    // 同一部剧各源文案详略不同（「全34集」/「完结」/「更新至34集」），推到统一结论，
    // 否则同一部剧的来源列表会看起来状态各异
    remarks: inferGroupRemarks(items.map((i) => i.remarks)),
    items,
  };
}

/**
 * 把扁平的跨源搜索结果按「同名影片」聚合：
 * - 以名称分桶；桶内年份不一致时（同名翻拍）按年份拆分，无年份的条目并入年份桶；
 * - 保持传入顺序（搜索结果已按名称排序）。
 */
export function aggregateResults(list: SearchResultItem[]): AggregatedGroup[] {
  const byName = new Map<string, SearchResultItem[]>();
  for (const item of list) {
    const k = (item.name || '').trim();
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k)!.push(item);
  }
  const groups: AggregatedGroup[] = [];
  for (const [name, items] of byName) {
    const years = [...new Set(items.map((i) => i.year).filter(Boolean))] as string[];
    if (years.length > 1) {
      for (const y of years) {
        groups.push(buildGroup(name, y, items.filter((i) => i.year === y)));
      }
      const noYear = items.filter((i) => !i.year);
      if (noYear.length) groups.push(buildGroup(name, undefined, noYear));
    } else {
      groups.push(buildGroup(name, years[0], items));
    }
  }
  return groups;
}

const PlayGlyph = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.4-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14z" />
  </svg>
);

const PosterFallback = () => (
  <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-chip to-line/40">
    <svg className="h-9 w-9 text-faint/60" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.4}
        d="M7 4v16m10-16v16M3 6a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6zm4 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6zm8 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6zm4 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6z"
      />
    </svg>
  </div>
);

/**
 * 聚合影片卡片（海报墙版）：
 * - 竖版 2:3 海报，圆角悬浮卡，悬停上浮 + 封面轻微缩放 + 播放按钮浮现；
 * - 单源：点击直接打开该源详情；
 * - 多源：显示「N 源」徽章，点击在卡片下方展开各源列表，选择具体源后打开详情。
 */
export function AggregatedCard({
  group,
  onOpen,
  sources,
}: {
  group: AggregatedGroup;
  onOpen: (item: SearchResultItem) => void;
  /** 完整源配置：探测画质需要 source.url / source.detail，搜索结果里只带 sourceUrl */
  sources?: SourceConfig[];
}) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const [imgFailed, setImgFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const showImg = !!group.pic && !imgFailed;

  const multi = group.items.length > 1;
  const adult = useMemo(() => group.items.some((i) => i.isAdult), [group.items]);

  const { qualities, probing, progress, prime, probe, probeQueued, retry } = useQualityProbe(sources);

  // 收起态就要有结论：先读缓存（展开时才真正探测）。
  // 依赖 group.key 而不是 items 数组——搜索页每次重渲染都会重建分组对象，
  // 用数组做依赖会让这个 effect 每帧触发，进而 setState 死循环。
  useEffect(() => {
    prime(group.items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.key]);

  // 单源卡片没有「展开」这一步：进入视口 500ms 后交给全局队列（并发 2），
  // 首屏能先亮，又不会把一屏十几张卡同时打向源站
  const { ref: inViewRef, inView } = useInView<HTMLDivElement>(!multi);
  useEffect(() => {
    if (!multi && inView) probeQueued(group.items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multi, inView, group.key]);

  const activate = () => {
    if (multi) {
      const next = !expanded;
      setExpanded(next);
      if (next) probe(group.items);
    } else {
      onOpen(group.items[0]);
    }
  };

  const singleItem = multi ? undefined : group.items[0];
  const singleKey = singleItem ? qualityKey(singleItem.sourceKey, singleItem.vodId) : undefined;

  // 展开面板按画质降序（同级保持原有源顺序）：探到一个更好的就往上走，
  // 用户不必自己横向比较三行灰字。没探到 / 未探到的排在最后。
  const heightOf = (item: SearchResultItem) => qualities[qualityKey(item.sourceKey, item.vodId)]?.height ?? 0;
  const sortedItems = useMemo(() => {
    const height = (item: SearchResultItem) => qualities[qualityKey(item.sourceKey, item.vodId)]?.height ?? 0;
    return group.items
      .map((item, index) => ({ item, index }))
      .sort((a, b) => height(b.item) - height(a.item) || a.index - b.index)
      .map((entry) => entry.item);
  }, [group.items, qualities]);
  const bestHeight = sortedItems.reduce((max, item) => Math.max(max, heightOf(item)), 0);
  // 并列最高时只强调排在第一的那一行：三个源里框两个等于没有推荐
  const firstBest = sortedItems.find((item) => bestHeight > 0 && heightOf(item) === bestHeight);
  const bestKey = firstBest ? qualityKey(firstBest.sourceKey, firstBest.vodId) : undefined;
  // 各源集数一致时（常见：同剧多源同步更新）只在表头说一次，逐行不再重复
  const remarksList = sortedItems.map((item) => compactRemarks(item.remarks));
  const sharedRemarks =
    remarksList.length > 0 && remarksList.every((label) => label && label === remarksList[0])
      ? remarksList[0]
      : undefined;

  const metaLine = [group.year, group.typeName].filter(Boolean).join(' · ');

  return (
    <div ref={inViewRef} className="group/poster relative select-none">
      <div
        className={cn(
          'relative cursor-pointer rounded-2xl outline-none transition-all duration-300',
          'hover:-translate-y-1 focus-visible:-translate-y-1',
          'focus-visible:ring-2 focus-visible:ring-accent/70'
        )}
        role="button"
        tabIndex={0}
        aria-expanded={multi ? expanded : undefined}
        aria-label={`${group.name}${metaLine ? `，${metaLine}` : ''}${multi ? `，${group.items.length} 个来源` : ''}`}
        onClick={activate}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            activate();
          }
        }}
      >
        {/* 海报 */}
        <div
          className={cn(
            'relative aspect-[2/3] w-full overflow-hidden rounded-2xl bg-chip',
            'ring-1 ring-line/70 transition-all duration-300',
            'group-hover/poster:ring-accent/50 group-hover/poster:shadow-[0_22px_45px_-18px_rgba(0,0,0,.85)]',
            multi && expanded && 'ring-accent/60 shadow-[0_22px_45px_-18px_rgba(0,0,0,.85)]'
          )}
        >
          {showImg ? (
            <SmartImage
              url={group.pic}
              mode={imageProxyMode}
              customProxy={customImageProxy}
              alt={group.name}
              className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover/poster:scale-[1.07]"
              onExhausted={() => setImgFailed(true)}
            />
          ) : (
            <PosterFallback />
          )}

          {/* 底部信息渐变 */}
          <div className="poster-scrim pointer-events-none absolute inset-x-0 bottom-0 h-[68%]" />

          {/* 顶部徽章 */}
          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-1 p-2">
            {multi ? (
              <span className="badge-glass">{group.items.length} 源</span>
            ) : (
              <span className="badge-glass opacity-80">{(group.items[0].sourceName || '').slice(0, 6)}</span>
            )}
            {singleKey && (
              <QualityBadge
                entry={qualities[singleKey]}
                loading={probing[singleKey]}
                onRetry={singleItem ? () => retry([singleItem]) : undefined}
                className="pointer-events-auto"
              />
            )}
          </div>

          {/* 悬停播放按钮 */}
          <div className="pointer-events-none absolute inset-0 grid place-items-center opacity-0 transition-opacity duration-300 group-hover/poster:opacity-100">
            <span className="grid h-12 w-12 place-items-center rounded-full bg-white/20 text-white shadow-lg ring-1 ring-white/35 backdrop-blur-md">
              <PlayGlyph className="h-5 w-5 translate-x-[1px]" />
            </span>
          </div>

          {/* 底部标题 */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 p-2.5 pb-2">
            <h3
              className="poster-title line-clamp-2 text-[15px] leading-[1.22]"
              title={group.name}
            >
              {group.name}
            </h3>
            <p className="poster-sub mt-1 truncate text-[11.5px] font-medium">{metaLine || '—'}</p>
          </div>

          {adult && <span className="absolute right-2 bottom-14 tag bg-pink-500/85 text-white">18+</span>}
        </div>

        {/* 信息条 */}
        <div className="mt-1.5 px-0.5">
          <div className="flex items-center justify-between gap-1.5">
            <span className="truncate text-[11px] text-faint">
              {multi ? `${group.items.length} 个来源` : group.items[0].sourceName}
            </span>
            <span className="flex shrink-0 items-center gap-1">
              {progress.best && (
                <span
                  className="chip bg-accent/15 font-medium text-accent"
                  title={
                    progress.known < progress.total
                      ? `已探到 / 实测的最高画质（${progress.known}/${progress.total} 个来源已有结论）`
                      : '已探到 / 实测的最高画质'
                  }
                >
                  {progress.best}
                </span>
              )}
              {multi && (
                <svg
                  className={cn('h-3.5 w-3.5 text-faint transition-transform duration-300', expanded && 'rotate-180')}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              )}
            </span>
          </div>
          <p className="mt-0.5 line-clamp-1 text-[11px] text-faint/85">{group.remarks || '暂无简介'}</p>
        </div>
      </div>

      {multi && expanded && (
        <div className="mt-2 animate-fade-in rounded-xl border border-line bg-card/80 p-2.5 shadow-lg backdrop-blur">
          <div className="mb-1.5 flex items-baseline justify-between gap-2">
            <p className="text-[10px] text-faint">
              选择来源
              {sharedRemarks ? ` · 均 ${sharedRemarks}` : ''}
            </p>
            {progress.total > 0 &&
              (progress.done < progress.total ? (
                <p className="text-[10px] tabular-nums text-faint">
                  探测中 {progress.done}/{progress.total}
                </p>
              ) : (
                // 探完后「3/3」已经没有信息量，换成用户真正要的结论
                <p className="text-[10px] tabular-nums text-accent">
                  {progress.best ? `最高 ${progress.best}` : '未能探到画质'}
                  {progress.failed > 0 ? ` · ${progress.failed} 源未探到` : ''}
                </p>
              ))}
          </div>
          {/*
            单列全宽行：一行内「源名 / 画质 / 集数 / 播放」四段排开，
            信息密度更高也更容易纵向扫读。
          */}
          <div className="flex flex-col gap-1.5">
            {sortedItems.map((item) => {
              const itemKey = qualityKey(item.sourceKey, item.vodId);
              const label = compactRemarks(item.remarks);
              const isBest = itemKey === bestKey;
              return (
                <div
                  key={`${item.sourceKey}_${item.vodId}`}
                  role="button"
                  tabIndex={0}
                  className={cn(
                    'group/row flex w-full min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2',
                    'text-xs transition-all cursor-pointer',
                    'bg-chip hover:border-accent hover:bg-accent/10',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                    isBest ? 'border-accent/50' : 'border-line',
                    item.isAdult && 'border-pink-500/30'
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpen(item);
                  }}
                  onKeyDown={(e) => {
                    // 不拦冒泡会连带触发整卡的 activate（外层 div 也在监听 Enter/Space）
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    e.stopPropagation();
                    onOpen(item);
                  }}
                  aria-label={`使用 ${item.sourceName} 播放${label && !sharedRemarks ? `，${label}` : ''}`}
                >
                  <span className="min-w-0 flex-1 truncate font-medium text-content">{item.sourceName}</span>
                  <QualityBadge
                    entry={qualities[itemKey]}
                    loading={probing[itemKey]}
                    onRetry={() => retry([item])}
                    // 定宽 + 等宽数字：三行的 360P / 540P / 1080P 左缘对齐，不随字符数抖动
                    className="min-w-[3.25rem] justify-center tabular-nums"
                  />
                  {/* 集数一致时已提到表头，逐行不再重复 */}
                  {!sharedRemarks && label && <span className="shrink-0 tabular-nums text-faint">{label}</span>}
                  <svg
                    className="h-3.5 w-3.5 shrink-0 text-accent transition-transform group-hover/row:translate-x-0.5"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden
                  >
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** 影片卡片：封面加载失败时逐级降级到占位图（未聚合的单一结果使用） */
export function VideoCard({ item, onClick }: { item: SearchResultItem; onClick: () => void }) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = !!item.pic && !imgFailed;
  const metaLine = [item.year, item.typeName].filter(Boolean).join(' · ');

  return (
    <div
      className="group/poster cursor-pointer select-none rounded-2xl outline-none transition-all duration-300 hover:-translate-y-1 focus-visible:ring-2 focus-visible:ring-accent/70"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          // 阻止空格触发页面滚动（AggregatedCard 已是此写法，此处对齐）
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div className="relative aspect-[2/3] w-full overflow-hidden rounded-2xl bg-chip ring-1 ring-line/70 transition-all duration-300 group-hover/poster:shadow-[0_22px_45px_-18px_rgba(0,0,0,.85)]">
        {showImg ? (
          <SmartImage
            url={item.pic}
            mode={imageProxyMode}
            customProxy={customImageProxy}
            alt={item.name}
            className="h-full w-full object-cover transition-transform duration-500 group-hover/poster:scale-[1.07]"
            onExhausted={() => setImgFailed(true)}
          />
        ) : (
          <PosterFallback />
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/90 via-black/45 to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 p-2.5">
          <h3 className="line-clamp-2 text-[13px] font-semibold leading-snug text-white drop-shadow-[0_1px_3px_rgba(0,0,0,.9)]" title={item.name}>
            {item.name}
          </h3>
          <p className="mt-0.5 truncate text-[11px] text-white/70">{metaLine || item.sourceName}</p>
        </div>
      </div>
      <div className="mt-1.5 px-0.5">
        <span className="truncate text-[11px] text-faint">{item.sourceName}</span>
      </div>
    </div>
  );
}

/** 豆瓣推荐卡片（无来源徽章，点击直接搜索） */
export function DoubanCard({ item, onClick }: { item: { title: string; cover: string; rating?: string }; onClick: () => void }) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => setImgFailed(false), [item.cover]);

  return (
    <div
      className="group/poster cursor-pointer select-none rounded-2xl outline-none transition-all duration-300 hover:-translate-y-1 focus-visible:ring-2 focus-visible:ring-accent/70"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          // 阻止空格触发页面滚动（AggregatedCard 已是此写法，此处对齐）
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div className="relative aspect-[2/3] overflow-hidden rounded-2xl bg-chip ring-1 ring-line/70 transition-all duration-300 group-hover/poster:shadow-[0_22px_45px_-18px_rgba(0,0,0,.85)]">
        {item.cover && !imgFailed ? (
          <SmartImage
            url={item.cover}
            mode={imageProxyMode}
            customProxy={customImageProxy}
            alt={item.title}
            className="h-full w-full object-cover transition-transform duration-500 group-hover/poster:scale-[1.07]"
            onExhausted={() => setImgFailed(true)}
          />
        ) : (
          <PosterFallback />
        )}
        <div className="poster-scrim pointer-events-none absolute inset-x-0 bottom-0 h-[55%]" />
        {item.rating && (
          <span className="absolute right-2 top-2 badge-glass text-rating">★ {item.rating}</span>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 p-2 pb-2">
          <div
            className="poster-title line-clamp-2 text-[14px] leading-[1.2]"
            title={item.title}
          >
            {item.title}
          </div>
        </div>
      </div>
    </div>
  );
}
