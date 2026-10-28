/**
 * 追剧日历（周表）的纯计算层。
 *
 * 设计取自 kanju.ai 追剧周表的三个硬结论（见 kanju-research/REPORT-kanju-impl.md）：
 *  1. 「周」是最小浏览单位，不是月——追剧的决策周期本来就是「这周追什么」；
 *  2. 日期格里三行信息（周几 / 几号 / 部数），让「哪天更新多」一眼可比；
 *  3. 日期条的汇总数与下面的列表必须同源，否则用户点进去会觉得「少了几部」。
 *     所以这里所有计数都由同一份 items 现算，绝不另开一个查询。
 *
 * 时间一律按 Asia/Shanghai（固定 +08:00，无夏令时）计算，不受服务器时区影响：
 * 上游 vod_time 是国内时间字符串，用本地时区解析会在 UTC 容器里整体偏 8 小时。
 */

/** 日历分类：一部片只归一类，全部分类之和严格等于「全部」 */
export type CalendarKind = 'series' | 'movie' | 'anime' | 'variety' | 'short' | 'other';

export const CALENDAR_KINDS: CalendarKind[] = ['series', 'movie', 'anime', 'variety', 'short', 'other'];

export const KIND_LABELS: Record<CalendarKind, string> = {
  series: '电视剧',
  movie: '电影',
  anime: '动漫',
  variety: '综艺',
  short: '短剧',
  other: '其他',
};

/** 日更新条目（已按片名去重后的「一部片」） */
export interface CalendarCard {
  name: string;
  pic?: string;
  remarks?: string;
  year?: string;
  area?: string;
  typeName?: string;
  kind: CalendarKind;
  /** 更新日期 YYYY-MM-DD（Asia/Shanghai） */
  date: string;
  /** 更新时间 HH:mm（源站没给时为空） */
  at?: string;
  /** 从 remarks 里解出的集数：更新至 21 集 → 21 */
  episode?: number;
  /** 打开详情需要的四件套 */
  sourceKey: string;
  sourceName: string;
  sourceUrl: string;
  vodId: string;
}

export type DayTotals = Record<'all' | CalendarKind, number>;

export interface CalendarDay {
  date: string;
  /** 1=周一 … 7=周日 */
  weekday: number;
  weekdayLabel: string;
  /** 「26日」 */
  dayLabel: string;
  /** 是否今天 */
  today: boolean;
  totals: DayTotals;
}

const CN_OFFSET_MS = 8 * 60 * 60 * 1000;
const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));

/** 把「客户端此刻」换算成中国时区的日期串 */
export function cnNow(now: Date = new Date()): { date: string; time: string } {
  const shifted = new Date(now.getTime() + CN_OFFSET_MS);
  return {
    date: `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`,
    time: `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}`,
  };
}

/** YYYY-MM-DD → 当天 00:00 的 UTC 毫秒（只当「日期序号」用，不代表真实时刻） */
function stamp(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1);
}

function fromStamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function addDays(date: string, days: number): string {
  return fromStamp(stamp(date) + days * 86400000);
}

/** 1=周一 … 7=周日 */
export function weekdayOf(date: string): number {
  return ((new Date(stamp(date)).getUTCDay() + 6) % 7) + 1;
}

export function weekdayLabel(weekday: number): string {
  return WEEKDAY_LABELS[Math.min(6, Math.max(0, weekday - 1))];
}

export function dayLabel(date: string): string {
  return `${Number(date.slice(8, 10))}日`;
}

/** 所在周（周一起）的周一 */
export function weekStartOf(date: string): string {
  return addDays(date, 1 - weekdayOf(date));
}

/** 一周七天 */
export function weekDates(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/** 「10月26日 - 11月1日」 */
export function weekRangeLabel(weekStart: string): string {
  const end = addDays(weekStart, 6);
  const md = (d: string) => `${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日`;
  return `${md(weekStart)} - ${md(end)}`;
}

/**
 * 解析上游 vod_time。
 * 实测采集站至少有三种写法：`2026-10-28 22:00:00`、`2026-10-28`、`2026/10/28 22:00`。
 * 解析不出来返回 undefined（宁可这条不进日历，也不要塞到错误的日期里）。
 */
export function parseVodTime(raw?: string): { date: string; at?: string } | undefined {
  const text = (raw || '').trim();
  if (!text) return undefined;
  const m = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m) return undefined;
  const [, y, mo, d, hh, mm] = m;
  const date = `${y}-${pad2(Number(mo))}-${pad2(Number(d))}`;
  if (weekdayOf(date) < 1) return undefined;
  return { date, at: hh && mm ? `${pad2(Number(hh))}:${mm}` : undefined };
}

/** 从 remarks 里解出集数：`更新至21集` / `第21集` / `21` */
export function episodeOf(remarks?: string): number | undefined {
  const text = (remarks || '').trim();
  if (!text) return undefined;
  const m = text.match(/(?:更新至|更新到|第)?\s*(\d{1,4})\s*集/);
  if (m) return Number(m[1]);
  const bare = text.match(/^(\d{1,4})$/);
  return bare ? Number(bare[1]) : undefined;
}

const SHORT_WORDS = ['短剧', '微短剧', '竖屏剧', '短剧场', '擦边短剧'];
const ANIME_WORDS = ['动漫', '动画', '番剧', '国漫', '日漫', '里番'];
const VARIETY_WORDS = ['综艺', '真人秀', '脱口秀', '访谈', '晚会', '记录片综艺'];
const MOVIE_WORDS = ['电影', '片'];
const SERIES_WORDS = ['电视剧', '连续剧', '剧集', '国产剧', '欧美剧', '韩剧', '日剧', '港剧', '台剧', '海外剧', '欧美剧'];

/**
 * 分类判定。顺序很重要：短剧必须最先判（很多源把短剧挂在「国产剧」下，
 * 但 type_name 里会带「短剧」二字）；「片」这种宽词放最后兜底，
 * 否则「电视剧」里的「视」不会误伤，但「纪录片」会被判成电影——这是可接受的取舍。
 */
export function classifyKind(typeName?: string, name?: string): CalendarKind {
  const t = (typeName || '').trim();
  const n = (name || '').trim();
  const has = (words: string[]) => words.some((w) => t.includes(w));
  if (has(SHORT_WORDS) || n.includes('短剧')) return 'short';
  if (has(ANIME_WORDS)) return 'anime';
  if (has(VARIETY_WORDS)) return 'variety';
  if (has(SERIES_WORDS)) return 'series';
  if (has(MOVIE_WORDS)) return 'movie';
  return 'other';
}

export function emptyTotals(): DayTotals {
  return { all: 0, series: 0, movie: 0, anime: 0, variety: 0, short: 0, other: 0 };
}

export function addToTotals(totals: DayTotals, kind: CalendarKind): void {
  totals.all += 1;
  totals[kind] += 1;
}

/** 跨源同名片去重：保留更新时间更晚的那条（同一条更新在多个采集站出现是常态） */
export function dedupeByTitle<T extends { name: string; at?: string; sourceName?: string }>(items: T[]): T[] {
  const map = new Map<string, T>();
  const keyOf = (s: string) => s.trim().toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  for (const it of items) {
    const key = keyOf(it.name);
    if (!key) continue;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, it);
      continue;
    }
    // 后到的更新更晚（at 大）就替换；都没时间时保留先到的
    if ((it.at || '') > (prev.at || '')) map.set(key, it);
  }
  return [...map.values()];
}

/** 一个分类在「选中日」下的分组：总数与列表同源（总数由同一份 items 算出） */
export interface CalendarGroup {
  key: CalendarKind | 'all';
  label: string;
  total: number;
  items: CalendarCard[];
  hasMore: boolean;
}

/** /api/calendar 的响应（桌面端与安卓端同构，安卓端 Kotlin 侧按这份结构输出） */
export interface CalendarPayload {
  object: 'mflixtv.watch_calendar';
  title: string;
  /** 周一的日期 */
  weekStart: string;
  weekEnd: string;
  weekLabel: string;
  /** 是否已经是最早/最晚可查的周（前端据此禁用「上一周/下一周」） */
  canPrev: boolean;
  canNext: boolean;
  days: CalendarDay[];
  selected: CalendarDay;
  /** 分类条：只列有数据的分类，全部 = 各类之和 */
  categories: { key: CalendarKind | 'all'; label: string; total: number }[];
  /** 选中日 + 选中分类下的列表；kind 传 all 时按分类各给一组 */
  groups: CalendarGroup[];
  /** 免责/口径提示：更新预测必然有误差，先把预期打下来 */
  notice: string;
  /** 命中「我追的剧」过滤时为 true */
  watchOnly: boolean;
  /** 追剧清单线索数（看过的 + 收藏的），0 表示本地还没有可用的追剧记录 */
  watchCount: number;
  generatedAt: string;
  expiresAt: string;
  /** 取数失败的源：不影响其它源的结果 */
  failures: { sourceKey: string; error: string }[];
  /** 全部去重后的条目数（整周），用于「本周共 N 部有更新」 */
  weekTotal: number;
}

/** 周表里一天的「日历视图」：日期条 + 选中日头部 */
export function buildDays(weekStart: string, items: CalendarCard[], today: string): CalendarDay[] {
  const byDate = new Map<string, DayTotals>();
  for (const date of weekDates(weekStart)) byDate.set(date, emptyTotals());
  for (const it of items) {
    const totals = byDate.get(it.date);
    if (totals) addToTotals(totals, it.kind);
  }
  return weekDates(weekStart).map((date) => ({
    date,
    weekday: weekdayOf(date),
    weekdayLabel: weekdayLabel(weekdayOf(date)),
    dayLabel: dayLabel(date),
    today: date === today,
    totals: byDate.get(date) ?? emptyTotals(),
  }));
}
