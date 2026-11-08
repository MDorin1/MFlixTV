'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/client-api';
import {
  DEFAULT_DANMAKU_PREFS,
  readDanmakuPrefs,
  readManualPick,
  saveDanmakuPrefs,
  saveManualPick,
  type DanmakuCandidate,
  type DanmakuItem,
  type DanmakuPrefs,
} from '@/lib/danmaku';

/**
 * 弹幕取数与偏好（播放器内部用）。
 *
 * 分工：
 * - `mode = off`：不发任何请求（关掉弹幕的人不该为此付流量）；
 * - `mode = auto`：片名 + 集数交给服务端自动匹配；
 * - `mode = manual`：先拿候选列表让用户挑，再用选定的 bvid 取弹幕；
 *   选过的记在 localStorage，下次同一集自动沿用。
 */

export type DanmakuStatus = 'off' | 'loading' | 'ready' | 'empty' | 'error';

export interface UseDanmakuOptions {
  /** 归一化前的片名（详情页拿到的原始标题） */
  title?: string;
  /** 1 起；0 = 电影/整季合集，只按片名匹配 */
  episode?: number;
  /** 当前集时长（秒），用于挑时间长度对得上的视频 */
  duration?: number;
  /** 播放器是否已经准备好（起播后再发请求，别和首屏抢带宽） */
  enabled?: boolean;
}

export interface UseDanmakuResult {
  prefs: DanmakuPrefs;
  setPrefs: (patch: Partial<DanmakuPrefs>) => void;
  /** 关掉弹幕（保留设置） */
  toggle: () => void;
  items: DanmakuItem[];
  status: DanmakuStatus;
  error?: string;
  /** 实际用的是哪条B站视频（面板上显示「来自 @UP主」） */
  matched?: { bvid: string; title: string; part?: string; count: number };
  candidates: DanmakuCandidate[];
  /** 手动模式下当前选中的 bvid */
  pickedBvid?: string;
  pick: (bvid: string) => void;
  reload: () => void;
  /** 是否需要在面板里显示「手动选源」列表 */
  needsManualPick: boolean;
}

interface CachedEntry {
  items: DanmakuItem[];
  candidates: DanmakuCandidate[];
  matched: { bvid: string; title: string; part?: string; count: number };
}

/** 同一集来回切时不重复打请求：一次会话里 40 条足够 */
const CACHE_MAX = 40;
const cache = new Map<string, CachedEntry>();

function cacheKeyOf(title: string, episode: number, bvid: string): string {
  return `${title.toLowerCase()}|${episode}|${bvid}`;
}

function remember(key: string, entry: CachedEntry): void {
  while (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  cache.set(key, entry);
}

export function useDanmaku({ title, episode = 0, duration = 0, enabled = true }: UseDanmakuOptions): UseDanmakuResult {
  const [prefs, setPrefsState] = useState<DanmakuPrefs>(() => readDanmakuPrefs());
  const [items, setItems] = useState<DanmakuItem[]>([]);
  const [candidates, setCandidates] = useState<DanmakuCandidate[]>([]);
  const [pickedBvid, setPickedBvid] = useState<string | undefined>(undefined);
  const [matched, setMatched] = useState<CachedEntry['matched'] | undefined>(undefined);
  const [status, setStatus] = useState<DanmakuStatus>('off');
  const [error, setError] = useState<string | undefined>(undefined);
  const [nonce, setNonce] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const setPrefs = useCallback((patch: Partial<DanmakuPrefs>) => {
    setPrefsState(saveDanmakuPrefs(patch));
  }, []);

  const toggle = useCallback(() => {
    const next = readDanmakuPrefs();
    setPrefsState(saveDanmakuPrefs({ mode: next.mode === 'off' ? 'auto' : 'off' }));
  }, []);

  const cleanTitle = (title || '').trim();

  useEffect(() => {
    // 关掉弹幕 / 没有片名 / 播放器还没起来：一律不发请求
    if (!enabled || !cleanTitle || prefs.mode === 'off') {
      setStatus('off');
      setItems([]);
      setCandidates([]);
      setMatched(undefined);
      setError(undefined);
      return;
    }

    const manual = prefs.mode === 'manual';
    const stored = manual ? readManualPick(cleanTitle, episode) : undefined;
    setPickedBvid(stored);

    // 手动模式还没选过：只拿候选列表，不取弹幕
    if (manual && !stored) {
      setStatus('loading');
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      api
        .danmaku({ title: cleanTitle, episode, duration: duration || undefined, list: true }, controller.signal)
        .then((payload) => {
          if (controller.signal.aborted) return;
          setCandidates(payload.candidates || []);
          setItems([]);
          setMatched(undefined);
          setStatus(payload.candidates?.length ? 'empty' : 'error');
          setError(payload.candidates?.length ? undefined : payload.error || '没有匹配的弹幕');
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setStatus('error');
            setError('候选列表获取失败');
          }
        });
      return () => controller.abort();
    }

    const key = cacheKeyOf(cleanTitle, episode, stored || '');
    const hit = cache.get(key);
    if (hit) {
      setItems(hit.items);
      setCandidates(hit.candidates);
      setMatched(hit.matched);
      setStatus(hit.items.length ? 'ready' : 'empty');
      setError(undefined);
      return;
    }

    setStatus('loading');
    setError(undefined);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    api
      .danmaku(
        {
          title: cleanTitle,
          episode,
          duration: duration || undefined,
          bvid: stored,
          refresh: nonce > 0,
        },
        controller.signal
      )
      .then((payload) => {
        if (controller.signal.aborted) return;
        if (!payload.ok) {
          setItems([]);
          setCandidates(payload.candidates || []);
          setStatus('error');
          setError(payload.error || '弹幕获取失败');
          return;
        }
        const entry: CachedEntry = {
          items: payload.items,
          candidates: payload.candidates || [],
          matched: {
            bvid: payload.bvid || '',
            title: payload.title || cleanTitle,
            part: payload.part,
            count: payload.count,
          },
        };
        remember(key, entry);
        setItems(entry.items);
        setCandidates(entry.candidates);
        setMatched(entry.matched);
        setStatus(entry.items.length ? 'ready' : 'empty');
        setError(undefined);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setStatus('error');
        setError(err instanceof Error ? err.message : '弹幕获取失败');
      });

    return () => controller.abort();
  }, [cleanTitle, episode, duration, enabled, prefs.mode, nonce]);

  const pick = useCallback(
    (bvid: string) => {
      if (!cleanTitle) return;
      saveManualPick(cleanTitle, episode, bvid);
      setPickedBvid(bvid);
      // 换一条视频 ⇒ 换一个缓存键，直接触发上面的 effect 重新取
      setNonce((n) => n + 1);
    },
    [cleanTitle, episode]
  );

  const reload = useCallback(() => {
    cache.clear();
    setNonce((n) => n + 1);
  }, []);

  const needsManualPick = prefs.mode === 'manual' && !pickedBvid;

  return useMemo(
    () => ({
      prefs,
      setPrefs,
      toggle,
      items,
      status,
      error,
      matched,
      candidates,
      pickedBvid,
      pick,
      reload,
      needsManualPick,
    }),
    [prefs, setPrefs, toggle, items, status, error, matched, candidates, pickedBvid, pick, reload, needsManualPick]
  );
}

/** 给面板用：默认值导出，避免面板自己再引一次常量 */
export { DEFAULT_DANMAKU_PREFS };
