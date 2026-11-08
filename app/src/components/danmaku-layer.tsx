'use client';

import { useEffect, useRef } from 'react';
import type { DanmakuItem, DanmakuPrefs } from '@/lib/danmaku';

/**
 * 弹幕绘制层。
 *
 * 为什么用 canvas 而不是往 DOM 里塞 `<div>`：
 * - 一条一集上千条的弹幕，DOM 方案每次换集都要建/删上千节点，滚动时还会触发重排；
 * - 位置必须和 `video.currentTime` 严格同步（暂停就停、拖动就跟），
 *   CSS 动画的时间轴是独立的，暂停/拖动/倍速都要额外补丁，容易错位；
 * - canvas 里位置是每帧算出来的，暂停、倍速、回拖天然一致。
 *
 * 只读视频时间，不碰播放器与控制条：宿主是挂在 `.art-video-player` 里的一层
 * `pointer-events:none` 画布，z-index 低于原生控制条。
 */

interface ActiveItem {
  item: DanmakuItem;
  /** 视频时间轴上的出现时刻 */
  born: number;
  lane: number;
  /** 画布纵向位置（px，已含字号） */
  y: number;
  width: number;
  /** 滚动速度（px/秒），固定弹幕为 0 */
  speed: number;
  /** 固定弹幕的存活秒数 */
  life: number;
}

export interface DanmakuLayerProps {
  /** 宿主容器：播放器内部的浮层节点 */
  host: HTMLElement | null;
  /** 取当前 video 元素（播放器换源/换集不重建实例，用函数取最稳） */
  getVideo: () => HTMLVideoElement | null;
  items: DanmakuItem[];
  prefs: DanmakuPrefs;
  /** 关掉时不绘制（画布仍挂着，恢复时立刻可用） */
  active: boolean;
}

/** 滚动弹幕横穿屏幕的基准时长（秒），实际按宽度与速度缩放 */
const BASE_TRAVEL_SEC = 9;
/** 固定弹幕停留时长（秒） */
const FIXED_LIFE_SEC = 4.5;
/** 底部留给字幕/控制条的比例，弹幕不铺到这里，免得压字幕 */
const BOTTOM_RESERVED = 0.16;

export function DanmakuLayer({ host, getVideo, items, prefs, active }: DanmakuLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // 用一个 ref 保存当前帧需要的一切，避免每次 props 变化都重启 rAF 循环
  const stateRef = useRef({ items, prefs, active });
  stateRef.current = { items, prefs, active };

  useEffect(() => {
    if (!host) return;
    const canvas = document.createElement('canvas');
    canvas.setAttribute('data-lcs-danmaku', '');
    canvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:20;';
    host.appendChild(canvas);
    canvasRef.current = canvas;

    const ctx = canvas.getContext('2d');
    let dpr = 1;
    let width = 0;
    let height = 0;

    const resize = () => {
      const box = host.getBoundingClientRect();
      width = Math.max(1, Math.round(box.width));
      height = Math.max(1, Math.round(box.height));
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    observer?.observe(host);
    window.addEventListener('resize', resize);

    const active: ActiveItem[] = [];
    let cursor = 0;
    let lastTime = -1;
    // 每条泳道的「再来一条不会被压住」的时间点
    let scrollLaneFree: number[] = [];
    let topLaneFree: number[] = [];
    let bottomLaneFree: number[] = [];
    let laneHeight = 24;
    /**
     * 同一句话的重复弹幕：B 站上「辛苦了」「前方高能」会被刷屏几百条，
     * 全画出来就是一块糊住画面的色块。8 秒内同一句只放一条。
     */
    const recentText = new Map<string, number>();
    /** 每秒出场上限：弹幕最密的段落也不会把画面糊死 */
    let spawnSecond = -1;
    let spawnedThisSecond = 0;
    /** 顶部/底部固定弹幕的节奏：B 站剧集里底部口令弹幕能堆成一块，单独限流 */
    let lastFixedAt = -10;

    const resetLanes = (lanes: number) => {
      scrollLaneFree = new Array(lanes).fill(0);
      topLaneFree = new Array(lanes).fill(0);
      bottomLaneFree = new Array(lanes).fill(0);
    };

    const fontOf = (item: DanmakuItem) => {
      const base = Math.max(14, Math.min(30, width / 78));
      return Math.round(base * stateRef.current.prefs.fontScale * item.size);
    };

    const measure = (text: string, fontPx: number) => {
      if (!ctx) return text.length * fontPx * 0.62;
      ctx.font = `700 ${fontPx}px "PingFang SC", "Microsoft YaHei", sans-serif`;
      return ctx.measureText(text).width;
    };

    /** 把指针移到「第一条时间 >= t 的弹幕」：回拖/跳集后不会补放一堆旧弹幕 */
    const seekCursor = (t: number) => {
      let lo = 0;
      let hi = stateRef.current.items.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (stateRef.current.items[mid].time < t) lo = mid + 1;
        else hi = mid;
      }
      cursor = lo;
    };

    const spawn = (item: DanmakuItem, now: number, scrollLanes: number) => {
      const prefsNow = stateRef.current.prefs;
      const fontPx = fontOf(item);
      const textWidth = measure(item.text, fontPx);
      const region = prefsNow.area;

      if (item.mode === 4 || item.mode === 5) {
        const fixed = item.mode === 5;
        // 固定弹幕太密会叠成一块色块（剧集的「辛苦了」口令），限到 0.4 秒一条
        if (now - lastFixedAt < 0.4) return;
        lastFixedAt = now;
        const lanes = fixed ? topLaneFree : bottomLaneFree;
        // 固定弹幕从顶部/底部往中间排，最多占 3 行
        const maxLanes = Math.min(3, lanes.length);
        let lane = -1;
        for (let i = 0; i < maxLanes; i++) {
          if (lanes[i] <= now) { lane = i; break; }
        }
        if (lane < 0) return;
        lanes[lane] = now + FIXED_LIFE_SEC * 0.6;
        const topLimit = height * (region === 'bottom' ? 1 - BOTTOM_RESERVED : 0.42);
        const bottomLimit = height * (region === 'top' ? 0.42 : 1 - BOTTOM_RESERVED);
        const y = fixed
          ? topLimit * 0.9 - lane * laneHeight + laneHeight
          : Math.min(bottomLimit, height - BOTTOM_RESERVED * height) - lane * laneHeight - 6;
        active.push({
          item,
          born: now,
          lane,
          y: Math.round(y),
          width: textWidth,
          speed: 0,
          life: FIXED_LIFE_SEC,
        });
        return;
      }

      // 滚动弹幕
      const topLimit = height * (region === 'bottom' ? 1 - BOTTOM_RESERVED - 0.28 : 0.1);
      const bottomLimit = height * (region === 'top' ? 0.42 : 1 - BOTTOM_RESERVED);
      const usable = Math.max(laneHeight, bottomLimit - topLimit);
      const lanes = Math.min(scrollLanes, Math.max(1, Math.floor(usable / laneHeight)));
      const speed = (width + textWidth) / (BASE_TRAVEL_SEC / prefsNow.speed);
      let lane = -1;
      for (let i = 0; i < lanes; i++) {
        if (scrollLaneFree[i] <= now) { lane = i; break; }
      }
      // 全都占着：挑最早空出来的那条，宁可轻微重叠也别丢弹幕（丢了会显得「弹幕很少」）
      if (lane < 0) return;
      // 这条弹幕完全进入画面需要的秒数：等它再放同一条泳道就不会追尾
      scrollLaneFree[lane] = now + Math.max(0.5, (textWidth + 40) / speed);
      active.push({
        item,
        born: now,
        lane,
        y: Math.round(topLimit + lane * laneHeight),
        width: textWidth,
        speed,
        life: 0,
      });
    };

    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (!ctx) return;
      const { items: list, prefs: nowPrefs, active: isActive } = stateRef.current;
      const video = getVideo();
      const t = video ? video.currentTime : 0;

      // 字号依赖设置，及时更新泳道高度
      laneHeight = Math.max(20, Math.round(Math.max(14, Math.min(30, width / 78)) * nowPrefs.fontScale) + 8);
      const scrollLanes = Math.max(1, Math.min(24, nowPrefs.density));
      if (!scrollLaneFree.length) resetLanes(scrollLanes);

      if (!isActive || !video) {
        ctx.clearRect(0, 0, width, height);
        active.length = 0;
        lastTime = t;
        return;
      }

      // 跳转（含换集、回拖）：清空并重新定位，旧位置残留会像「弹幕堆在左边缘」
      if (lastTime < 0 || Math.abs(t - lastTime) > 1.5) {
        active.length = 0;
        resetLanes(scrollLanes);
        recentText.clear();
        spawnSecond = -1;
        spawnedThisSecond = 0;
        seekCursor(t);
      }
      lastTime = t;

      // 每帧最多补 40 条：从暂停状态恢复或跳进密集段时，别一次塞进几百条
      const perSecond = Math.max(8, Math.min(40, Math.round(nowPrefs.density * 0.6)));
      const second = Math.floor(t);
      if (second !== spawnSecond) {
        spawnSecond = second;
        spawnedThisSecond = 0;
      }

      let budget = 40;
      while (cursor < list.length && list[cursor].time <= t && budget-- > 0 && spawnedThisSecond < perSecond) {
        const item = list[cursor];
        cursor++;
        // 弹幕时间戳可能比当前时间早很多（拖动后进入旧区段）：超过 3 秒的不补
        if (t - item.time >= 3) continue;
        // 同一句话 8 秒内只放一条：刷屏式弹幕不该糊满画面
        const last = recentText.get(item.text);
        if (last !== undefined && t - last < 8) continue;
        recentText.set(item.text, t);
        if (recentText.size > 400) {
          // 只留最近的一段，防止长片把 Map 撑大
          for (const [key, at] of recentText) {
            if (t - at > 12) recentText.delete(key);
          }
        }
        spawn(item, t, scrollLanes);
        spawnedThisSecond++;
      }

      ctx.clearRect(0, 0, width, height);

      for (let i = active.length - 1; i >= 0; i--) {
        const entry = active[i];
        const fontPx = fontOf(entry.item);
        let x: number;
        if (entry.speed > 0) {
          const elapsed = t - entry.born;
          x = width - entry.speed * elapsed;
          if (x + entry.width < 0 || elapsed < 0) {
            active.splice(i, 1);
            continue;
          }
        } else {
          const elapsed = t - entry.born;
          if (elapsed > entry.life || elapsed < 0) {
            active.splice(i, 1);
            continue;
          }
          x = (width - entry.width) / 2;
        }

        const baseAlpha = nowPrefs.opacity;
        const fade = entry.speed > 0 ? 1 : Math.min(1, Math.max(0, (entry.life - (t - entry.born)) / 0.6));
        ctx.globalAlpha = Math.max(0, Math.min(1, baseAlpha * fade));
        ctx.font = `700 ${fontPx}px "PingFang SC", "Microsoft YaHei", sans-serif`;
        ctx.textBaseline = 'top';
        ctx.lineWidth = Math.max(2, fontPx / 9);
        ctx.strokeStyle = 'rgba(0,0,0,.82)';
        ctx.strokeText(entry.item.text, x, entry.y);
        ctx.fillStyle = entry.item.color;
        ctx.fillText(entry.item.text, x, entry.y);
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
      window.removeEventListener('resize', resize);
      canvas.remove();
      canvasRef.current = null;
    };
  }, [host, getVideo]);

  return null;
}
