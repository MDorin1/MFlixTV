'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Icon } from '@/components/icon';

interface Person {
  id: string;
  name: string;
  latinName: string;
  avatar: string;
  subtitle: string;
}
interface Work {
  id: string;
  title: string;
  year: string;
  type: 'movie' | 'tv';
  rating: number | null;
  cover: string;
  genres: string[];
}

function proxied(url: string) {
  if (!url) return '';
  return `/api/proxy?url=${encodeURIComponent(url)}`;
}

type Sort = 'hot' | 'time';

export default function PersonPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id || '';
  const [person, setPerson] = useState<Person | null>(null);
  const [works, setWorks] = useState<Work[]>([]);
  const [total, setTotal] = useState(0);
  const [sort, setSort] = useState<Sort>('hot');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr('');
    fetch(`/api/douban/person?id=${encodeURIComponent(id)}&sort=${sort}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d?.error || '加载失败');
        return d;
      })
      .then((d) => {
        if (!alive) return;
        setPerson(d.person);
        setWorks(d.works || []);
        setTotal(d.total || 0);
      })
      .catch((e) => alive && setErr(e.message || '加载失败'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [id, sort]);

  return (
    <div className="min-h-screen bg-surface">
      <div className="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2.5 sm:px-6">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-1.5 rounded-full bg-chip px-3 py-1.5 text-xs text-muted hover:text-content"
          >
            <Icon name="arrowDown" className="h-3.5 w-3.5 rotate-90" />
            返回
          </button>
          <Link href="/" className="rounded-full bg-chip px-3 py-1.5 text-xs text-muted hover:text-content">
            首页
          </Link>
        </div>
      </div>

      <main className="mx-auto max-w-6xl px-4 pb-16 pt-6 sm:px-6">
        {/* 人物头 */}
        <header className="flex items-center gap-4">
          <div className="h-20 w-20 shrink-0 overflow-hidden rounded-full bg-chip ring-1 ring-line sm:h-24 sm:w-24">
            {person?.avatar ? (
              <img src={proxied(person.avatar)} alt={person.name} className="h-full w-full object-cover" />
            ) : (
              <div className="grid h-full w-full place-items-center text-2xl text-faint">
                {(person?.name || '?').slice(0, 1)}
              </div>
            )}
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-content sm:text-2xl">{person?.name || '加载中…'}</h1>
            {person?.latinName && <p className="mt-0.5 text-xs text-faint">{person.latinName}</p>}
            {person?.subtitle && <p className="mt-0.5 line-clamp-1 text-xs text-faint">{person.subtitle}</p>}
            <p className="mt-1 text-xs text-muted">
              共 <span className="font-semibold text-content">{total || works.length}</span> 部作品
            </p>
          </div>
        </header>

        {/* 排序：热度 / 时间 */}
        <div className="mt-5 flex items-center gap-2">
          {(
            [
              ['hot', '最热'],
              ['time', '最新'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setSort(k)}
              className={
                'rounded-full px-3.5 py-1.5 text-xs transition-colors ' +
                (sort === k
                  ? 'bg-accent font-medium text-on-accent'
                  : 'bg-chip text-muted hover:text-content')
              }
            >
              {label}
            </button>
          ))}
          {loading && <span className="text-xs text-faint">加载中…</span>}
        </div>

        {err && (
          <div className="mt-5 rounded-xl border border-line bg-chip p-4 text-sm text-muted">{err}</div>
        )}

        {/* 作品网格：手机 3 列 / 平板 4-5 / 桌面 6 */}
        <div className="mt-4 grid grid-cols-3 gap-2.5 sm:grid-cols-4 sm:gap-3 md:grid-cols-5 lg:grid-cols-6">
          {works.map((w) => (
            <Link key={w.id} href={`/title/${w.id}`} className="group block">
              <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-chip ring-1 ring-line">
                {w.cover ? (
                  <img
                    src={proxied(w.cover)}
                    alt={w.title}
                    loading="lazy"
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                  />
                ) : (
                  <div className="grid h-full w-full place-items-center px-1 text-center text-[10px] text-faint">
                    {w.title}
                  </div>
                )}
                {w.rating !== null && (
                  <span className="absolute left-1 top-1 rounded bg-black/70 px-1 py-[1px] text-[10px] font-medium text-amber-300">
                    ★ {w.rating.toFixed(1)}
                  </span>
                )}
              </div>
              <p className="mt-1.5 line-clamp-1 text-[11px] text-content sm:text-xs">{w.title}</p>
              <p className="line-clamp-1 text-[10px] text-faint">
                {[w.year, w.type === 'tv' ? '剧集' : '电影'].filter(Boolean).join(' · ')}
              </p>
            </Link>
          ))}
        </div>

        {!loading && !err && works.length === 0 && (
          <p className="mt-8 text-center text-sm text-faint">没有取到作品列表（豆瓣可能限流，稍后重试）</p>
        )}
      </main>
    </div>
  );
}
