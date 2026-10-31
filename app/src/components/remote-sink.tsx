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
        case 'toggle':
          fireKey(' ', 'Space', 32);
          return;
        case 'seek': {
          const n = Number(arg) || 15;
          fireKey(n > 0 ? 'ArrowRight' : 'ArrowLeft', n > 0 ? 'ArrowRight' : 'ArrowLeft', n > 0 ? 39 : 37);
          return;
        }
        // 遥控端还有「快退 10s / 快进 10s / 拖进度条」三种粒度（和安卓端 rc-host 同一套命令名）
        case 'seekb': {
          const n = Math.abs(Number(arg) || 10);
          for (let i = 0; i < Math.max(1, Math.round(n / 10)); i += 1) {
            fireKey('ArrowLeft', 'ArrowLeft', 37);
          }
          return;
        }
        case 'seekf': {
          const n = Math.abs(Number(arg) || 10);
          for (let i = 0; i < Math.max(1, Math.round(n / 10)); i += 1) {
            fireKey('ArrowRight', 'ArrowRight', 39);
          }
          return;
        }
        case 'seekto': {
          // 键盘快捷键只能相对跳，绝对位置要靠播放器自己接：派事件给播放页
          const to = Number(arg);
          if (Number.isFinite(to) && to >= 0) {
            window.dispatchEvent(new CustomEvent('mfl:rc-seekto', { detail: to }));
          }
          return;
        }
        case 'volup':
          fireKey('ArrowUp', 'ArrowUp', 38);
          return;
        case 'voldown':
          fireKey('ArrowDown', 'ArrowDown', 40);
          return;
        case 'mute':
          fireKey('m', 'KeyM', 77);
          return;
        case 'rateup':
          fireKey('.', 'Period', 190);
          return;
        case 'ratedown':
          fireKey(',', 'Comma', 188);
          return;
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
        case 'fullscreen':
          fireKey('f', 'KeyF', 70);
          return;
        case 'back':
          router.back();
          return;
        case 'exit':
          router.push('/');
          return;
        case 'settings':
        case 'menu':
          // 顶栏的设置抽屉监听这个事件；电脑端没有 /settings 这个路由
          // （旧面板 remote-pad 上的「菜单」发的是 menu，以前落到 default 被丢掉）
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
    /** 连续失败次数：断网时退避，恢复后立刻回到 800ms */
    let fails = 0;
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
          fails = 0;
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
        } else {
          fails += 1;
        }
      } catch {
        // 服务重启 / 断网：退避重试，不拿 800ms 一次的节奏去打失败请求
        fails += 1;
      }
      if (alive) {
        const delay = fails > 0 ? Math.min(1800, 800 * Math.pow(2, Math.min(3, fails))) : 800;
        timer = setTimeout(tick, delay);
      }
    };
    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [exec]);

  return null;
}
