import { normalizeTitle } from './cms-parser';
import { latestEpisodeDate, recencyYear } from './remarks';
import type { SearchResultItem } from './types';

/**
 * 搜索结果排序规则（双端必须一致，见 `docs/dual-impl.md` 第 2 项）。
 *
 * 安卓端是 `Freshness.titleRank` + `Sources.search()`，改动要两边一起落。
 *
 * 三段：
 *  1. 标题精确度：归一化后完全相等 > 前缀匹配 > 包含匹配 > 其他
 *     —— 老片（「小明星大跟班」vod_year=2016）靠这一档才不会被一堆 2024/2025
 *     的模糊命中压到后面；以前安卓端只按年份倒序，精确命中反而排最后。
 *  2. 同档按 recencyYear 降序：连载综艺取最新一期的年份，不是首播年。
 *  3. 再同按原始标题、源名，保证同一关键词两次结果顺序一致（不依赖源站返回顺序）。
 */

/** 0 完全相等 / 1 前缀 / 2 包含 / 3 其他 */
export function titleRank(name: string | undefined, wd: string): number {
  const n = normalizeTitle(name || '');
  const w = normalizeTitle(wd);
  if (!n || !w) return 3;
  if (n === w) return 0;
  if (n.startsWith(w)) return 1;
  if (n.includes(w)) return 2;
  return 3;
}

/** 排序用的年份：有最新一期日期时以那一年的年份为准 */
export function sortYear(item: Pick<SearchResultItem, 'year' | 'remarks'>): number {
  return recencyYear(item.year, latestEpisodeDate(item.remarks));
}

/** 集合原地排序（`aggregateOutcomes` 用） */
export function sortSearchResults(list: SearchResultItem[], wd: string): SearchResultItem[] {
  return list.sort((a, b) => {
    const r = titleRank(a.name, wd) - titleRank(b.name, wd);
    if (r !== 0) return r;
    const y = sortYear(b) - sortYear(a);
    if (y !== 0) return y;
    const nameCompare = (a.name || '').localeCompare(b.name || '', 'zh-Hans-CN');
    if (nameCompare !== 0) return nameCompare;
    return (a.sourceName || '').localeCompare(b.sourceName || '', 'zh-Hans-CN');
  });
}
