'use client';

import { installNav, topLayer, type NavDir, type NavHandle } from '@/lib/remote-nav';

/**
 * 「扫一扫当遥控器」的被控端引擎 —— 活在模块里，不跟着组件挂载 / 卸载。
 *
 * 为什么必须这样：电脑端的顶栏是按页面各自渲染的（首页、日历、直播各一个 Header），
 * 从首页点进播放页时旧 Header 会被卸载。以前会话状态挂在组件里，一换路由 token 就没了，
 * 于是「首页能控、进播放页按什么都没反应」。现在 token、轮询、指令执行都放在这里，
 * 换页面只是换了个按钮的宿主，会话一直在。
 */

/** 播放页注册过来的桥接口（选集、片源），没有就是首页/详情页 */
export interface WatchBridge {
  episodes: string[];
  index: number;
  goEpisode: (i: number) => void;
  lines: string[];
  lineIndex: number;
  setLine: (i: number) => void;
}

declare global {
  interface Window {
    __mflWatch?: WatchBridge;
  }
}

export interface Snapshot {
  token: string;
  url: string;
  peers: number;
  hostAlive: boolean;
  busy: boolean;
}

type Handlers = {
  back: () => void;
  home: () => void;
  /** 手机上打了片名点搜索：在被控页上真的搜一遍 */
  search: (q: string) => void;
};

/* 服务端长轮询挂多久：有指令会立刻返回，没指令才等这么久 */
const WAIT_MS = 700;
/* 两轮之间的间隔：长轮询自己承担了节奏，这里只留一点点空档 */
const POLL_MS = 60;
/* 状态上报的间隔：遥控器那边的进度条 / 音量 / 倍速靠它刷新 */
const STATE_MS = 700;
/* 连续失败时的退避上限：断网时不打满速空转，恢复后一成功就回到 POLL_MS */
const FAIL_MAX_MS = 1500;
/* 会话码存在 sessionStorage：刷新页面还认得手机上那台遥控器，关掉标签页就结束 */
const TOKEN_KEY = 'mfl:rc-token';
const URL_KEY = 'mfl:rc-url';

function rememberSession(token: string, url = '') {
  try {
    if (token) {
      sessionStorage.setItem(TOKEN_KEY, token);
      sessionStorage.setItem(URL_KEY, url);
    } else {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(URL_KEY);
    }
  } catch {
    /* 无痕模式之类，记不住就算了，不影响本次会话 */
  }
}

function recallSession(): { token: string; url: string } {
  try {
    return { token: sessionStorage.getItem(TOKEN_KEY) || '', url: sessionStorage.getItem(URL_KEY) || '' };
  } catch {
    return { token: '', url: '' };
  }
}

const S = {
  token: '',
  url: '',
  peers: 0,
  hostAlive: true,
  busy: false,
  since: 0,
  stateAt: 0,
  forceAt: 0,
  /** 状态上报是否还在飞：飞着就不再叠一条，避免断网时请求越堆越多 */
  stateBusy: false,
  /** 连续失败次数：断网时用来退避，别拿满速空转打失败请求 */
  fails: 0,
  /** 刚从 sessionStorage 接手会话：第一条 host 回执只对齐序号，不回放旧指令 */
  resume: false,
  started: false,
  timer: 0,
};

let nav: NavHandle | null = null;
/** 二维码面板是不是开着：开着时十字键不许去动背后那层页面 */
let panelOpen = false;
let handlers: Handlers = {
  back: () => window.history.back(),
  home: () => window.location.assign('/'),
  search: (q: string) => window.location.assign('/?s=' + encodeURIComponent(q)),
};
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function snapshot(): Snapshot {
  return { token: S.token, url: S.url, peers: S.peers, hostAlive: S.hostAlive, busy: S.busy };
}

export function setPanelOpen(v: boolean) {
  panelOpen = v;
}

/** 组件挂载时把「当前路由的 router」接进来：换页后自动换成新的那个 */
export function setHandlers(h: Partial<Handlers>) {
  handlers = { ...handlers, ...h };
}

/* ------------------------------------------------------------------ 基础工具 */

function fireKey(key: string, code: string, keyCode: number, extra: KeyboardEventInit = {}) {
  const ev = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...extra });
  try {
    Object.defineProperty(ev, 'keyCode', { get: () => keyCode });
    Object.defineProperty(ev, 'which', { get: () => keyCode });
  } catch {
    /* 只读属性就别补了 */
  }
  (document.activeElement || document.body).dispatchEvent(ev);
  document.dispatchEvent(ev);
}

function allVideos(): HTMLVideoElement[] {
  return Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
}

function mainVideo(): HTMLVideoElement | null {
  const all = allVideos();
  if (all.length === 0) return null;
  const playing = all.find((v) => !v.paused && v.currentTime > 0);
  if (playing) return playing;
  return all.sort((a, b) => (b.duration || 0) - (a.duration || 0))[0];
}

/** 真的在播的那个（遥控的播放指令只对它生效，避免误触隐藏的广告位 video） */
function liveVideo(): HTMLVideoElement | null {
  const all = allVideos();
  if (all.length === 0) return null;
  const hit = all.find((v) => !v.paused || v.currentTime > 0 || v.readyState > 0);
  return hit || all[0];
}

/** `当前下标|名|名…`；竖线是分隔符，名字里的竖线换掉 */
function packList(arr: string[], cur: number, limit = 60): string {
  const items = arr.slice(0, limit).map((s) => String(s || '').replace(/\|/g, '/').slice(0, 24));
  return `${Math.max(0, cur)}|${items.join('|')}`;
}

function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /Windows/i.test(ua)
    ? 'Windows'
    : /Macintosh|Mac OS/i.test(ua)
      ? 'Mac'
      : /Android/i.test(ua)
        ? 'Android'
        : /iPhone|iPad/i.test(ua)
          ? 'iOS'
          : /Linux/i.test(ua)
            ? 'Linux'
            : '设备';
  const br = /Edg\//i.test(ua)
    ? 'Edge'
    : /Chrome\//i.test(ua) && !/Edg\//i.test(ua)
      ? 'Chrome'
      : /Safari\//i.test(ua) && !/Chrome\//i.test(ua)
        ? 'Safari'
        : /Firefox\//i.test(ua)
          ? 'Firefox'
          : '浏览器';
  return `${br} · ${os}`;
}

/* ------------------------------------------------------------------ 指令执行 */

/**
 * 音量步进：先把当前值规整成 0.1 的整数倍再加减。
 *
 * 以前写成 `video.volume + 0.1`，浮点会把 0.65 变成 0.7500000000000001，
 * 手机上连按「音量 + −」会慢慢漂（实测 0.65 → 0.8 → 0.7，净 +0.05）。
 */
function bumpVolume(delta: number) {
  for (const el of allVideos()) {
    const cur = Math.round((el.volume || 0) * 10) / 10;
    el.volume = Math.min(1, Math.max(0, Math.round((cur + delta) * 10) / 10));
    // 加音量必须解静音，否则用户按了半天没声音（以前只有安卓那份会解）
    if (delta > 0) el.muted = false;
  }
}

function setVolume(pct: number) {
  const v = Math.min(1, Math.max(0, pct / 100));
  for (const el of allVideos()) {
    el.volume = Math.round(v * 10) / 10;
    el.muted = false;
  }
}

function setRate(rate: number) {
  const r = Math.min(3, Math.max(0.5, Math.round(rate * 4) / 4));
  for (const el of allVideos()) el.playbackRate = r;
}

function layeredBack() {
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => {});
    return;
  }
  // 让页面自己先处理（播放器内选集/换源面板、抽屉、弹窗……）
  const ev = new CustomEvent('mfl:rc-back', { cancelable: true, detail: { handled: false } });
  window.dispatchEvent(ev);
  if (ev.defaultPrevented) return;

  const top = topLayer();
  if (top?.close) {
    top.close.click();
    return;
  }
  handlers.back();
}

export function exec(cmd: string, arg: string) {
  const v = liveVideo();
  const num = Number(arg);
  const bridge = typeof window !== 'undefined' ? window.__mflWatch : undefined;
  switch (cmd) {
    case 'toggle':
      if (v) {
        if (v.paused) void v.play().catch(() => {});
        else v.pause();
      } else fireKey(' ', 'Space', 32);
      return;
    case 'play':
      if (v) void v.play().catch(() => {});
      else fireKey(' ', 'Space', 32);
      return;
    case 'pause':
      if (v) v.pause();
      else fireKey(' ', 'Space', 32);
      return;
    case 'seekb':
      if (v && Number.isFinite(v.duration)) {
        v.currentTime = Math.max(0, v.currentTime - (Number.isFinite(num) && num ? num : 10));
      } else fireKey('ArrowLeft', 'ArrowLeft', 37);
      return;
    case 'seekf':
      if (v && Number.isFinite(v.duration)) {
        v.currentTime = Math.min(v.duration, v.currentTime + (Number.isFinite(num) && num ? num : 10));
      } else fireKey('ArrowRight', 'ArrowRight', 39);
      return;
    case 'seekto':
      if (v && Number.isFinite(v.duration) && Number.isFinite(num)) {
        v.currentTime = Math.max(0, Math.min(v.duration, num));
      }
      return;
    case 'volup':
      bumpVolume(0.1);
      return;
    case 'voldown':
      bumpVolume(-0.1);
      return;
    case 'volset':
      if (Number.isFinite(num)) setVolume(num);
      return;
    case 'mute':
      for (const el of allVideos()) el.muted = !el.muted;
      return;
    case 'rateup':
    case 'ratedown': {
      // 倍速 ±0.25：手机上「看慢一点」是高频操作，跟 PC 端的 , . 快捷键对齐
      const step = cmd === 'rateup' ? 0.25 : -0.25;
      const videos = allVideos();
      if (!videos.length) {
        fireKey(cmd === 'rateup' ? '.' : ',', cmd === 'rateup' ? 'Period' : 'Comma', cmd === 'rateup' ? 190 : 188);
        return;
      }
      for (const el of videos) {
        const next = Math.round(((el.playbackRate || 1) + step) * 4) / 4;
        el.playbackRate = Math.min(3, Math.max(0.5, next));
      }
      return;
    }
    case 'rateset':
      if (Number.isFinite(num) && num > 0) setRate(num / 100);
      return;
    case 'fullscreen': {
      // 浏览器只允许「用户手势」触发原生全屏，遥控指令不算手势：
      // requestFullscreen 会被拒，连脚本点页面上的全屏按钮也一样（合成 click 不算激活）。
      // 所以顺序是：播放页自己切网页全屏 → 没人接就把画面元素用 CSS 铺满 →
      // 都不适用（不在播放页）就什么都不做，遥控页那边会提示「这页没有可全屏的画面」。
      const ev = new CustomEvent('mfl:rc-fullscreen', { detail: { handled: false } });
      window.dispatchEvent(ev);
      if ((ev.detail as { handled?: boolean } | null)?.handled) return;
      if (toggleCssFullscreen()) return;
      if (document.fullscreenElement) {
        // 本机用户自己按 F 进了原生全屏：遥控按一下就退出去
        void document.exitFullscreen().catch(() => {});
      }
      return;
    }
    case 'ep': {
      if (bridge && Number.isFinite(num) && bridge.episodes.length > 0) {
        bridge.goEpisode(Math.max(0, Math.min(bridge.episodes.length - 1, num)));
      }
      return;
    }
    case 'line': {
      if (bridge) bridge.setLine(Math.max(0, num || 0));
      return;
    }
    case 'next': {
      if (bridge && bridge.episodes.length > 0) {
        if (bridge.index < bridge.episodes.length - 1) bridge.goEpisode(bridge.index + 1);
        return;
      }
      fireKey('ArrowRight', 'ArrowRight', 39, { altKey: true });
      return;
    }
    case 'prev': {
      if (bridge && bridge.episodes.length > 0) {
        if (bridge.index > 0) bridge.goEpisode(bridge.index - 1);
        return;
      }
      fireKey('ArrowLeft', 'ArrowLeft', 37, { altKey: true });
      return;
    }
    case 'ok': {
      if (panelOpen) {
        window.dispatchEvent(new CustomEvent('mfl:rc-panel-close'));
        return;
      }
      // 页面上已经有遥控焦点就走焦点，否则退回 Enter
      if (nav?.hasFocus()) nav.ok();
      else fireKey('Enter', 'Enter', 13);
      return;
    }
    case 'up':
    case 'down':
    case 'left':
    case 'right': {
      if (panelOpen) return;
      if (nav?.move(cmd as NavDir)) return;
      const map: Record<string, [string, number]> = {
        up: ['ArrowUp', 38],
        down: ['ArrowDown', 40],
        left: ['ArrowLeft', 37],
        right: ['ArrowRight', 39],
      };
      const [k, c] = map[cmd];
      fireKey(k, k, c);
      return;
    }
    case 'back':
      if (panelOpen) {
        window.dispatchEvent(new CustomEvent('mfl:rc-panel-close'));
        return;
      }
      nav?.clear();
      layeredBack();
      return;
    case 'home':
      nav?.clear();
      window.dispatchEvent(new CustomEvent('mfl:rc-back-all'));
      handlers.home();
      return;
    case 'search': {
      // 手机上打片名、点搜索 → 这个页面直接搜一遍（和顶栏搜索走同一条路径）
      const q = String(arg || '').trim().slice(0, 100);
      if (!q) return;
      if (panelOpen) window.dispatchEvent(new CustomEvent('mfl:rc-panel-close'));
      window.dispatchEvent(new CustomEvent('mfl:rc-back-all'));
      handlers.search(q);
      return;
    }
    case 'settings':
      window.dispatchEvent(new CustomEvent('mfl:rc-settings'));
      return;
    default:
      return;
  }
}

/* ------------------------------------------------------------------ 会话循环 */

/* ---------------- 伪全屏：遥控唯一能保证生效的那种全屏 ----------------
   浏览器要求原生全屏必须由用户手势触发，而遥控走的是 fetch 轮询，永远拿不到手势：
   requestFullscreen 必被拒，连「脚本点页面上的全屏按钮」也一样（合成 click 不算激活）。
   这里把画面元素直接铺满视口，纯 CSS，不挑环境、不挑手势，退出同理。 */

const FS_CLASS = 'mfl-fs-video';
const FS_LOCK = 'mfl-fs-lock';
const FS_STYLE_ID = 'mfl-fs-style';

function ensureFsStyle() {
  if (document.getElementById(FS_STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = FS_STYLE_ID;
  s.textContent =
    `.${FS_CLASS}{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;` +
    `max-width:none!important;max-height:none!important;object-fit:contain!important;background:#000!important;` +
    `z-index:2147483000!important;}` +
    `body.${FS_LOCK}{overflow:hidden!important;}`;
  document.head.appendChild(s);
}

/** 返回 true 表示「这一下归我处理了」；页面里没有画面就交回上层 */
function toggleCssFullscreen(): boolean {
  const v = mainVideo();
  if (!v) return false;
  ensureFsStyle();
  const on = v.classList.contains(FS_CLASS);
  if (on) {
    v.classList.remove(FS_CLASS);
    document.body.classList.remove(FS_LOCK);
  } else {
    v.classList.add(FS_CLASS);
    document.body.classList.add(FS_LOCK);
  }
  return true;
}

/** 当前是不是处于任何一种全屏（播放页自己的网页全屏会在 dataset.mflFs 里写 1） */
function fsOn(): boolean {
  if (document.fullscreenElement) return true;
  if (document.documentElement.dataset.mflFs === '1') return true;
  const v = mainVideo();
  return !!v && v.classList.contains(FS_CLASS);
}

async function reportState(token: string, force = false) {
  const now = Date.now();
  if (!force && now - S.stateAt < STATE_MS) return;
  if (force) {
    // 连发（长按音量 / 连点方向键）时别把请求打成洪水
    if (now - S.forceAt < 200) {
      S.stateAt = 0;
      return;
    }
    S.forceAt = now;
  }
  // 上一发还在飞：这一轮直接放弃。上报只是锦上添花，
  // 断网时若排队等它，整条指令长轮询会被一起拖死。
  if (S.stateBusy) return;
  S.stateAt = now;
  S.stateBusy = true;
  const v = mainVideo();
  const docTitle = (document.title || '').replace(/\s*[-–|]\s*MFlixTV.*$/i, '').trim();
  const h = document.querySelector('h1');
  const bridge = window.__mflWatch;
  const ac = new AbortController();
  // 4 秒还没回来就当这发丢了：不能让一个挂住的 fetch 永远占着通道
  const killer = window.setTimeout(() => ac.abort(), 4000);
  try {
    const qs = new URLSearchParams({
      t: token,
      title: (h?.textContent || docTitle || '').slice(0, 120),
      sub: bridge && bridge.episodes.length > 0 ? `第 ${bridge.index + 1}/${bridge.episodes.length} 集` : '',
      playing: v && !v.paused && !v.ended ? '1' : '0',
      pos: String(v && Number.isFinite(v.currentTime) ? Math.round(v.currentTime) : 0),
      dur: String(v && Number.isFinite(v.duration) ? Math.round(v.duration) : 0),
      page: (window.location.pathname || '').slice(0, 200),
      // 音量 / 倍速 / 静音：遥控器上要能看见自己按到了多少
      vol: String(v ? Math.round((v.volume || 0) * 100) : 100),
      rate: String(v ? Math.round((v.playbackRate || 1) * 100) : 100),
      muted: v && v.muted ? '1' : '0',
      // 全屏状态：遥控页的按钮要跟着亮/灭，按了没生效也得看得出来
      fs: fsOn() ? '1' : '0',
    });
    // 空串也要发：离开播放页后遥控器上不能再留着上一部的集数
    if (bridge && bridge.episodes.length > 0) {
      qs.set('eps', packList(bridge.episodes, bridge.index));
      qs.set('lines', packList(bridge.lines.length > 0 ? bridge.lines : ['换源'], bridge.lineIndex));
    } else {
      qs.set('eps', '');
      qs.set('lines', '');
    }
    await fetch(`/api/rs/state?${qs.toString()}`, { cache: 'no-store', signal: ac.signal });
  } catch {
    /* 上报失败无所谓 */
  } finally {
    window.clearTimeout(killer);
    S.stateBusy = false;
  }
}

/** 执行完一条指令立刻把新状态推上去：遥控器上的暂停图标、音量、倍速不用等下一轮 */
function flushState() {
  const t = S.token;
  if (!t) return;
  void reportState(t, true);
}

async function tick() {
  const t = S.token;
  if (t) {
    try {
      const r = await fetch(`/api/rs/host?t=${t}&since=${S.since}&wait=${WAIT_MS}`, { cache: 'no-store' });
      if (r.status === 404) {
        // 会话过期（30 分钟或服务重启）：清掉，遥控器那边会提示已关闭
        S.token = '';
        S.url = '';
        S.since = 0;
        S.peers = 0;
        S.fails = 0;
        rememberSession('');
        emit();
      } else if (r.ok) {
        S.fails = 0;
        const d = (await r.json()) as {
          now: number;
          cmds: { id: number; cmd: string; arg: string }[];
          ctls: number;
        };
        // 刚接过会话的头一条回执：队列里的旧指令不再重放，只把序号对齐到当前
        const cmds = S.resume ? [] : d.cmds || [];
        S.resume = false;
        for (const c of cmds) {
          try {
            exec(c.cmd, c.arg);
          } catch {
            /* 单条失败不影响后面的 */
          }
          S.since = Math.max(S.since, c.id);
        }
        if (cmds.length > 0) flushState();
        S.since = Math.max(S.since, d.now || 0);
        if ((d.ctls || 0) !== S.peers) {
          S.peers = d.ctls || 0;
          S.hostAlive = true;
          emit();
        }
      } else {
        S.fails += 1;
      }
    } catch {
      // 断网 / 服务重启中：退避重试，不要 60ms 一次地空转打失败请求
      S.fails += 1;
    }
    // 上报只放出去，不等它：它挂住也不许拖慢指令链路
    void reportState(t);
  }
  const delay = S.fails > 0
    ? Math.min(FAIL_MAX_MS, POLL_MS * Math.pow(2, Math.min(5, S.fails)))
    : (S.token ? POLL_MS : 1000);
  S.timer = window.setTimeout(tick, delay);
}

/** 页面一挂载就调用；重复调用无副作用，会话一直跑着 */
export function start() {
  if (S.started) return;
  S.started = true;
  nav = installNav({
    selector: [
      'a[href]',
      'button',
      '[role="button"]',
      '[role="tab"]',
      'input',
      'select',
      'summary',
      // 用 div 撑起来、靠 onClick 点的元素（首页推荐条、日历格子、设置行）也要能聚焦，
      // 否则遥控器按到这些地方就是「选不到」
      '[tabindex="0"]',
      '[onclick]',
      '.ep',
      '.grp',
      '.cast',
    ].join(','),
  });
  // 刷新 / 直接打开深层页面：把上次那个会话码接回来。
  // 不接的话，手机上已经连上的遥控器会在被控端一刷新之后彻底失灵（会话还在服务端活着，
  // 只是这台页面没人来取指令了）。刷新后第一条回执只用来对齐序号，不重放旧指令。
  const saved = recallSession();
  if (saved.token && !S.token) {
    S.token = saved.token;
    S.url = saved.url;
    S.since = 0;
    S.peers = 0;
    S.resume = true;
    emit();
  }
  void tick();
}

/** 领一个新的会话码（点按钮时若还没有、或用户点「换一个码」） */
export async function create(): Promise<boolean> {
  if (S.busy) return false;
  S.busy = true;
  emit();
  try {
    const r = await fetch(`/api/rs/create?name=${encodeURIComponent(deviceName())}`, { cache: 'no-store' });
    if (!r.ok) return false;
    const d = (await r.json()) as { token: string; url: string };
    S.token = d.token;
    S.url = d.url;
    S.since = 0;
    S.peers = 0;
    S.hostAlive = true;
    S.resume = false;
    rememberSession(d.token, d.url);
    return true;
  } catch {
    return false;
  } finally {
    S.busy = false;
    emit();
  }
}

/** 面板开着时每 2.5 秒问一次「对方还在不在、连了几台遥控器」 */
export async function refreshInfo() {
  if (!S.token) return;
  try {
    const r = await fetch(`/api/rs/info?t=${S.token}`, { cache: 'no-store' });
    if (r.ok) {
      const d = (await r.json()) as { hostAlive: boolean; ctls: number };
      const alive = d.hostAlive !== false;
      const peers = d.ctls || 0;
      if (alive !== S.hostAlive || peers !== S.peers) {
        S.hostAlive = alive;
        S.peers = peers;
        emit();
      }
    }
  } catch {
    /* ignore */
  }
}

export function navHandle(): NavHandle | null {
  return nav;
}
