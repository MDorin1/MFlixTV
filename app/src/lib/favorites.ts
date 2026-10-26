'use client';

import { useEffect, useState } from 'react';

/**
 * 「我的清单」（收藏）。
 *
 * 不塞进 zustand store，也不新开 IndexedDB 表：收藏是一小撮扁平数据（通常几十条），
 * 放 localStorage 就够，还免了 store 的 persist 迁移和 Dexie 的版本升级——
 * 这两处都是「动一次要连带改 schema 和 migrate」的地方，为了一个收藏不值得冒险。
 * 用自定义事件在同一页面的多个组件之间同步，跨标签页用 storage 事件。
 */

export interface FavoriteItem {
  /** `db:<豆瓣id>` 或 `<源key>:<vodId>` —— 两种资料页共用一份清单 */
  key: string;
  title: string;
  cover: string;
  href: string;
  /** 收藏时间，倒序排列 */
  ts: number;
}

const STORAGE_KEY = 'mflixtv:favorites';
const EVENT = 'mflixtv:favorites-changed';

export function readFavorites(): FavoriteItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is FavoriteItem => Boolean(x && typeof x.key === 'string' && typeof x.href === 'string'))
      .sort((a, b) => b.ts - a.ts);
  } catch {
    return [];
  }
}

function writeFavorites(list: FavoriteItem[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* 配额满 / 隐私模式：静默失败，按钮状态仍会按返回值更新 */
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function isFavorite(key: string): boolean {
  return readFavorites().some((f) => f.key === key);
}

/** 切换收藏，返回切换后的状态（true = 已收藏） */
export function toggleFavorite(item: Omit<FavoriteItem, 'ts'>): boolean {
  const list = readFavorites();
  const exists = list.find((f) => f.key === item.key);
  if (exists) {
    writeFavorites(list.filter((f) => f.key !== item.key));
    return false;
  }
  writeFavorites([{ ...item, ts: Date.now() }, ...list]);
  return true;
}

/** 订阅收藏变化（同页自定义事件 + 跨标签页 storage 事件） */
export function useFavorites(): FavoriteItem[] {
  const [list, setList] = useState<FavoriteItem[]>([]);
  useEffect(() => {
    const sync = () => setList(readFavorites());
    sync();
    window.addEventListener(EVENT, sync);
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) sync();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return list;
}
