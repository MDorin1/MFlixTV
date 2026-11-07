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
 */

const CATEGORY_CACHE_TTL = 10 * 60 * 1000;
const catCache = new Map<string, { at: number; map: Record<string, number> }>();

function normalizeBase(url: string): string {
  return url.replace(/\/+$/, '');
}

async function loadCategories(sourceUrl: string): Promise<Record<string, number>> {
  const hit = catCache.get(sourceUrl);
  if (hit && Date.now() - hit.at < CATEGORY_CACHE_TTL) return hit.map;
  const map: Record<string, number> = {};
  try {
    const res = await fetch(`${normalizeBase(sourceUrl)}?ac=list`, {
      headers: { 'User-Agent': 'Mozilla/5.0 MFlixTV' },
      signal: AbortSignal.timeout(15000),
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
  page: number
): Promise<TimedItem[]> {
  const url = `${normalizeBase(source.url)}?ac=detail&t=${typeId}&pg=${page}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 MFlixTV' },
    signal: AbortSignal.timeout(15000),
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
