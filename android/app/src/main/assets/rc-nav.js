/*
 * 方向键导航（电视遥控器式），电脑网页版和安卓页面共用同一份。
 *
 * 为什么不用现成的 tabindex 顺序：影视站的页面是网格海报，Tab 顺序是 DOM 顺序，
 * 和眼睛看到的行列对不上，按右键会跳到看不见的地方。这里改成**几何导航**：
 * 往哪个方向按，就在那个半平面里找「主轴最近、次轴偏移最小」的可点元素，
 * 和电视遥控器的手感一致。
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
    if (r.bottom < 0 || r.top > (window.innerHeight || 800)) {
      // 完全滚出屏幕的先不算；留一点余量给刚滚进来的
      if (r.bottom < -60 || r.top > (window.innerHeight || 800) + 120) return false;
    }
    return true;
  }

  function autoScope() {
    // 找最后一个可见的对话框 / aria-modal 容器
    var list = document.querySelectorAll('[role="dialog"],[aria-modal="true"]');
    for (var i = list.length - 1; i >= 0; i--) {
      if (visible(list[i])) return list[i];
    }
    return null;
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
      return out;
    }

    function rectOf(el) { return el.getBoundingClientRect(); }

    function score(from, to, dir) {
      var a = rectOf(from), b = rectOf(to);
      if (!a || !b) return -1;
      var ax = a.left + a.width / 2, ay = a.top + a.height / 2;
      var bx = b.left + b.width / 2, by = b.top + b.height / 2;
      var dx = bx - ax, dy = by - ay;
      var main, cross;
      if (dir === 'left') {
        if (dx > -10) return -1;
        main = -dx;
        // 左右只在「同一行」里走：竖直方向完全不挨着的（比如顶栏图标）不算，
        // 否则在一行的最后一个卡片上按右，焦点会窜到右上角去
        if (overlapGap(a, b, 'y') > 0) return -1;
        cross = 0;
      } else if (dir === 'right') {
        if (dx < 10) return -1;
        main = dx;
        if (overlapGap(a, b, 'y') > 0) return -1;
        cross = 0;
      } else if (dir === 'up') {
        if (dy > -10) return -1;
        main = -dy;
        cross = overlapGap(a, b, 'x');
      } else {
        if (dy < 10) return -1;
        main = dy;
        cross = overlapGap(a, b, 'x');
      }
      // 上下可以稍微斜着走（顶栏是全宽的），但别为了斜一点点跑很远
      return main + cross * (dir === 'up' || dir === 'down' ? 2 : 3);
    }

    /** 同一行/列的重叠部分为 0 时返回偏移量，重叠时返回 0 —— 让「正对着」优先 */
    function overlapGap(a, b, axis) {
      if (axis === 'y') {
        var top = Math.max(a.top, b.top), bot = Math.min(a.bottom, b.bottom);
        if (bot > top) return 0;
        return Math.min(Math.abs(b.top - a.bottom), Math.abs(a.top - b.bottom));
      }
      var l = Math.max(a.left, b.left), r = Math.min(a.right, b.right);
      if (r > l) return 0;
      return Math.min(Math.abs(b.left - a.right), Math.abs(a.left - b.right));
    }

    function firstIn(dir) {
      var cs = list();
      if (!cs.length) return null;
      if (dir === 'up') {
        // 最下面那一行最靠中间的那个
        cs.sort(function (x, y) {
          var a = rectOf(x), b = rectOf(y);
          return b.bottom - a.bottom || a.left - b.left;
        });
        return cs[0];
      }
      cs.sort(function (x, y) {
        var a = rectOf(x), b = rectOf(y);
        if (dir === 'down') return a.top - b.top || a.left - b.left;
        if (dir === 'left') return b.right - a.right || a.top - b.top;
        return a.left - b.left || a.top - b.top;
      });
      return cs[0];
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
        el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      } catch (e5) {
        try { el.scrollIntoView(false); } catch (e6) {}
      }
      return true;
    }

    function move(dir) {
      if (dir !== 'up' && dir !== 'down' && dir !== 'left' && dir !== 'right') return false;
      if (S.cur && !visible(S.cur)) { S.cur.removeAttribute(ATTR); S.cur = null; }
      if (!S.cur) return focusEl(firstIn(dir));
      var cs = list(), best = null, bestScore = 1e12;
      for (var i = 0; i < cs.length; i++) {
        var sc = score(S.cur, cs[i], dir);
        if (sc >= 0 && sc < bestScore) { bestScore = sc; best = cs[i]; }
      }
      if (!best) return false;
      return focusEl(best);
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
