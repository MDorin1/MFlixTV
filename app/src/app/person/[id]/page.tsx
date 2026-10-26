'use client';

import { useEffect, useMemo, useState } from 'react';
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
type Kind = 'all' | 'movie' | 'tv';

export default function PersonPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id || '';
  const [person, setPerson] = useState<Person | null>(null);
  const [works, setWorks] = useState<Work[]>([]);
  const [total, setTotal] = useState(0);
  const [sort, setSort] = useState<Sort>('hot');
  const [kind, setKind] = useState<Kind>('all');
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

  /** 电影 / 剧集筛选：纯本地筛，不再打豆瓣（那边一次只给一页，翻页还得再请求） */
  const filtered = useMemo(
    () => (kind === 'all' ? works : works.filter((w) => w.type === kind)),
    [works, kind]
  );

  /** 代表作：按评分取前 8 部（没有评分的排在后面，不参与） */
  const highlights = useMemo(
    () =>
      [...works]
        .filter((w) => typeof w.rating === 'number' && w.rating > 0)
        .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
        .slice(0, 8),
    [works]
  );

  const counts = useMemo(
    () => ({
      movie: works.filter((w) => w.type === 'movie').length,
      tv: works.filter((w) => w.type === 'tv').length,
    }),
    [works]
  );

  return (
    <div className="min-h-screen bg-page">
      <div className="sticky top-0 z-30 border-b border-line bg-page/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2.5 sm:px-6">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-1.5 rounded-lg bg-chip px-3 py-1.5 text-[13px] text-muted transition-colors hover:text-content"
          >
            <Icon name="arrowDown" className="h-3.5 w-3.5 rotate-90" />
            返回
          </button>
          <Link href="/" className="rounded-lg bg-chip px-3 py-1.5 text-[13px] text-muted transition-colors hover:text-content">
            首页
          </Link>
        </div>
      </div>

      <main className="mx-auto max-w-6xl px-4 pb-16 pt-6 sm:px-6">
        {/* 人物头 */}
        <header className="flex items-center gap-5">
          <div className="h-24 w-24 shrink-0 overflow-hidden rounded-full bg-chip ring-1 ring-line sm:h-28 sm:w-28">
            {person?.avatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={proxied(person.avatar)} alt={person.name} className="h-full w-full object-cover" />
            ) : (
              <div className="grid h-full w-full place-items-center text-2xl text-faint">
                {(person?.name || '?').slice(0, 1)}
              </div>
            )}
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-content sm:text-3xl">{person?.name || '加载中…'}</h1>
            {person?.latinName && <p className="mt-1 text-[13px] text-faint">{person.latinName}</p>}
            {person?.subtitle && <p className="mt-0.5 line-clamp-1 text-[13px] text-muted">{person.subtitle}</p>}
            <p className="mt-2 text-[13px] text-muted">
              共 <span className="font-semibold text-content">{total || works.length}</span> 部作品
              {works.length > 0 && (
                <span className="text-faint">
                  {' '}
                  · 电影 {counts.movie} · 剧集 {counts.tv}
                </span>
              )}
            </p>
          </div>
        </header>

        {/* 代表作：高分优先，横滑一行——进来先看到「他最好的几部」，而不是一屏平铺 */}
        {highlights.length > 0 && (
          <section className="mt-8">
            <h2 className="row-title mb-3.5 text-content">代表作</h2>
            <div className="-mx-4 flex gap-2.5 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {highlights.map((w) => (
                <Link key={`h-${w.id}`} href={`/title/${w.id}`} className="group/h w-[112px] shrink-0 sm:w-[128px]">
                  <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-chip ring-1 ring-line/70">
                    {w.cover && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={proxied(w.cover)}
                        alt={w.title}
                        loading="lazy"
                        className="h-full w-full object-cover transition-transform duration-300 group-hover/h:scale-105"
                      />
                    )}
                    {typeof w.rating === 'number' && (
                      <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1 py-0.5 text-[10px] font-semibold text-amber-300">
                        ★ {w.rating.toFixed(1)}
                      </span>
                    )}
                    <div className="poster-scrim absolute inset-x-0 bottom-0 h-[55%]" />
                    <p className="poster-title absolute inset-x-0 bottom-0 line-clamp-2 p-1.5 text-[12px] leading-tight">
                      {w.title}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* 全部作品：排序 + 电影/剧集筛选 */}
        <section className="mt-8">
          <div className="mb-3.5 flex flex-wrap items-center gap-2">
            <h2 className="row-title mr-1 text-content">全部作品</h2>
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
                  'rounded-full px-3.5 py-1.5 text-[13px] transition-colors ' +
                  (sort === k ? 'bg-accent font-medium text-on-accent' : 'bg-chip text-muted hover:text-content')
                }
              >
                {label}
              </button>
            ))}
            <span className="mx-1 h-4 w-px bg-line" aria-hidden />
            {(
              [
                ['all', '全部'],
                ['movie', '电影'],
                ['tv', '剧集'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                className={
                  'rounded-full px-3.5 py-1.5 text-[13px] transition-colors ' +
                  (kind === k ? 'bg-content font-medium text-page' : 'bg-chip text-muted hover:text-content')
                }
              >
                {label}
              </button>
            ))}
            {loading && <span className="text-[13px] text-faint">加载中…</span>}
          </div>

          {err && <div className="rounded-xl border border-line bg-chip p-4 text-sm text-muted">{err}</div>}

          <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 sm:gap-3 md:grid-cols-5 lg:grid-cols-6">
            {filtered.map((w) => (
              <Link key={w.id} href={`/title/${w.id}`} className="group block">
                <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-chip ring-1 ring-line">
                  {w.cover ? (
                    // eslint-disable-next-line @next/next/no-img-element
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
                  {typeof w.rating === 'number' && (
                    <span className="absolute left-1 top-1 rounded bg-black/70 px-1 py-[1px] text-[10px] font-medium text-amber-300">
                      ★ {w.rating.toFixed(1)}
                    </span>
                  )}
                </div>
                <p className="mt-1.5 line-clamp-1 text-[12.5px] text-content">{w.title}</p>
                <p className="line-clamp-1 text-[11px] text-faint">
                  {[w.year, w.type === 'tv' ? '剧集' : '电影'].filter(Boolean).join(' · ')}
                </p>
              </Link>
            ))}
          </div>

          {!loading && !err && filtered.length === 0 && (
            <p className="mt-8 text-center text-sm text-faint">
              {works.length === 0 ? '没有取到作品列表（豆瓣可能限流，稍后重试）' : '这个筛选下没有作品'}
            </p>
          )}
        </section>
      </main>
    </div>
  );
}
