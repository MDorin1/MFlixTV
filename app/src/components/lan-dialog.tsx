'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { copyToClipboard } from '@/lib/clipboard';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';
import { RemotePad } from '@/components/remote-pad';

export interface LanInfo {
  port: string;
  url: string | null;
  addresses: { name: string; ip: string; private: boolean }[];
  /** 最近 15 秒来过心跳的设备数（手机遥控、别的设备开着网页版都算一台） */
  devices?: number;
}

/**
 * 「同一网络观看」面板。
 *
 * 这是安装版最容易被忽略、也最好用的能力：这台电脑上开着 MFlixTV，
 * 同一个 WiFi 里的手机 / 平板 / 电视打开 http://本机IP:端口 就是一个完整的网页版，
 * 不用装 App、不用投屏、不占电脑的播放器。面板只做三件事：
 * 给出可直接扫的二维码、给出可复制的地址、把「多网卡时该用哪个」和「首次要输密码」说清楚。
 */
export function LanDialog({ open, info, onClose }: { open: boolean; info: LanInfo | null; onClose: () => void }) {
  const { toast } = useToast();
  const [pick, setPick] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [tab, setTab] = useState<'qr' | 'remote'>('qr');

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    setPick(0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open || !info || !mounted) return null;

  const port = info.port || '8080';
  const urls = info.addresses.map((a) => ({ ...a, url: `http://${a.ip}:${port}` }));
  const current = urls[Math.min(pick, Math.max(0, urls.length - 1))] || (info.url ? { name: '', ip: '', url: info.url } : null);
  const target = current?.url || info.url || '';

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="同一网络观看"
        className="relative bg-surface-raised rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden animate-slide-up border border-line/60"
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-5">
          <div>
            <h2 className="text-base font-semibold text-content">用手机、平板、电视看这台电脑上的片子</h2>
            <p className="text-xs text-muted mt-1 leading-relaxed">
              只要在<strong className="text-content font-semibold">同一个 WiFi / 同一个局域网</strong>里，用浏览器打开下面这个地址，就是完整的网页版。
              不用装 App，不用投屏，也不用在这台电脑前坐着。
            </p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 w-7 h-7 rounded-md grid place-items-center text-muted hover:text-content hover:bg-hover transition-colors"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        <div className="px-5 py-4 grid grid-cols-[auto_1fr] gap-4 items-center">
          <div className="rounded-xl bg-white p-2 shadow-lg">
            {target ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/lan/qr?u=${encodeURIComponent(target)}`}
                alt={`扫二维码打开 ${target}`}
                width={132}
                height={132}
                className="block w-[132px] h-[132px]"
              />
            ) : (
              <div className="w-[132px] h-[132px] grid place-items-center text-xs text-black/50">无地址</div>
            )}
          </div>
          <div className="min-w-0">
            <div className="text-[11px] text-muted">手机相机扫一下，或直接在浏览器输入</div>
            <div className="mt-1 font-mono text-[15px] sm:text-base text-content tabular-nums break-all leading-snug">
              {target || '未取到局域网地址'}
            </div>
            <div className="flex flex-wrap gap-2 mt-3">
              <button
                className="btn text-xs text-on-accent bg-accent hover:bg-accent-hover"
                onClick={async () => {
                  const ok = await copyToClipboard(target);
                  toast(ok ? `已复制：${target}` : '复制失败，请手动选中', ok ? 'success' : 'error');
                }}
                disabled={!target}
              >
                复制地址
              </button>
              <button className="btn-ghost text-xs" onClick={() => window.open(target, '_blank', 'noopener')} disabled={!target}>
                在本机新标签打开
              </button>
            </div>
          </div>
        </div>

        <div className="px-5 pb-1 flex items-center gap-2">
          <button
            onClick={() => setTab('qr')}
            className={cn(
              'text-[11.5px] px-2.5 py-1 rounded-md border transition-colors',
              tab === 'qr' ? 'border-accent/70 text-content bg-accent/12' : 'border-line/60 text-muted hover:text-content'
            )}
          >
            扫码打开
          </button>
          <button
            onClick={() => setTab('remote')}
            className={cn(
              'text-[11.5px] px-2.5 py-1 rounded-md border transition-colors',
              tab === 'remote' ? 'border-accent/70 text-content bg-accent/12' : 'border-line/60 text-muted hover:text-content'
            )}
          >
            用这台手机遥控
          </button>
          <span className="ml-auto text-[11px] text-muted">
            {(info.devices || 0) > 1 ? `当前 ${info.devices} 台设备连着` : '目前只有这台在用'}
          </span>
        </div>

        {tab === 'remote' && (
          <div className="px-5 pb-2">
            <RemotePad />
          </div>
        )}

        {urls.length > 1 && (
          <div className="px-5 pb-1">
            <div className="text-[11px] text-muted mb-1">这台电脑有好几个地址，手机连哪个网就选哪个</div>
            <div className="flex flex-wrap gap-1.5">
              {urls.map((u, i) => (
                <button
                  key={u.url}
                  onClick={() => setPick(i)}
                  className={cn(
                    'text-[11px] px-2 py-1 rounded-md border transition-colors font-mono',
                    i === pick
                      ? 'border-accent/70 text-content bg-accent/12'
                      : 'border-line/60 text-muted hover:text-content hover:border-line'
                  )}
                  title={u.name}
                >
                  {u.ip}
                </button>
              ))}
            </div>
          </div>
        )}

        <ul className="px-5 py-3 text-[11.5px] text-muted leading-relaxed space-y-1">
          <li>· 这台电脑上的 MFlixTV 要<strong className="text-content/90">开着</strong>（关掉窗口就是关服务），手机才能打开。</li>
          <li>· 第一次打开要输入这台电脑上设的访问密码，之后同一个浏览器会记住。</li>
          <li>· 看的是这台电脑在放的那份片源和缓存，手机自己不占空间。</li>
          <li>· 播放记录各端独立：手机看过的记录留在手机，电脑上的不会跟着变。</li>
        </ul>
      </div>
    </div>,
    document.body
  );
}
