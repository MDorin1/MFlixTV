'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AggregatedCard, aggregateResults } from '@/components/video-card';
import { cn } from '@/lib/utils';
import type { SearchResultItem } from '@/lib/types';

const CATEGORIES = ['综艺', '大陆综艺', '港台综艺', '日韩综艺', '欧美综艺'];

export function VarietyBoard() {
  const router = useRouter();
  const [category, setCategory] = useState(CATEGORIES[1]);
  const [items, setItems] = useState<SearchResultItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr('');
    const key = 'mflixtv:variety:' + category;
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const cached = JSON.parse(raw);
        if (Array.isArray(cached)) setItems(cached);
      }
    } catch {
      /* 忽略 */
    }
    fetch('/api/category?category=' + encodeURIComponent(category) + '&page=1')
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d && d.error ? d.error : '加载失败');
        return d as { items?: SearchResultItem[] };
      })
      .then((d) => {
        if (!alive) return;
        const list = d.items || [];
        setItems(list);
        try {
          localStorage.setItem(key, JSON.stringify(list.slice(0, 120)));
        } catch {
          /* 配额满 */
        }
      })
      .catch((e) => alive && setErr(e instanceof Error ? e.message : '加载失败'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [category]);

  const groups = useMemo(() => aggregateResults(items), [items]);

  const open = (item: SearchResultItem) => {
    const sp = new URLSearchParams({ name: item.name, sn: item.sourceName });
    if (item.pic) sp.set('pic', item.pic);
    if (item.sourceUrl) sp.set('su', item.sourceUrl);
    router.push('/detail/' + encodeURIComponent(item.sourceKey) + '/' + encodeURIComponent(item.vodId) + '?' + sp.toString());
  };

  return (
    <section aria-label="综艺分类">
      <div className="mb-4 flex flex-wrap gap-1.5">
        {CATEGORIES.map((c) => (
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
        <p className="py-10 text-center text-sm text-faint">综艺分类加载失败：{err}</p>
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
