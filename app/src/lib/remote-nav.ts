/*
 * 方向键导航（电视遥控器式）——电脑网页版用。
 *
 * 安卓那边的 index.html / tv.html 用的是同名同逻辑的 `public/rc-nav.js`，
 * 两边行为必须一致，改一处记得改另一处。
 *
 * 为什么不用现成的 tabindex 顺序：影视站的页面是网格海报，Tab 顺序是 DOM 顺序，
 * 和眼睛看到的行列对不上，按右键会跳到看不见的地方。这里改成**几何导航**：
 * 往哪个方向按，就在那个半平面里找「主轴最近、次轴偏移最小」的可点元素，
 * 和电视遥控器的手感一致。
 */

export type NavDir = 'up' | 'down' | 'left' | 'right';

const ATTR = 'data-rc-focus';
const STYLE_ID = 'rc-nav-style';
const CSS =
  `[${ATTR}]{outline:3px solid #ff3b30 !important;outline-offset:2px !important;` +
  'border-radius:10px !important;box-shadow:0 0 0 6px rgba(255,59,48,.22) !important;' +
  'transition:outline-offset .12s ease}';

export interface NavOptions {
  /** 哪些算可聚焦 */
  selector?: string;
  /** 当前最上层容器：给了就只在它里面走，避免焦点跑到背后的页面上 */
  scope?: () => HTMLElement | null;
  /** 额外排除 */
  skip?: (el: HTMLElement) => boolean;
}

export interface NavHandle {
  move: (dir: NavDir) => boolean;
  ok: () => boolean;
  clear: () => void;
  current: () => HTMLElement | null;
  hasFocus: () => boolean;
}

const DEFAULT_SELECTOR =
  'a[href],button,[role="button"],[role="tab"],summary,select,input,textarea';

function injectStyle() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.appendChild(document.createTextNode(CSS));
  (document.head || document.documentElement).appendChild(s);
}

function visible(el: HTMLElement | null): boolean {
  if (!el || el.nodeType !== 1) return false;
  if ((el as HTMLButtonElement).disabled) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  const r = el.getBoundingClientRect();
  if (r.width < 6 || r.height < 6) return false;
  const cs = getComputedStyle(el);
  if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
  if (el.offsetParent === null && cs.position !== 'fixed') return false;
  const vh = window.innerHeight || 800;
  // 完全滚出屏幕的先不算；留一点余量给刚滚进来的
  if (r.bottom < -60 || r.top > vh + 120) return false;
  return true;
}

/** 找最后一个可见的对话框 / aria-modal 容器 */
export function autoScope(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const list = document.querySelectorAll<HTMLElement>('[role="dialog"],[aria-modal="true"]');
  for (let i = list.length - 1; i >= 0; i--) {
    if (visible(list[i])) return list[i];
  }
  return null;
}

function overlapGap(a: DOMRect, b: DOMRect, axis: 'x' | 'y'): number {
  if (axis === 'y') {
    const top = Math.max(a.top, b.top);
    const bot = Math.min(a.bottom, b.bottom);
    if (bot > top) return 0;
    return Math.min(Math.abs(b.top - a.bottom), Math.abs(a.top - b.bottom));
  }
  const l = Math.max(a.left, b.left);
  const r = Math.min(a.right, b.right);
  if (r > l) return 0;
  return Math.min(Math.abs(b.left - a.right), Math.abs(a.left - b.right));
}

function score(from: DOMRect, to: DOMRect, dir: NavDir): number {
  const ax = from.left + from.width / 2;
  const ay = from.top + from.height / 2;
  const bx = to.left + to.width / 2;
  const by = to.top + to.height / 2;
  const dx = bx - ax;
  const dy = by - ay;
  let main: number;
  let cross: number;
  if (dir === 'left') {
    if (dx > -10) return -1;
    main = -dx;
    // 左右只在「同一行」里走：竖直方向完全不挨着的（比如顶栏图标）不算，
    // 否则在一行的最后一个卡片上按右，焦点会窜到右上角去
    if (overlapGap(from, to, 'y') > 0) return -1;
    cross = 0;
  } else if (dir === 'right') {
    if (dx < 10) return -1;
    main = dx;
    if (overlapGap(from, to, 'y') > 0) return -1;
    cross = 0;
  } else if (dir === 'up') {
    if (dy > -10) return -1;
    main = -dy;
    cross = overlapGap(from, to, 'x');
  } else {
    if (dy < 10) return -1;
    main = dy;
    cross = overlapGap(from, to, 'x');
  }
  // 上下可以稍微斜着走（顶栏是全宽的），但别为了斜一点点跑很远
  return main + cross * (dir === 'up' || dir === 'down' ? 2 : 3);
}

export function installNav(cfg: NavOptions = {}): NavHandle {
  injectStyle();
  const selector = cfg.selector || DEFAULT_SELECTOR;
  let cur: HTMLElement | null = null;

  const scopeEl = (): HTMLElement | null => {
    try {
      const s = cfg.scope ? cfg.scope() : autoScope();
      return s || null;
    } catch {
      return null;
    }
  };

  const list = (): HTMLElement[] => {
    const host = scopeEl() || document.body || document.documentElement;
    const all = Array.from(host.querySelectorAll<HTMLElement>(selector));
    const out: HTMLElement[] = [];
    for (const el of all) {
      if (el === cur) continue;
      if (cfg.skip && cfg.skip(el)) continue;
      if (!visible(el)) continue;
      out.push(el);
    }
    return out;
  };

  const firstIn = (dir: NavDir): HTMLElement | null => {
    const cs = list();
    if (!cs.length) return null;
    if (dir === 'up') {
      cs.sort((x, y) => {
        const a = x.getBoundingClientRect();
        const b = y.getBoundingClientRect();
        return b.bottom - a.bottom || a.left - b.left;
      });
      return cs[0];
    }
    cs.sort((x, y) => {
      const a = x.getBoundingClientRect();
      const b = y.getBoundingClientRect();
      if (dir === 'down') return a.top - b.top || a.left - b.left;
      if (dir === 'left') return b.right - a.right || a.top - b.top;
      return a.left - b.left || a.top - b.top;
    });
    return cs[0];
  };

  const focusEl = (el: HTMLElement | null): boolean => {
    if (!el) return false;
    if (cur && cur !== el) cur.removeAttribute(ATTR);
    cur = el;
    try {
      el.setAttribute(ATTR, '1');
    } catch {
      /* ignore */
    }
    try {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    } catch {
      /* ignore */
    }
    try {
      el.focus({ preventScroll: true });
    } catch {
      try {
        el.focus();
      } catch {
        /* ignore */
      }
    }
    try {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    } catch {
      try {
        el.scrollIntoView(false);
      } catch {
        /* ignore */
      }
    }
    return true;
  };

  const move = (dir: NavDir): boolean => {
    if (dir !== 'up' && dir !== 'down' && dir !== 'left' && dir !== 'right') return false;
    if (cur && !visible(cur)) {
      cur.removeAttribute(ATTR);
      cur = null;
    }
    if (!cur) return focusEl(firstIn(dir));
    const from = cur.getBoundingClientRect();
    const cs = list();
    let best: HTMLElement | null = null;
    let bestScore = 1e12;
    for (const el of cs) {
      const sc = score(from, el.getBoundingClientRect(), dir);
      if (sc >= 0 && sc < bestScore) {
        bestScore = sc;
        best = el;
      }
    }
    if (!best) return false;
    return focusEl(best);
  };

  const ok = (): boolean => {
    if (!cur || !document.documentElement.contains(cur)) return false;
    try {
      cur.click();
      return true;
    } catch {
      return false;
    }
  };

  const clear = () => {
    if (cur) {
      try {
        cur.removeAttribute(ATTR);
      } catch {
        /* ignore */
      }
    }
    cur = null;
  };

  // 用户自己用鼠标 / 手指点了，就把遥控焦点让出来
  const onPointer = () => clear();
  document.addEventListener('mousedown', onPointer, true);
  document.addEventListener('touchstart', onPointer, true);

  return { move, ok, clear, current: () => cur, hasFocus: () => !!cur };
}

/**
 * 找当前最上层的浮层，供 `back` 逐层返回用：
 * 页面上最后一个可见的 `[data-rc-layer]` 或带关闭按钮的浮层。
 */
export function topLayer(): { el: HTMLElement; close: HTMLElement | null } | null {
  if (typeof document === 'undefined') return null;
  const list = document.querySelectorAll<HTMLElement>('[role="dialog"],[aria-modal="true"]');
  for (let i = list.length - 1; i >= 0; i--) {
    const el = list[i];
    if (!visible(el)) continue;
    const btn =
      el.querySelector<HTMLElement>('[data-rc-close]') ||
      el.querySelector<HTMLElement>('button[aria-label="关闭"],button[aria-label="Close"]');
    return { el, close: btn || null };
  }
  return null;
}
