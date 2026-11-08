import { describe, expect, it } from 'vitest';
import { sortSearchResults, sortYear, titleRank } from './search-sort';
import type { SearchResultItem } from './types';

/** 造一条搜索结果，只填排序用得到的字段 */
function item(name: string, year?: string, remarks?: string, sourceName = 'A'): SearchResultItem {
  return { sourceKey: 'k', sourceName, vodId: name, name, year, remarks };
}

const names = (list: SearchResultItem[]) => list.map((i) => i.name);

describe('titleRank', () => {
  it('完全相等 / 前缀 / 包含 / 其他 四级递增', () => {
    expect(titleRank('小明星大跟班', '小明星大跟班')).toBe(0);
    expect(titleRank('小明星大跟班2024', '小明星大跟班')).toBe(1);
    expect(titleRank('超级小明星大跟班', '小明星大跟班')).toBe(2);
    expect(titleRank('极限挑战', '小明星大跟班')).toBe(3);
  });

  it('忽略标点、空白与大小写（源站存「摔跤吧!爸爸」也能精确命中）', () => {
    expect(titleRank('摔跤吧!爸爸', '摔跤吧！爸爸')).toBe(0);
    expect(titleRank('  The  Office ', 'the office')).toBe(0);
  });

  it('空片名或空关键词落到最后一档，不抛错', () => {
    expect(titleRank(undefined, '庆余年')).toBe(3);
    expect(titleRank('', '庆余年')).toBe(3);
    expect(titleRank('庆余年', '  ')).toBe(3);
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

  it('前缀优先于包含，即使包含的那条年份更新', () => {
    const list = [item('超长版锻刀大赛', '2026'), item('锻刀大赛 第10季', '2024')];
    expect(names(sortSearchResults(list, '锻刀大赛'))).toEqual(['锻刀大赛 第10季', '超长版锻刀大赛']);
  });

  it('全部相同字段时按源名定序，同一输入两次结果一致', () => {
    const list = [item('庆余年', '2019', undefined, '源B'), item('庆余年', '2019', undefined, '源A')];
    expect(names(sortSearchResults(list, '庆余年'))).toEqual(['庆余年', '庆余年']);
    expect(sortSearchResults(list, '庆余年')[0].sourceName).toBe('源A');
  });
});
