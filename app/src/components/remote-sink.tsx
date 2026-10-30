'use client';

import { useCallback, useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';

/**
 * 遥控指令的「接收端」（挂在整个站点上）。
 *
 * 手机在同一网络打开网页版 → 点遥控 → 指令进 /api/remote 队列，
 * 这里每 0.8 秒取一次并执行。电脑端能做的事情和电视端不一样：
 * 播放控制、返回、回首页都走「合成键盘事件」——播放器本来就有这套快捷键，
 * 复用它们比自己再造一套播放器控制面稳得多；搜索遥控在电脑端不做
 * （首页搜索框是输入框，合成输入法事件不可靠），电视端才支持。
 */

function fireKey(key: string, code: string, keyCode: number, extra: KeyboardEventInit = {}) {
  const ev = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...extra });
  // 一部分老代码还在读 keyCode，补上再派发
  try {
    Object.defineProperty(ev, 'keyCode', { get: () => keyCode });
    Object.defineProperty(ev, 'which', { get: () => keyCode });
  } catch {
    /* 只读属性就别补了 */
  }
  (document.activeElement || document.body).dispatchEvent(ev);
  document.dispatchEvent(ev);
}

export function RemoteSink() {
  const router = useRouter();
  const pathname = usePathname();
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  const exec = useCallback(
    (cmd: string, arg: string) => {
      switch (cmd) {
        case 'play':
        case 'pause':
          fireKey(' ', 'Space', 32);
          return;
        case 'seek': {
          const n = Number(arg) || 15;
          fireKey(n > 0 ? 'ArrowRight' : 'ArrowLeft', n > 0 ? 'ArrowRight' : 'ArrowLeft', n > 0 ? 39 : 37);
          return;
        }
        case 'next':
          fireKey('ArrowRight', 'ArrowRight', 39, { altKey: true });
          return;
        case 'prev':
          fireKey('ArrowLeft', 'ArrowLeft', 37, { altKey: true });
          return;
        case 'ok':
          fireKey('Enter', 'Enter', 13);
          return;
        case 'up':
        case 'down':
        case 'left':
        case 'right': {
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
          router.back();
          return;
        case 'exit':
          router.push('/');
          return;
        case 'settings':
          // 顶栏的设置抽屉监听这个事件；电脑端没有 /settings 这个路由
          window.dispatchEvent(new CustomEvent('mfl:rc-settings'));
          return;
        default:
          return;
      }
    },
    [router]
  );

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let since = 0;
    let who = '';
    try {
      who = localStorage.getItem('mfl:rcid') || '';
      if (!who) {
        who = 'pc' + Math.random().toString(36).slice(2, 8);
        localStorage.setItem('mfl:rcid', who);
      }
    } catch {
      who = 'pc';
    }

    const tick = async () => {
      if (!alive) return;
      try {
        const r = await fetch(`/api/remote/poll?role=pc&since=${since}&who=${encodeURIComponent(who)}`);
        if (r.ok) {
          const d = (await r.json()) as { now: number; cmds: { id: number; cmd: string; arg: string }[] };
          for (const c of d.cmds || []) {
            try {
              exec(c.cmd, c.arg);
            } catch {
              /* 单条失败不影响后面的 */
            }
            since = Math.max(since, c.id);
          }
          since = Math.max(since, d.now || 0);
        }
      } catch {
        /* 服务重启 / 断网就下一轮再试 */
      }
      if (alive) timer = setTimeout(tick, 800);
    };
    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [exec]);

  return null;
}
