'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Icon } from '@/components/icon';

interface Subject {
  id: string;
  title: string;
  year: string;
  type: 'movie' | 'tv';
  rating: number | null;
  ratingCount: number;
  genres: string[];
  countries: string[];
  durations: string[];
  episodes: number | null;
  intro: string;
  cover: string;
  pubdate: string;
  aka: string[];
}
interface CastMember {
  id: string;
  name: string;
  latinName: string;
  character: string;
  avatar: string;
}

/** 图片走内置代理，避免豆瓣图床的盗链限制 */
function proxied(url: string) {
  if (!url) return '';
  return `/api/proxy?url=${encodeURIComponent(url)}`;
}

export default function TitlePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id || '';
  const [subject, setSubject] = useState<Subject | null>(null);
  const [cast, setCast] = useState<{ directors: CastMember[]; actors: CastMember[] }>({ directors: [], actors: [] });
  const [err, setErr] = useState('');
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let alive = true;
    setErr('');
    fetch(`/api/douban/info?id=${encodeURIComponent(id)}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d?.error || '加载失败');
        return d;
      })
      .then((d) => {
        if (!alive) return;
        setSubject(d.subject);
        setCast(d.cast || { directors: [], actors: [] });
      })
      .catch((e) => alive && setErr(e.message || '加载失败'));
    return () => {
      alive = false;
    };
  }, [id]);

  const meta = subject
    ? [
        subject.year,
        subject.type === 'tv' && subject.episodes ? `${subject.episodes} 集` : '',
        subject.countries[0] || '',
        subject.durations[0] || '',
        subject.genres.slice(0, 3).join(' · '),
      ]
        .filter(Boolean)
        .join('  ·  ')
    : '';

  return (
    <div className="min-h-screen bg-black text-white">
      {/* 顶部返回 */}
      <div className="fixed left-0 right-0 top-0 z-30 flex items-center gap-2 bg-gradient-to-b from-black/80 to-transparent px-3 py-2.5 sm:px-6">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-1.5 rounded-full bg-black/40 px-3 py-1.5 text-xs text-white/90 backdrop-blur hover:bg-black/60"
        >
          <Icon name="arrowDown" className="h-3.5 w-3.5 rotate-90" />
          返回
        </button>
        <Link
          href="/"
          className="rounded-full bg-black/40 px-3 py-1.5 text-xs text-white/90 backdrop-blur hover:bg-black/60"
        >
          首页
        </Link>
      </div>

      {/* 背景大图：手机竖版取海报，宽屏可看 */ }
      {subject?.cover && (
        <div className="pointer-events-none fixed inset-0 z-0">
          <img
            src={proxied(subject.cover)}
            alt=""
            className="h-full w-full scale-110 object-cover opacity-25 blur-2xl"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/70 to-black" />
        </div>
      )}

      <main className="relative z-10 mx-auto max-w-5xl px-4 pb-16 pt-16 sm:px-6 sm:pt-24">
        {err && (
          <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-white/80">{err}</div>
        )}

        {!subject && !err && (
          <div className="space-y-3">
            <div className="h-8 w-48 animate-pulse rounded bg-white/10" />
            <div className="h-4 w-64 animate-pulse rounded bg-white/5" />
            <div className="h-40 w-full animate-pulse rounded-xl bg-white/5" />
          </div>
        )}

        {subject && (
          <>
            {/* 标题区（手机：竖排；平板/桌面：海报 + 信息并排） */}
            <div className="flex flex-col gap-5 sm:flex-row sm:items-end">
              <img
                src={proxied(subject.cover)}
                alt={subject.title}
                className="mx-auto w-40 shrink-0 rounded-xl shadow-2xl ring-1 ring-white/10 sm:mx-0 sm:w-44 md:w-52"
              />
              <div className="min-w-0 flex-1 text-center sm:text-left">
                <h1 className="text-2xl font-bold leading-tight sm:text-3xl md:text-4xl">{subject.title}</h1>
                {subject.aka.length > 0 && (
                  <p className="mt-1 line-clamp-1 text-xs text-white/45">{subject.aka.join(' / ')}</p>
                )}
                <div className="mt-2.5 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-white/70 sm:justify-start sm:text-sm">
                  {subject.rating !== null && (
                    <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 font-semibold text-emerald-400">
                      ★ {subject.rating.toFixed(1)}
                      <span className="font-normal text-emerald-300/60">
                        · {subject.ratingCount.toLocaleString()} 人评
                      </span>
                    </span>
                  )}
                  <span className="text-white/60">{meta}</span>
                </div>

                {/* 主按钮：播放（跳回聚合搜索，用标题找源） */}
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5 sm:justify-start">
                  <Link
                    href={`/?s=${encodeURIComponent(subject.title)}`}
                    className="inline-flex items-center gap-2 rounded-md bg-white px-5 py-2.5 text-sm font-semibold text-black transition hover:bg-white/85"
                  >
                    <Icon name="arrowDown" className="h-4 w-4 -rotate-90" />
                    播放
                  </Link>
                  <Link
                    href={`/hongguo?q=${encodeURIComponent(subject.title)}`}
                    className="inline-flex items-center gap-2 rounded-md bg-white/15 px-4 py-2.5 text-sm text-white/90 backdrop-blur transition hover:bg-white/25"
                  >
                    短剧专区搜
                  </Link>
                </div>
              </div>
            </div>

            {/* 简介 */}
            {subject.intro && (
              <section className="mt-7">
                <p
                  className={
                    'whitespace-pre-line text-sm leading-relaxed text-white/80 ' +
                    (expanded ? '' : 'line-clamp-4 sm:line-clamp-3')
                  }
                >
                  {subject.intro}
                </p>
                {subject.intro.length > 90 && (
                  <button
                    onClick={() => setExpanded((v) => !v)}
                    className="mt-1 text-xs text-white/50 hover:text-white/80"
                  >
                    {expanded ? '收起' : '展开全部'}
                  </button>
                )}
              </section>
            )}

            {/* 导演（小字一行） */}
            {cast.directors.length > 0 && (
              <section className="mt-6 text-sm text-white/70">
                <span className="text-white/45">导演：</span>
                {cast.directors.map((d, i) => (
                  <span key={d.id}>
                    {i > 0 && <span className="text-white/30"> / </span>}
                    <Link href={`/person/${d.id}`} className="hover:text-white hover:underline">
                      {d.name}
                    </Link>
                  </span>
                ))}
              </section>
            )}

            {/* 演员：小红书式横滑圆头像（Netflix 的「演员」行） */}
            {cast.actors.length > 0 && (
              <section className="mt-6">
                <h2 className="mb-3 text-sm font-semibold text-white/85">演员</h2>
                <div className="-mx-4 flex gap-3.5 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {cast.actors.map((a) => (
                    <Link
                      key={a.id}
                      href={`/person/${a.id}`}
                      className="w-[76px] shrink-0 text-center sm:w-20"
                    >
                      <div className="mx-auto h-[76px] w-[76px] overflow-hidden rounded-full bg-white/10 ring-1 ring-white/15 sm:h-20 sm:w-20">
                        {a.avatar ? (
                          <img src={proxied(a.avatar)} alt={a.name} className="h-full w-full object-cover" />
                        ) : (
                          <div className="grid h-full w-full place-items-center text-lg text-white/40">
                            {a.name.slice(0, 1)}
                          </div>
                        )}
                      </div>
                      <p className="mt-1.5 line-clamp-1 text-[11px] text-white/85">{a.name}</p>
                      {a.character && (
                        <p className="line-clamp-1 text-[10px] text-white/40">{a.character}</p>
                      )}
                    </Link>
                  ))}
                </div>
              </section>
            )}

            <p className="mt-8 text-[11px] leading-relaxed text-white/30">
              影片资料与图片来自豆瓣公开接口，仅用于本机展示；播放内容来自你自己配置的第三方点播源。
            </p>
          </>
        )}
      </main>
    </div>
  );
}
