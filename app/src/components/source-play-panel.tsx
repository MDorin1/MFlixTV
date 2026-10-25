'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client-api';
import { useAppStore, resolveSource, isInDisabledSubscription, isSourceDisabled } from '@/lib/store';
import { buildWatchUrl, validateSourceUrl, cn } from '@/lib/utils';
import { formatRemarks } from '@/lib/remarks';
import { copyToClipboard } from '@/lib/clipboard';
import { addSearchHistory } from '@/lib/db';
import type { SearchResultItem, VideoDetail } from '@/lib/types';
import { useToast } from './toast';
import { Icon } from './icon';

/**
 * 采集源播放面板（原「播放前详情弹窗」的替代）。
 *
 * 资料页里的一块：按标题聚合各采集源 → 选源 → 选集 → 直接进播放器。
 * 换成整页而不是弹窗，是为了让「资料 + 播放」在同一页完成：
 * 看简介、看演员、挑源、点集数，中间不再跳来跳去。
 */

export interface PlaySource {
  sourceKey: string;
  sourceName: string;
  vodId: string;
  name: string;
  pic?: string;
  year?: string;
  remarks?: string;
  sourceUrl?: string;
}

interface DetailState {
  data?: VideoDetail;
  loading?: boolean;
  error?: string;
}

export function SourcePlayPanel({
  title,
  preferred,
  className,
}: {
  /** 用于跨源搜索的片名 */
  title: string;
  /** 已知来源（从搜索结果点进来时带上，免去再猜哪个源） */
  preferred?: PlaySource;
  className?: string;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const sourceHealth = useAppStore((s) => s.sourceHealth);
  const subscriptions = useAppStore((s) => s.subscriptions);

  /** 各源里同名影片的可用条目 */
  const [options, setOptions] = useState<PlaySource[]>(preferred ? [preferred] : []);
  const [searching, setSearching] = useState(true);
  const [waited, setWaited] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [activeKey, setActiveKey] = useState<string>(preferred?.sourceKey || '');
  const [details, setDetails] = useState<Record<string, DetailState>>({});
  const [reversed, setReversed] = useState(false);

  const searchedRef = useRef(false);

  const sources = useMemo(() => {
    const seen = new Set<string>();
    return selectedKeys
      .map((key) => resolveSource({ customAPIs, envSources }, key))
      .filter((s): s is NonNullable<typeof s> => {
        if (!s || !validateSourceUrl(s.url) || seen.has(s.key)) return false;
        seen.add(s.key);
        return true;
      })
      .filter((s) => !isSourceDisabled({ sourceHealth }, s.key))
      .filter((s) => !isInDisabledSubscription({ subscriptions }, s.key));
  }, [selectedKeys, customAPIs, envSources, sourceHealth, subscriptions]);

  // 首屏：按片名跨源搜索一次，找出哪些源有这部片。
  // 注意要等 store 里的点播源就绪（深链直达资料页时 envSources 是异步灌进来的），
  // 源还没到就先别把「搜过了」的标记立起来，否则会永远显示「没搜到」。
  useEffect(() => {
    if (!title || sources.length === 0) return;
    if (searchedRef.current) return;
    searchedRef.current = true;
    const controller = new AbortController();
    api
      .search(title.slice(0, 100), sources, yellowFilter, { signal: controller.signal })
      .then((res) => {
        const key = normalize(title);
        // 只要同名（去空格/标点后相同）的条目：搜索会带出续集、同名翻拍，别混进换源列表
        const same = (res.list || []).filter((it) => normalize(it.name) === key);
        const picked = (same.length > 0 ? same : res.list || []).map(toPlaySource);
        // 已知来源（从搜索结果点进来）排在最前，其余按搜索结果顺序；同源只留一条
        const seen = new Set<string>();
        const merged: PlaySource[] = [];
        for (const p of [...(preferred ? [preferred] : []), ...picked]) {
          if (!p || seen.has(p.sourceKey)) continue;
          seen.add(p.sourceKey);
          merged.push(p);
        }
        setOptions(merged);
        if (!activeKey && merged[0]) setActiveKey(merged[0].sourceKey);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setSearchError(err instanceof Error ? err.message : '搜索播放源失败');
      })
      .finally(() => setSearching(false));
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, sources.length]);

  // 源列表是异步灌进来的：短暂宽限期内先当「还在加载」，不要立刻下「没有源」的结论
  useEffect(() => {
    const t = setTimeout(() => setWaited(true), 1200);
    return () => clearTimeout(t);
  }, []);

  // 宽限期过了还是没源：结束加载态，直接给「去设置里勾选」的提示
  useEffect(() => {
    if (waited && sources.length === 0) setSearching(false);
  }, [waited, sources.length]);

  const loadDetail = useCallback(
    (opt: PlaySource) => {
      const source = resolveSource({ customAPIs, envSources }, opt.sourceKey, {
        url: opt.sourceUrl,
        name: opt.sourceName,
      });
      if (!source) {
        setDetails((d) => ({ ...d, [opt.sourceKey]: { error: '该点播源已不存在，请在设置里重新添加' } }));
        return;
      }
      setDetails((d) => ({ ...d, [opt.sourceKey]: { ...d[opt.sourceKey], loading: true, error: '' } }));
      api
        .detail(opt.vodId, source)
        .then((data) => setDetails((d) => ({ ...d, [opt.sourceKey]: { data, loading: false } })))
        .catch((err) =>
          setDetails((d) => ({
            ...d,
            [opt.sourceKey]: {
              ...d[opt.sourceKey],
              loading: false,
              error: err instanceof Error ? err.message : '获取剧集失败',
            },
          }))
        );
    },
    [customAPIs, envSources]
  );

  const active = options.find((o) => o.sourceKey === activeKey);
  const activeState = activeKey ? details[activeKey] : undefined;

  // 选中的源第一次出现时拉它的剧集列表
  useEffect(() => {
    if (!active) return;
    if (details[active.sourceKey]?.data || details[active.sourceKey]?.loading) return;
    loadDetail(active);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.sourceKey]);

  const episodes = activeState?.data?.episodes ?? [];
  const orderedIndexes = useMemo(() => {
    const all = episodes.map((_, i) => i);
    return reversed ? all.reverse() : all;
  }, [episodes, reversed]);

  const play = (index: number) => {
    if (!active) return;
    addSearchHistory(title).catch(() => {});
    router.push(
      buildWatchUrl({
        sourceKey: active.sourceKey,
        vodId: active.vodId,
        index,
        title: active.name || title,
        sourceUrl: active.sourceUrl,
      })
    );
  };

  const copyLinks = async () => {
    if (episodes.length === 0) return;
    const ok = await copyToClipboard(episodes.join('\n'));
    toast(ok ? '播放链接已复制' : '复制失败，请检查浏览器权限', ok ? 'success' : 'error');
  };

  const remarks = formatRemarks(activeState?.data?.videoInfo?.remarks || active?.remarks);
  // 「全30集 / 更新至30集」这类备注和左边的「共 30 集」是同一件事，重复显示只是噪声
  const remarkRestatesCount =
    !!remarks && new RegExp(`^\\s*(全|共|更新至|已更新至|连载至)?\\s*${episodes.length}\\s*\\s*集\\s*$`).test(remarks);

  return (
    <section className={cn('mt-8', className)} aria-label="播放源">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold text-white">播放</h2>
        {episodes.length > 0 && (
          <div className="flex items-center gap-2">
            <button className="nf-btn-ghost" onClick={() => setReversed((v) => !v)} title="切换集数排列方向">
              <Icon name="arrowDown" className={cn('h-3.5 w-3.5 transition-transform', reversed && 'rotate-180')} />
              {reversed ? '正序' : '倒序'}
            </button>
            <button className="nf-btn-ghost" onClick={copyLinks}>
              <Icon name="link" className="h-3.5 w-3.5" />
              复制链接
            </button>
          </div>
        )}
      </div>

      {/* 源选择：一行胶囊，横向可滑（手机）/ 自动换行（桌面） */}
      {options.length === 0 && (searching || (!waited && sources.length === 0)) ? (
        <div className="flex gap-2 overflow-hidden">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-8 w-24 shrink-0 animate-pulse rounded-full bg-white/10" />
          ))}
        </div>
      ) : options.length === 0 ? (
        <p className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/70">
          {searchError
            ? `播放源检索失败：${searchError}`
            : sources.length === 0
              ? '还没有勾选点播源，去右上角「设置」里添加后即可播放。'
              : '已勾选的源里暂时没搜到这部片，可以换个源或稍后再试。'}
        </p>
      ) : (
        <>
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {options.map((opt) => {
              const on = opt.sourceKey === activeKey;
              const st = details[opt.sourceKey];
              const count = st?.data?.episodes?.length;
              return (
                <button
                  key={opt.sourceKey}
                  onClick={() => setActiveKey(opt.sourceKey)}
                  className={cn(
                    'shrink-0 rounded-full border px-3.5 py-1.5 text-[13px] transition-colors',
                    on
                      ? 'border-white bg-white font-semibold text-black'
                      : 'border-white/20 bg-white/5 text-white/75 hover:border-white/40 hover:text-white'
                  )}
                >
                  {opt.sourceName || opt.sourceKey}
                  {typeof count === 'number' && (
                    <span className={cn('ml-1.5 text-[11px]', on ? 'text-black/55' : 'text-white/40')}>
                      {count} 集
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* 主播放按钮：直接第一集，Netflix 的白底黑字主按钮 */}
          {episodes.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                onClick={() => play(0)}
                className="inline-flex items-center gap-2 rounded-md bg-white px-6 py-2.5 text-sm font-bold text-black transition hover:bg-white/85"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
                  <path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.4-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14z" />
                </svg>
                播放第 1 集
              </button>
              <span className="text-sm text-white/55">
                共 {episodes.length} 集{remarks && !remarkRestatesCount ? ` · ${remarks}` : ''}
              </span>
            </div>
          )}

          {/* 剧集网格 */}
          <div className="mt-4">
            {activeState?.loading && episodes.length === 0 ? (
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-8 md:grid-cols-10">
                {Array.from({ length: 16 }).map((_, i) => (
                  <div key={i} className="h-10 animate-pulse rounded-md bg-white/10" />
                ))}
              </div>
            ) : activeState?.error ? (
              <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/70">
                <Icon name="alert" className="h-4 w-4 shrink-0 text-white/50" />
                <span className="min-w-0 flex-1">{activeState.error}</span>
                <button className="nf-btn-ghost shrink-0" onClick={() => active && loadDetail(active)}>
                  <Icon name="refresh" className="h-3.5 w-3.5" />
                  重试
                </button>
              </div>
            ) : episodes.length === 0 ? (
              <p className="text-sm text-white/55">这个源暂时没有可播放的剧集，换一个源试试。</p>
            ) : (
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-8 md:grid-cols-10">
                {orderedIndexes.map((realIndex) => (
                  <button
                    key={realIndex}
                    onClick={() => play(realIndex)}
                    className="rounded-md border border-white/15 bg-white/[0.06] py-2 text-center text-sm text-white/85 transition-colors hover:border-white/50 hover:bg-white/15 hover:text-white"
                  >
                    {realIndex + 1}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function toPlaySource(it: SearchResultItem): PlaySource {
  return {
    sourceKey: it.sourceKey,
    sourceName: it.sourceName,
    vodId: it.vodId,
    name: it.name,
    pic: it.pic,
    year: it.year,
    remarks: it.remarks,
    sourceUrl: it.sourceUrl,
  };
}

/** 片名归一化：全半角括号、空白、常见标点差异不该影响「是否同一部」的判断 */
function normalize(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[\s·・:：\-—_/／,，.。!！?？'"“”‘’()（）[\]【】]/g, '');
}
