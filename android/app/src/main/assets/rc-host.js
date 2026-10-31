/*
 * 「扫一扫当遥控器」——被控端（index.html / tv.html 共用一份）。
 *
 * 做的是：
 *   右上角的遥控按钮 → 向服务端领一个 6 位 token → 把 http://本机IP:端口/rc?t=TOKEN
 *   画成二维码 → 另一台手机扫码打开 /rc 页就成了遥控器，只控制「点按钮的那一个页面」。
 *   被控端每秒来取一次指令并当场执行，同时把片名 / 进度 / 播放状态报上去，
 *   遥控器那边就能显示「在放什么、放到哪」。
 *
 * 为什么单独成文件：手机版（index.html）和电视版（tv.html）要的是同一套逻辑，
 * 复制两份以后必然改一处漏一处；页面只留一句 MFlixRC.mount({...})。
 *
 * 用法：
 *   MFlixRC.mount({
 *     btn: document.getElementById('rcBtn'),
 *     title: function () { ... },   // 遥控器上显示的片名
 *     sub:   function () { ... },   // 小字，例如「第 3 集」
 *     page:  function () { return 'home'; },
 *     onCmd: function (cmd, arg) {  // 返回 true = 这个页面自己处理了
 *       if (cmd === 'next') { nextEp(); return true; }
 *       return false;
 *     }
 *   });
 *
 * 指令（和 /rc 页面、电脑端 RemoteHost 完全一致）：
 *   toggle play pause seekb seekf seekto volup voldown mute fullscreen
 *   prev next up down left right ok back home
 */
(function (root) {
  'use strict';

  var CSS = [
    '#rcq{position:fixed;inset:0;z-index:2147483000;display:none;align-items:center;justify-content:center;',
    'padding:18px;background:rgba(0,0,0,.76);-webkit-backdrop-filter:blur(7px);backdrop-filter:blur(7px)}',
    '#rcq.on{display:flex}',
    '.rcq-box{width:100%;max-width:334px;max-height:92vh;overflow:auto;background:#141416;',
    'border:1px solid rgba(255,255,255,.09);border-radius:18px;padding:18px 18px 14px;text-align:center;',
    'box-shadow:0 26px 64px rgba(0,0,0,.65);font-family:inherit;color:#fff}',
    '.rcq-box h3{margin:0 0 6px;font-size:15px;font-weight:600;line-height:1.4}',
    '.rcq-box p{margin:0 0 14px;font-size:11.5px;line-height:1.65;color:rgba(255,255,255,.5)}',
    '.rcq-box p b{color:rgba(255,255,255,.86);font-weight:600}',
    '.rcq-code{width:212px;height:212px;margin:0 auto;background:#fff;border-radius:12px;padding:9px}',
    '.rcq-code svg,.rcq-code img{display:block;width:212px;height:212px}',
    '.rcq-code .wait{display:flex;align-items:center;justify-content:center;height:100%;',
    'font-size:12px;color:#666}',
    '.rcq-url{margin:12px 0 0;font-size:10.5px;line-height:1.5;color:rgba(255,255,255,.42);',
    'word-break:break-all;font-family:ui-monospace,Menlo,Consolas,monospace}',
    '.rcq-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:12px;',
    'font-size:11px;color:rgba(255,255,255,.5)}',
    '.rcq-foot span.on{color:#34d399}',
    '.rcq-foot span.off{color:#f87171}',
    '.rcq-foot button{border:0;background:none;color:rgba(255,255,255,.6);font:inherit;font-size:11px;',
    'padding:4px 2px;cursor:pointer}',
    '.rcq-ops{display:flex;gap:8px;margin-top:12px}',
    '.rcq-ops button{flex:1;height:40px;border:0;border-radius:10px;background:rgba(255,255,255,.09);',
    'color:#fff;font:inherit;font-size:13px;cursor:pointer}',
    '.rcq-ops button.primary{background:#fff;color:#0a0a0d;font-weight:600}',
    '#rcq.on button:focus-visible{outline:2px solid #fff;outline-offset:2px}'
  ].join('');

  /** 没有 hooks 时也认得的「主视频」：优先在放的那个，其次时长最长的那个 */
  function pickVideo() {
    var v = document.getElementById('video');
    if (v && v.tagName === 'VIDEO') return v;
    var all = document.querySelectorAll('video');
    var playing = null, best = null;
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      if (!playing && !e.paused && e.currentTime > 0) playing = e;
      if (!best || (e.duration || 0) > (best.duration || 0)) best = e;
    }
    return playing || best || null;
  }

  function fireKey(key, code, keyCode, extra) {
    var ev;
    try {
      ev = new KeyboardEvent('keydown', {
        key: key, code: code, bubbles: true, cancelable: true, altKey: !!(extra && extra.altKey)
      });
      Object.defineProperty(ev, 'keyCode', { get: function () { return keyCode; } });
      Object.defineProperty(ev, 'which', { get: function () { return keyCode; } });
    } catch (e) { return; }
    try { (document.activeElement || document.body).dispatchEvent(ev); } catch (e2) {}
    try { document.dispatchEvent(ev); } catch (e3) {}
  }

  function deviceName() {
    var ua = navigator.userAgent || '';
    var os = /Windows/i.test(ua) ? 'Windows'
      : /Macintosh|Mac OS/i.test(ua) ? 'Mac'
        : /Android/i.test(ua) ? 'Android'
          : /iPhone|iPad|iPod/i.test(ua) ? 'iOS'
            : /Linux/i.test(ua) ? 'Linux' : '设备';
    var br = /Edg\//i.test(ua) ? 'Edge'
      : /OPR\//i.test(ua) ? 'Opera'
        : /Chrome\//i.test(ua) ? 'Chrome'
          : /Safari\//i.test(ua) ? 'Safari'
            : /Firefox\//i.test(ua) ? 'Firefox' : '浏览器';
    return br + ' · ' + os;
  }

  var S = {
    hooks: {},
    el: null,
    btn: null,
    token: '',
    since: 0,
    peers: 0,
    open: false,
    busy: false,
    alive: true,
    timer: 0,
    probe: 0,
    stateAt: 0,
    url: ''
  };

  function byId(id) { return document.getElementById(id); }

  function build() {
    if (S.el) return S.el;
    var style = document.createElement('style');
    style.id = 'rcq-style';
    style.appendChild(document.createTextNode(CSS));
    (document.head || document.documentElement).appendChild(style);

    var box = document.createElement('div');
    box.id = 'rcq';
    box.innerHTML =
      '<div class="rcq-box" role="dialog" aria-modal="true" aria-label="扫码当遥控器">' +
      '<h3>拿另一台手机扫这个码</h3>' +
      '<p>扫完它就是个遥控器，只控制<b>你现在打开的这个页面</b>，' +
      '不影响同一网络下的电视和别人的手机。</p>' +
      '<div class="rcq-code" id="rcqCode"><div class="wait">正在生成…</div></div>' +
      '<div class="rcq-url" id="rcqUrl"></div>' +
      '<div class="rcq-foot"><span id="rcqStat">等待扫码</span>' +
      '<button type="button" id="rcqNew">换一个码</button></div>' +
      '<div class="rcq-ops"><button type="button" class="primary" id="rcqOk">知道了</button></div>' +
      '</div>';
    document.body.appendChild(box);

    box.addEventListener('click', function (e) { if (e.target === box) close(); });
    byId('rcqOk').onclick = close;
    byId('rcqNew').onclick = function () { create(); };
    S.el = box;
    return box;
  }

  function paintCode(txt) {
    var box = byId('rcqCode');
    if (!box) return;
    if (!txt || !/^https?:\/\//i.test(txt)) {
      box.innerHTML = '<div class="wait">' + (txt || '正在生成…') + '</div>';
      return;
    }
    var svg = '';
    try {
      svg = root.MFlixQR ? root.MFlixQR.svg(txt, { quiet: 2 }) : '';
    } catch (e) { svg = ''; }
    box.innerHTML = svg || '<div class="wait">二维码组件没加载</div>';
    var u = byId('rcqUrl');
    if (u) u.textContent = txt;
  }

  function paintFoot() {
    var s = byId('rcqStat');
    if (!s) return;
    if (S.peers > 0) {
      s.className = 'on';
      s.textContent = '已连 ' + S.peers + ' 台遥控器';
    } else {
      s.className = '';
      s.textContent = '等待扫码';
    }
  }

  /* ---------------- 指令执行 ---------------- */

  function exec(cmd, arg) {
    var h = S.hooks || {};
    var v = pickVideo();
    var n = Number(arg);

    // 页面自己有更准的做法（选集、返回、回首页…）就让它先接
    if (typeof h.onCmd === 'function') {
      var done = false;
      try { done = h.onCmd(cmd, arg) === true; } catch (e) { done = false; }
      if (done) return;
    }

    switch (cmd) {
      case 'toggle':
        if (v) {
          if (v.paused) { var pr = v.play(); if (pr && pr.catch) pr.catch(function () {}); }
          else v.pause();
        } else fireKey(' ', 'Space', 32);
        return;
      case 'play':
        if (v) { var pr2 = v.play(); if (pr2 && pr2.catch) pr2.catch(function () {}); }
        else fireKey(' ', 'Space', 32);
        return;
      case 'pause':
        if (v) v.pause();
        else fireKey(' ', 'Space', 32);
        return;
      case 'seekb':
        if (v) v.currentTime = Math.max(0, v.currentTime - (isFinite(n) && n > 0 ? n : 10));
        else fireKey('ArrowLeft', 'ArrowLeft', 37);
        return;
      case 'seekf':
        if (v) {
          var top = isFinite(v.duration) ? v.duration : v.currentTime + 1e9;
          v.currentTime = Math.min(top, v.currentTime + (isFinite(n) && n > 0 ? n : 10));
        } else fireKey('ArrowRight', 'ArrowRight', 39);
        return;
      case 'seekto':
        if (v && isFinite(n)) {
          var d = isFinite(v.duration) ? v.duration : n;
          v.currentTime = Math.max(0, Math.min(d, n));
        }
        return;
      case 'volup':
        if (v) v.volume = Math.min(1, Math.round((v.volume + 0.1) * 10) / 10);
        if (v && v.muted) v.muted = false;
        return;
      case 'voldown':
        if (v) v.volume = Math.max(0, Math.round((v.volume - 0.1) * 10) / 10);
        return;
      case 'mute':
        if (v) v.muted = !v.muted;
        return;
      case 'fullscreen':
        if (typeof h.fullscreen === 'function') { h.fullscreen(); return; }
        if (document.fullscreenElement || document.webkitFullscreenElement) {
          try {
            (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
          } catch (e) {}
        } else {
          var target = v || document.documentElement;
          var fn = target.requestFullscreen || target.webkitRequestFullscreen || target.webkitRequestFullScreen;
          if (fn) { try { fn.call(target); } catch (e2) {} }
        }
        return;
      case 'next':
        if (typeof h.next === 'function') { h.next(); return; }
        fireKey('ArrowRight', 'ArrowRight', 39, { altKey: true });
        return;
      case 'prev':
        if (typeof h.prev === 'function') { h.prev(); return; }
        fireKey('ArrowLeft', 'ArrowLeft', 37, { altKey: true });
        return;
      case 'back':
        if (typeof h.back === 'function') { h.back(); return; }
        if (root.history) root.history.back();
        return;
      case 'home':
        if (typeof h.home === 'function') { h.home(); return; }
        root.location.href = '/';
        return;
      case 'ok':
        if (typeof h.ok === 'function') { h.ok(); return; }
        fireKey('Enter', 'Enter', 13);
        return;
      case 'up':
      case 'down':
      case 'left':
      case 'right':
        if (typeof h.dpad === 'function') { h.dpad(cmd); return; }
        var map = { up: ['ArrowUp', 38], down: ['ArrowDown', 40], left: ['ArrowLeft', 37], right: ['ArrowRight', 39] };
        fireKey(map[cmd][0], map[cmd][0], map[cmd][1]);
        return;
      default:
        return;
    }
  }

  /* ---------------- 被控端循环 ---------------- */

  function create() {
    if (S.busy) return;
    S.busy = true;
    paintCode('正在生成…');
    fetch('/api/rs/create?name=' + encodeURIComponent(deviceName()), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        S.busy = false;
        if (!d || !d.token) { paintCode('会话创建失败，服务没应答'); return; }
        S.token = d.token;
        S.since = 0;
        S.peers = 0;
        S.url = d.url || '';
        paintCode(S.url || '正在生成…');
        paintFoot();
        tick();
        if (S.open) probeStart();
      })
      .catch(function () { S.busy = false; paintCode('连不上服务'); });
  }

  function tick() {
    if (!S.token) return;
    if (S.timer) { clearTimeout(S.timer); S.timer = 0; }
    var t = S.token;
    var body = null;
    fetch('/api/rs/host?t=' + encodeURIComponent(t) + '&since=' + S.since, { cache: 'no-store' })
      .then(function (r) {
        if (r.status === 404) return { gone: true };
        return r.ok ? r.json() : null;
      })
      .then(function (d) {
        if (!d) { return; }
        if (d.gone) {
          // 会话过期了：遥控器那边已经提示「已关闭」，这里安静地重新领一个，用户不用管
          S.token = '';
          S.since = 0;
          if (S.open) create();
          return;
        }
        body = d;
        var list = d.cmds || [];
        for (var i = 0; i < list.length; i++) {
          try { exec(list[i].cmd, list[i].arg); } catch (e) {}
          if (list[i].id > S.since) S.since = list[i].id;
        }
        if (d.now > S.since) S.since = d.now;
        var n = d.ctls == null ? 0 : d.ctls | 0;
        if (n !== S.peers) { S.peers = n; if (S.open) paintFoot(); }
        reportState();
      })
      .catch(function () {})
      .then(function () {
        if (S.token) S.timer = setTimeout(tick, 1000);
      });
  }

  function reportState() {
    var t = S.token;
    if (!t) return;
    var now = Date.now();
    if (now - S.stateAt < 1200) return;
    S.stateAt = now;
    var h = S.hooks || {};
    var v = pickVideo();
    var name = '';
    try { name = typeof h.title === 'function' ? String(h.title() || '') : ''; } catch (e) { name = ''; }
    if (!name) name = String(document.title || '').replace(/^MFlixTV\s*[-–|·]\s*/i, '');
    var sb = '';
    try { sb = typeof h.sub === 'function' ? String(h.sub() || '') : ''; } catch (e2) { sb = ''; }
    var pg = '';
    try { pg = typeof h.page === 'function' ? String(h.page() || '') : ''; } catch (e3) { pg = ''; }
    var qs = 't=' + encodeURIComponent(t) +
      '&title=' + encodeURIComponent(name.slice(0, 120)) +
      '&sub=' + encodeURIComponent(sb.slice(0, 60)) +
      '&playing=' + (v && !v.paused && !v.ended ? '1' : '0') +
      '&pos=' + (v && isFinite(v.currentTime) ? Math.round(v.currentTime) : 0) +
      '&dur=' + (v && isFinite(v.duration) ? Math.round(v.duration) : 0) +
      '&page=' + encodeURIComponent(pg.slice(0, 200));
    fetch('/api/rs/state?' + qs, { cache: 'no-store' }).catch(function () {});
  }

  function probeStart() {
    probeStop();
    S.probe = setInterval(function () {
      if (!S.open || !S.token) return;
      fetch('/api/rs/info?t=' + encodeURIComponent(S.token), { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { if (d) { S.peers = d.ctls == null ? 0 : d.ctls | 0; paintFoot(); } })
        .catch(function () {});
    }, 2500);
  }
  function probeStop() {
    if (S.probe) { clearInterval(S.probe); S.probe = 0; }
  }

  /* ---------------- 面板开关 ---------------- */

  function open() {
    build();
    S.open = true;
    S.el.classList.add('on');
    var orig = document.body.style.overflow;
    S._ovf = orig;
    document.body.style.overflow = 'hidden';
    if (!S.token) create();
    else { paintFoot(); probeStart(); }
  }

  function close() {
    if (!S.el) return;
    S.open = false;
    S.el.classList.remove('on');
    probeStop();
    // 关面板不销毁会话：遥控器那边还能继续用
    document.body.style.overflow = S._ovf || '';
  }

  /** 把任意一个按钮变成「出二维码」的入口（一个页面可以有多个：顶栏一个、播放器里一个） */
  function attach(btn) {
    if (!btn) return;
    btn.onclick = function (e) {
      if (e && e.preventDefault) e.preventDefault();
      open();
    };
    if (!btn.getAttribute('title')) {
      btn.setAttribute('title', '用另一台手机扫码当遥控器，控制当前这个页面');
    }
  }

  function mount(opts) {
    opts = opts || {};
    S.hooks = opts;
    S.btn = opts.btn || (opts.btnId ? byId(opts.btnId) : null);
    attach(S.btn);
    document.addEventListener('keydown', function (e) {
      if (!S.open) return;
      if (e.key === 'Escape' || e.keyCode === 27 || e.keyCode === 4) {
        e.stopPropagation();
        close();
      }
    }, true);
    // 页面关掉就停掉轮询，别让后台一直转
    root.addEventListener('pagehide', function () {
      if (S.timer) { clearTimeout(S.timer); S.timer = 0; }
      probeStop();
    });
    root.addEventListener('pageshow', function () {
      if (S.token && !S.timer) tick();
    });
    return { open: open, close: close, attach: attach, token: function () { return S.token; } };
  }

  root.MFlixRC = {
    mount: mount,
    attach: attach,
    open: open,
    close: close,
    exec: exec,
    isOpen: function () { return !!S.open; }
  };
})(typeof window !== 'undefined' ? window : this);
