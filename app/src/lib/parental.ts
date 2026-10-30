'use client';

/**
 * 家长控制（电脑端）：密码 + 屏蔽词 + 限时时段。
 *
 * 存在本机 localStorage，不上传。语义和手机/电视端一致：
 *  - 命中屏蔽词的片子不出现在列表里（播放前还要密码）；
 *  - 限时时段内播放任何内容都要密码；
 *  - 输入正确密码后本浏览器 30 分钟内不再问（sessionStorage）。
 *
 * 定位很明确：这是「给家里小孩用的那台设备」加一道门槛，不是安全机制——
 * 会开浏览器控制台的人当然能绕过，真正的边界是不让小孩随手点开就播。
 */

export interface ParentalCfg {
  on: boolean;
  pin: string;
  kids: string[];
  from: number | null;
  to: number | null;
}

const KEY = 'mfl:parental';
const UNLOCK = 'mfl:punlock';
const UNLOCK_MS = 30 * 60 * 1000;

const EMPTY: ParentalCfg = { on: false, pin: '', kids: [], from: null, to: null };

export function readParental(): ParentalCfg {
  if (typeof window === 'undefined') return EMPTY;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const o = JSON.parse(raw) as Partial<ParentalCfg>;
    return {
      on: o.on === true,
      pin: typeof o.pin === 'string' ? o.pin : '',
      kids: Array.isArray(o.kids) ? o.kids.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [],
      from: typeof o.from === 'number' ? o.from : null,
      to: typeof o.to === 'number' ? o.to : null,
    };
  } catch {
    return EMPTY;
  }
}

export function writeParental(cfg: ParentalCfg) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(cfg));
  } catch {
    /* 隐私模式下写不进去就算了 */
  }
}

export function parentalUnlocked(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const t = Number(window.sessionStorage.getItem(UNLOCK) || 0);
    return Date.now() - t < UNLOCK_MS;
  } catch {
    return true;
  }
}

export function markParentalUnlocked() {
  try {
    window.sessionStorage.setItem(UNLOCK, String(Date.now()));
  } catch {
    /* 同上 */
  }
}

export function inBlockTime(cfg: ParentalCfg, at = new Date()): boolean {
  if (cfg.from == null || cfg.to == null) return false;
  const h = at.getHours();
  if (cfg.from === cfg.to) return false;
  return cfg.from < cfg.to ? h >= cfg.from && h < cfg.to : h >= cfg.from || h < cfg.to;
}

export function kidsHit(name: string, cfg: ParentalCfg): boolean {
  const n = (name || '').toLowerCase();
  return cfg.kids.some((k) => k && n.includes(k.toLowerCase()));
}

/** 这条内容现在该不该藏起来（列表过滤用） */
export function parentalHidden(name: string): boolean {
  const cfg = readParental();
  if (!cfg.on || parentalUnlocked()) return false;
  return kidsHit(name, cfg);
}

/** 这次播放要不要先要密码 */
export function parentalNeedsPin(title: string): boolean {
  const cfg = readParental();
  if (!cfg.on || parentalUnlocked()) return false;
  return kidsHit(title, cfg) || inBlockTime(cfg);
}
