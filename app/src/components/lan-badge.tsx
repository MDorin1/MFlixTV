'use client';

import { useEffect, useState } from 'react';
import { copyToClipboard } from '@/lib/clipboard';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';

interface LanInfo {
  port: string;
  url: string | null;
  addresses: { name: string; ip: string; private: boolean }[];
}

/**
 * 局域网地址徽标：显示本机实际 IP:端口，点一下复制。
 *
 * 场景：安装版跑在本机，同一 WiFi 下的手机/平板用浏览器打开这个地址就能看片。
 * 拿不到局域网地址（或未登录）时什么都不渲染，不占位。
 */
export function LanBadge({ className, showOnMobile = false }: { className?: string; showOnMobile?: boolean }) {
  const { toast } = useToast();
  const [info, setInfo] = useState<LanInfo | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/lan')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: LanInfo | null) => {
        if (!alive || !d || !d.url) return;
        setInfo(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!info || !info.url) return null;

  const label = info.url.replace(/^https?:\/\//, '');

  return (
    <button
      type="button"
      onClick={async () => {
        const ok = await copyToClipboard(info.url as string);
        toast(ok ? `已复制：${info.url}` : '复制失败，请手动选中', ok ? 'success' : 'error');
      }}
      title={`同一 WiFi 下的手机 / 平板 / 电视，用浏览器打开 ${info.url} 即可观看（服务开着的时候）`}
      className={cn(
        'items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted shrink-0 whitespace-nowrap',
        'hover:text-content hover:bg-hover transition-colors',
        showOnMobile ? 'flex' : 'hidden sm:flex',
        className
      )}
    >
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent" aria-hidden />
      <span className="font-mono tabular-nums">{label}</span>
    </button>
  );
}
