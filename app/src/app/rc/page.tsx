'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as RMouseEvent, PointerEvent as RPointerEvent } from 'react';

/**
 * 扫码后手机打开的就是这一页：一个只控制「发起方那个页面会话」的遥控器。
 *
 * token 从 URL 的 ?t= 里来，30 分钟有效；全程只发到发起方所在的这台服务上，
 * 不经过任何外部服务器。被控端每 450ms 取一次指令，这里 900ms 取一次它的状态。
 *
 * 和安卓包里的 `assets/rc.html` 是同一份交互（那边是原生页面，这边是 Next 页面）：
 * 十字键走格子、确定进片、选集点第几集就播第几集、线路换源、上集下集、音量倍速长按连发。
 *
 * 体感上有三件事必须做成「按下去立刻有反应」，因为服务端状态到达最坏要 1.4 秒：
 * 1. 暂停 / 播放图标乐观翻转（本地先翻，等服务端对齐后就交给服务端）；
 * 2. 音量、倍速本地先算出新值再发**绝对值**（volset / rateset），两端不会漂；
 * 3. 进度条本地插值走秒，不是每 0.9 秒跳一下。
 */

interface State {
  title: string;
  sub: string;
  playing: boolean;
  pos: number;
  dur: number;
  page: string;
  /** `当前集下标|第1集|第2集…` */
  eps?: string;
  /** `当前线路下标|线路 1|线路 2…` */
  lines?: string;
  /** 音量 0–100 */
  vol?: number;
  /** 倍速 ×100 */
  rate?: number;
  muted?: boolean;
  /** 对方页面现在是不是全屏 */
  fs?: boolean;
}

interface CtlResp {
  ok: boolean;
  name: string;
  state: State;
  hostAlive: boolean;
  ctls: number;
}

type Book = { cur: number; list: string[] };

/** 本地乐观值：按完先显示这个，最多活这么久（够服务端状态回来一轮） */
type Optim = { playing?: boolean; vol?: number; rate?: number; muted?: boolean; at: number };

const EMPTY: Book = { cur: -1, list: [] };
const OPTIM_TTL = 1800;
const VOL_STEP = 10;
const RATE_STEP = 0.25;
const RATE_MIN = 0.5;
const RATE_MAX = 3;

function unpack(v?: string): Book {
  if (!v) return EMPTY;
  const parts = String(v).split('|');
  const cur = parseInt(parts[0], 10);
  return { cur: Number.isNaN(cur) ? -1 : cur, list: parts.slice(1) };
}

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

function fmtRate(r: number): string {
  // 1× / 1.25× / 1.5× —— 整数不带小数点
  return `${Number.isInteger(r) ? r : r.toFixed(2).replace(/0$/, '')}×`;
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

/**
 * 长按连发：按下去先发一次，按住 420ms 后每 140ms 再来一次，松手立刻停。
 *
 * 音量、倍速、方向键都要这个——从 60% 调到 0 要按 6 次太蠢。
 */
function useRepeat(fire: () => void, delay = 420, every = 140) {
  const fireRef = useRef(fire);
  fireRef.current = fire;
  const t1 = useRef<number | undefined>(undefined);
  const t2 = useRef<number | undefined>(undefined);
  /** 上一次由 pointerdown 触发的时间：click 事件拿它去重，键盘/读屏还能用 */
  const lastDown = useRef(0);

  const stop = useCallback(() => {
    if (t1.current) {
      window.clearTimeout(t1.current);
      t1.current = undefined;
    }
    if (t2.current) {
      window.clearInterval(t2.current);
      t2.current = undefined;
    }
  }, []);

  const start = useCallback(
    (e?: RPointerEvent) => {
      // 拦掉 pointerdown 带来的 click，否则一次点击会发两条指令
      if (e) e.preventDefault();
      lastDown.current = Date.now();
      stop();
      fireRef.current();
      t1.current = window.setTimeout(() => {
        t2.current = window.setInterval(() => fireRef.current(), every);
      }, delay);
    },
    [stop, delay, every]
  );

  const onClick = useCallback(() => {
    if (Date.now() - lastDown.current < 600) return;
    fireRef.current();
  }, []);

  useEffect(() => stop, [stop]);

  return {
    onPointerDown: start,
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
    onClick,
    onContextMenu: (e: RMouseEvent) => e.preventDefault(),
  };
}

export default function RemoteControlPage() {
  const [token, setToken] = useState('');
  const [info, setInfo] = useState<CtlResp | null>(null);
  const [gone, setGone] = useState(false);
  const [vibrate, setVibrate] = useState(true);
  const [drag, setDrag] = useState<number | null>(null);
  const [sheet, setSheet] = useState<'' | 'eps' | 'lines' | 'search'>('');
  const [word, setWord] = useState('');
  const [flashMsg, setFlashMsg] = useState('');
  const [optim, setOptim] = useState<Optim>({ at: 0 });
  const [, setClock] = useState(0);

  const flashTimer = useRef<number | undefined>(undefined);
  const setFlash = (s: string) => {
    setFlashMsg(s);
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashMsg(''), 1800);
  };
  const dragRef = useRef<number | null>(null);
  const wordRef = useRef<HTMLInputElement | null>(null);
  dragRef.current = drag;
  const whoRef = useRef('');
  /** 每次收到被控端状态时的本地时刻：进度条从这里往后插值 */
  const infoAt = useRef(0);
  /** 最新一帧状态：全屏校验要拿它比对，不能在闭包里读旧值 */
  const infoRef = useRef<CtlResp | null>(null);
  infoRef.current = info;
  /** 上一次画出来的进度：只允许往前走，服务端快照落后时不要回跳 */
  const lastWalk = useRef(0);
  /** 刚拖完进度条的目标位置：服务端还没追上的这几秒，从这个位置继续走 */
  const seekInfo = useRef({ pos: 0, at: 0 });

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setToken((q.get('t') || '').toUpperCase());
    whoRef.current = who();
  }, []);

  // 250ms 一格的心跳：进度条平滑走秒、乐观值到点过期，都靠它
  useEffect(() => {
    const id = window.setInterval(() => setClock((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    infoAt.current = Date.now();
  }, [info]);

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
      if (alive) timer = setTimeout(tick, 900);
    };
    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [token]);

  const haptic = useCallback(
    (ms: number) => {
      if (!vibrate) return;
      try {
        navigator.vibrate?.(ms);
      } catch {
        /* 有些浏览器不允许 */
      }
    },
    [vibrate]
  );

  const send = useCallback(
    async (cmd: string, arg = '', buzz = 8) => {
      if (!token) return;
      haptic(buzz);
      try {
        await fetch(
          `/api/rs/cmd?t=${encodeURIComponent(token)}&cmd=${encodeURIComponent(cmd)}&arg=${encodeURIComponent(arg)}`,
          { cache: 'no-store' }
        );
      } catch {
        /* 网络抖动忽略，用户会再按一次 */
      }
    },
    [token, haptic]
  );

  /** 拖完进度条：记下目标位置（服务端追上来之前进度条从这儿继续走），再发指令 */
  const commitSeek = useCallback(() => {
    const v = dragRef.current;
    if (v == null) return;
    seekInfo.current = { pos: v, at: Date.now() };
    void send('seekto', String(Math.round(v)));
    window.setTimeout(() => setDrag(null), 400);
  }, [send]);

  /** 手机上打完片名点搜索：发给被控页，它自己回到首页搜这个词 */
  const submitSearch = () => {
    const q = word.trim();
    if (!q) {
      wordRef.current?.focus();
      return;
    }
    void send('search', q);
    setSheet('');
    setWord('');
    setFlash(`已让「${info?.name || '对方页面'}」搜索「${q}」`);
    try {
      wordRef.current?.blur();
    } catch {
      /* ignore */
    }
  };

  const st = info?.state;
  const alive = info?.hostAlive !== false;
  const eps = unpack(st?.eps);
  const lines = unpack(st?.lines);

  // 乐观值只在短窗口内有效：服务端追平后自然交还给它
  const fresh = optim.at > 0 && Date.now() - optim.at < OPTIM_TTL;
  const playing = (fresh ? optim.playing : undefined) ?? !!st?.playing;
  const muted = (fresh ? optim.muted : undefined) ?? !!st?.muted;
  const fsOn = !!st?.fs;
  const vol = (fresh ? optim.vol : undefined) ?? Math.round(st?.vol ?? 100);
  const rawRate = st?.rate ? st.rate / 100 : 1;
  const rate = (fresh ? optim.rate : undefined) ?? rawRate;

  const dur = Math.max(0, st?.dur ?? 0);
  const basePos = Math.max(0, st?.pos ?? 0);
  // 播放中就地插值，进度条不再每 0.9 秒跳一下；
  // 服务端状态是 0.7–1.6 秒前的快照，直接用它当基准会让进度往回跳一小格，
  // 所以只允许往前走（差距太大时才认罚后退）。
  // 刚拖完进度条的那几秒，服务端还没执行到新位置，就从拖动目标继续走。
  const sk = seekInfo.current;
  const justSought = sk.at > 0 && Date.now() - sk.at < 5000 && Math.abs(basePos - sk.pos) > 2;
  let walked = playing
    ? justSought
      ? sk.pos + (Date.now() - sk.at) / 1000
      : basePos + (Date.now() - infoAt.current) / 1000
    : basePos;
  if (playing && lastWalk.current > walked && lastWalk.current - walked < 4) walked = lastWalk.current;
  if (!playing) lastWalk.current = basePos;
  else lastWalk.current = walked;
  const smooth = dur > 0 ? Math.min(dur, walked) : walked;
  const pos = drag ?? smooth;

  const markOptim = (patch: Partial<Optim>) => setOptim({ ...patch, at: Date.now() });

  const canPrev = eps.list.length > 0 && eps.cur > 0;
  const canNext = eps.list.length > 0 && eps.cur >= 0 && eps.cur < eps.list.length - 1;

  const btn =
    'select-none touch-manipulation rounded-xl bg-white/[0.06] active:bg-white/20 transition-colors grid place-items-center text-content';
  const dim = 'opacity-40';

  /* 音量 / 倍速 / 方向键的长按连发 */
  const volDown = useRepeat(() => {
    const next = Math.max(0, Math.min(100, vol - VOL_STEP));
    markOptim({ vol: next, muted: false });
    void send('volset', String(next), 6);
  });
  const volUp = useRepeat(() => {
    const next = Math.max(0, Math.min(100, vol + VOL_STEP));
    markOptim({ vol: next, muted: false });
    void send('volset', String(next), 6);
  });
  const rateDown = useRepeat(() => {
    const next = Math.max(RATE_MIN, Math.round((rate - RATE_STEP) * 4) / 4);
    markOptim({ rate: next });
    void send('rateset', String(Math.round(next * 100)), 6);
  });
  const rateUp = useRepeat(() => {
    const next = Math.min(RATE_MAX, Math.round((rate + RATE_STEP) * 4) / 4);
    markOptim({ rate: next });
    void send('rateset', String(Math.round(next * 100)), 6);
  });
  const navUp = useRepeat(() => void send('up', '', 5));
  const navDown = useRepeat(() => void send('down', '', 5));
  const navLeft = useRepeat(() => void send('left', '', 5));
  const navRight = useRepeat(() => void send('right', '', 5));

  const togglePlay = () => {
    const next = !playing;
    markOptim({ playing: next });
    void send('toggle');
    // 被控页没有视频时这条会退化成空格键，图标交给服务端纠正
    if (!dur) setTimeout(() => setOptim({ at: 0 }), 600);
  };

  const doMute = () => {
    const next = !muted;
    markOptim({ muted: next });
    void send('mute');
  };

  /**
   * 全屏：对方页面在浏览器里，原生全屏需要「真实用户手势」——手机上的按键传过去不算，
   * 所以被控端走的是网页全屏（纯 CSS 铺满）。这里不猜结果：发完 1.8 秒拿真实状态比对一次，
   * 没变化就明说一句，而不是让人对着一个按了没反应的按钮。
   */
  const doFullscreen = () => {
    const before = fsOn;
    void send('fullscreen', '', 10);
    window.setTimeout(() => {
      const now = !!infoRef.current?.state?.fs;
      if (now === before) setFlash(before ? '还没退出全屏，对方可能不在这页' : '这个页面没有可全屏的画面');
    }, 1800);
  };

  const stateLine = useMemo(() => {
    if (!alive) return '对方页面已断开';
    if (!dur && !st?.playing) return '对方页面没在放片';
    return '';
  }, [alive, dur, st?.playing]);

  return (
    <div className="min-h-dvh bg-[#0a0a0d] text-white flex flex-col">
      <header className="px-4 pt-4 pb-2 flex items-center gap-2">
        <span
          className={`inline-block w-2 h-2 rounded-full ${gone ? 'bg-red-500' : alive ? 'bg-emerald-400' : 'bg-red-500'}`}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold truncate">
            {info?.name ? `正在遥控 ${info.name}` : '正在连接…'}
          </div>
          <div className={`text-[11px] truncate ${gone || !alive ? 'text-red-400/80' : 'text-white/45'}`}>
            {gone ? '这个会话已经关闭，让对方重新点一次遥控按钮' : alive ? '遥控已连接' : '对方页面可能已关闭'}
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
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium truncate">{st?.title || '—'}</div>
              {st?.sub ? <div className="text-[10.5px] text-white/40 truncate mt-0.5">{st.sub}</div> : null}
            </div>
            {/* 上集 / 下集：追剧时最常用的两个键，以前只能开选集面板 */}
            <button
              className={`${btn} shrink-0 h-8 px-2 text-[11px] ${canPrev ? '' : dim}`}
              onClick={() => (canPrev ? void send('prev') : setFlash('这已经是第一集'))}
              aria-label="上一集"
            >
              ‹ 上集
            </button>
            <button
              className={`${btn} shrink-0 h-8 px-2 text-[11px] ${canNext ? '' : dim}`}
              onClick={() => (canNext ? void send('next') : setFlash(eps.list.length ? '这已经是最后一集' : '对方页面没有分集'))}
              aria-label="下一集"
            >
              下集 ›
            </button>
          </div>
          <div className="mt-1.5 flex items-center gap-2 text-[11px] tabular-nums text-white/50">
            <span>{fmt(pos)}</span>
            <input
              type="range"
              min={0}
              max={Math.max(1, Math.floor(dur))}
              step={1}
              value={Math.min(Math.floor(pos), Math.max(1, Math.floor(dur)))}
              disabled={!dur || gone}
              onChange={(e) => setDrag(Number(e.target.value))}
              onPointerUp={commitSeek}
              onTouchEnd={commitSeek}
              className="flex-1 accent-white"
              aria-label="进度"
            />
            <span>{fmt(dur)}</span>
          </div>
          {/* 音量 / 倍速 / 静音状态：以前按了完全没反馈，压根不知道按到多少 */}
          <div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-white/40">
            {stateLine ? (
              <span>{stateLine}</span>
            ) : (
              <>
                <span className="tabular-nums">{muted ? '已静音' : `音量 ${vol}%`}</span>
                <span className="text-white/20">·</span>
                <span className="tabular-nums">{fmtRate(rate)}</span>
                {st?.playing ? (
                  <>
                    <span className="text-white/20">·</span>
                    <span className="text-emerald-400/80">播放中</span>
                  </>
                ) : null}
              </>
            )}
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
          onClick={togglePlay}
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

      {/* 搜索 / 选集 / 线路 */}
      <div className="px-4 mt-3 flex items-center justify-center gap-2.5 text-[12px]">
        <button
          className={`${btn} h-11 flex-1`}
          onClick={() => {
            setSheet('search');
            // 输入框一直在 DOM 里（只是移出屏幕），所以这里 focus 能直接把手机键盘顶起来
            wordRef.current?.focus();
          }}
        >
          搜索
        </button>
        <button
          className={`${btn} h-11 flex-1 ${eps.list.length ? '' : dim}`}
          onClick={() => (eps.list.length ? setSheet('eps') : setFlash('对方页面现在没有分集'))}
        >
          {eps.list.length > 1 && eps.cur >= 0 ? `选集 ${eps.cur + 1}/${eps.list.length}` : '选集'}
        </button>
        <button
          className={`${btn} h-11 flex-1 ${lines.list.length ? '' : dim}`}
          onClick={() => (lines.list.length ? setSheet('lines') : setFlash('对方页面现在没有可选线路'))}
        >
          {lines.list.length > 1 && lines.cur >= 0 ? `线路 ${lines.cur + 1}/${lines.list.length}` : '线路'}
        </button>
      </div>

      <div className="px-4 mt-4">
        <div className="mx-auto w-[196px] grid grid-cols-3 grid-rows-3 gap-2">
          <span />
          <button className={`${btn} h-14`} {...navUp} aria-label="上">
            ▲
          </button>
          <span />
          <button className={`${btn} h-14`} {...navLeft} aria-label="左">
            ◀
          </button>
          <button className={`${btn} h-14 font-semibold`} onClick={() => void send('ok')} aria-label="确定">
            确定
          </button>
          <button className={`${btn} h-14`} {...navRight} aria-label="右">
            ▶
          </button>
          <span />
          <button className={`${btn} h-14`} {...navDown} aria-label="下">
            ▼
          </button>
          <span />
        </div>
      </div>

      {/* 音量 / 倍速：都能长按连发 */}
      <div className="px-4 mt-4 flex items-center justify-center gap-1.5 text-[12px]">
        <button className={`${btn} h-11 px-2`} {...volDown} aria-label="音量减">
          音量 −
        </button>
        <button
          className={`${btn} h-11 px-2 ${muted ? 'bg-white text-[#0a0a0d] font-semibold' : ''}`}
          onClick={doMute}
        >
          静音
        </button>
        <button className={`${btn} h-11 px-2`} {...volUp} aria-label="音量加">
          音量 +
        </button>
        <button className={`${btn} h-11 px-2`} {...rateDown} aria-label="减速">
          倍速 −
        </button>
        <button className={`${btn} h-11 px-2`} {...rateUp} aria-label="加速">
          倍速 +
        </button>
      </div>

      <div className="px-4 mt-3 mb-6 flex items-center justify-center gap-2 text-[12px]">
        <button
          className={`${btn} h-11 flex-1 ${fsOn ? 'bg-white text-[#0a0a0d] font-semibold' : ''}`}
          onClick={doFullscreen}
        >
          {fsOn ? '退出全屏' : '全屏'}
        </button>
        <button className={`${btn} h-11 flex-1`} onClick={() => void send('back')}>
          返回
        </button>
        <button className={`${btn} h-11 flex-1`} onClick={() => void send('home')}>
          回首页
        </button>
      </div>

      <p className="pb-6 text-center text-[10.5px] leading-relaxed text-white/30 px-8">
        十字键、音量、倍速都能长按连发；确定键点进去，首页、详情页、搜索结果都能用，不只是播放器。
        这个页面只控制发起方的那一个页面，关掉对方页面后这里会显示「已关闭」。
      </p>

      {/* 搜索浮层：一直挂在 DOM 里（只是移到屏幕外），点「搜索」时 input.focus() 能直接顶起手机键盘 */}
      <div
        className={`fixed inset-0 z-50 flex items-end bg-black/60 transition-opacity duration-200 ${
          sheet === 'search' ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={() => setSheet('')}
      >
        <div
          className={`w-full bg-[#141416] rounded-t-[18px] px-4 pt-3.5 pb-6 transition-transform duration-200 ${
            sheet === 'search' ? 'translate-y-0' : 'translate-y-full'
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-[13px] font-semibold">在手机上打片名</span>
            <button className="text-[12px] text-white/50" onClick={() => setSheet('')}>
              关闭
            </button>
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={wordRef}
              value={word}
              onChange={(e) => setWord(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitSearch();
              }}
              inputMode="search"
              enterKeyHint="search"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="电影 / 剧集 / 综艺名"
              className="flex-1 min-w-0 h-12 rounded-xl bg-white/[0.08] px-3 text-[14px] text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-white/25"
            />
            <button
              className="shrink-0 h-12 px-5 rounded-xl bg-white text-[#0a0a0d] text-[14px] font-semibold active:scale-95 transition-transform"
              onClick={submitSearch}
            >
              搜索
            </button>
          </div>
          <div className="mt-2 text-[10.5px] leading-relaxed text-white/30">
            发给「{info?.name || '对方页面'}」，它会自己回到首页并搜这个词。
          </div>
        </div>
      </div>

      {/* 选集 / 线路 浮层 */}
      {sheet === 'eps' || sheet === 'lines' ? (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-end" onClick={() => setSheet('')}>
          <div
            className="w-full max-h-[64vh] overflow-auto bg-[#141416] rounded-t-[18px] px-4 pt-3.5 pb-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-[13px] font-semibold">
                {sheet === 'eps' ? `选集 · 共 ${eps.list.length} 集` : `线路 · 共 ${lines.list.length} 条`}
              </span>
              <button className="text-[12px] text-white/50" onClick={() => setSheet('')}>
                关闭
              </button>
            </div>

            {sheet === 'eps' ? (
              eps.list.length === 0 ? (
                <div className="text-[12px] text-white/40 text-center py-2">这个页面现在没有分集（首页 / 搜索页正常）</div>
              ) : (
                <div className="grid grid-cols-4 gap-2">
                  {eps.list.map((label, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        void send('ep', String(i));
                        setTimeout(() => setSheet(''), 180);
                      }}
                      className={`h-[42px] rounded-[10px] text-[12px] px-1 truncate ${
                        i === eps.cur ? 'bg-white text-[#0a0a0d] font-semibold' : 'bg-white/[0.06] active:bg-white/25'
                      }`}
                    >
                      {label || `第${i + 1}集`}
                    </button>
                  ))}
                </div>
              )
            ) : lines.list.length === 0 ? (
              <div className="text-[12px] text-white/40 text-center py-2">这个页面现在没有可选线路</div>
            ) : (
              <div className="space-y-2">
                {lines.list.map((label, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      void send('line', String(i));
                      setTimeout(() => setSheet(''), 180);
                    }}
                    className={`w-full h-[46px] rounded-[10px] text-[12.5px] px-3 text-left ${
                      i === lines.cur ? 'bg-white text-[#0a0a0d] font-semibold' : 'bg-white/[0.06] active:bg-white/25'
                    }`}
                  >
                    {label || `线路 ${i + 1}`}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}
      {/* 发完指令的一行反馈 */}
      {flashMsg ? (
        <div className="fixed inset-x-4 bottom-6 z-[60] rounded-xl bg-white/12 backdrop-blur px-3 py-2.5 text-center text-[12px] text-white/90">
          {flashMsg}
        </div>
      ) : null}
    </div>
  );
}
