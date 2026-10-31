/**
 * 播放器偏好记忆：音量、静音、倍速、画面亮度。
 *
 * 以前每进一次播放器都从 80% 音量、1.0 倍速开始：
 * - 夜里看剧时上一集刚把音量调到 25%，换集又炸回来；
 * - 看倍速剧的人每集都要重设 1.5 倍；
 * - 手机上觉得画面偏亮/偏暗，调完换一集就丢了。
 * 这里统一存 localStorage 一份，换集、换片、重启浏览器都沿用上次的设定。
 *
 * 亮度是我们自己在 video 元素上叠的 CSS filter（不改片源、不改解码），
 * 所以只在本地生效，不影响下载与投屏。
 */

const STORAGE_KEY = 'mfl:player:prefs';

export interface PlayerPrefs {
  /** 0 ~ 1 */
  volume: number;
  muted: boolean;
  /** 0.5 ~ 3 */
  rate: number;
  /** 0.3 ~ 1（1 = 原始亮度） */
  brightness: number;
}

export const RATE_MIN = 0.5;
export const RATE_MAX = 3;
export const RATE_STEP = 0.25;
export const BRIGHT_MIN = 0.3;
export const BRIGHT_MAX = 1;

export const DEFAULT_PREFS: PlayerPrefs = {
  volume: 0.8,
  muted: false,
  rate: 1,
  brightness: BRIGHT_MAX,
};

/** 数值夹取（局部比较用，避免每次调用都建闭包） */
export function clampNum(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** 倍速对齐到 0.25 档，并夹在允许区间内 */
export function normalizeRate(rate: number): number {
  const stepped = Math.round(rate / RATE_STEP) * RATE_STEP;
  return Math.round(clampNum(stepped, RATE_MIN, RATE_MAX) * 100) / 100;
}

const num = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? clampNum(value, min, max) : fallback;

/** 模块级缓存：同一标签页内多次读走内存，避免每集解析一遍 JSON */
let cached: PlayerPrefs | null = null;

export function readPlayerPrefs(): PlayerPrefs {
  if (cached) return { ...cached };
  if (typeof window === 'undefined') return { ...DEFAULT_PREFS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cached = { ...DEFAULT_PREFS };
      return { ...cached };
    }
    const parsed = JSON.parse(raw) as Partial<PlayerPrefs> | null;
    cached = {
      volume: num(parsed?.volume, DEFAULT_PREFS.volume, 0, 1),
      muted: parsed?.muted === true,
      rate: normalizeRate(num(parsed?.rate, DEFAULT_PREFS.rate, RATE_MIN, RATE_MAX)),
      brightness: num(parsed?.brightness, DEFAULT_PREFS.brightness, BRIGHT_MIN, BRIGHT_MAX),
    };
    return { ...cached };
  } catch {
    // 隐私模式 / 存储被禁用 / 旧数据坏掉：一律退回默认值，绝不因为记忆功能把播放器搞崩
    cached = { ...DEFAULT_PREFS };
    return { ...cached };
  }
}

export function savePlayerPrefs(patch: Partial<PlayerPrefs>): PlayerPrefs {
  const next: PlayerPrefs = { ...readPlayerPrefs(), ...patch };
  // 音量/亮度只留两位小数：0.7000000000000001 这种浮点尾巴存进去很难看，
  // 而且每次读出来再比较都判不相等
  next.volume = Math.round(clampNum(next.volume, 0, 1) * 100) / 100;
  next.rate = normalizeRate(next.rate);
  next.brightness = Math.round(clampNum(next.brightness, BRIGHT_MIN, BRIGHT_MAX) * 100) / 100;
  next.muted = next.muted === true;
  cached = next;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* 写不进去就算了，内存值仍然生效 */
    }
  }
  return { ...next };
}
