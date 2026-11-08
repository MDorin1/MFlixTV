/**
 * 片源新鲜度：一条源「最新采到哪一天」以及它算不算归档源。
 *
 * 这里有两个字段，性质完全不同，不能混着用：
 *
 * - `vod_remarks`（备注）是**内容日期**：`更新至20251020期`、`第20250224期`。
 *   它只会在上游真的采到新一期时才变，所以能拿它判「这条源还更不更新」。
 * - `vod_time`（采集站的上架/更新时间，形如 `2026-11-07 15:42:27`）是**抓取时间**：
 *   一条内容停在 2023 年的旧源，只要被重新抓一次，`vod_time` 就变成今天。
 *   拿它判归档，所有源都会显示「健康」，归档闸等于没装。
 *
 * 所以：能算日期时优先用备注；备注里根本没有日期（电影写 `HD国语`、连载剧写
 * `更新至1285集`）才退回 `vod_time` 兜底，并且用 `dateSource` 标清楚来源，
 * 显示时写成「上架时间」，不写进「最新一集」。
 * 归档判定**只认 `remarks`**。
 */
import { latestEpisodeDate } from '@/lib/remarks';

/** 日期来自哪个字段 */
export type DateSource = 'remarks' | 'vod_time';

export interface SourceLatest {
  /** YYYY-MM-DD */
  date: string;
  source: DateSource;
}

/** 归档门槛（天）：最新一期比这还旧，说明上游早不采了，只是接口还活着 */
export const ARCHIVE_DAYS = 90;

/**
 * 一条源「最新内容日期」。
 *
 * 逐条取备注里的最晚日期与上架时间的最晚日期，两者分开比：
 * 只要有任何一条备注带日期，就用以它为准（内容日期优先）；
 * 一条都没有才退回上架时间。
 */
export function latestInRaw(list: unknown): SourceLatest | undefined {
  if (!Array.isArray(list)) return undefined;
  let bestRemarks = '';
  let bestUpload = '';
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const it = raw as { vod_time?: unknown; vod_remarks?: unknown };
    const remarks = latestEpisodeDate(String(it.vod_remarks ?? ''));
    if (remarks && remarks > bestRemarks) bestRemarks = remarks;
    const upload = latestEpisodeDate(String(it.vod_time ?? ''));
    if (upload && upload > bestUpload) bestUpload = upload;
  }
  if (bestRemarks) return { date: bestRemarks, source: 'remarks' };
  if (bestUpload) return { date: bestUpload, source: 'vod_time' };
  return undefined;
}

/** 距今天数（本地日历口径，跨时区差一天不影响判档） */
export function ageInDays(iso: string, now: number = Date.now()): number | undefined {
  const t = Date.parse(`${iso}T00:00:00`);
  if (!Number.isFinite(t)) return undefined;
  return Math.max(0, Math.round((now - t) / 86400000));
}

/**
 * 归档判定：只有内容日期（备注）能判死一条源。
 *
 * 上架时间是抓取时间，重抓一次就是今天，永远判不旧——拿它判等于把闸拆了。
 */
export function isArchivedSource(latest: SourceLatest | undefined, now: number = Date.now()): boolean {
  if (!latest || latest.source !== 'remarks') return false;
  const days = ageInDays(latest.date, now);
  return days !== undefined && days > ARCHIVE_DAYS;
}

/**
 * 体检页那一格的文案。
 *
 * 内容日期写「最新一集 2025-10-20 · 源 12 个月前更新」，上架时间写「上架时间 …」，
 * 两者一眼能分清——用户不会把「刚被重抓过」当成「刚更新过」。
 */
export function freshnessLabel(latest: SourceLatest, now: number = Date.now()): string {
  if (latest.source === 'vod_time') return `上架时间 ${latest.date}`;
  const days = ageInDays(latest.date, now);
  const months = days === undefined ? 0 : Math.floor(days / 30);
  return `最新一集 ${latest.date}${months >= 1 ? ` · 源 ${months} 个月前更新` : ''}`;
}
