import type { NavDir } from '@/lib/remote-nav';

/**
 * 播放器里方向键归谁 —— 纯函数，好测。
 *
 * 审核单的原话：「播放器内 ←/→ 固定 ±10 秒，上下移动只在控制栏唤起时选按钮」。
 * 以前方向键一律先走焦点导航，而 ArtPlayer 的按钮在控制条收起时依然满足 `visible()`
 * （父层 `.art-bottom` 的 opacity:0 不算元素自己不可见），于是同一台电视上
 * 「按右键」有时跳进度、有时挪按钮 —— 手感是随机的。
 *
 * 现在拆成四种归属：
 * - `seek`   点播播放器在场时的 ←/→：永远交给播放器快退快进，谁也别抢；
 * - `bar`    点播播放器在场、且控制条亮着时的 ↑/↓：在控制条按钮之间挪焦点；
 * - `volume` 点播播放器在场、控制条收着时的 ↑/↓：调音量（看电视时的常态）；
 * - `page`   没有点播播放器（首页 / 详情页 / 直播）：照旧走页面焦点导航。
 */
export type ArrowRoute = 'seek' | 'bar' | 'volume' | 'page';

export function arrowRoute(opts: {
  /** 页面上有没有点播播放器（`[data-mfl-player]`） */
  inPlayer: boolean;
  /** 播放器控制条是否亮着（`.art-control-show`） */
  barShown: boolean;
  dir: NavDir;
}): ArrowRoute {
  const { inPlayer, barShown, dir } = opts;
  if (!inPlayer) return 'page';
  if (dir === 'left' || dir === 'right') return 'seek';
  // 上下：控制条亮着才有按钮可挑，收着就是音量
  return barShown ? 'bar' : 'volume';
}
