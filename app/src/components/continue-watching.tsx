'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { db, removeHistory, type HistoryEntry } from '@/lib/db';
import { buildWatchUrl, cn, formatTime } from '@/lib/utils';
import { SmartImage } from './smart-image';
import { Rail } from './rail';
import { useAppStore } from '@/lib/store';

/**
 * 首页「继续观看」。
 *
 * Netflix 的首屏第一行就是这个，作用很实在：上次看到第 3 集 12:30，点一下接着看，
 * 不用重新搜片名再选集。数据直接读 IndexedDB 的观看记录（换源/换集都会更新）。
 * 看完的（≥95%）不进这一行——用户已经看完了，再推一遍只是噪音。
 *
 * 0.35：
 * - 短剧（MFlixTV短剧）的记录也并进这一行，点一下直接回到那一集那一秒；
 * - 每张卡右上角多一个 ×，悬停就出现，删掉这条记录不用进记录面板；
 * - 记录全部来自本机：这个浏览器只看到自己看过的，别的设备开的网页版是另外一份。
 */

const MAX_ITEMS = 12;
const HG_KEY = 'hg_progress_v2';
const HG_MAX = 12;

interface HgRec {
  seriesId: string;
  title: string;
  cover?: string;
  eps?: Record<string, number>;
  durs?: Record<string, number>;
  lastEp: number;
  lastPos: number;
  updatedAt: number;
  fav?: boolean;
}

type Row = {
  kind: 'vod' | 'hg';
  id: string;
  ts: number;
  title: string;
  pic?: string;
  href: string;
  ratio: number;
  sub: string;
  pos: number;
  /** 点播记录原样留着：删记录要精确到 sourceKey + vodId，资料页链接也要用 */
  e?: HistoryEntry;
};

function loadHg(): HgRec[] {
  try {
    const raw = localStorage.getItem(HG_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as HgRec[];
    return Array.isArray(arr) ? arr.filter((x) => x && x.seriesId && x.title) : [];
  } catch {
    return [];
  }
}

function saveHg(list: HgRec[]) {
  try {
    localStorage.setItem(HG_KEY, JSON.stringify(list));
  } catch {
    /* 隐私模式写不进去就算了 */
  }
}

export function ContinueWatchingRow({ className }: { className?: string }) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const [rows, setRows] = useState<Row[]>([]);
  const [failed, setFailed] = useState<Set<string>>(new Set());

  const build = useCallback((vod: HistoryEntry[], hg: HgRec[]) => {
    const out: Row[] = [];
    for (const r of vod) {
      if (!r.title) continue;
      const ratio = r.duration > 0 ? r.playbackPosition / r.duration : 0;
      if (ratio >= 0.95) continue;
      const left = Math.max(0, Math.round((r.duration - r.playbackPosition) / 60));
      out.push({
        kind: 'vod',
        e: r,
        id: 'vod:' + r.id,
        ts: r.timestamp || 0,
        title: r.title,
        pic: r.pic,
        pos: r.playbackPosition || 0,
        ratio: Math.min(1, Math.max(0, ratio)),
        href: buildWatchUrl({
          sourceKey: r.sourceKey,
          vodId: r.vodId,
          index: r.episodeIndex,
          title: r.title,
          sourceUrl: r.sourceUrl,
          position: r.playbackPosition,
        }),
        sub:
          (r.totalEpisodes > 1 ? `第 ${r.episodeIndex + 1} 集 · ` : '') +
          (left > 0 ? `剩余约 ${left} 分钟` : '快看完了'),
      });
    }
    for (const h of hg) {
      const dur = (h.durs && h.durs[String(h.lastEp)]) || 0;
      const pos = h.lastPos || 0;
      if (!(pos > 0) && !(dur > 0)) continue;
      const ratio = dur > 0 ? Math.min(1, Math.max(0, pos / dur)) : 0;
      const left = dur > 0 ? Math.max(0, Math.round((dur - pos) / 60)) : 0;
      out.push({
        kind: 'hg',
        id: 'hg:' + h.seriesId,
        ts: h.updatedAt || 0,
        title: h.title,
        pic: h.cover,
        pos,
        ratio,
        href: `/hongguo?resume=${encodeURIComponent(h.seriesId)}`,
        sub: `短剧 · 第 ${h.lastEp} 集${dur > 0 ? (left > 0 ? ` · 剩余约 ${left} 分钟` : ' · 快看完了') : ''}`,
      });
    }
    out.sort((a, b) => b.ts - a.ts);
    setRows(out.slice(0, MAX_ITEMS));
  }, []);

  const load = useCallback(() => {
    db.history
      .orderBy('timestamp')
      .reverse()
      .limit(MAX_ITEMS * 2)
      .toArray()
      .then((list) => build(list, loadHg().slice(0, HG_MAX)))
      .catch(() => {
        /* 读取失败就不显示这一行，不影响首页其它内容 */
      });
  }, [build]);

  // 只在客户端读 IndexedDB：服务端渲染没有这个库
  useEffect(() => {
    load();
    // 从播放页返回首页时进度已变：重新聚焦页面就刷新一次，避免显示旧进度
    const onVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  /** 删掉一条记录：点播删 IndexedDB，短剧删本机 JSON，然后立刻重画这一行 */
  const drop = async (row: Row) => {
    if (row.kind === 'hg') {
      const sid = row.id.slice(3);
      saveHg(loadHg().filter((x) => x.seriesId !== sid));
    } else if (row.e) {
      await removeHistory(row.e.sourceKey, row.e.vodId).catch(() => {});
    }
    setRows((prev) => prev.filter((r) => r.id !== row.id));
  };

  if (rows.length === 0) return null;

  return (
    <section className={cn('mb-8', className)} aria-label="继续观看">
      <h2 className="row-title mb-3.5 text-content">继续观看</h2>
      <Rail className="-mx-4 px-4 sm:mx-0 sm:px-0" ariaLabel="继续观看">
        {rows.map((it) => {
          const showImg = !!it.pic && !failed.has(it.id);
          return (
            <div key={it.id} className="group/w relative w-[104px] shrink-0 sm:w-[124px]">
              <Link
                href={it.href}
                className="block"
                title={`从 ${formatTime(it.pos)} 继续 · ${it.title}`}
              >
                <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-chip ring-1 ring-line/60">
                  {showImg ? (
                    <SmartImage
                      url={it.pic!}
                      mode={imageProxyMode}
                      customProxy={customImageProxy}
                      alt={it.title}
                      className="h-full w-full object-cover transition-transform duration-500 group-hover/w:scale-[1.05]"
                      onExhausted={() => setFailed((prev) => new Set(prev).add(it.id))}
                    />
                  ) : (
                    <div className="grid h-full w-full place-items-center bg-gradient-to-br from-chip to-line/40 text-[11px] text-faint">
                      无封面
                    </div>
                  )}
                  {/* 悬停播放 */}
                  <span className="pointer-events-none absolute inset-0 grid place-items-center opacity-0 transition-opacity duration-300 group-hover/w:opacity-100">
                    <span className="grid h-9 w-9 place-items-center rounded-full bg-white/25 text-white ring-1 ring-white/40 backdrop-blur-md">
                      <svg viewBox="0 0 24 24" className="h-4 w-4 translate-x-[1px]" fill="currentColor" aria-hidden>
                        <path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.4-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14z" />
                      </svg>
                    </span>
                  </span>
                  {/* 底部进度条：Netflix 那种细红条 */}
                  <div className="absolute inset-x-0 bottom-0 h-[3px] bg-white/25">
                    <div className="h-full bg-accent" style={{ width: `${Math.round(it.ratio * 100)}%` }} />
                  </div>
                </div>
                <p className="mt-1.5 line-clamp-1 text-[13px] font-medium text-content" title={it.title}>
                  {it.title}
                </p>
                <p className="line-clamp-1 text-[11px] text-faint">{it.sub}</p>
              </Link>
              {/* 删掉这条记录：不用去记录面板找 */}
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void drop(it);
                }}
                className="absolute left-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-black/70 text-[14px] leading-none text-white/90 opacity-0 backdrop-blur transition-opacity hover:bg-red-500/90 group-hover/w:opacity-100 focus:opacity-100"
                title="删除这条记录"
                aria-label={`删除「${it.title}」的观看记录`}
              >
                ×
              </button>
              {/* 资料入口：不想续播、只想看看这部的简介/演员时用；短剧没有资料页 */}
              {it.e && (
                <Link
                  href={`/detail/${encodeURIComponent(it.e.sourceKey)}/${encodeURIComponent(it.e.vodId)}?${new URLSearchParams(
                    {
                      name: it.e.title,
                      ...(it.e.pic ? { pic: it.e.pic } : {}),
                      ...(it.e.sourceUrl ? { su: it.e.sourceUrl } : {}),
                    }
                  ).toString()}`}
                  className="absolute right-1 top-1 rounded-md bg-black/65 px-1.5 py-0.5 text-[10px] text-white/85 opacity-0 backdrop-blur transition-opacity group-hover/w:opacity-100 focus:opacity-100"
                  title="查看资料页"
                >
                  资料
                </Link>
              )}
            </div>
          );
        })}
      </Rail>
    </section>
  );
}
