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

const S = {
  token: '',
  url: '',
  peers: 0,
  hostAlive: true,
  busy: false,
  since: 0,
  stateAt: 0,
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
      for (const el of allVideos()) el.volume = Math.min(1, Math.round((el.volume + 0.1) * 10) / 10);
      return;
    case 'voldown':
      for (const el of allVideos()) el.volume = Math.max(0, Math.round((el.volume - 0.1) * 10) / 10);
      return;
    case 'mute':
      for (const el of allVideos()) el.muted = !el.muted;
      return;
    case 'fullscreen': {
      if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => {});
        return;
      }
      // 优先点页面自己的全屏按钮：脚本直接调 requestFullscreen 不是用户手势，会被浏览器拒
      const btn = document.querySelector<HTMLElement>(
        '[data-rc-fullscreen],button[aria-label="全屏"],button[title="全屏"]'
      );
      if (btn) {
        btn.click();
        return;
      }
      const el = v || document.documentElement;
      void el.requestFullscreen?.().catch(() => {});
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

async function reportState(token: string) {
  const now = Date.now();
  if (now - S.stateAt < 1200) return;
  S.stateAt = now;
  const v = mainVideo();
  const docTitle = (document.title || '').replace(/\s*[-–|]\s*MFlixTV.*$/i, '').trim();
  const h = document.querySelector('h1');
  const bridge = window.__mflWatch;
  try {
    const qs = new URLSearchParams({
      t: token,
      title: (h?.textContent || docTitle || '').slice(0, 120),
      sub: bridge && bridge.episodes.length > 0 ? `第 ${bridge.index + 1}/${bridge.episodes.length} 集` : '',
      playing: v && !v.paused && !v.ended ? '1' : '0',
      pos: String(v && Number.isFinite(v.currentTime) ? Math.round(v.currentTime) : 0),
      dur: String(v && Number.isFinite(v.duration) ? Math.round(v.duration) : 0),
      page: (window.location.pathname || '').slice(0, 200),
    });
    // 空串也要发：离开播放页后遥控器上不能再留着上一部的集数
    if (bridge && bridge.episodes.length > 0) {
      qs.set('eps', packList(bridge.episodes, bridge.index));
      qs.set('lines', packList(bridge.lines.length > 0 ? bridge.lines : ['换源'], bridge.lineIndex));
    } else {
      qs.set('eps', '');
      qs.set('lines', '');
    }
    await fetch(`/api/rs/state?${qs.toString()}`, { cache: 'no-store' });
  } catch {
    /* 上报失败无所谓 */
  }
}

async function tick() {
  const t = S.token;
  if (t) {
    try {
      const r = await fetch(`/api/rs/host?t=${t}&since=${S.since}`, { cache: 'no-store' });
      if (r.status === 404) {
        // 会话过期（30 分钟或服务重启）：清掉，遥控器那边会提示已关闭
        S.token = '';
        S.url = '';
        S.since = 0;
        S.peers = 0;
        emit();
      } else if (r.ok) {
        const d = (await r.json()) as {
          now: number;
          cmds: { id: number; cmd: string; arg: string }[];
          ctls: number;
        };
        for (const c of d.cmds || []) {
          try {
            exec(c.cmd, c.arg);
          } catch {
            /* 单条失败不影响后面的 */
          }
          S.since = Math.max(S.since, c.id);
        }
        S.since = Math.max(S.since, d.now || 0);
        if ((d.ctls || 0) !== S.peers) {
          S.peers = d.ctls || 0;
          S.hostAlive = true;
          emit();
        }
      }
    } catch {
      /* 断网就下一轮再试 */
    }
    await reportState(t);
  }
  S.timer = window.setTimeout(tick, 1000);
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
      '.ep',
      '.grp',
      '.cast',
    ].join(','),
  });
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
