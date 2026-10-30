'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { markParentalUnlocked, parentalNeedsPin, readParental } from '@/lib/parental';

/**
 * 播放前的家长控制门禁。
 *
 * 用法：把播放页的内容包在它里面。命中屏蔽词、或正处于限时时段时，
 * 先要 4 位密码，输对了才渲染 children（解锁 30 分钟）。
 * 没开启家长控制时它什么都不做，直接渲染 children——零开销、零视觉痕迹。
 */
export function ParentalGate({ children, title }: { children: ReactNode; title?: string }) {
  /* 片名从 URL 上取（/watch?title=…）：不用 useSearchParams，
     否则整个播放页会被要求套 Suspense 边界，构建期直接失败。 */
  const [name, setName] = useState(title || '');
  const [need, setNeed] = useState<boolean | null>(null);
  const [buf, setBuf] = useState('');
  const [wrong, setWrong] = useState(false);

  useEffect(() => {
    let t = title || '';
    if (!t) {
      try {
        t = new URLSearchParams(window.location.search).get('title') || '';
      } catch {
        t = '';
      }
    }
    setName(t);
    setNeed(parentalNeedsPin(t));
  }, [title]);

  if (need === null || need === false) return <>{children}</>;

  const cfg = readParental();
  const press = (d: string) => {
    if (d === 'del') {
      setBuf(buf.slice(0, -1));
      return;
    }
    if (buf.length >= 4) return;
    const next = buf + d;
    setBuf(next);
    if (next.length < 4) return;
    if (next === cfg.pin) {
      markParentalUnlocked();
      setNeed(false);
    } else {
      setWrong(true);
      setBuf('');
      setTimeout(() => setWrong(false), 1200);
    }
  };

  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-[#08080b] p-6">
      <div className="w-full max-w-xs rounded-2xl border border-line/60 bg-surface-raised p-5 text-center shadow-2xl">
        <h2 className="text-sm font-semibold text-content">
          {cfg.kids.some((k) => k && name.toLowerCase().includes(k.toLowerCase()))
            ? '这个内容受家长控制保护'
            : '现在是限时时段'}
        </h2>
        <p className="mt-1 text-xs text-muted">输入这台设备上设的 4 位密码继续，解锁后 30 分钟内不再问。</p>
        <div className="mt-4 flex justify-center gap-2">
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className={cn(
                'h-3 w-3 rounded-full transition-colors',
                i < buf.length ? 'bg-content' : 'bg-line',
                wrong && 'bg-danger'
              )}
            />
          ))}
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', ' '].map((d, i) =>
            d === ' ' ? (
              <span key={i} />
            ) : (
              <button
                key={i}
                onClick={() => press(d)}
                className="h-11 rounded-lg bg-hover text-sm font-bold text-content hover:bg-hover/70 active:scale-95 transition-transform"
              >
                {d === 'del' ? '⌫' : d}
              </button>
            )
          )}
        </div>
        {wrong && <p className="mt-3 text-xs text-danger">密码不对，再试一次</p>}
      </div>
    </div>
  );
}
