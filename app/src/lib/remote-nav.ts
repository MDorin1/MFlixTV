/*
 * 方向键导航（电视遥控器式）——电脑网页版用。
 *
 * 安卓那边的 index.html 用的是同名同逻辑的 `rc-nav.js`，两边行为必须一致，改一处记得改另一处。
 *
 * 为什么不用现成的 tabindex 顺序：影视站的页面是网格海报，Tab 顺序是 DOM 顺序，
 * 和眼睛看到的行列对不上，按右键会跳到看不见的地方。这里改成**几何导航**：
 * 往哪个方向按，就在那个方向里找「正对着、离得近」的可点元素，和电视遥控器的手感一致。
 *
 * —— 三条手感规则（按实测重写过）——
 * 1) **正对着的优先**：候选元素的横/纵向区间要盖住源元素的中心线，才算「直上直下 / 正左右」；
 *    不盖住的往后排一格。以前只按「主轴距离 + 次轴偏移 ×2」算分，格子一错位就会斜着跳。
 * 2) **横排里不串排**：左右移动只在同一「排容器」里走。以前靠「纵向有没有重叠」判断，
 *    顶栏恰好在同一高度就会把焦点吸走（页面向下滚、列表贴着顶栏时必现）。
 * 3) **看得见的和看不见的都能到**：以前把「滚出视口」的元素直接过滤掉，于是
 *    带 `max-h + overflow-y` 的剧集列表里，最后几集永远走不到。现在一律算候选，
 *    只给「不在视口里」的加一点距离惩罚，到了就 scrollIntoView 拉进来。
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

const vpW = () => window.innerWidth || 1200;
const vpH = () => window.innerHeight || 800;

function visible(el: HTMLElement | null): boolean {
  if (!el || el.nodeType !== 1) return false;
  if ((el as HTMLButtonElement).disabled) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  const r = el.getBoundingClientRect();
  if (r.width < 6 || r.height < 6) return false;
  const cs = getComputedStyle(el);
  if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
  if (el.offsetParent === null && cs.position !== 'fixed') return false;
  // 注意：这里**不再**因为「滚出视口」就判死。带 overflow 的内层列表、横向长条里的卡片
  // 都要能被走到，滚动交给 focusEl 的 scrollIntoView。
  return true;
}

function inView(r: DOMRect): boolean {
  return r.bottom > 0 && r.top < vpH() && r.right > 0 && r.left < vpW();
}

/** 元素完全在视口外时给出「有多远」，用来看得见的优先，但看得见的没有出路时也能走 */
function offPenalty(r: DOMRect): number {
  let d = 0;
  if (r.bottom <= 0) d += -r.bottom;
  else if (r.top >= vpH()) d += r.top - vpH();
  if (r.right <= 0) d += -r.right;
  else if (r.left >= vpW()) d += r.left - vpW();
  return Math.min(1200, d) * 0.35;
}

/** 两个区间之间的间隙（重叠时为 0） */
function gapOn(a1: number, a2: number, b1: number, b2: number): number {
  if (b2 < a1) return a1 - b2;
  if (b1 > a2) return b1 - a2;
  return 0;
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

interface Ev {
  tier: number;
  score: number;
}

/**
 * 给一个候选打分：null 表示不在这个方向上。
 * tier 0 = 正对着（中心线被盖住），1 = 差半格，2 = 斜的。
 */
function evaluate(a: DOMRect, b: DOMRect, dir: NavDir): Ev | null {
  // 同一个位置上套着的两层（海报 <a> 套 div[role=button]）算同一个元素，
  // 否则两个候选的坐标几乎一样，焦点在它们之间来回跳
  if (
    Math.abs(a.left - b.left) < 6 &&
    Math.abs(a.top - b.top) < 6 &&
    Math.abs(a.width - b.width) < 8 &&
    Math.abs(a.height - b.height) < 8
  ) {
    return null;
  }
  const horiz = dir === 'left' || dir === 'right';
  /* 方向判定用「边到边」：候选必须真的在源元素的这一侧（留 8px 容差给错位排列）。
     只用中心点距离的话，一个很宽的元素按右键会挑到「横向偏右、其实在它上面」的顶栏图标。 */
  let mainEdge: number;
  if (dir === 'right') mainEdge = b.left - a.right;
  else if (dir === 'left') mainEdge = a.left - b.right;
  else if (dir === 'down') mainEdge = b.top - a.bottom;
  else mainEdge = a.top - b.bottom;
  if (mainEdge < -8) return null;
  if (mainEdge < 0) mainEdge = 0;
  const acx = a.left + a.width / 2;
  const acy = a.top + a.height / 2;
  let crossGap: number;
  let cover: boolean;
  let crossSize: number;
  if (horiz) {
    crossGap = gapOn(a.top, a.bottom, b.top, b.bottom);
    cover = b.top <= acy && b.bottom >= acy;
    crossSize = a.height;
  } else {
    crossGap = gapOn(a.left, a.right, b.left, b.right);
    cover = b.left <= acx && b.right >= acx;
    crossSize = a.width;
  }
  const tier = cover ? 0 : crossGap <= Math.max(20, crossSize * 0.5) ? 1 : 2;
  const w = tier === 0 ? 0.5 : tier === 1 ? 1.6 : 4;
  return { tier, score: mainEdge + crossGap * w };
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
    return dropNested(out);
  };

  /**
   * 去掉「被外层可点元素整块包住」的内层元素（海报 <a> 里再套一个 div[role=button] 这类）。
   * 不去掉的话，同一个位置会有两个候选，焦点会在两者之间来回跳，按「下」看着像卡住不动。
   */
  const dropNested = (out: HTMLElement[]): HTMLElement[] => {
    if (out.length < 2) return out;
    const pool = new Set(out);
    const keep: HTMLElement[] = [];
    for (const el of out) {
      let covered = false;
      let p = el.parentElement;
      let d = 0;
      while (p && p !== document.body && d < 10) {
        if (pool.has(p) && similarRect(p, el)) {
          covered = true;
          break;
        }
        p = p.parentElement;
        d += 1;
      }
      if (!covered) keep.push(el);
    }
    return keep.length ? keep : out;
  };

  /** 内层元素有 70% 以上面积落在外层里，就当是同一个可点区域 */
  function similarRect(outer: HTMLElement, inner: HTMLElement): boolean {
    const a = outer.getBoundingClientRect();
    const b = inner.getBoundingClientRect();
    const oa = a.width * a.height;
    if (oa <= 0) return false;
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (w <= 0 || h <= 0) return false;
    return (w * h) / oa >= 0.7;
  }

  /**
   * 「这一排」的容器：往上找一个除了自己还装着别的候选的祖先。
   * 左右移动时只在同一排里走，避免从日历/卡片串到顶栏或别的排。
   * 不能要求「容器里第一个候选不是自己」——那会让一排最左边那个直接跳级到 body。
   */
  const rowHost = (el: HTMLElement): HTMLElement => {
    let p = el.parentElement;
    let d = 0;
    while (p && p !== document.body && d < 8) {
      let all: HTMLElement[] | null = null;
      try {
        all = Array.from(p.querySelectorAll<HTMLElement>(selector));
      } catch {
        all = null;
      }
      if (all) {
        for (const one of all) if (one !== el) return p;
      }
      p = p.parentElement;
      d += 1;
    }
    return document.body;
  };

  /** 没有焦点时往这个方向的第一格：优先视口内、离这个方向最近的那个 */
  const firstIn = (dir: NavDir): HTMLElement | null => {
    const cs = list();
    if (!cs.length) return null;
    const scored = cs.map((el) => ({ el, r: el.getBoundingClientRect() }));
    scored.sort((x, y) => {
      const ox = inView(x.r) ? 0 : 1;
      const oy = inView(y.r) ? 0 : 1;
      if (ox !== oy) return ox - oy;
      if (dir === 'up') return y.r.bottom - x.r.bottom || x.r.left - y.r.left;
      if (dir === 'down') return x.r.top - y.r.top || x.r.left - y.r.left;
      if (dir === 'left') return y.r.right - x.r.right || x.r.top - y.r.top;
      return x.r.left - y.r.left || x.r.top - y.r.top;
    });
    return scored[0].el;
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
      // 用「立刻到位」而不是平滑滚动：遥控器连按时平滑动画会让下一格的坐标还在变，
      // 几何导航就会跳过一格（按两次右键窜到第四张卡）
      el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
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
      try {
        cur.removeAttribute(ATTR);
      } catch {
        /* ignore */
      }
      cur = null;
    }
    if (!cur) return focusEl(firstIn(dir));
    const from = cur.getBoundingClientRect();
    const horiz = dir === 'left' || dir === 'right';
    const homeRow = horiz ? rowHost(cur) : null;
    const cs = list();
    let best: HTMLElement | null = null;
    let bestTier = 9;
    let bestScore = 1e12;
    for (const el of cs) {
      const to = el.getBoundingClientRect();
      const ev = evaluate(from, to, dir);
      if (!ev) continue;
      let tier = ev.tier;
      /* 左右只在同一排里走；同一排的优先，别的排靠后（有出路时不会被选）。
         不同排、而且垂直方向差得很远（从左上角甩到页面中间那种），宁可不动。 */
      if (horiz && rowHost(el) !== homeRow) {
        if (gapOn(from.top, from.bottom, to.top, to.bottom) > Math.max(24, from.height * 0.6)) continue;
        tier += 3;
      }
      const sc = ev.score + offPenalty(to);
      if (tier < bestTier || (tier === bestTier && sc < bestScore)) {
        bestTier = tier;
        bestScore = sc;
        best = el;
      }
    }
    if (best) return focusEl(best);
    /* 这个方向上确实没有东西（比如已经在最后一行）：保持不动才是遥控器该有的反应。
       以前这里按 DOM 顺序硬挪一格，结果按「下」沿着页尾那一排横着跳，看着像乱走。 */
    return false;
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
