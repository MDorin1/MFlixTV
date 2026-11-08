import { normalizeTitle } from './cms-parser';
import { latestEpisodeDate, recencyYear } from './remarks';
import type { SearchResultItem } from './types';

/**
 * 搜索结果排序规则（双端必须一致，见 `docs/dual-impl.md` 第 2 项）。
 *
 * 安卓端是 `Freshness.titleRank` + `Sources.search()`，改动要两边一起落。
 *
 * 两档（2026-11-09 定案，不是三档）：
 *  1. 归一化后**与关键词完全相同**的排最前，其余一律平等
 *     —— 老片（「小明星大跟班」vod_year=2016）靠这一档才不会被一堆 2024/2025
 *     的模糊命中压到后面；前缀与包含之间的先后在电视上分辨不出来，
 *     两端各写一遍细分档位反而更容易走样，所以只留「正主置顶」这一条。
 *  2. 同档按 recencyYear 降序：连载综艺取最新一期的年份，不是首播年。
 *  3. 再同按原始标题、源名，保证同一关键词两次结果顺序一致（不依赖源站返回顺序）。
 */

/** 0 完全相同 / 1 其余（两档，别再细分前缀与包含） */
export function titleRank(name: string | undefined, wd: string): number {
  const n = normalizeTitle(name || '');
  const w = normalizeTitle(wd);
  if (!n || !w) return 1;
  return n === w ? 0 : 1;
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
