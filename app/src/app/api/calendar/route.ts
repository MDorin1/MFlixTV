import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { cmsRequestHeaders } from '@/lib/cms-parser';
import { fetchUpstream, getCache, setCache } from '@/lib/fetch-utils';
import { checkUpstreamAllowed } from '@/lib/ssrf';
import {
  addDays,
  buildDays,
  cnNow,
  classifyKind,
  dayLabel,
  dedupeByTitle,
  emptyTotals,
  episodeOf,
  KIND_LABELS,
  parseVodTime,
  weekRangeLabel,
  weekStartOf,
  weekdayLabel,
  weekdayOf,
  type CalendarCard,
  type CalendarDay,
  type CalendarGroup,
  type CalendarKind,
  type CalendarPayload,
} from '@/lib/calendar';
import type { SourceConfig } from '@/lib/types';

export const runtime = 'nodejs';

/**
 * 追剧日历（周表）。
 *
 * 数据来源**只有一条**：各点播源「最新更新」列表里的 vod_time。
 * 也就是「已经在源站发生过的更新」，不是我们编的排播表——
 * 所以文案必须老实话说明这一点（notice 字段），不能承诺「几点更新」。
 *
 * 关键取舍（来自 kanju.ai 的实测教训）：
 *  - 日期条汇总数与下面的列表用同一份 items 现算，绝不两次查询分别取，
 *    否则「日期条 61 部、点进去 59 部」这种对不上的现象会被用户当成数据错误；
 *  - 全周快照缓存 10 分钟（同一批人看到的是同批数据，也扛得住反复翻页）；
 *  - 翻页只在快照上切片，不重新打源站。
 */

const SNAPSHOT_TTL = 10 * 60 * 1000;
/** 每个源抓几页「最新更新」：两页 × 8 源足够覆盖一周（含去重前的原始条目） */
const PAGES_PER_SOURCE = 3;
const MAX_SOURCES = 8;

interface CalendarBody {
  sources: SourceConfig[];
  filterAdult?: boolean;
  week?: string;
  weekday?: number;
  kind?: string;
  limit?: number;
  /** 只看我追的剧：追剧清单按片名匹配 */
  watchOnly?: boolean;
  /** 追剧清单：本地历史 + 收藏的片名 */
  watchlist?: string[];
}

interface RawItem {
  name: string;
  pic?: string;
  remarks?: string;
  year?: string;
  area?: string;
  typeName?: string;
  time?: string;
  vodId?: string;
}

const ADULT_WORDS = ['伦理', '福利', '无码', '有码', '里番', '门事件', '自拍偷拍', '传媒'];
const isAdultType = (t?: string) => !!t && ADULT_WORDS.some((w) => t.includes(w));

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s || undefined;
}

async function fetchPage(source: SourceConfig, page: number): Promise<RawItem[]> {
  const base = source.url.replace(/\/+$/, '');
  // 先按最标准的「最新更新」接口取；部分源不认 videolist 时退回 detail
  const urls = [`${base}?ac=videolist&pg=${page}`, `${base}?ac=detail&pg=${page}`];
  for (const url of urls) {
    try {
      const res = await fetchUpstream(url, {
        timeoutMs: 8000,
        headers: cmsRequestHeaders(),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { list?: unknown };
      const list = Array.isArray(data.list) ? data.list : [];
      if (list.length === 0) continue;
      return list.map((row) => {
        const vod = (row || {}) as Record<string, unknown>;
        return {
          name: str(vod.vod_name) || '',
          pic: str(vod.vod_pic),
          remarks: str(vod.vod_remarks),
          year: str(vod.vod_year),
          area: str(vod.vod_area),
          typeName: str(vod.type_name),
          time: str(vod.vod_time) || str(vod.vod_pubdate),
          vodId: vod.vod_id === undefined ? undefined : String(vod.vod_id),
        };
      });
    } catch {
      /* 换下一个接口形态再试 */
    }
  }
  return [];
}

interface Snapshot {
  items: CalendarCard[];
  failures: { sourceKey: string; error: string }[];
  generatedAt: string;
  expiresAt: string;
}

/** 一周的原始快照（10 分钟） */
async function loadSnapshot(
  sources: SourceConfig[],
  filterAdult: boolean,
  weekStart: string
): Promise<Snapshot> {
  const key = `calendar:${weekStart}:${filterAdult ? 1 : 0}:${sources
    .map((s) => s.url.replace(/\/+$/, ''))
    .sort()
    .join('|')}`;
  const cached = getCache<Snapshot>(key);
  if (cached) return cached;

  const failures: { sourceKey: string; error: string }[] = [];
  const collected: CalendarCard[] = [];

  await Promise.all(
    sources.slice(0, MAX_SOURCES).map(async (source) => {
      if (!/^https?:\/\//.test(source.url || '')) {
        failures.push({ sourceKey: source.key, error: '无效的源地址' });
        return;
      }
      // 用户可控地址发起服务端请求，必须先过 SSRF 校验
      const verdict = await checkUpstreamAllowed(source.url);
      if (!verdict.ok) {
        failures.push({ sourceKey: source.key, error: verdict.reason });
        return;
      }
      try {
        const pages = await Promise.all(
          Array.from({ length: PAGES_PER_SOURCE }, (_, i) => fetchPage(source, i + 1).catch(() => []))
        );
        const rows = pages.flat();
        if (rows.length === 0) {
          failures.push({ sourceKey: source.key, error: '没有取到更新列表' });
          return;
        }
        for (const row of rows) {
          if (!row.name || !row.vodId) continue;
          if (filterAdult && isAdultType(row.typeName)) continue;
          const parsed = parseVodTime(row.time);
          if (!parsed) continue;
          collected.push({
            name: row.name,
            pic: row.pic,
            remarks: row.remarks,
            year: row.year,
            area: row.area,
            typeName: row.typeName,
            kind: classifyKind(row.typeName, row.name),
            date: parsed.date,
            at: parsed.at,
            episode: episodeOf(row.remarks),
            sourceKey: source.key,
            sourceName: source.name,
            sourceUrl: source.url,
            vodId: row.vodId,
          });
        }
      } catch (err) {
        failures.push({ sourceKey: source.key, error: err instanceof Error ? err.message : '请求失败' });
      }
    })
  );

  // 同一部片同一天在多个采集站重复出现是常态：按「日期 + 片名」去重，
  // 只留更新时间更晚的那条，避免日期条上的数字被重复条目灌水。
  const byDay = new Map<string, CalendarCard[]>();
  for (const item of collected) {
    const list = byDay.get(item.date);
    if (list) list.push(item);
    else byDay.set(item.date, [item]);
  }
  const items: CalendarCard[] = [];
  for (const list of byDay.values()) items.push(...dedupeByTitle(list));
  items.sort((a, b) => (b.date + (b.at || '')).localeCompare(a.date + (a.at || '')));

  const snapshot: Snapshot = {
    items,
    failures,
    generatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SNAPSHOT_TTL).toISOString(),
  };
  setCache(key, snapshot, SNAPSHOT_TTL);
  return snapshot;
}

/** 周参数 → 周一日期；historyStart 之前的周不再提供（源站没有更早的更新记录） */
function resolveWeek(week: string | undefined, today: string): string {
  const current = weekStartOf(today);
  if (!week || week === 'current') return current;
  if (week === 'prev') return addDays(current, -7);
  if (week === 'next') return addDays(current, 7);
  if (/^\d{4}-\d{2}-\d{2}$/.test(week)) return weekStartOf(week);
  return current;
}

const normTitle = (s: string) => s.trim().toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: CalendarBody;
  try {
    body = (await req.json()) as CalendarBody;
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }
  if (!Array.isArray(body.sources) || body.sources.length === 0) {
    return NextResponse.json({ error: '请至少选择一个点播源' }, { status: 400 });
  }

  const now = cnNow();
  const weekStart = resolveWeek(body.week, now.date);
  const weekEnd = addDays(weekStart, 6);
  const snapshot = await loadSnapshot(body.sources, body.filterAdult !== false, weekStart);

  // 只看我追的剧：按片名归一化匹配本地追剧清单
  const watchSet = new Set(
    (body.watchlist || []).map((t) => normTitle(String(t || ''))).filter((t) => t.length >= 2)
  );
  const watchOnly = body.watchOnly === true && watchSet.size > 0;
  const inWeek = snapshot.items.filter((it) => it.date >= weekStart && it.date <= weekEnd);
  const scoped = watchOnly ? inWeek.filter((it) => watchSet.has(normTitle(it.name))) : inWeek;

  const days = buildDays(weekStart, scoped, now.date);

  // 默认选中的日子：本周就今天，别的周选周一
  const fallbackDay = weekStart <= now.date && now.date <= weekEnd ? now.date : weekStart;
  const wanted = Number(body.weekday);
  const selectedDate =
    Number.isInteger(wanted) && wanted >= 1 && wanted <= 7 ? addDays(weekStart, wanted - 1) : fallbackDay;
  const selectedDay: CalendarDay =
    days.find((d) => d.date === selectedDate) ?? {
      date: selectedDate,
      weekday: weekdayOf(selectedDate),
      weekdayLabel: weekdayLabel(weekdayOf(selectedDate)),
      dayLabel: dayLabel(selectedDate),
      today: selectedDate === now.date,
      totals: emptyTotals(),
    };

  const limit = Math.min(200, Math.max(4, Number(body.limit) || 60));
  const kindParam = (body.kind || 'all').trim();
  const dayItems = scoped.filter((it) => it.date === selectedDate);

  // 分类条：只列当天真有内容的分类；「全部」恒等于各类之和（口径永远对得上）
  const categories: { key: CalendarKind | 'all'; label: string; total: number }[] = [
    { key: 'all', label: '全部', total: selectedDay.totals.all },
  ];
  (Object.keys(KIND_LABELS) as CalendarKind[]).forEach((k) => {
    if (selectedDay.totals[k] > 0) categories.push({ key: k, label: KIND_LABELS[k], total: selectedDay.totals[k] });
  });

  const groups: CalendarGroup[] = [];
  if (kindParam === 'all') {
    for (const cat of categories) {
      if (cat.key === 'all') continue;
      const list = dayItems.filter((it) => it.kind === cat.key);
      groups.push({
        key: cat.key,
        label: cat.label,
        total: list.length,
        items: list.slice(0, Math.max(4, Math.min(limit, 12))),
        hasMore: list.length > Math.max(4, Math.min(limit, 12)),
      });
    }
  } else {
    const list = dayItems.filter((it) => it.kind === kindParam);
    groups.push({
      key: kindParam as CalendarKind,
      label: KIND_LABELS[kindParam as CalendarKind] ?? '全部',
      total: list.length,
      items: list.slice(0, limit),
      hasMore: list.length > limit,
    });
  }

  const payload: CalendarPayload = {
    object: 'mflixtv.watch_calendar',
    title: '追剧日历',
    weekStart,
    weekEnd,
    weekLabel: weekRangeLabel(weekStart),
    canPrev: true,
    canNext: true,
    days,
    selected: selectedDay,
    categories,
    groups,
    notice: '按各点播源最近更新记录统计（片名去重），源站排播会变，实际更新可能延迟。',
    watchOnly,
    watchCount: watchSet.size,
    generatedAt: snapshot.generatedAt,
    expiresAt: snapshot.expiresAt,
    failures: snapshot.failures,
    weekTotal: scoped.length,
  };
  return NextResponse.json(payload);
}

/** 兼容 GET：给局域网/安卓端一个显式的使用说明（周表必须带源列表） */
export async function GET() {
  return NextResponse.json(
    { error: '请用 POST 提交源列表（与 /api/search 同一套约定）' },
    { status: 405 }
  );
}
