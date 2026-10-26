/**
 * zustand persist 用的节流 localStorage 包装（独立成模块的原因：
 * db.ts 的 importConfig 需要 flush 节流缓冲，而运行时依赖方向是 store → db，
 * db.ts 不能反向 import store，故把两者共用的存储逻辑放在这个无依赖的底层模块）。
 */

import type { StateStorage } from 'zustand/middleware';

/** store 持久化在 localStorage 中的键（store.ts 的 persist name 与 importConfig 共用） */
export const PERSIST_KEY = 'mflixtv-settings';

/**
 * 品牌改名的兼容层：旧版把设置/主题/收藏都存在 `lihongguotv-*` / `lihongguotv:*` 下，
 * 直接在模块顶层搬一次（此时 store 还没创建，persist 读到的就是搬完后的新键），
 * 否则改名等于把用户的点播源、勾选状态、收藏全部清空。
 */
function migrateLegacyStorage(): void {
  if (typeof window === 'undefined') return;
  try {
    const legacy: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith('lihongguotv')) legacy.push(key);
    }
    for (const key of legacy) {
      const next = key.replace(/^lihongguotv/, 'mflixtv');
      const value = window.localStorage.getItem(key);
      if (value !== null && window.localStorage.getItem(next) === null) {
        window.localStorage.setItem(next, value);
      }
      window.localStorage.removeItem(key);
    }
  } catch {
    /* 隐私模式 / 配额满：搬不动就算了，继续用默认值 */
  }
}
migrateLegacyStorage();

/** 节流窗口：搜索/测活等高频 set 合并为 800ms 一次落盘 */
const THROTTLE_MS = 800;

let timer: ReturnType<typeof setTimeout> | null = null;
let pending: [string, string] | null = null;

function flush(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!pending) return;
  const [key, value] = pending;
  pending = null;
  try {
    localStorage.setItem(key, value);
  } catch {
    // 配额不足 / 隐私模式下静默放弃持久化，内存态仍可用
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('beforeunload', flush);
}

/**
 * 立即落盘缓冲中的待写状态。
 * importConfig 直接写 localStorage 前必须先调用，否则缓冲中的旧状态
 * 会在导入后 flush 覆盖刚写入的配置（竞态见 db.ts importConfig）。
 */
export function flushPendingPersist(): void {
  flush();
}

/**
 * 节流写入的 localStorage 包装。
 * 搜索会逐源写健康度、测活每 200ms 合并写回，这些都会触发 persist 的整份序列化 + 写盘；
 * 这里把写入合并为 800ms 一次，并在页面隐藏/卸载时立即 flush，确保不丢最后一次修改。
 */
export function createThrottledStorage(): StateStorage {
  return {
    getItem: (name) => {
      try {
        return localStorage.getItem(name);
      } catch {
        return null;
      }
    },
    setItem: (name, value) => {
      pending = [name, value];
      if (!timer) timer = setTimeout(flush, THROTTLE_MS);
    },
    removeItem: (name) => {
      try {
        localStorage.removeItem(name);
      } catch {
        // 忽略
      }
    },
  };
}
