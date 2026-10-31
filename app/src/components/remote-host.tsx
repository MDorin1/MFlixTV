'use client';

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { copyToClipboard } from '@/lib/clipboard';
import { useToast } from '@/components/toast';
import { create, refreshInfo, setHandlers, setPanelOpen, snapshot, start, subscribe } from '@/lib/remote-engine';
import { cn } from '@/lib/utils';

/**
 * 「扫一扫当遥控器」的被控端按钮 + 二维码面板。
 *
 * 会话本身活在 `lib/remote-engine.ts` 里（模块级），所以从首页点进播放页时
 * 顶栏换了一个实例也不影响已经扫上的遥控器 —— 这是上一版「首页能控、进播放页失灵」的根因。
 * 这里只负责：出码、显示连了几台、以及挂载时把当前路由的 router 交给引擎。
 */

export type { WatchBridge } from '@/lib/remote-engine';

export function RemoteHost({ className }: { className?: string }) {
  const router = useRouter();
  const { toast } = useToast();

  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [snap, setSnap] = useState(snapshot);

  useEffect(() => {
    setMounted(true);
    start();
    setHandlers({
      back: () => router.back(),
      home: () => router.push('/'),
    });
    const off = subscribe(() => setSnap(snapshot()));
    setSnap(snapshot());
    return off;
  }, [router]);

  // 让引擎知道面板开着：这时候十字键不该去动背后的页面
  useEffect(() => {
    setPanelOpen(open);
    return () => setPanelOpen(false);
  }, [open]);

  // 面板开着才探测对方是否还在
  useEffect(() => {
    if (!open) return;
    void refreshInfo();
    const iv = setInterval(() => void refreshInfo(), 2500);
    return () => clearInterval(iv);
  }, [open]);

  // Esc 关面板
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

  const onOpen = useCallback(async () => {
    setOpen(true);
    if (!snapshot().token) {
      const ok = await create();
      if (!ok) toast('遥控会话创建失败，检查一下服务是否正常', 'error');
    } else {
      void refreshInfo();
    }
  }, [toast]);

  // 面板开着的时候遥控器的十字键不该去动背后那层页面
  useEffect(() => {
    if (!open) return;
    const onCmd = (e: Event) => {
      e.preventDefault();
      setOpen(false);
    };
    window.addEventListener('mfl:rc-panel-close', onCmd);
    return () => window.removeEventListener('mfl:rc-panel-close', onCmd);
  }, [open]);

  const qr = snap.url ? `/api/lan/qr?u=${encodeURIComponent(snap.url)}` : '';
  const peers = snap.peers;

  return (
    <>
      <button
        type="button"
        onClick={() => void onOpen()}
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
            // z-[120]：必须压过首启向导（z-85 / z-95），否则遮罩会吃掉所有点击，连 ✕ 都点不动
            <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
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
                    data-rc-close
                    className="shrink-0 w-7 h-7 rounded-md grid place-items-center text-muted hover:text-content hover:bg-hover transition-colors"
                    aria-label="关闭"
                  >
                    ✕
                  </button>
                </div>

                <div className="px-5 py-4">
                  <div className="mx-auto w-[220px] h-[220px] rounded-xl bg-white p-2.5 shadow-inner">
                    {snap.busy || !qr ? (
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
                        value={snap.url || '正在生成…'}
                        className="flex-1 min-w-0 rounded-lg bg-surface border border-line/60 px-2.5 py-2 text-[12px] font-mono text-muted"
                      />
                      <button
                        onClick={async () => {
                          if (!snap.url) return;
                          const ok = await copyToClipboard(snap.url);
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
                          className={cn('inline-block w-1.5 h-1.5 rounded-full', snap.hostAlive ? 'bg-success' : 'bg-danger')}
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
                    扫码后：十字键走格子（首页海报也能走）、确定进入、返回逐层退、选集、线路、播放暂停、
                    快退快进、拖进度、音量、全屏。关掉这个面板不影响遥控。
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
