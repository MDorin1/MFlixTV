/*
 * 方向键导航（电视遥控器式），电脑网页版和安卓页面共用同一份。
 *
 * 为什么不用现成的 tabindex 顺序：影视站的页面是网格海报，Tab 顺序是 DOM 顺序，
 * 和眼睛看到的行列对不上，按右键会跳到看不见的地方。这里改成**几何导航**：
 * 往哪个方向按，就在那个方向里找「正对着、离得近」的可点元素，和电视遥控器的手感一致。
 *
 * 用法：
 *   var nav = MFlixRCNav.install({
 *     selector: '.card,.ep,.nv,button,a[href]',   // 哪些算可聚焦
 *     scope: function () { return 当前最上层的浮层或 null; },
 *     skip: function (el) { return el.offsetParent === null; }
 *   });
 *   nav.move('down'); nav.ok(); nav.clear();
 *
 * 焦点用 [data-rc-focus] 标出来，样式由本文件注入。
 *
 * —— 三条手感规则（按实测重写）——
 * 1) 正对着的优先：候选元素的横/纵向区间要盖住源元素的中心线，才算「直上直下 / 正左右」，
 *    不盖住的往后排一格。只按距离算分的话，格子一错位就会斜着跳。
 * 2) 横排里不串排：左右移动只在同一「排容器」里走，不靠「纵向有没有重叠」判断——
 *    顶栏恰好在同一高度时，那个判断会把焦点吸到顶栏去。
 * 3) 看得见和看不见的都能到：不再把滚出视口的元素过滤掉，只给一点距离惩罚。
 *    带 max-height + overflow 的剧集列表里，最后几集以前永远走不到。
 */
(function (root) {
  'use strict';

  var ATTR = 'data-rc-focus';
  var CSS = [
    '[', ATTR, ']{outline:3px solid #ff3b30 !important;outline-offset:2px !important;',
    'border-radius:10px !important;box-shadow:0 0 0 6px rgba(255,59,48,.22) !important;',
    'transition:outline-offset .12s ease}'
  ].join('');

  var DEFAULTS = {
    selector: 'a[href],button,[role="button"],[role="tab"],summary,select,input,textarea',
    // 没有指定 scope 时：优先在最上层的对话框里走，避免焦点跑到背后的页面上
    scope: null,
    skip: null
  };

  function injectStyle() {
    if (document.getElementById('rc-nav-style')) return;
    var s = document.createElement('style');
    s.id = 'rc-nav-style';
    s.appendChild(document.createTextNode(CSS));
    (document.head || document.documentElement).appendChild(s);
  }

  function visible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.disabled) return false;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
    if (el.offsetParent === null) {
      // position:fixed 的元素 offsetParent 也是 null，单独放行
      var cs0 = getComputedStyle(el);
      if (cs0.position !== 'fixed') return false;
      if (cs0.display === 'none' || cs0.visibility === 'hidden') return false;
    }
    var r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) return false;
    var cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
    // 注意：这里不再因为「滚出视口」就判死，滚动交给 focusEl 的 scrollIntoView
    return true;
  }

  function vw() { return window.innerWidth || 1200; }
  function vh() { return window.innerHeight || 800; }

  /** 元素完全在视口外时给出「有多远」，让看得见的优先，但看得见的没出路时也能走 */
  function offPenalty(r) {
    var d = 0, VW = vw(), VH = vh();
    if (r.bottom <= 0) d += -r.bottom;
    else if (r.top >= VH) d += r.top - VH;
    if (r.right <= 0) d += -r.right;
    else if (r.left >= VW) d += r.left - VW;
    return Math.min(1200, d) * 0.35;
  }

  function inView(r) {
    return r.bottom > 0 && r.top < vh() && r.right > 0 && r.left < vw();
  }

  /** 两个区间之间的间隙（重叠时为 0） */
  function gapOn(a1, a2, b1, b2) {
    if (b2 < a1) return a1 - b2;
    if (b1 > a2) return b1 - a2;
    return 0;
  }

  function autoScope() {
    // 找最后一个可见的对话框 / aria-modal 容器
    var list = document.querySelectorAll('[role="dialog"],[aria-modal="true"]');
    for (var i = list.length - 1; i >= 0; i--) {
      if (visible(list[i])) return list[i];
    }
    return null;
  }

  /** 内层元素有 70% 以上面积落在外层里，就当是同一个可点区域 */
  function similarRect(outer, inner) {
    var a = outer.getBoundingClientRect(), b = inner.getBoundingClientRect();
    var oa = a.width * a.height;
    if (oa <= 0) return false;
    var w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    var h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (w <= 0 || h <= 0) return false;
    return (w * h) / oa >= 0.7;
  }

  function make(cfg) {
    var opts = {};
    for (var k in DEFAULTS) if (DEFAULTS.hasOwnProperty(k)) opts[k] = cfg && cfg[k] != null ? cfg[k] : DEFAULTS[k];
    if (cfg && cfg.selector) opts.selector = cfg.selector;
    if (cfg && cfg.scope) opts.scope = cfg.scope;
    if (cfg && cfg.skip) opts.skip = cfg.skip;

    var S = { cur: null };

    function scopeEl() {
      try {
        var s = opts.scope ? opts.scope() : autoScope();
        return s || null;
      } catch (e) { return null; }
    }

    /**
     * 去掉「被外层可点元素整块包住」的内层元素（海报 <a> 里再套 div[role=button] 这类）。
     * 不去掉的话同一个位置有两个候选，焦点在两者之间来回跳，按「下」看着像卡住不动。
     */
    function dropNested(out) {
      if (out.length < 2) return out;
      var useSet = typeof Set === 'function';
      var pool = useSet ? new Set(out) : out;
      var keep = [];
      for (var i = 0; i < out.length; i++) {
        var el = out[i], covered = false;
        var p = el.parentElement, d = 0;
        while (p && p !== document.body && d < 10) {
          var isCand = useSet ? pool.has(p) : out.indexOf(p) >= 0;
          if (isCand && similarRect(p, el)) { covered = true; break; }
          p = p.parentElement; d++;
        }
        if (!covered) keep.push(el);
      }
      return keep.length ? keep : out;
    }

    function list() {
      var scope = scopeEl();
      var host = scope || document.body || document.documentElement;
      var all = host.querySelectorAll(opts.selector);
      var out = [];
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el === S.cur) continue;
        if (opts.skip && opts.skip(el)) continue;
        if (!visible(el)) continue;
        out.push(el);
      }
      return dropNested(out);
    }

    /** 「这一排」的容器：往上找第一个除了自己还装着别的候选的祖先，左右移动只在同一排里走。
        注意不能要求「容器里第一个候选不是自己」——那会让一排里最左边那个直接跳级到 body，
        于是「自己在一排里最左」这件事就丢了，按左会斜着甩到别的排。 */
    function rowHost(el) {
      var p = el.parentElement, d = 0;
      while (p && p !== document.body && d < 8) {
        var all = null;
        try { all = p.querySelectorAll(opts.selector); } catch (e) { all = null; }
        if (all) {
          for (var i = 0; i < all.length; i++) if (all[i] !== el) return p;
        }
        p = p.parentElement; d++;
      }
      return document.body;
    }

    /**
     * 给一个候选打分：null 表示不在这个方向上。
     * tier 0 = 正对着（中心线被盖住），1 = 差半格，2 = 斜的。
     */
    function evaluate(a, b, dir) {
      // 同一个位置上套着的两层算同一个元素，否则两个候选坐标几乎一样，焦点会来回跳
      if (Math.abs(a.left - b.left) < 6 && Math.abs(a.top - b.top) < 6 &&
        Math.abs(a.width - b.width) < 8 && Math.abs(a.height - b.height) < 8) return null;
      var horiz = (dir === 'left' || dir === 'right');
      /* 方向判定用「边到边」：候选必须真的在源元素的这一侧（留 8px 容差给错位排列）。
         只用中心点距离的话，一个很宽的元素按右键会挑到「横向偏右、其实在它上面」的顶栏图标。 */
      var mainEdge;
      if (dir === 'right') mainEdge = b.left - a.right;
      else if (dir === 'left') mainEdge = a.left - b.right;
      else if (dir === 'down') mainEdge = b.top - a.bottom;
      else mainEdge = a.top - b.bottom;
      if (mainEdge < -8) return null;
      if (mainEdge < 0) mainEdge = 0;
      var acx = a.left + a.width / 2, acy = a.top + a.height / 2;
      var crossGap, cover, crossSize;
      if (horiz) {
        crossGap = gapOn(a.top, a.bottom, b.top, b.bottom);
        cover = b.top <= acy && b.bottom >= acy;
        crossSize = a.height;
      } else {
        crossGap = gapOn(a.left, a.right, b.left, b.right);
        cover = b.left <= acx && b.right >= acx;
        crossSize = a.width;
      }
      var tier = cover ? 0 : (crossGap <= Math.max(20, crossSize * 0.5) ? 1 : 2);
      var w = tier === 0 ? 0.5 : tier === 1 ? 1.6 : 4;
      return { tier: tier, score: mainEdge + crossGap * w };
    }

    /** 没有焦点时往这个方向的第一格：优先视口内、离这个方向最近的那个 */
    function firstIn(dir) {
      var cs = list();
      if (!cs.length) return null;
      var scored = [];
      for (var i = 0; i < cs.length; i++) scored.push({ el: cs[i], r: cs[i].getBoundingClientRect() });
      scored.sort(function (x, y) {
        var ox = inView(x.r) ? 0 : 1, oy = inView(y.r) ? 0 : 1;
        if (ox !== oy) return ox - oy;
        if (dir === 'up') return y.r.bottom - x.r.bottom || x.r.left - y.r.left;
        if (dir === 'down') return x.r.top - y.r.top || x.r.left - y.r.left;
        if (dir === 'left') return y.r.right - x.r.right || x.r.top - y.r.top;
        return x.r.left - y.r.left || x.r.top - y.r.top;
      });
      return scored[0].el;
    }

    function focusEl(el) {
      if (!el) return false;
      if (S.cur && S.cur !== el) S.cur.removeAttribute(ATTR);
      S.cur = el;
      try { el.setAttribute(ATTR, '1'); } catch (e) {}
      try {
        if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
      } catch (e2) {}
      try { el.focus({ preventScroll: true }); } catch (e3) {
        try { el.focus(); } catch (e4) {}
      }
      try {
        // 用「立刻到位」而不是平滑滚动：遥控器连按时，平滑动画会让下一格的坐标还在变，
        // 几何导航算出来就会跳过一格（按两次右键窜到第四张卡）。
        el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
      } catch (e5) {
        try { el.scrollIntoView(false); } catch (e6) {}
      }
      return true;
    }

    function move(dir) {
      if (dir !== 'up' && dir !== 'down' && dir !== 'left' && dir !== 'right') return false;
      if (S.cur && !visible(S.cur)) { try { S.cur.removeAttribute(ATTR); } catch (e) {} S.cur = null; }
      if (!S.cur) return focusEl(firstIn(dir));
      var from = S.cur.getBoundingClientRect();
      var horiz = (dir === 'left' || dir === 'right');
      var homeRow = horiz ? rowHost(S.cur) : null;
      var cs = list();
      var best = null, bestTier = 9, bestScore = 1e12;
      for (var i = 0; i < cs.length; i++) {
        var el = cs[i];
        var to = el.getBoundingClientRect();
        var ev = evaluate(from, to, dir);
        if (!ev) continue;
        var tier = ev.tier;
        // 左右只在同一排里走；同一排的优先，别的排靠后（有出路时不会被选）。
        // 不同排、而且垂直方向差得很远的（比如从一排的最左端斜着甩到页面中间的按钮），宁可不动。
        if (horiz && rowHost(el) !== homeRow) {
          if (gapOn(from.top, from.bottom, to.top, to.bottom) > Math.max(24, from.height * 0.6)) continue;
          tier += 3;
        }
        var sc = ev.score + offPenalty(to);
        if (tier < bestTier || (tier === bestTier && sc < bestScore)) {
          bestTier = tier; bestScore = sc; best = el;
        }
      }
      if (best) return focusEl(best);
      /* 这个方向上确实没有东西（比如已经在最后一行）：保持不动才是遥控器该有的反应。
         按 DOM 顺序硬挪一格会让「下」沿着页尾那一排横着跳，看着像乱走。 */
      return false;
    }

    function ok() {
      if (!S.cur || !document.documentElement.contains(S.cur)) return false;
      try {
        if (typeof S.cur.click === 'function') { S.cur.click(); return true; }
      } catch (e) {}
      return false;
    }

    function clear() {
      if (S.cur) { try { S.cur.removeAttribute(ATTR); } catch (e) {} }
      S.cur = null;
    }

    function current() { return S.cur; }

    // 用户自己用鼠标 / 手指点了，就把遥控焦点让出来
    var onPointer = function () { clear(); };
    document.addEventListener('mousedown', onPointer, true);
    document.addEventListener('touchstart', onPointer, true);

    return { move: move, ok: ok, clear: clear, current: current, hasFocus: function () { return !!S.cur; } };
  }

  function install(cfg) {
    injectStyle();
    return make(cfg || {});
  }

  root.MFlixRCNav = { install: install };
})(typeof window !== 'undefined' ? window : this);
