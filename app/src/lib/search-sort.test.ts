import { describe, expect, it } from 'vitest';
import { sortSearchResults, sortYear, titleRank } from './search-sort';
import type { SearchResultItem } from './types';

/** 造一条搜索结果，只填排序用得到的字段 */
function item(name: string, year?: string, remarks?: string, sourceName = 'A'): SearchResultItem {
  return { sourceKey: 'k', sourceName, vodId: name, name, year, remarks };
}

const names = (list: SearchResultItem[]) => list.map((i) => i.name);

describe('titleRank（两档：完全相同置顶，其余一律平等）', () => {
  it('完全相同 = 0，前缀/包含/无关都是 1', () => {
    expect(titleRank('小明星大跟班', '小明星大跟班')).toBe(0);
    expect(titleRank('小明星大跟班2024', '小明星大跟班')).toBe(1);
    expect(titleRank('超级小明星大跟班', '小明星大跟班')).toBe(1);
    expect(titleRank('极限挑战', '小明星大跟班')).toBe(1);
  });

  it('忽略标点、空白与大小写（源站存「摔跤吧!爸爸」也能精确命中）', () => {
    expect(titleRank('摔跤吧!爸爸', '摔跤吧！爸爸')).toBe(0);
    expect(titleRank('  The  Office ', 'the office')).toBe(0);
  });

  it('空片名或空关键词落到非置顶档，不抛错', () => {
    expect(titleRank(undefined, '庆余年')).toBe(1);
    expect(titleRank('', '庆余年')).toBe(1);
    expect(titleRank('庆余年', '  ')).toBe(1);
  });
});

describe('sortYear', () => {
  it('连载综艺取最新一期的年份，不是首播年', () => {
    expect(sortYear({ year: '2016', remarks: '更新至20251020期' })).toBe(2025);
    expect(sortYear({ year: '2016', remarks: '更新至20240101期' })).toBe(2024);
  });

  it('没有最新一期日期时退回 vod_year', () => {
    expect(sortYear({ year: '2016', remarks: '更新至12集' })).toBe(2016);
    expect(sortYear({ year: '', remarks: undefined })).toBe(0);
  });

  it('首播年比最新一期还新时以首播年为准（不会被日期压小）', () => {
    expect(sortYear({ year: '2026', remarks: '更新至20250101期' })).toBe(2026);
  });
});

describe('sortSearchResults', () => {
  it('精确命中排最前，老片不会被一堆新片压下去（最初那条 bug）', () => {
    const list = [
      item('小明星大跟班之新人报到', '2025'),
      item('超级小明星', '2025'),
      item('小明星大跟班', '2016', '更新至20251020期'),
    ];
    expect(names(sortSearchResults(list, '小明星大跟班'))[0]).toBe('小明星大跟班');
  });

  it('同一档内按最新一期年份倒序', () => {
    const list = [
      item('极限挑战 第3季', '2017'),
      item('极限挑战 第9季', '2023', '更新至20250601期'),
      item('极限挑战 第6季', '2020'),
    ];
    expect(names(sortSearchResults(list, '极限挑战'))).toEqual([
      '极限挑战 第9季',
      '极限挑战 第6季',
      '极限挑战 第3季',
    ]);
  });

  it('同档内按最新一期年份倒序，前缀/包含不再细分档', () => {
    const list = [item('超长版锻刀大赛', '2026'), item('锻刀大赛 第10季', '2024')];
    // 两档规则下「前缀」不占优，谁的最新一期年份新谁在前
    expect(names(sortSearchResults(list, '锻刀大赛'))).toEqual(['超长版锻刀大赛', '锻刀大赛 第10季']);
  });

  it('全部相同字段时按源名定序，同一输入两次结果一致', () => {
    const list = [item('庆余年', '2019', undefined, '源B'), item('庆余年', '2019', undefined, '源A')];
    expect(names(sortSearchResults(list, '庆余年'))).toEqual(['庆余年', '庆余年']);
    expect(sortSearchResults(list, '庆余年')[0].sourceName).toBe('源A');
  });
});
