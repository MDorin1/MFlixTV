import { describe, expect, it } from 'vitest';
import { arrowRoute } from '@/lib/player-keys';

/**
 * 播放器里的方向键归属（审核单第 2 条）。
 *
 * 这条规则之前只有「先试焦点导航、失败再交给播放器」的隐式顺序，
 * 而焦点导航在播放器里几乎总能「成功」（ArtPlayer 的按钮即使控制条收起也算可见），
 * 于是 ←/→ 有时跳进度、有时挪按钮。现在把它写成纯函数钉住。
 */
describe('箭头归属 · 播放器内', () => {
  it('← / → 永远是进度，控制条亮着也不例外', () => {
    for (const barShown of [false, true]) {
      expect(arrowRoute({ inPlayer: true, barShown, dir: 'left' })).toBe('seek');
      expect(arrowRoute({ inPlayer: true, barShown, dir: 'right' })).toBe('seek');
    }
  });

  it('↑ / ↓ 只在控制条亮着时挑按钮', () => {
    expect(arrowRoute({ inPlayer: true, barShown: true, dir: 'up' })).toBe('bar');
    expect(arrowRoute({ inPlayer: true, barShown: true, dir: 'down' })).toBe('bar');
  });

  it('控制条收着时 ↑ / ↓ 是音量（看电视的常态）', () => {
    expect(arrowRoute({ inPlayer: true, barShown: false, dir: 'up' })).toBe('volume');
    expect(arrowRoute({ inPlayer: true, barShown: false, dir: 'down' })).toBe('volume');
  });
});

describe('箭头归属 · 不在播放器里', () => {
  it('首页 / 详情页 / 直播：四个方向都走页面焦点导航', () => {
    const dirs = ['up', 'down', 'left', 'right'] as const;
    for (const dir of dirs) {
      expect(arrowRoute({ inPlayer: false, barShown: false, dir })).toBe('page');
      // 页面上有别的控件带 art-control-show（比如复用的播放器壳）也不影响：没有点播播放器就走页面
      expect(arrowRoute({ inPlayer: false, barShown: true, dir })).toBe('page');
    }
  });
});
