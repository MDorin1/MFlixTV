'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/client-api';
import { useAppStore, resolveSource } from '@/lib/store';
import { formatRemarks } from '@/lib/remarks';
import { stripHtml } from '@/lib/utils';
import type { VideoDetail } from '@/lib/types';
import { Icon } from '@/components/icon';
import { SourcePlayPanel, type PlaySource } from '@/components/source-play-panel';

/**
 * 采集源资料页：/detail/<源 key>/<vodId>
 *
 * 取代原来的「播放前详情弹窗」。整页给出：大图背景 + 标题 + 年份/地区/类型/备注
 * + 简介 + 导演主演 + 播放源与剧集（SourcePlayPanel）。
 * 先用手上已有的搜索结果（?name / ?pic / ?sn）把标题和海报铺出来，
 * 详情接口回来后再补简介等字段——页面不会先白后跳，观感上就是「立刻有东西」。
 */

const proxied = (url: string) => (url ? `/api/proxy?url=${encodeURIComponent(url)}` : '');

export default function DetailPage() {
  return (
    <Suspense>
      <DetailContent />
    </Suspense>
  );
}

function DetailContent() {
  const params = useParams<{ sourceKey: string; vodId: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();

  const sourceKey = decodeURIComponent(String(params?.sourceKey || ''));
  const vodId = decodeURIComponent(String(params?.vodId || ''));
  const qName = searchParams.get('name') || '';
  const qPic = searchParams.get('pic') || '';
  const qSourceName = searchParams.get('sn') || '';
  const qSourceUrl = searchParams.get('su') || '';

  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);

  const [detail, setDetail] = useState<VideoDetail | null>(null);
  const [err, setErr] = useState('');
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!sourceKey || !vodId) return;
    const source = resolveSource({ customAPIs, envSources }, sourceKey, { url: qSourceUrl, name: qSourceName });
    if (!source) {
      setErr('这个点播源已不存在，请在设置里重新添加后再试');
      return;
    }
    const controller = new AbortController();
    api
      .detail(vodId, source, controller.signal)
      .then(setDetail)
      .catch((e) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setErr(e instanceof Error ? e.message : '获取资料失败');
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, vodId]);

  const info = detail?.videoInfo;
  const title = info?.title || qName || '未命名影片';
  const cover = info?.cover || qPic;
  const meta = useMemo(
    () =>
      [info?.year, info?.area, info?.typeName, formatRemarks(info?.remarks)]
        .filter(Boolean)
        .join('  ·  '),
    [info?.year, info?.area, info?.typeName, info?.remarks]
  );
  /** 采集源的导演/主演是一整串，拆成名字后每个都能点：点名字 = 用这个名字再搜一次 */
  const directorNames = useMemo(() => splitNames(info?.director), [info?.director]);
  const actorNames = useMemo(() => splitNames(info?.actor).slice(0, 12), [info?.actor]);

  /** 采集源的简介是 HTML 片段，先转成纯文本再排版（否则会把 <p> 标签直接显示出来） */
  const desc = useMemo(() => stripHtml(info?.desc), [info?.desc]);

  const preferred: PlaySource = {
    sourceKey,
    sourceName: info?.sourceName || qSourceName || sourceKey,
    vodId,
    name: title,
    pic: cover,
    sourceUrl: info?.sourceUrl || qSourceUrl,
  };

  return (
    <div className="min-h-screen bg-black text-white">
      {/* 顶部返回条：滚动时始终可用 */}
      <div className="fixed inset-x-0 top-0 z-30 flex items-center gap-2 bg-gradient-to-b from-black/85 via-black/45 to-transparent px-3 py-2.5 sm:px-6">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-1.5 rounded-full bg-black/40 px-3 py-1.5 text-xs text-white/90 backdrop-blur transition-colors hover:bg-black/65"
        >
          <Icon name="arrowDown" className="h-3.5 w-3.5 rotate-90" />
          返回
        </button>
        <Link
          href="/"
          className="rounded-full bg-black/40 px-3 py-1.5 text-xs text-white/90 backdrop-blur transition-colors hover:bg-black/65"
        >
          首页
        </Link>
      </div>

      {/* 背景：封面放大模糊 + 上下压黑，Netflix 资料页那种氛围 */}
      {cover && (
        <div className="pointer-events-none fixed inset-0 z-0">
          <img src={proxied(cover)} alt="" className="h-full w-full scale-110 object-cover opacity-25 blur-2xl" />
          <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/70 to-black" />
        </div>
      )}

      <main className="relative z-10 mx-auto max-w-5xl px-4 pb-20 pt-16 sm:px-6 sm:pt-24">
        {err && <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-white/80">{err}</div>}

        <div className="flex flex-col gap-5 sm:flex-row sm:items-end">
          {cover ? (
            <img
              src={proxied(cover)}
              alt={title}
              className="mx-auto w-40 shrink-0 rounded-xl shadow-2xl ring-1 ring-white/10 sm:mx-0 sm:w-44 md:w-52"
            />
          ) : (
            <div className="mx-auto aspect-[2/3] w-40 shrink-0 rounded-xl bg-white/10 sm:mx-0 sm:w-44 md:w-52" />
          )}

          <div className="min-w-0 flex-1 text-center sm:text-left">
            <h1 className="text-2xl font-bold leading-tight sm:text-3xl md:text-4xl">{title}</h1>
            {meta && <p className="mt-2 text-sm text-white/60">{meta}</p>}
            {(directorNames.length > 0 || actorNames.length > 0) && (
              <dl className="mt-3 space-y-1.5 text-[13px] leading-relaxed text-white/70">
                {directorNames.length > 0 && (
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-left">
                    <dt className="shrink-0 text-white/40">导演</dt>
                    <dd className="flex flex-wrap gap-1.5">
                      {directorNames.map((n, i) => (
                        <NameChip key={`d-${n}-${i}`} name={n} />
                      ))}
                    </dd>
                  </div>
                )}
                {actorNames.length > 0 && (
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-left">
                    <dt className="shrink-0 text-white/40">主演</dt>
                    <dd className="flex flex-wrap gap-1.5">
                      {actorNames.map((n, i) => (
                        <NameChip key={`a-${n}-${i}`} name={n} />
                      ))}
                    </dd>
                  </div>
                )}
              </dl>
            )}
            {!detail && !err && (
              <div className="mt-3 space-y-2">
                <div className="h-3 w-2/3 animate-pulse rounded bg-white/10" />
                <div className="h-3 w-1/2 animate-pulse rounded bg-white/10" />
              </div>
            )}
          </div>
        </div>

        {desc && (
          <section className="mt-6">
            <p className={`whitespace-pre-line text-sm leading-relaxed text-white/80 ${expanded ? '' : 'line-clamp-4'}`}>
              {desc}
            </p>
            {desc.length > 90 && (
              <button onClick={() => setExpanded((v) => !v)} className="mt-1 text-xs text-white/50 hover:text-white/85">
                {expanded ? '收起' : '展开全部'}
              </button>
            )}
          </section>
        )}

        <SourcePlayPanel title={title} preferred={preferred} />

        <p className="mt-10 text-[11px] leading-relaxed text-white/30">
          影片资料来自你自己配置的第三方点播源，仅用于本机展示与播放。
        </p>
      </main>
    </div>
  );
}

/**
 * 采集源的「导演 / 主演」是一整串（空格、斜杠、顿号混着用），拆成独立名字。
 * 过滤掉空项和明显不是人名的长串，避免把一句简介塞进胶囊里。
 */
function splitNames(raw?: string): string[] {
  return stripHtml(raw)
    .split(/[\s,，、\/|；;]+/)
    .map((s) => s.replace(/^[·・.\-]+|[·・.\-]+$/g, '').trim())
    .filter((s) => s.length > 0 && s.length <= 12);
}

/** 名字胶囊：点一下就用这个名字再搜一次（搜索结果里会带出演员行） */
function NameChip({ name }: { name: string }) {
  return (
    <Link
      href={`/?s=${encodeURIComponent(name)}`}
      className="rounded-full border border-white/15 bg-white/5 px-2.5 py-0.5 text-[12.5px] text-white/80 transition-colors hover:border-white/40 hover:bg-white/15 hover:text-white"
    >
      {name}
    </Link>
  );
}