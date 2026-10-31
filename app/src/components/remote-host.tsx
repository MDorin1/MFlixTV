'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePathname, useRouter } from 'next/navigation';
import { copyToClipboard } from '@/lib/clipboard';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';

/**
 * 「扫一扫当遥控器」的被控端。
 *
 * 每个打开网页的标签页都是一个独立的会话：点右上角遥控按钮，
 * 这里向服务端领一个 6 位 token，把 http://本机IP:端口/rc?t=TOKEN 做成二维码。
 * 另一台手机扫码打开的就是遥控器页面，只会控制「这个标签页」，
 * 不影响同一服务上的其它设备（电视、别人的手机、另一台电脑的浏览器）。
 *
 * 指令执行优先直接控制 <video>，找不到视频（首页、详情页）时退回合成键盘事件，
 * 复用页面本来就有的快捷键，不另造一套。
 */

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

function mainVideo(): HTMLVideoElement | null {
  const all = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
  if (all.length === 0) return null;
  const playing = all.find((v) => !v.paused && v.currentTime > 0);
  if (playing) return playing;
  return all.sort((a, b) => (b.duration || 0) - (a.duration || 0))[0];
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

export function RemoteHost({ className }: { className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const pathRef = useRef(pathname);
  pathRef.current = pathname;
  const { toast } = useToast();

  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [token, setToken] = useState('');
  const [url, setUrl] = useState('');
  const [peers, setPeers] = useState(0);
  const [busy, setBusy] = useState(false);
  const [hostAlive, setHostAlive] = useState(true);

  const tokenRef = useRef('');
  const sinceRef = useRef(0);

  useEffect(() => {
    setMounted(true);
  }, []);

  const exec = useCallback(
    (cmd: string, arg: string) => {
      const v = mainVideo();
      const num = Number(arg);
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
          if (v && Number.isFinite(v.duration)) v.currentTime = Math.max(0, v.currentTime - (Number.isFinite(num) && num ? num : 10));
          else fireKey('ArrowLeft', 'ArrowLeft', 37);
          return;
        case 'seekf':
          if (v && Number.isFinite(v.duration)) v.currentTime = Math.min(v.duration, v.currentTime + (Number.isFinite(num) && num ? num : 10));
          else fireKey('ArrowRight', 'ArrowRight', 39);
          return;
        case 'seekto':
          if (v && Number.isFinite(v.duration) && Number.isFinite(num)) v.currentTime = Math.max(0, Math.min(v.duration, num));
          return;
        case 'volup':
          if (v) v.volume = Math.min(1, Math.round((v.volume + 0.1) * 10) / 10);
          return;
        case 'voldown':
          if (v) v.volume = Math.max(0, Math.round((v.volume - 0.1) * 10) / 10);
          return;
        case 'mute':
          if (v) v.muted = !v.muted;
          return;
        case 'fullscreen': {
          const el = v || document.documentElement;
          if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
          else void el.requestFullscreen?.().catch(() => {});
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
        case 'home':
          router.push('/');
          return;
        case 'settings':
          window.dispatchEvent(new CustomEvent('mfl:rc-settings'));
          return;
        default:
          return;
      }
    },
    [router]
  );

  // 领一个会话：每次点按钮都重新领，避免拿着一个早就过期的 token
  const create = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/rs/create?name=${encodeURIComponent(deviceName())}`, { cache: 'no-store' });
      if (!r.ok) {
        toast('遥控会话创建失败，检查一下服务是否正常', 'error');
        return;
      }
      const d = (await r.json()) as { token: string; url: string };
      tokenRef.current = d.token;
      sinceRef.current = 0;
      setToken(d.token);
      setUrl(d.url);
      setHostAlive(true);
    } catch {
      toast('连不上服务', 'error');
    } finally {
      setBusy(false);
    }
  }, [toast]);

  // 被控端循环：取指令 + 执行 + 上报自己的播放状态
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stateAt = 0;

    const tick = async () => {
      if (!alive) return;
      const t = tokenRef.current;
      if (t) {
        try {
          const r = await fetch(`/api/rs/host?t=${t}&since=${sinceRef.current}`, { cache: 'no-store' });
          if (r.status === 404) {
            // 会话过期：安静地换一个，用户不用管
            tokenRef.current = '';
            setToken('');
            sinceRef.current = 0;
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
              sinceRef.current = Math.max(sinceRef.current, c.id);
            }
            sinceRef.current = Math.max(sinceRef.current, d.now || 0);
            setPeers(d.ctls || 0);
          }
        } catch {
          /* 断网就下一轮再试 */
        }

        // 上报状态（遥控器那边要显示片名和进度）
        const now = Date.now();
        if (now - stateAt > 1200) {
          stateAt = now;
          const v = mainVideo();
          const title = (document.title || '').replace(/\s*[-–|]\s*MFlixTV.*$/i, '').trim();
          const h = document.querySelector('h1');
          try {
            const qs = new URLSearchParams({
              t,
              title: (h?.textContent || title || '').slice(0, 120),
              sub: '',
              playing: v && !v.paused && !v.ended ? '1' : '0',
              pos: String(v && Number.isFinite(v.currentTime) ? Math.round(v.currentTime) : 0),
              dur: String(v && Number.isFinite(v.duration) ? Math.round(v.duration) : 0),
              page: pathRef.current || '',
            });
            await fetch(`/api/rs/state?${qs.toString()}`, { cache: 'no-store' });
          } catch {
            /* 上报失败无所谓 */
          }
        }
      }
      if (alive) timer = setTimeout(tick, 1000);
    };

    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [exec]);

  // 面板开着才探测对方是否还在
  useEffect(() => {
    if (!open || !token) return;
    let alive = true;
    const probe = async () => {
      if (!alive) return;
      try {
        const r = await fetch(`/api/rs/info?t=${token}`, { cache: 'no-store' });
        if (r.ok) {
          const d = (await r.json()) as { hostAlive: boolean; ctls: number };
          setHostAlive(d.hostAlive !== false);
          setPeers(d.ctls || 0);
        }
      } catch {
        /* ignore */
      }
    };
    probe();
    const iv = setInterval(probe, 2500);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [open, token]);

  // 关面板不销毁会话：遥控器还能继续用
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  const qr = url ? `/api/lan/qr?u=${encodeURIComponent(url)}` : '';

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          if (!tokenRef.current) void create();
        }}
        title="用另一台手机扫码当遥控器，控制当前这个页面"
        className={cn(
          'items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted shrink-0 whitespace-nowrap',
          'hover:text-content hover:bg-hover transition-colors flex',
          className
        )}
      >
        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
          <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
          <circle cx="12" cy="7" r="1.6" />
          <path d="M10 12h4M10 15.5h4M12 18.5h.01" strokeLinecap="round" />
        </svg>
        <span className="hidden md:inline">遥控器</span>
        {peers > 0 && (
          <span className="ml-0.5 rounded-full bg-accent/15 text-accent px-1.5 py-px text-[10px] tabular-nums">{peers}</span>
        )}
      </button>

      {mounted && open
        ? createPortal(
            <div className="fixed inset-0 z-[85] flex items-center justify-center p-4">
              <div className="absolute inset-0 bg-black/72 backdrop-blur-sm animate-fade-in" onClick={() => setOpen(false)} aria-hidden />
              <div
                role="dialog"
                aria-modal="true"
                aria-label="扫码当遥控器"
                className="relative bg-surface-raised rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden animate-slide-up border border-line/60"
              >
                <div className="flex items-start justify-between gap-3 px-5 pt-5">
                  <div>
                    <h2 className="text-base font-semibold text-content">拿另一台手机扫这个码</h2>
                    <p className="text-xs text-muted mt-1 leading-relaxed">
                      扫完它就是个遥控器，只控制<strong className="text-content">你现在打开的这个页面</strong>，
                      不影响同一网络下的电视和别人的手机。
                    </p>
                  </div>
                  <button
                    onClick={() => setOpen(false)}
                    className="shrink-0 w-7 h-7 rounded-md grid place-items-center text-muted hover:text-content hover:bg-hover transition-colors"
                    aria-label="关闭"
                  >
                    ✕
                  </button>
                </div>

                <div className="px-5 py-4">
                  <div className="mx-auto w-[220px] h-[220px] rounded-xl bg-white p-2.5 shadow-inner">
                    {busy || !qr ? (
                      <div className="w-full h-full grid place-items-center text-xs text-neutral-500">正在生成…</div>
                    ) : (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img src={qr} alt="遥控器二维码" className="w-full h-full object-contain" />
                    )}
                  </div>

                  <div className="mt-4 space-y-2">
                    <div className="flex items-center gap-2">
                      <input
                        readOnly
                        value={url || '正在生成…'}
                        className="flex-1 min-w-0 rounded-lg bg-surface border border-line/60 px-2.5 py-2 text-[12px] font-mono text-muted"
                      />
                      <button
                        onClick={async () => {
                          if (!url) return;
                          const ok = await copyToClipboard(url);
                          toast(ok ? '链接已复制' : '复制失败，手动选一下', ok ? 'success' : 'error');
                        }}
                        className="shrink-0 rounded-lg bg-hover hover:bg-line/60 px-3 py-2 text-xs text-content transition-colors"
                      >
                        复制
                      </button>
                    </div>

                    <div className="flex items-center justify-between text-[11px] text-muted">
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className={cn('inline-block w-1.5 h-1.5 rounded-full', hostAlive ? 'bg-accent' : 'bg-red-500')}
                          aria-hidden
                        />
                        {peers > 0 ? `已连 ${peers} 台遥控器` : '等待扫码'}
                      </span>
                      <button
                        onClick={() => void create()}
                        className="text-muted hover:text-content transition-colors"
                      >
                        换一个码
                      </button>
                    </div>
                  </div>

                  <p className="mt-4 text-[11px] leading-relaxed text-muted/80">
                    扫码后能做：播放/暂停、快退快进、拖进度、音量、上一集下一集、返回、回首页。
                    关掉这个面板不影响遥控，关掉页面就不行了。
                  </p>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
