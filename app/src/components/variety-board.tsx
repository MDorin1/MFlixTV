'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AggregatedCard, aggregateResults } from '@/components/video-card';
import { cn } from '@/lib/utils';
import type { SearchResultItem } from '@/lib/types';

/** 短剧二级筛选：真人剧 / AI剧 / 漫剧（按分类名与标题判断，纯前端过滤） */
export const KIND_FILTERS = ['全部', '真人剧', 'AI剧', '漫剧'] as const;

function kindOf(item: { name?: string; typeName?: string }): '真人剧' | 'AI剧' | '漫剧' {
  const t = ((item.typeName || '') + ' ' + (item.name || '')).toUpperCase();
  if (t.includes('AI')) return 'AI剧';
  if (/漫剧|动漫|动画/.test(t)) return '漫剧';
  return '真人剧';
}

export const VARIETY_CATEGORIES = ['综艺', '大陆综艺', '港台综艺', '日韩综艺', '欧美综艺'];

/**
 * 海外向分类。第一项「海外」是服务端聚合模式：把各源的海外剧/日韩剧/韩剧/日剧/欧美综艺…
 * 一次全拉回来按更新时间倒序合并，所以不管哪家有新片都落在这一排里；
 * 后面的单项就是按某个分类精确浏览（哪家有就出哪家）。
 */
export const OVERSEAS_CATEGORIES = [
  '海外',
  '海外剧',
  '日韩剧',
  '韩剧',
  '日剧',
  '欧美剧',
  '美剧',
  '泰剧',
  '日韩综艺',
  '欧美综艺',
  '港台综艺',
  '海外动漫',
];

/** 点播源里的短剧分类（实测 豪华资源 48 个分类里的这批） */
export const SHORT_CATEGORIES = [
  '短剧',
  '反转爽剧',
  '擦边短剧',
  'AI漫剧',
  '古装仙侠',
  '现代都市',
  '穿越年代',
  '言情总裁',
  '重生民国',
  '脑洞悬疑',
];

export function VarietyBoard() {
  return <CategoryBoard categories={VARIETY_CATEGORIES} cachePrefix="variety" />;
}

/** 海外板块：默认就停在聚合那一档，进来先看到各源最新的海外剧与日韩综艺 */
export function OverseasBoard() {
  return <CategoryBoard categories={OVERSEAS_CATEGORIES} cachePrefix="overseas" defaultCategory="海外" />;
}

export function CategoryBoard({
  categories,
  cachePrefix,
  defaultCategory,
}: {
  categories: string[];
  cachePrefix: string;
  defaultCategory?: string;
}) {
  const router = useRouter();
  const [category, setCategory] = useState(
    defaultCategory && categories.includes(defaultCategory)
      ? defaultCategory
      : (categories[1] ?? categories[0])
  );
  const [items, setItems] = useState<SearchResultItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr('');
    const key = 'mflixtv:' + cachePrefix + ':' + category;
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const cached = JSON.parse(raw);
        if (Array.isArray(cached)) setItems(cached);
      }
    } catch {
      /* 忽略 */
    }
    /** 「海外」聚合模式服务端有软截止：partial 时先渲染已有结果，几秒后自动补齐一次 */
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = (isRetry: boolean) => {
      fetch('/api/category?category=' + encodeURIComponent(category) + '&page=1')
        .then(async (r) => {
          const d = await r.json();
          if (!r.ok) throw new Error(d && d.error ? d.error : '加载失败');
          return d as { items?: SearchResultItem[]; partial?: boolean };
        })
        .then((d) => {
          if (!alive) return;
          const list = d.items || [];
          if (list.length > 0 || !isRetry) setItems(list);
          if (list.length > 0) {
            try {
              localStorage.setItem(key, JSON.stringify(list.slice(0, 120)));
            } catch {
              /* 配额满 */
            }
          }
          if (d.partial && !isRetry) {
            retry = setTimeout(() => alive && load(true), 8000);
          }
        })
        .catch((e) => {
          if (alive && !isRetry) setErr(e instanceof Error ? e.message : '加载失败');
        })
        .finally(() => alive && !isRetry && setLoading(false));
    };
    load(false);
    return () => {
      alive = false;
      if (retry) clearTimeout(retry);
    };
  }, [category, cachePrefix]);

  const [kind, setKind] = useState<(typeof KIND_FILTERS)[number]>('全部');
  const filtered = useMemo(
    () => (kind === '全部' ? items : items.filter((it) => kindOf(it) === kind)),
    [items, kind]
  );
  const groups = useMemo(() => aggregateResults(filtered), [filtered]);

  const open = (item: SearchResultItem) => {
    const sp = new URLSearchParams({ name: item.name, sn: item.sourceName });
    if (item.pic) sp.set('pic', item.pic);
    if (item.sourceUrl) sp.set('su', item.sourceUrl);
    router.push('/detail/' + encodeURIComponent(item.sourceKey) + '/' + encodeURIComponent(item.vodId) + '?' + sp.toString());
  };

  return (
    <section aria-label="分类浏览">
      {/* 二级筛选：真人剧 / AI剧 / 漫剧 */}
      <div className="mb-2 flex flex-wrap gap-1.5">
        {KIND_FILTERS.map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={cn(
              'rounded-full px-3 py-1 text-[12.5px] transition-colors',
              k === kind ? 'bg-content font-medium text-page' : 'bg-chip text-muted hover:text-content'
            )}
          >
            {k}
          </button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5">
        {categories.map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            className={cn(
              'rounded-full px-3 py-1.5 text-[13px] transition-colors',
              c === category ? 'bg-accent font-medium text-on-accent' : 'bg-chip text-muted hover:text-content'
            )}
          >
            {c}
          </button>
        ))}
      </div>

      {err ? (
        <p className="py-10 text-center text-sm text-faint">分类加载失败：{err}</p>
      ) : loading && groups.length === 0 ? (
        <div className="poster-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-x-3 gap-y-5">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="aspect-[2/3] animate-pulse rounded-2xl bg-chip" />
          ))}
        </div>
      ) : groups.length === 0 ? (
        <p className="py-10 text-center text-sm text-faint">这个分类暂时没有内容，换一个试试</p>
      ) : (
        <div className="poster-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-x-3 gap-y-5 items-start">
          {groups.map((g) => (
            <AggregatedCard key={g.key} group={g} onOpen={open} />
          ))}
        </div>
      )}
    </section>
  );
}
