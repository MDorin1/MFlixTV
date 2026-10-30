'use client';

import { useState } from 'react';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';

/**
 * 手机遥控面板：手机打开「这台设备的网页版」后，用它代替遥控器。
 *
 * 指令走高：POST/GET /api/remote/push → 服务端内存队列 → 目标设备的页面 poll 执行。
 * 全程只在本机/局域网里转，不经过任何外部服务器。
 */
export function RemotePad({ className }: { className?: string }) {
  const { toast } = useToast();
  const [word, setWord] = useState('');
  const [busy, setBusy] = useState(false);

  const send = async (cmd: string, arg?: string) => {
    try {
      setBusy(true);
      const q = new URLSearchParams({ cmd, to: 'any', from: 'phone' });
      if (arg) q.set('arg', arg);
      const r = await fetch(`/api/remote/push?${q.toString()}`);
      if (!r.ok) throw new Error(String(r.status));
    } catch {
      toast('指令没发出去：服务没应答', 'error');
    } finally {
      setBusy(false);
    }
  };

  const keyBtn =
    'h-11 min-w-[58px] rounded-xl bg-hover/70 text-content font-bold text-base active:scale-95 transition-transform disabled:opacity-50';

  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex gap-2">
        <input
          value={word}
          onChange={(e) => setWord(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && word.trim()) void send('search', word.trim());
          }}
          placeholder="输入片名，让电视去搜"
          className="flex-1 min-w-0 rounded-lg bg-hover/60 px-3 py-2 text-sm text-content placeholder:text-muted outline-none focus:ring-2 focus:ring-accent/60"
        />
        <button
          className="btn text-sm text-on-accent bg-accent hover:bg-accent-hover disabled:opacity-50"
          disabled={busy || !word.trim()}
          onClick={() => word.trim() && void send('search', word.trim())}
        >
          搜
        </button>
      </div>

      <div className="flex flex-col items-center gap-2">
        <button className={keyBtn} disabled={busy} onClick={() => void send('up')}>
          ▲
        </button>
        <div className="flex gap-2 items-center">
          <button className={keyBtn} disabled={busy} onClick={() => void send('left')}>
            ◀
          </button>
          <button className={cn(keyBtn, 'min-w-[76px] bg-hover')} disabled={busy} onClick={() => void send('ok')}>
            OK
          </button>
          <button className={keyBtn} disabled={busy} onClick={() => void send('right')}>
            ▶
          </button>
        </div>
        <button className={keyBtn} disabled={busy} onClick={() => void send('down')}>
          ▼
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button className="btn-ghost text-xs" disabled={busy} onClick={() => void send('play')}>
          播放 / 暂停
        </button>
        <button className="btn-ghost text-xs" disabled={busy} onClick={() => void send('menu')}>
          菜单
        </button>
        <button className="btn-ghost text-xs" disabled={busy} onClick={() => void send('prev')}>
          上一集
        </button>
        <button className="btn-ghost text-xs" disabled={busy} onClick={() => void send('next')}>
          下一集
        </button>
        <button className="btn-ghost text-xs" disabled={busy} onClick={() => void send('back')}>
          返回
        </button>
        <button className="btn-ghost text-xs" disabled={busy} onClick={() => void send('exit')}>
          回首页
        </button>
        <button
          className="btn-ghost text-xs col-span-2"
          disabled={busy}
          onClick={() => void send('settings')}
        >
          打开设置
        </button>
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        手机要打开的是「这台设备」的地址（同一网络）。发出去的是方向键与播放指令：
        电视端支持全部按键和搜索，电脑端支持播放控制、返回、回首页与打开设置（电脑上打字搜索还是直接用手边的键盘更快）。
      </p>
    </div>
  );
}
