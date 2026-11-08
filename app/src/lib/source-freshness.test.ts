import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_DAYS,
  ageInDays,
  freshnessLabel,
  isArchivedSource,
  latestInRaw,
} from '@/lib/source-freshness';

/** 固定「现在」：2026-11-08 中午，避免用例随真实时间漂移 */
const NOW = Date.parse('2026-11-08T12:00:00');

describe('latestInRaw', () => {
  it('备注里有内容日期时优先用它，哪怕上架时间更新', () => {
    const latest = latestInRaw([
      { vod_remarks: '更新至20251020期', vod_time: '2026-11-07 15:42:27' },
    ]);
    expect(latest).toEqual({ date: '2025-10-20', source: 'remarks' });
  });

  it('备注完全没有日期时退回上架时间，并标明来源', () => {
    const latest = latestInRaw([
      { vod_remarks: 'HD国语', vod_time: '2026-11-07 15:42:27' },
      { vod_remarks: '更新至1285集', vod_time: '2026-10-01 08:00:00' },
    ]);
    expect(latest).toEqual({ date: '2026-11-07', source: 'vod_time' });
  });

  it('同一个源里不同条目混着写，内容日期仍然优先', () => {
    const latest = latestInRaw([
      { vod_remarks: 'HD国语', vod_time: '2026-11-08 09:00:00' },
      { vod_remarks: '第20250224期', vod_time: '2026-11-01 09:00:00' },
    ]);
    expect(latest).toEqual({ date: '2025-02-24', source: 'remarks' });
  });

  it('纯年份不算日期：`2026` 不能被当成期号', () => {
    expect(latestInRaw([{ vod_remarks: '2026', vod_time: '2026' }])).toBeUndefined();
  });

  it('不是数组、或有空条目时不炸', () => {
    expect(latestInRaw(undefined)).toBeUndefined();
    expect(latestInRaw('nope')).toBeUndefined();
    expect(latestInRaw([null, 1, 'x', { vod_remarks: '正片' }])).toBeUndefined();
  });

  it('区间写法取最晚的日期', () => {
    expect(latestInRaw([{ vod_remarks: '20240101-20251020' }])).toEqual({
      date: '2025-10-20',
      source: 'remarks',
    });
  });
});

describe('isArchivedSource', () => {
  it('内容日期超过门槛判归档', () => {
    const old = latestInRaw([{ vod_remarks: '更新至20250420期' }]);
    expect(ageInDays(old!.date, NOW)).toBeGreaterThan(ARCHIVE_DAYS);
    expect(isArchivedSource(old, NOW)).toBe(true);
  });

  it('内容日期在门槛内不判归档', () => {
    const fresh = latestInRaw([{ vod_remarks: '更新至20261102期' }]);
    expect(ageInDays(fresh!.date, NOW)).toBeLessThanOrEqual(ARCHIVE_DAYS);
    expect(isArchivedSource(fresh, NOW)).toBe(false);
  });

  it('只有上架时间时永远不判归档——重抓一次就变今天，拿它判闸等于没装', () => {
    // 上架时间很旧，但来源只有它是上架时间这一种口径，仍然不判死
    const upload = latestInRaw([{ vod_remarks: 'HD国语', vod_time: '2023-01-01 10:00:00' }]);
    expect(upload?.source).toBe('vod_time');
    expect(isArchivedSource(upload, NOW)).toBe(false);
  });

  it('拿不到日期不判归档', () => {
    expect(isArchivedSource(undefined, NOW)).toBe(false);
  });
});

describe('freshnessLabel', () => {
  it('内容日期写成「最新一集…源 N 个月前更新」', () => {
    expect(freshnessLabel({ date: '2025-10-20', source: 'remarks' }, NOW)).toBe(
      '最新一集 2025-10-20 · 源 12 个月前更新'
    );
  });

  it('内容日期在 30 天内时不加「几个月前」', () => {
    expect(freshnessLabel({ date: '2026-11-02', source: 'remarks' }, NOW)).toBe('最新一集 2026-11-02');
  });

  it('上架时间明写成「上架时间」，不混进「最新一集」', () => {
    expect(freshnessLabel({ date: '2026-11-07', source: 'vod_time' }, NOW)).toBe('上架时间 2026-11-07');
  });
});
