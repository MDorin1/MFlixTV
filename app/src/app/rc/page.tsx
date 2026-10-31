'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 扫码后手机打开的就是这一页：一个只控制「发起方那个页面会话」的遥控器。
 *
 * token 从 URL 的 ?t= 里来，30 分钟有效；全程只发到发起方所在的这台服务上，
 * 不经过任何外部服务器。被控端每秒来取一次指令，这里 1.2 秒取一次它的播放状态。
 *
 * 和安卓包里的 `assets/rc.html` 是同一份交互（那边是原生页面，这边是 Next 页面）：
 * 十字键走格子、确定进片、选集点第几集就播第几集、线路换源。
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
}

interface CtlResp {
  ok: boolean;
  name: string;
  state: State;
  hostAlive: boolean;
  ctls: number;
}

type Book = { cur: number; list: string[] };

const EMPTY: Book = { cur: -1, list: [] };

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
  const [sheet, setSheet] = useState<'' | 'eps' | 'lines' | 'search'>('');
  const [word, setWord] = useState('');
  const [flashMsg, setFlashMsg] = useState('');
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
  const playing = !!st?.playing;
  const pos = drag ?? st?.pos ?? 0;
  const dur = st?.dur ?? 0;
  const alive = info?.hostAlive !== false;
  const eps = unpack(st?.eps);
  const lines = unpack(st?.lines);

  const btn =
    'select-none touch-manipulation rounded-xl bg-white/[0.06] active:bg-white/20 transition-colors grid place-items-center text-content';

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
          <div className="text-[11px] text-white/45 truncate">
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
        <button className={`${btn} h-11 flex-1`} onClick={() => setSheet('eps')}>
          {eps.list.length > 1 && eps.cur >= 0 ? `选集 ${eps.cur + 1}/${eps.list.length}` : '选集'}
        </button>
        <button className={`${btn} h-11 flex-1`} onClick={() => setSheet('lines')}>
          {lines.list.length > 1 && lines.cur >= 0 ? `线路 ${lines.cur + 1}/${lines.list.length}` : '线路'}
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
        <button className={`${btn} h-11 flex-1`} onClick={() => void send('fullscreen')}>
          全屏
        </button>
        <button className={`${btn} h-11 flex-1`} onClick={() => void send('back')}>
          返回
        </button>
        <button className={`${btn} h-11 flex-1`} onClick={() => void send('home')}>
          回首页
        </button>
      </div>

      <p className="pb-6 text-center text-[10.5px] leading-relaxed text-white/30 px-8">
        十字键走格子、确定键点进去——首页、详情页、搜索结果都能用，不只是播放器。
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
