'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 扫码后手机打开的就是这一页：一个只控制「发起方那个页面会话」的遥控器。
 *
 * token 从 URL 的 ?t= 里来，30 分钟有效；全程只发到发起方所在的这台服务上，
 * 不经过任何外部服务器。被控端每秒来取一次指令，这里 1.2 秒取一次它的播放状态。
 */

interface State {
  title: string;
  sub: string;
  playing: boolean;
  pos: number;
  dur: number;
  page: string;
}

interface CtlResp {
  ok: boolean;
  name: string;
  state: State;
  hostAlive: boolean;
  ctls: number;
}

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

function who(): string {
  const k = 'mfl:ctlid';
  try {
    const v = localStorage.getItem(k);
    if (v) return v;
    const n = 'c' + Math.random().toString(36).slice(2, 9);
    localStorage.setItem(k, n);
    return n;
  } catch {
    return 'c0';
  }
}

export default function RemoteControlPage() {
  const [token, setToken] = useState('');
  const [info, setInfo] = useState<CtlResp | null>(null);
  const [gone, setGone] = useState(false);
  const [vibrate, setVibrate] = useState(true);
  const [drag, setDrag] = useState<number | null>(null);
  const dragRef = useRef<number | null>(null);
  dragRef.current = drag;
  const whoRef = useRef('');
  const sentAt = useRef(0);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setToken((q.get('t') || '').toUpperCase());
    whoRef.current = who();
  }, []);

  // 拉被控端状态
  useEffect(() => {
    if (!token) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!alive) return;
      try {
        const r = await fetch(`/api/rs/ctl?t=${token}&who=${encodeURIComponent(whoRef.current)}`, { cache: 'no-store' });
        if (r.status === 404) {
          setGone(true);
        } else if (r.ok) {
          setInfo((await r.json()) as CtlResp);
          setGone(false);
        }
      } catch {
        /* 断网就下一轮再试 */
      }
      if (alive) timer = setTimeout(tick, 1200);
    };
    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [token]);

  const send = useCallback(
    async (cmd: string, arg = '') => {
      if (!token) return;
      if (vibrate && 'vibrate' in navigator) {
        try {
          navigator.vibrate?.(8);
        } catch {
          /* 有些浏览器不允许 */
        }
      }
      sentAt.current = Date.now();
      try {
        await fetch(
          `/api/rs/cmd?t=${encodeURIComponent(token)}&cmd=${encodeURIComponent(cmd)}&arg=${encodeURIComponent(arg)}`,
          { cache: 'no-store' }
        );
      } catch {
        /* 网络抖动忽略，用户会再按一次 */
      }
    },
    [token, vibrate]
  );

  const st = info?.state;
  const playing = !!st?.playing;
  const pos = drag ?? st?.pos ?? 0;
  const dur = st?.dur ?? 0;
  const alive = info?.hostAlive !== false;

  const btn =
    'select-none touch-manipulation rounded-xl bg-white/[0.06] active:bg-white/20 transition-colors grid place-items-center text-content';

  return (
    <div className="min-h-dvh bg-[#0a0a0d] text-white flex flex-col">
      <header className="px-4 pt-4 pb-2 flex items-center gap-2">
        <span
          className={`inline-block w-2 h-2 rounded-full ${alive ? 'bg-emerald-400' : 'bg-red-500'}`}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold truncate">
            {info?.name ? `正在遥控 ${info.name}` : '正在连接…'}
          </div>
          <div className="text-[11px] text-white/45 truncate">
            {gone ? '这个会话已经关闭' : alive ? '遥控已连接' : '对方页面可能已关闭'}
          </div>
        </div>
        <button
          onClick={() => setVibrate((v) => !v)}
          className="shrink-0 rounded-lg px-2.5 py-1.5 text-[11px] text-white/60 bg-white/[0.06] active:bg-white/20"
        >
          {vibrate ? '震动 开' : '震动 关'}
        </button>
      </header>

      <div className="px-4 pb-3">
        <div className="rounded-xl bg-white/[0.05] px-3 py-2.5">
          <div className="text-[13px] font-medium truncate">{st?.title || '—'}</div>
          <div className="mt-1.5 flex items-center gap-2 text-[11px] tabular-nums text-white/50">
            <span>{fmt(pos)}</span>
            <input
              type="range"
              min={0}
              max={Math.max(1, Math.floor(dur))}
              step={1}
              value={Math.min(pos, Math.max(1, Math.floor(dur)))}
              disabled={!dur || gone}
              onChange={(e) => setDrag(Number(e.target.value))}
              onPointerUp={() => {
                const v = dragRef.current;
                if (v != null) void send('seekto', String(v));
                setTimeout(() => setDrag(null), 400);
              }}
              onTouchEnd={() => {
                const v = dragRef.current;
                if (v != null) void send('seekto', String(v));
                setTimeout(() => setDrag(null), 400);
              }}
              className="flex-1 accent-white"
              aria-label="进度"
            />
            <span>{fmt(dur)}</span>
          </div>
        </div>
      </div>

      <div className="px-4 flex items-center justify-center gap-3">
        <button className={`${btn} w-14 h-14`} onClick={() => void send('seekb', '10')} aria-label="快退 10 秒">
          <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <path d="M11 7l-5 5 5 5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M18 7l-5 5 5 5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <button
          className="select-none touch-manipulation w-20 h-20 rounded-full bg-white text-black grid place-items-center active:scale-95 transition-transform"
          onClick={() => void send('toggle')}
          aria-label={playing ? '暂停' : '播放'}
        >
          {playing ? (
            <svg viewBox="0 0 24 24" className="w-8 h-8" fill="currentColor" aria-hidden>
              <rect x="6" y="5" width="4" height="14" rx="1.2" />
              <rect x="14" y="5" width="4" height="14" rx="1.2" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" className="w-8 h-8 ml-1" fill="currentColor" aria-hidden>
              <path d="M8 5.5v13l11-6.5z" />
            </svg>
          )}
        </button>

        <button className={`${btn} w-14 h-14`} onClick={() => void send('seekf', '10')} aria-label="快进 10 秒">
          <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <path d="M6 7l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M13 7l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <div className="px-4 mt-3 flex items-center justify-center gap-3 text-[12px]">
        <button className={`${btn} h-11 px-4`} onClick={() => void send('prev')}>
          上一集
        </button>
        <button className={`${btn} h-11 px-4`} onClick={() => void send('next')}>
          下一集
        </button>
        <button className={`${btn} h-11 px-4`} onClick={() => void send('fullscreen')}>
          全屏
        </button>
      </div>

      <div className="px-4 mt-4">
        <div className="mx-auto w-[196px] grid grid-cols-3 grid-rows-3 gap-2">
          <span />
          <button className={`${btn} h-14`} onClick={() => void send('up')} aria-label="上">
            ▲
          </button>
          <span />
          <button className={`${btn} h-14`} onClick={() => void send('left')} aria-label="左">
            ◀
          </button>
          <button className={`${btn} h-14 font-semibold`} onClick={() => void send('ok')} aria-label="确定">
            确定
          </button>
          <button className={`${btn} h-14`} onClick={() => void send('right')} aria-label="右">
            ▶
          </button>
          <span />
          <button className={`${btn} h-14`} onClick={() => void send('down')} aria-label="下">
            ▼
          </button>
          <span />
        </div>
      </div>

      <div className="px-4 mt-4 flex items-center justify-center gap-2 text-[12px]">
        <button className={`${btn} h-11 px-3`} onClick={() => void send('voldown')}>
          音量 −
        </button>
        <button className={`${btn} h-11 px-3`} onClick={() => void send('mute')}>
          静音
        </button>
        <button className={`${btn} h-11 px-3`} onClick={() => void send('volup')}>
          音量 +
        </button>
      </div>

      <div className="px-4 mt-3 mb-6 flex items-center justify-center gap-2 text-[12px]">
        <button className={`${btn} h-11 flex-1`} onClick={() => void send('back')}>
          返回
        </button>
        <button className={`${btn} h-11 flex-1`} onClick={() => void send('home')}>
          回首页
        </button>
      </div>

      <p className="pb-6 text-center text-[10.5px] leading-relaxed text-white/30 px-8">
        这个页面只控制发起方的那一个页面，关掉对方页面后这里会显示「已关闭」。
        {gone ? '' : ''}
      </p>
    </div>
  );
}
