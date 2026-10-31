/*
 * 「扫一扫当遥控器」——被控端（index.html / tv.html 共用一份）。
 *
 * 做的是：
 *   右上角的遥控按钮 → 向服务端领一个 6 位 token → 把 http://本机IP:端口/rc?t=TOKEN
 *   画成二维码 → 另一台手机扫码打开 /rc 页就成了遥控器，只控制「点按钮的那一个页面」。
 *   被控端每秒来取一次指令并当场执行，同时把片名 / 进度 / 选集 / 线路报上去。
 *
 * 遥控器控制的不只是播放器：方向键走 MFlixRCNav（几何导航），所以首页海报墙、
 * 详情页、搜索结果、设置页都能用十字键一格一格走、确定键点进去——
 * 和电视遥控器的手感一样。
 *
 * 用法：
 *   MFlixRC.mount({
 *     btn: document.getElementById('rcBtn'),
 *     nav: { selector: '.card,.ep,.nv,button', scope: function () { return null; } },
 *     title: function () { ... },      // 遥控器上显示的片名
 *     sub:   function () { ... },      // 小字，例如「第 3 集」
 *     page:  function () { return 'home'; },
 *     lists: function () {             // 选集 / 线路（没有就返回 null）
 *       return { eps: ['第1集','第2集'], ep: 0, lines: ['线路 1'], ln: 0 };
 *     },
 *     onCmd: function (cmd, arg) {     // 返回 true = 这个页面自己处理了
 *       if (cmd === 'ep') { playEp(+arg); return true; }
 *       return false;
 *     }
 *   });
 *
 * 指令（和 /rc 页面、电脑端 RemoteHost 完全一致）：
 *   toggle play pause seekb seekf seekto volup voldown mute fullscreen
 *   prev next up down left right ok back home ep line
 */
(function (root) {
  'use strict';

  /* 面板样式：不用 inset / flex-gap / grid，安卓 7 那种老 WebView 也认得 */
  var CSS = [
    '#rcq{position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483000;display:none;',
    'align-items:center;justify-content:center;padding:18px;background:rgba(0,0,0,.76);',
    '-webkit-backdrop-filter:blur(7px);backdrop-filter:blur(7px)}',
    '#rcq.on{display:-webkit-flex;display:flex}',
    '.rcq-box{width:100%;max-width:334px;max-height:90vh;overflow:auto;-webkit-overflow-scrolling:touch;',
    'background:#141416;border:1px solid rgba(255,255,255,.09);border-radius:18px;padding:18px 18px 14px;',
    'text-align:center;box-shadow:0 26px 64px rgba(0,0,0,.65);color:#fff}',
    '.rcq-box h3{margin:0 0 6px;font-size:15px;font-weight:600;line-height:1.4}',
    '.rcq-box p{margin:0 0 14px;font-size:11.5px;line-height:1.65;color:rgba(255,255,255,.5)}',
    '.rcq-box p b{color:rgba(255,255,255,.86);font-weight:600}',
    '.rcq-code{width:200px;height:200px;margin:0 auto;background:#fff;border-radius:12px;padding:9px}',
    '.rcq-code svg,.rcq-code img{display:block;width:200px;height:200px}',
    '.rcq-code .wait{display:-webkit-flex;display:flex;align-items:center;justify-content:center;',
    'height:100%;font-size:12px;color:#666}',
    '.rcq-url{margin:12px 0 0;font-size:10.5px;line-height:1.5;color:rgba(255,255,255,.42);',
    'word-break:break-all;font-family:ui-monospace,Menlo,Consolas,monospace}',
    '.rcq-foot{margin-top:12px;font-size:11px;color:rgba(255,255,255,.5);text-align:left}',
    '.rcq-foot .st{float:left}',
    '.rcq-foot .st.on{color:#34d399}',
    '.rcq-foot .st.off{color:#f87171}',
    '.rcq-foot button{float:right;border:0;background:none;color:rgba(255,255,255,.6);font:inherit;',
    'font-size:11px;padding:4px 2px;cursor:pointer}',
    '.rcq-ops{margin-top:14px;clear:both}',
    '.rcq-ops button{width:100%;height:42px;border:0;border-radius:11px;background:#fff;color:#0a0a0d;',
    'font:inherit;font-size:14px;font-weight:600;cursor:pointer}',
    '.rcq-tip{margin:10px 0 0;font-size:10.5px;line-height:1.6;color:rgba(255,255,255,.3);text-align:left}'
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

  /** 这个 <video> 真的在放东西吗（空标签页里的空 video 不能当播放器用） */
  function liveVideo(v) {
    return !!(v && (v.currentSrc || v.src || (v.readyState && v.readyState > 0) || v.currentTime > 0));
  }

  function togglePlay(v) {
    if (v.paused) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
    else v.pause();
  }

  /**
   * 音量步进：先把当前值规整成 0.1 的整数倍再加减。
   * 直接 `volume + 0.1` 浮点会漂（0.65 → 0.7500000000000001），手机上连按会跑偏。
   * 加音量必须解静音，否则用户按了半天没声音。
   */
  function bumpVol(v, delta) {
    if (!v) return;
    var cur = Math.round((v.volume || 0) * 10) / 10;
    v.volume = Math.min(1, Math.max(0, Math.round((cur + delta) * 10) / 10));
    if (delta > 0) v.muted = false;
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

  /** 选集 / 线路压成一行：cur|名字|名字|…（名字里的竖线换成斜杠，省得解析歧义） */
  function packList(arr, cur, limit) {
    if (!arr || !arr.length) return '';
    var out = String(cur == null ? -1 : cur), i;
    for (i = 0; i < arr.length; i++) out += '|' + String(arr[i] == null ? '' : arr[i]).replace(/\|/g, '/');
    return out.length > limit ? out.slice(0, limit) : out;
  }

  var S = {
    hooks: {},
    el: null,
    btn: null,
    nav: null,
    token: '',
    since: 0,
    peers: 0,
    open: false,
    busy: false,
    timer: 0,
    probe: 0,
    stateAt: 0,
    forceAt: 0,
    /* 状态上报是否还在飞：飞着就不再叠一条，避免断网时请求越堆越多 */
    stateBusy: false,
    /* 连续失败次数：断网时用来退避 */
    fails: 0,
    /* 刚从 sessionStorage 接手会话：第一条回执只对齐序号，不回放旧指令 */
    resume: false,
    url: '',
    listAt: 0,
    lastEps: '',
    lastLines: ''
  };

  /* 服务端长轮询挂多久：有指令会立刻返回，没指令才等这么久 */
  var WAIT_MS = 700;
  /* 两轮之间的间隔：长轮询自己承担了节奏 */
  var POLL_MS = 60;
  /* 状态上报的间隔：遥控器那边的进度条 / 音量 / 倍速靠它刷新 */
  var STATE_MS = 700;
  /* 连续失败时的退避上限：断网时不打满速空转，恢复后一成功就回到 POLL_MS */
  var FAIL_MAX_MS = 1500;

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
      '<p>扫完它就是个遥控器，能像电视遥控器一样操作<b>你现在打开的这个页面</b>：' +
      '方向键走格子、确定进片、播放控制、选集换线路都在手机上。</p>' +
      '<div class="rcq-code" id="rcqCode"><div class="wait">正在生成…</div></div>' +
      '<div class="rcq-url" id="rcqUrl"></div>' +
      '<div class="rcq-foot"><span class="st" id="rcqStat">等待扫码</span>' +
      '<button type="button" id="rcqNew">换一个码</button></div>' +
      '<div class="rcq-ops"><button type="button" id="rcqOk">知道了</button></div>' +
      '<p class="rcq-tip">关掉这个面板不影响遥控，遥控器还连着；关掉页面才算结束。' +
      '手机锁屏太久再回来，指令可能要等十几秒才生效。</p>' +
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
      s.className = 'st on';
      s.textContent = '已连 ' + S.peers + ' 台遥控器';
    } else {
      s.className = 'st';
      s.textContent = '等待扫码';
    }
  }

  /* ---------------- 指令执行 ---------------- */

  function exec(cmd, arg) {
    var h = S.hooks || {};
    var v = pickVideo();
    var n = Number(arg);

    // 页面自己有更准的做法（选集、换线路、返回、回首页…）就让它先接
    if (typeof h.onCmd === 'function') {
      var done = false;
      try { done = h.onCmd(cmd, arg) === true; } catch (e) { done = false; }
      if (done) return;
    }

    switch (cmd) {
      case 'up':
      case 'down':
      case 'left':
      case 'right':
        if (S.nav) S.nav.move(cmd);
        else fireKey(cmd, cmd, 0);
        return;
      case 'ok':
        if (S.nav && S.nav.hasFocus() && S.nav.ok()) return;
        if (liveVideo(v)) { togglePlay(v); return; }
        fireKey('Enter', 'Enter', 13);
        return;
      case 'toggle':
        if (liveVideo(v)) togglePlay(v);
        else if (S.nav && S.nav.hasFocus()) S.nav.ok();
        else fireKey(' ', 'Space', 32);
        return;
      case 'play':
        if (liveVideo(v)) { var pr2 = v.play(); if (pr2 && pr2.catch) pr2.catch(function () {}); }
        else fireKey(' ', 'Space', 32);
        return;
      case 'pause':
        if (liveVideo(v)) v.pause();
        else fireKey(' ', 'Space', 32);
        return;
      case 'seekb':
        if (liveVideo(v)) v.currentTime = Math.max(0, v.currentTime - (isFinite(n) && n > 0 ? n : 10));
        else fireKey('ArrowLeft', 'ArrowLeft', 37);
        return;
      case 'seekf':
        if (liveVideo(v)) {
          var top = isFinite(v.duration) ? v.duration : v.currentTime + 1e9;
          v.currentTime = Math.min(top, v.currentTime + (isFinite(n) && n > 0 ? n : 10));
        } else fireKey('ArrowRight', 'ArrowRight', 39);
        return;
      case 'seekto':
        if (liveVideo(v) && isFinite(n)) {
          var d = isFinite(v.duration) ? v.duration : n;
          v.currentTime = Math.max(0, Math.min(d, n));
        }
        return;
      case 'volup':
        bumpVol(v, 0.1);
        return;
      case 'voldown':
        bumpVol(v, -0.1);
        return;
      case 'volset':
        if (v && isFinite(n)) {
          v.volume = Math.min(1, Math.max(0, Math.round(n) / 100));
          v.muted = false;
        }
        return;
      case 'rateset':
        if (v && isFinite(n) && n > 0) {
          // 遥控器发的是百分数（150 = 1.5×），落回 0.25 一档
          v.playbackRate = Math.min(3, Math.max(0.5, Math.round(n / 25) / 4));
        }
        return;
      case 'mute':
        if (v) v.muted = !v.muted;
        return;
      case 'rateup':
      case 'ratedown':
        // 倍速 ±0.25：手机上看慢/看快都是高频操作，和 PC 端 , . 快捷键同一套档位
        if (v) {
          var step = cmd === 'rateup' ? 0.25 : -0.25;
          var nextRate = Math.round(((v.playbackRate || 1) + step) * 4) / 4;
          v.playbackRate = Math.min(3, Math.max(0.5, nextRate));
        }
        return;
      case 'fullscreen':
        if (typeof h.fullscreen === 'function') { h.fullscreen(); return; }
        toggleFullscreen(v);
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
        if (S.nav) S.nav.clear();
        if (typeof h.back === 'function') { h.back(); return; }
        if (!layeredBack()) { if (root.history) root.history.back(); }
        return;
      case 'home':
        if (typeof h.home === 'function') { h.home(); return; }
        root.location.href = '/';
        return;
      default:
        return;
    }
  }

  function toggleFullscreen(v) {
    // 安卓 App 里优先用原生全屏（不受浏览器「必须有用户手势」的限制）
    var nat = root.MFlixNative;
    if (nat && nat.fullscreen) {
      // 原生接口是 fullscreen(Boolean)，不是切换：先问现在是不是横着，再取反
      var wide = false;
      try { wide = !!(nat.wide && nat.wide()); } catch (e) {}
      try { nat.fullscreen(!wide); return; } catch (e2) {}
    }
    var fs = document.fullscreenElement || document.webkitFullscreenElement;
    if (fs) {
      try { (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document); } catch (e2) {}
      return;
    }
    var target = v || document.documentElement;
    var fn = target.requestFullscreen || target.webkitRequestFullscreen || target.webkitRequestFullScreen;
    if (fn) { try { fn.call(target); } catch (e3) {} }
  }

  /**
   * 页面自己没接管时的「逐层返回」：先退出全屏，再找最上层浮层的关闭按钮点一下，
   * 都没有才真的后退一页。这样按返回不会直接跳出整个站点。
   */
  function layeredBack() {
    var fs = document.fullscreenElement || document.webkitFullscreenElement;
    if (fs) {
      try { (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document); } catch (e) {}
      return true;
    }
    var scopes = document.querySelectorAll('[role="dialog"],[aria-modal="true"],#rcq.on');
    for (var i = scopes.length - 1; i >= 0; i--) {
      var el = scopes[i];
      if (!el || el.offsetParent === null && getComputedStyle(el).position !== 'fixed') continue;
      var r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) continue;
      var btn = el.querySelector('[aria-label*="关闭"],button[data-close],.close');
      if (btn) { try { btn.click(); return true; } catch (e2) {} }
    }
    return false;
  }

  /* ---------------- 被控端循环 ---------------- */

  /* 会话码存在 sessionStorage：页面重载（旋转、切前台被回收再回来）仍认得手机上那台遥控器 */
  var TK_KEY = 'mfl:rc-token';
  var URL_KEY = 'mfl:rc-url';

  function rememberSession(token, url) {
    try {
      if (token) {
        sessionStorage.setItem(TK_KEY, token);
        sessionStorage.setItem(URL_KEY, url || '');
      } else {
        sessionStorage.removeItem(TK_KEY);
        sessionStorage.removeItem(URL_KEY);
      }
    } catch (e) { /* 存不了就算了，不影响本次会话 */ }
  }

  function recallSession() {
    try {
      return {
        token: sessionStorage.getItem(TK_KEY) || '',
        url: sessionStorage.getItem(URL_KEY) || ''
      };
    } catch (e) {
      return { token: '', url: '' };
    }
  }

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
        S.resume = false;
        S.url = d.url || '';
        rememberSession(S.token, S.url);
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
    fetch('/api/rs/host?t=' + encodeURIComponent(t) + '&since=' + S.since + '&wait=' + WAIT_MS, { cache: 'no-store' })
      .then(function (r) {
        if (r.status === 404) return { gone: true };
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      })
      .then(function (d) {
        S.fails = 0;
        if (d.gone) {
          // 会话过期了：遥控器那边已经提示「已关闭」，这里安静地重新领一个
          S.token = '';
          S.since = 0;
          rememberSession('');
          if (S.open) create();
          return;
        }
        // 刚接过会话的头一条回执：队列里的旧指令不再重放，只把序号对齐到当前
        var list = S.resume ? [] : (d.cmds || []);
        S.resume = false;
        for (var i = 0; i < list.length; i++) {
          try { exec(list[i].cmd, list[i].arg); } catch (e) {}
          if (list[i].id > S.since) S.since = list[i].id;
        }
        if (d.now > S.since) S.since = d.now;
        var n = d.ctls == null ? 0 : d.ctls | 0;
        if (n !== S.peers) { S.peers = n; if (S.open) paintFoot(); }
        // 有指令就别等下一轮：遥控器上的暂停图标、音量、倍速要立刻对得上
        reportState(list.length > 0);
      })
      .catch(function () {
        // 断网 / 服务重启中：退避重试，不要 60ms 一次地空转打失败请求
        S.fails = (S.fails || 0) + 1;
      })
      .then(function () {
        if (!S.token) return;
        var delay = S.fails > 0
          ? Math.min(FAIL_MAX_MS, POLL_MS * Math.pow(2, Math.min(5, S.fails)))
          : POLL_MS;
        S.timer = setTimeout(tick, delay);
      });
  }

  function reportState(force) {
    var t = S.token;
    if (!t) return;
    var now = Date.now();
    if (!force && now - S.stateAt < STATE_MS) return;
    if (force) {
      // 连发（长按音量 / 连点方向键）时别把请求打成洪水
      if (now - S.forceAt < 200) { S.stateAt = 0; return; }
      S.forceAt = now;
    }
    // 上一发还没回来：这一轮直接放弃。上报只是锦上添花，
    // 断网时若排队等它，整条指令长轮询会被一起拖死。
    if (S.stateBusy) return;
    S.stateAt = now;
    S.stateBusy = true;
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
      '&page=' + encodeURIComponent(pg.slice(0, 200)) +
      // 音量 / 倍速 / 静音：遥控器上要能看见自己按到了多少
      '&vol=' + (v ? Math.round((v.volume || 0) * 100) : 100) +
      '&rate=' + (v ? Math.round((v.playbackRate || 1) * 100) : 100) +
      '&muted=' + (v && v.muted ? '1' : '0');

    // 选集 / 线路每 5 秒重算一次就够（列表基本不变，省点带宽）
    if (now - S.listAt > 5000) {
      S.listAt = now;
      var L = null;
      try { L = typeof h.lists === 'function' ? h.lists() : null; } catch (e4) { L = null; }
      S.lastEps = L ? packList(L.eps, L.ep, 2400) : '';
      S.lastLines = L ? packList(L.lines, L.ln, 800) : '';
    }
    // 空串也要发：离开播放器后遥控器上不能再留着上一部的集数
    qs += '&eps=' + encodeURIComponent(S.lastEps) + '&lines=' + encodeURIComponent(S.lastLines);
    fetch('/api/rs/state?' + qs, { cache: 'no-store' }).then(function () {
      S.stateBusy = false;
    }, function () {
      S.stateBusy = false;
    });
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
    S.el.className = 'on';
    if (!S._ovf) S._ovf = document.body.style.overflow || '';
    document.body.style.overflow = 'hidden';
    if (!S.token) create();
    else {
      // 会话是从 sessionStorage 接回来的：面板上那张码要现画，否则一直停在「正在生成…」
      paintCode(S.url || '正在生成…');
      paintFoot();
      probeStart();
    }
  }

  function close() {
    if (!S.el) return;
    S.open = false;
    S.el.className = '';
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
    if (root.MFlixRCNav && !S.nav) {
      try { S.nav = root.MFlixRCNav.install(opts.nav || {}); } catch (e) {}
    }
    document.addEventListener('keydown', function (e) {
      if (!S.open) return;
      if (e.key === 'Escape' || e.keyCode === 27 || e.keyCode === 4) {
        e.stopPropagation();
        close();
      }
    }, true);
    root.addEventListener('pagehide', function () {
      if (S.timer) { clearTimeout(S.timer); S.timer = 0; }
      probeStop();
    });
    root.addEventListener('pageshow', function () {
      if (S.token && !S.timer) tick();
    });
    // 刷新 / 重新进入这个页面：把上次那个会话码接回来。
    // 不接的话，手机上已经连着的遥控器会在页面一重载之后彻底失灵
    // （会话还在服务端活着，只是这台页面没人来取指令了）。
    var saved = recallSession();
    if (saved.token && !S.token) {
      S.token = saved.token;
      S.url = saved.url;
      S.since = 0;
      S.resume = true;
      tick();
    }
    return {
      open: open, close: close, attach: attach,
      nav: function () { return S.nav; },
      token: function () { return S.token; }
    };
  }

  root.MFlixRC = {
    mount: mount,
    attach: attach,
    open: open,
    close: close,
    exec: exec,
    isOpen: function () { return !!S.open; },
    nav: function () { return S.nav; }
  };
})(typeof window !== 'undefined' ? window : this);
