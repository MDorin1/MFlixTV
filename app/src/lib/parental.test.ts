import { describe, expect, it } from 'vitest';
import { inBlockTime, kidsHit, type ParentalCfg } from './parental';

const base: ParentalCfg = { on: true, pin: '1234', kids: ['恐怖', 'violence'], from: null, to: null };

describe('家长控制：屏蔽词', () => {
  it('中文与大小写不敏感命中', () => {
    expect(kidsHit('恐怖片精选', base)).toBe(true);
    expect(kidsHit('VIOLENCE 特辑', base)).toBe(true);
  });

  it('没命中就是没命中', () => {
    expect(kidsHit('纪录片：海洋', base)).toBe(false);
  });

  it('空关键词不会把所有片子都挡掉', () => {
    const cfg: ParentalCfg = { ...base, kids: ['', '  '] };
    expect(kidsHit('随便一部', cfg)).toBe(false);
  });
});

describe('家长控制：限时时段', () => {
  it('同一天内的时段（22 点-23 点）', () => {
    const cfg: ParentalCfg = { ...base, from: 22, to: 23 };
    expect(inBlockTime(cfg, new Date('2026-01-01T22:30:00'))).toBe(true);
    expect(inBlockTime(cfg, new Date('2026-01-01T21:59:00'))).toBe(false);
    expect(inBlockTime(cfg, new Date('2026-01-01T23:00:00'))).toBe(false);
  });

  it('跨零点时段（22 点-次日 7 点）', () => {
    const cfg: ParentalCfg = { ...base, from: 22, to: 7 };
    expect(inBlockTime(cfg, new Date('2026-01-01T23:10:00'))).toBe(true);
    expect(inBlockTime(cfg, new Date('2026-01-02T03:00:00'))).toBe(true);
    expect(inBlockTime(cfg, new Date('2026-01-02T06:59:00'))).toBe(true);
    expect(inBlockTime(cfg, new Date('2026-01-02T07:00:00'))).toBe(false);
    expect(inBlockTime(cfg, new Date('2026-01-02T12:00:00'))).toBe(false);
  });

  it('没设置时段或起止相同 = 不限时', () => {
    expect(inBlockTime(base, new Date('2026-01-01T03:00:00'))).toBe(false);
    expect(inBlockTime({ ...base, from: 9, to: 9 }, new Date('2026-01-01T09:30:00'))).toBe(false);
  });
});
