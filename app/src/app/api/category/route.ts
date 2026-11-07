import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { getEnvSources } from '@/lib/env-sources';
import type { SearchResultItem } from '@/lib/types';

export const runtime = 'nodejs';

/**
 * 按分类浏览点播源（用于「综艺 / 大陆综艺 / 港台综艺 …」这类板块）。
 *
 * 关键事实（实测）：CMS 的 `t` 参数要的是**数字 type_id**，传中文分类名会返回空。
 * 不同源的 id 还不一样，所以这里先取一次 `?ac=list` 建「分类名 → id」映射并缓存，
 * 再并发拉各源的 `?ac=videolist&t=<id>&pg=<page>`，合并成与搜索结果同构的列表，
 * 前端就能直接用现有的跨源聚合卡片，播放链路不用改。
 *
 * 特例：`category=海外` 走聚合模式（见下面的 OVERSEAS_PLAN），把各源的海外向分类
 * 一次合并成一排，不用逐家点。
 */

const CATEGORY_CACHE_TTL = 10 * 60 * 1000;
const catCache = new Map<string, { at: number; map: Record<string, number> }>();

function normalizeBase(url: string): string {
  return url.replace(/\/+$/, '');
}

async function loadCategories(sourceUrl: string, timeoutMs = 15000): Promise<Record<string, number>> {
  const hit = catCache.get(sourceUrl);
  if (hit && Date.now() - hit.at < CATEGORY_CACHE_TTL) return hit.map;
  const map: Record<string, number> = {};
  try {
    const res = await fetch(`${normalizeBase(sourceUrl)}?ac=list`, {
      headers: { 'User-Agent': 'Mozilla/5.0 MFlixTV' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const data = (await res.json()) as { class?: { type_id?: number; type_name?: string }[] };
      for (const c of data.class || []) {
        if (typeof c.type_id === 'number' && c.type_name) map[c.type_name] = c.type_id;
      }
    }
  } catch {
    /* 拿不到分类就返回空，前端提示该源无此分类 */
  }
  catCache.set(sourceUrl, { at: Date.now(), map });
  return map;
}

interface VodItem {
  vod_id?: number | string;
  vod_name?: string;
  vod_pic?: string;
  vod_remarks?: string;
  vod_year?: string;
  vod_area?: string;
  type_name?: string;
  /** 源站的上架/更新时间（苹果CMS `vod_time`）。只有 ac=detail 才返回 */
  vod_time?: string;
}

interface TimedItem {
  item: SearchResultItem;
  time: number;
}

/** `2026-11-07 15:42:27` → 时间戳；解析不了给 0，排到最后 */
function parseVodTime(raw?: string): number {
  if (!raw) return 0;
  const ms = Date.parse(String(raw).replace(' ', 'T'));
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * 拉某个源的某个分类。
 *
 * 用 `ac=detail` 而不是 `ac=videolist`：只有 detail 会带 `vod_time`，
 * 而「国外综艺更新快不快」正是靠这个时间排出来的——没有它就只能按源站 id 排序，
 * 新上架的节目会被老片压在后面。
 */
async function fetchCategory(
  source: { key: string; name: string; url: string },
  typeId: number,
  page: number,
  timeoutMs = 15000
): Promise<TimedItem[]> {
  const url = `${normalizeBase(source.url)}?ac=detail&t=${typeId}&pg=${page}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 MFlixTV' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { list?: VodItem[] };
  const list = Array.isArray(data.list) ? data.list : [];
  return list
    .filter((v) => v && v.vod_id !== undefined && v.vod_name)
    .map((v) => ({
      time: parseVodTime(v.vod_time),
      item: {
        sourceKey: source.key,
        sourceName: source.name,
        vodId: String(v.vod_id),
        name: String(v.vod_name),
        pic: v.vod_pic || undefined,
        typeName: v.type_name || undefined,
        year: v.vod_year || undefined,
        area: v.vod_area || undefined,
        remarks: v.vod_remarks || undefined,
        updatedAt: v.vod_time || undefined,
        sourceUrl: source.url,
      },
    }));
}

/* ---------------- 「海外」聚合模式 ---------------- */

/**
 * 各家采集站的海外向分类叫什么完全不一样（海外剧 / 日韩剧 / 韩剧 / 韩国剧…），
 * 一家还常常只建了其中几个，所以单点一个分类名总会漏。
 * 这里按「海外剧集 / 海外综艺 / 海外动漫」三组去各源找，每组每个源最多取 max 个分类，
 * 拉回来按源站更新时间倒序合并成一排——一排里既有最新的韩剧也有日韩综艺。
 */
const OVERSEAS_KEY = '海外';

const OVERSEAS_PLAN: { names: string[]; max: number }[] = [
  {
    names: ['海外剧', '日韩剧', '欧美剧', '韩剧', '日剧', '美剧', '泰剧', '港台剧', '香港剧', '台湾剧', '韩国剧', '日本剧', '美国剧'],
    max: 2,
  },
  { names: ['日韩综艺', '欧美综艺', '港台综艺'], max: 2 },
  { names: ['海外动漫'], max: 1 },
];

/** 一排最多给多少张卡（再多前端渲染也卡，翻页另有 page 参数） */
const OVERSEAS_MAX_ITEMS = 240;
const OVERSEAS_CACHE_TTL = 10 * 60 * 1000;
/**
 * 软截止：聚合要打十几个源，只要有慢的就得让整排等着，实测冷启动会拖到 10 秒。
 * 到点先把手上的结果发出去（其余源下次刷新就齐了），跟首页「先出内容再补齐」一个思路——
 * 宁可少两张卡，也不要白屏。
 */
const OVERSEAS_DEADLINE_MS = 4500;

interface OverseasResult {
  items: SearchResultItem[];
  failures: { sourceKey: string; error: string }[];
  /** 是否在软截止前跑完（false = 还有源没回来） */
  complete: boolean;
}

const overCache = new Map<number, { at: number; ttl: number } & OverseasResult>();
let overInflight: { page: number; p: Promise<OverseasResult> } | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function overseas(
  sources: { key: string; name: string; url: string }[],
  page: number
): Promise<OverseasResult> {
  const hit = overCache.get(page);
  if (hit && Date.now() - hit.at < hit.ttl) {
    return { items: hit.items, failures: hit.failures, complete: hit.complete };
  }
  if (overInflight && overInflight.page === page) return overInflight.p;

  const p = (async (): Promise<OverseasResult> => {
    const deadline = Date.now() + OVERSEAS_DEADLINE_MS;
    const failures: { sourceKey: string; error: string }[] = [];
    const lists: TimedItem[][] = [];
    let deadlineHit = false;

    // 每个源一条流水线：自己取分类表、自己决定取哪几个分类、取到就立刻合并。
    // 不分「先全部拿分类表、再全部取内容」两个阶段——那样最慢的那个源会把整排卡住。
    const pipeline = Promise.all(
      sources.map(async (source) => {
        try {
          const map = await loadCategories(source.url, 5000);
          const picks: number[] = [];
          for (const plan of OVERSEAS_PLAN) {
            let taken = 0;
            for (const name of plan.names) {
              if (taken >= plan.max) break;
              const id = map[name];
              if (!id) continue;
              picks.push(id);
              taken++;
            }
          }
          // 一个源里的几个分类并行取：串行取会让这一排等上 5 个来回
          await Promise.all(
            picks.map(async (id) => {
              if (Date.now() > deadline) {
                deadlineHit = true;
                return;
              }
              try {
                lists.push(await fetchCategory(source, id, page, 6000));
              } catch (e) {
                failures.push({
                  sourceKey: source.key,
                  error: e instanceof Error ? e.message : '请求失败',
                });
              }
            })
          );
        } catch (e) {
          failures.push({ sourceKey: source.key, error: e instanceof Error ? e.message : '取分类失败' });
        }
      })
    );

    // 硬截止：软截止只挡「还没开始的请求」，已经在飞的慢源照样拖时间，
    // 所以这里直接跟计时器赛跑——到点就拿走手上已经回来的结果。
    const settled = await Promise.race([
      pipeline.then(() => true),
      sleep(Math.max(0, deadline - Date.now())).then(() => false),
    ]);
    if (!settled) deadlineHit = true;

    const flat = lists.flat();
    flat.sort((a, b) => b.time - a.time);
    // 同一部片在同一源可能被两个分类同时收录，去重后再截断
    const seen = new Set<string>();
    const items: SearchResultItem[] = [];
    for (const x of flat) {
      const k = `${x.item.sourceKey}|${x.item.vodId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      items.push(x.item);
      if (items.length >= OVERSEAS_MAX_ITEMS) break;
    }
    const complete = !deadlineHit;
    const out: OverseasResult = { items, failures, complete };
    // 只缓存跑完整的一轮：半成品不进缓存，前端 8 秒后重试才能真的补上新源
    if (complete && items.length > 0) {
      overCache.set(page, { at: Date.now(), ttl: OVERSEAS_CACHE_TTL, ...out });
    }
    return out;
  })();

  overInflight = { page, p };
  try {
    return await p;
  } finally {
    if (overInflight && overInflight.p === p) overInflight = null;
  }
}

export async function GET(req: Request) {
  const denied = guardRequest(req);
  if (denied) return denied;

  const sp = new URL(req.url).searchParams;
  const category = (sp.get('category') || '').trim();
  const page = Math.max(1, Math.min(50, parseInt(sp.get('page') || '1', 10) || 1));
  const keys = (sp.get('sources') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!category) return NextResponse.json({ items: [], failures: [] });

  const all = getEnvSources().filter((s) => !s.isAdult);
  const sources = keys.length > 0 ? all.filter((s) => keys.includes(s.key)) : all;

  // 「海外」= 聚合模式：一次把各源的海外向分类全拉回来，合成一排（见文件头说明）
  if (category === OVERSEAS_KEY) {
    const { items, failures, complete } = await overseas(sources, page);
    // partial=true 表示还有源没回来（软截止），前端可以先渲染、下次刷新补齐
    return NextResponse.json({ items, failures, total: items.length, partial: !complete });
  }

  const failures: { sourceKey: string; error: string }[] = [];
  const lists = await Promise.all(
    sources.map(async (source) => {
      try {
        const map = await loadCategories(source.url);
        const id = map[category];
        if (!id) {
          failures.push({ sourceKey: source.key, error: `该源没有「${category}」分类` });
          return [];
        }
        return await fetchCategory(source, id, page);
      } catch (e) {
        failures.push({ sourceKey: source.key, error: e instanceof Error ? e.message : '请求失败' });
        return [];
      }
    })
  );

  // 合并：同名同年的算一条，保留各自来源（前端聚合卡片按 name 分组）
  // 排序按源站更新时间倒序——「海外综艺更新快」的诉求就落在这里，
  // 刚上架的那期必须排在第一屏，而不是被老片挤到后面。
  const flat = lists.flat();
  flat.sort((a, b) => b.time - a.time);
  const items = flat.map((x) => x.item);
  return NextResponse.json({ items, failures, total: items.length });
}
