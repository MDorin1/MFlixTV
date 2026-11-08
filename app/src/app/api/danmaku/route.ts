import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { fetchDanmakuXml, fetchPages, fetchSeasonEpisodes, searchSeasons, searchVideos } from '@/lib/bilibili';
import {
  DANMAKU_MAX_ITEMS,
  guessEpisode,
  minScoreFor,
  parseDanmakuXml,
  rankCandidates,
  scoreDanmakuCandidate,
  scoreSeason,
  type DanmakuCandidate,
  type DanmakuItem,
  type DanmakuPayload,
} from '@/lib/danmaku';
import { withHostLimit } from '@/lib/host-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 弹幕接口：`/api/danmaku?title=片名&episode=3[&duration=2700][&bvid=BVxxx][&list=1]`
 *
 * 做三件事：
 * 1. 搜索（片名）→ 打分挑出最像「这一集」的视频（片名 + 集数 + 时长 + 播放量）；
 * 2. 多P 视频按集数挑 P，拿到 cid；
 * 3. 拉弹幕 XML 解析成可绘制的数组。
 *
 * `list=1` 只回候选列表，供播放器里的「手动选源」用；带 `bvid` 就是用户选定的那条。
 * 所有失败都返回 `ok:false` 而不是 4xx/5xx——弹幕是增强功能，不该让播放器报错。
 */

const MAX_TITLE = 120;
const MAX_BVID = 16;

/** 搜索缓存 1 小时：同一部剧反复点集数没必要每次都打一次搜索 */
const SEARCH_TTL_MS = 60 * 60 * 1000;
/** 弹幕本体缓存 6 小时：一集弹幕不会变 */
const ITEMS_TTL_MS = 6 * 60 * 60 * 1000;
/** 缓存条目上限：一部剧几十集，200 条足够覆盖一个家庭的使用量 */
const MAX_ENTRIES = 240;

interface Entry {
  value: unknown;
  expiresAt: number;
}

const store = new Map<string, Entry>();

function cacheGet<T>(key: string): T | undefined {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return hit.value as T;
}

function cacheSet(key: string, value: unknown, ttlMs: number): void {
  // Map 保序：超限时删最早插入的那条，不需要额外 LRU 结构
  while (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** 缓存里存的是「候选 + cid」，实际条目按 cid 分开存，多条同名片可复用 */
interface Resolved {
  candidates: DanmakuCandidate[];
  /** 自动模式：够格且可以继续尝试的候选（第一条弹幕为空时往后顺延） */
  eligible: DanmakuCandidate[];
  picked: DanmakuCandidate;
  cid: number;
  part: string;
  /** 走的是官方番剧/影视的某一集（弹幕为空时要退回用户投稿再试一次） */
  viaPgc?: boolean;
}

function parsePositiveInt(value: string | null, max: number): number {
  const n = parseInt(value || '', 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, max);
}

function toCandidate(video: { bvid: string; title: string; author: string; duration: number; play: number; danmaku: number }): DanmakuCandidate {
  return {
    bvid: video.bvid,
    title: video.title,
    author: video.author,
    duration: video.duration,
    pages: 1,
    episode: guessEpisode(video.title),
    score: 0,
    play: video.play,
    danmaku: video.danmaku,
  };
}

/** 多P 视频按集数挑 P：标题认不出集数时退回「第 N 个 P」 */
function pickPage(
  pages: { cid: number; page: number; part: string; duration: number }[],
  episode: number,
  fallbackTitle: string
): { cid: number; part: string } | null {
  if (!pages.length) return null;
  if (pages.length === 1) return { cid: pages[0].cid, part: pages[0].part || fallbackTitle };
  if (episode > 0) {
    const byName = pages.find((p) => guessEpisode(p.part) === episode);
    if (byName) return { cid: byName.cid, part: byName.part };
    const byIndex = pages[episode - 1];
    if (byIndex) return { cid: byIndex.cid, part: byIndex.part };
  }
  return { cid: pages[0].cid, part: pages[0].part || fallbackTitle };
}

/** 超过上限就等间隔抽稀：宁可密度低一点，也别把结尾的弹幕整段丢掉 */
function thinOut(items: DanmakuItem[]): DanmakuItem[] {
  if (items.length <= DANMAKU_MAX_ITEMS) return items;
  const step = items.length / DANMAKU_MAX_ITEMS;
  const out: DanmakuItem[] = [];
  for (let i = 0; i < items.length && out.length < DANMAKU_MAX_ITEMS; i += step) out.push(items[Math.floor(i)]);
  return out;
}

/**
 * 官方番剧/影视优先：正版剧集的弹幕动辄几万条，而用户投稿的「单集」大多是
 * 二次上传、弹幕寥寥。片名与季对得上时就用官方那一集的 cid。
 * 返回 null 表示没上架/对不上，交给用户投稿那条路。
 */
async function tryPgc(title: string, episode: number): Promise<Resolved | null> {
  const key = `pgc:${title}#${episode}`;
  const cached = cacheGet<Resolved>(key);
  if (cached) return cached;

  const seasons = await withHostLimit('https://api.bilibili.com', () => searchSeasons(title));
  if (!seasons.length) return null;
  const ranked = seasons
    .map((season) => ({ season, score: scoreSeason(season.title, title) }))
    .filter((item) => item.score >= 45)
    .sort((a, b) => b.score - a.score);

  for (const { season } of ranked.slice(0, 2)) {
    const episodes = await withHostLimit('https://api.bilibili.com', () =>
      fetchSeasonEpisodes(season.seasonId)
    );
    if (!episodes.length) continue;
    // 集数超出这一季的集数 = 这是另一季/番外，别硬套最后一集
    if (episode > episodes.length) continue;
    const index = episode > 0 ? episode - 1 : 0;
    const pickedEpisode = episodes[index];
    if (!pickedEpisode) continue;
    const label = pickedEpisode.longTitle
      ? `第${index + 1}话 ${pickedEpisode.longTitle}`
      : `第${index + 1}话`;
    const picked: DanmakuCandidate = {
      bvid: '',
      title: season.title,
      author: season.type || 'B站官方',
      duration: 0,
      pages: episodes.length,
      episode,
      score: 100,
      play: 0,
      danmaku: 1,
    };
    const resolved: Resolved = {
      candidates: [picked],
      eligible: [],
      picked,
      cid: pickedEpisode.cid,
      part: label,
      viaPgc: true,
    };
    cacheSet(key, resolved, SEARCH_TTL_MS);
    return resolved;
  }
  return null;
}

async function resolve(
  title: string,
  episode: number,
  duration: number,
  bvid: string,
  refresh: boolean,
  allowPgc = true
): Promise<Resolved | { error: string; candidates?: DanmakuCandidate[] }> {
  const key = `search:${title}#${episode}|${duration}`;
  const manual = bvid.length > 0;

  // 官方季优先（手动指定 bvid 时不走这条：用户明确选了哪条视频）
  if (!manual && allowPgc) {
    const pgc = await tryPgc(title, episode).catch(() => null);
    if (pgc) return pgc;
  }

  let candidates: DanmakuCandidate[] = manual ? [] : cacheGet<DanmakuCandidate[]>(key) ?? [];
  if (!manual && (!candidates.length || refresh)) {
    // 两次搜索：片名一次，「片名 + 第N集」再一次。
    // 只搜片名时前排几乎全是解说/预告；带上集数才能把真正的单集上传顶上来。
    const queries = episode > 0 ? [title, `${title} 第${episode}集`] : [title];
    const seen = new Set<string>();
    const videos: { bvid: string; title: string; author: string; duration: number; play: number; danmaku: number }[] = [];
    for (const keyword of queries) {
      const found = await withHostLimit('https://api.bilibili.com', () => searchVideos(keyword, 1));
      for (const video of found) {
        if (seen.has(video.bvid)) continue;
        seen.add(video.bvid);
        videos.push(video);
      }
      // 第一次就够用了（没有集数概念，或者已经有明确的集数候选）就不再打第二次
      if (episode <= 0) break;
    }
    if (!videos.length) return { error: '没搜到同名视频' };
    candidates = videos.map((video) => {
      const candidate = toCandidate(video);
      candidate.score = scoreDanmakuCandidate(candidate, { title, episode, duration });
      return candidate;
    });
    cacheSet(key, rankCandidates(candidates, 24), SEARCH_TTL_MS);
    candidates = cacheGet<DanmakuCandidate[]>(key) ?? [];
  }

  if (manual) {
    // 手动指定：用户已经决定了用哪条视频，只补集数与片名信息
    const pages = await withHostLimit('https://api.bilibili.com', () => fetchPages(bvid));
    const page = pickPage(pages, episode, title);
    if (!page) return { error: '这条视频取不到分P' };
    const picked: DanmakuCandidate = {
      bvid,
      title,
      author: '',
      duration: pages[0]?.duration || 0,
      pages: pages.length,
      episode,
      score: 100,
      play: 0,
      danmaku: 0,
    };
    return { candidates: [picked], eligible: [picked], picked, cid: page.cid, part: page.part };
  }

  const ranked = rankCandidates(candidates, 8);
  if (!ranked.length) return { error: '没有匹配的弹幕视频' };

  // 自动模式只接受够格的候选：分数太低宁可空着，也别把解说的弹幕盖到正片上
  const threshold = minScoreFor({ title, episode, duration });
  // 弹幕数为 0 的（B 站上不少二次上传就是这样）直接跳过：挑了也只是空画布
  const eligible = ranked.filter((c) => c.score >= threshold && c.danmaku !== 0);
  if (!eligible.length) {
    const withDanmaku = ranked.filter((c) => c.danmaku > 0);
    return {
      error:
        ranked[0].danmaku === 0
          ? '这一集在B站只有没有弹幕的转载，可在「手动选源」里挑一条别的'
          : withDanmaku.length
            ? `没找到这一集的弹幕（最高匹配 ${ranked[0].score} 分，需要 ${threshold} 分），可以在「手动选源」里自己挑`
            : '这一集在B站没有带弹幕的片源，可在「手动选源」里挑一条别的',
      // 候选一并带回去：自动匹配失败时用户还能手动选
      candidates: ranked,
    };
  }

  // 逐个候选试：第一个取不到分P（视频被删/地区限制）就换下一个，别整条链断掉
  for (const candidate of eligible) {
    const pages = await withHostLimit('https://api.bilibili.com', () => fetchPages(candidate.bvid));
    if (!pages.length) continue;
    candidate.pages = pages.length;
    const page = pickPage(pages, episode, title);
    if (!page) continue;
    return { candidates: ranked, eligible, picked: candidate, cid: page.cid, part: page.part };
  }
  return { error: '候选视频都取不到分P' };
}

export async function GET(req: Request) {
  const denied = guardRequest(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const title = (url.searchParams.get('title') || '').trim().slice(0, MAX_TITLE);
  const episode = parsePositiveInt(url.searchParams.get('episode'), 9999);
  const duration = parsePositiveInt(url.searchParams.get('duration'), 60 * 60 * 12);
  const bvidRaw = (url.searchParams.get('bvid') || '').trim();
  const bvid = /^BV[0-9A-Za-z]{8,12}$/.test(bvidRaw) ? bvidRaw.slice(0, MAX_BVID) : '';
  const listOnly = url.searchParams.get('list') === '1';
  const refresh = url.searchParams.get('refresh') === '1';

  if (!title) return jsonError('缺少片名', 400);

  try {
    const resolved = await resolve(title, episode, duration, bvid, refresh);
    if ('error' in resolved) {
      const payload: DanmakuPayload = {
        ok: false,
        count: 0,
        items: [],
        error: resolved.error,
        candidates: resolved.candidates,
      };
      return NextResponse.json(payload);
    }

    if (listOnly) {
      const payload: DanmakuPayload = {
        ok: true,
        count: 0,
        items: [],
        candidates: resolved.candidates,
        bvid: resolved.picked.bvid,
        title: resolved.picked.title,
      };
      return NextResponse.json(payload);
    }

    const loadItems = async (cid: number): Promise<DanmakuItem[]> => {
      const itemsKey = `items:${cid}`;
      const cached = cacheGet<DanmakuItem[]>(itemsKey);
      if (cached && !refresh) return cached;
      const xml = await withHostLimit('https://comment.bilibili.com', () => fetchDanmakuXml(cid));
      const parsed = thinOut(parseDanmakuXml(xml));
      cacheSet(itemsKey, parsed, ITEMS_TTL_MS);
      return parsed;
    };

    let items = await loadItems(resolved.cid);
    let picked = resolved.picked;
    let cid = resolved.cid;
    let part = resolved.part;

    /**
     * 官方那一集没弹幕（冷门番/付费集常见）→ 退回用户投稿再走一遍。
     * 这一趟不进缓存判断：它只是一次补救，失败也不影响整体结果。
     */
    if (!items.length && resolved.viaPgc && !bvid) {
      const fallback = await resolve(title, episode, duration, '', refresh, false);
      if (!('error' in fallback)) {
        const next = await loadItems(fallback.cid);
        if (next.length) {
          items = next;
          picked = fallback.picked;
          cid = fallback.cid;
          part = fallback.part;
        }
      }
    }

    /**
     * 顺延：B 站上很多单集是二次上传，分P 在但弹幕是空的（或只有几条）。
     * 命中这种就接着试下一个够格候选，而不是让用户看到「0 条弹幕」。
     */
    if (!items.length) {
      for (const alt of resolved.eligible) {
        if (alt.bvid === picked.bvid) continue;
        const pages = await withHostLimit('https://api.bilibili.com', () => fetchPages(alt.bvid));
        const page = pickPage(pages, episode, title);
        if (!page) continue;
        const next = await loadItems(page.cid);
        if (!next.length) continue;
        items = next;
        picked = alt;
        cid = page.cid;
        part = page.part;
        break;
      }
    }

    const payload: DanmakuPayload = {
      ok: true,
      bvid: picked.bvid,
      cid,
      title: picked.title,
      part,
      count: items.length,
      items,
      candidates: resolved.candidates,
    };
    return NextResponse.json(payload, {
      // 弹幕是长缓存只读数据：浏览器也存一份，换集回来零请求
      headers: { 'cache-control': 'private, max-age=600' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : '弹幕获取失败';
    const payload: DanmakuPayload = { ok: false, count: 0, items: [], error: message };
    return NextResponse.json(payload);
  }
}
