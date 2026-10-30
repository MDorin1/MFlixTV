'use client';

import { useEffect, useState } from 'react';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';
import { LanDialog, type LanInfo } from '@/components/lan-dialog';

/**
 * 顶部「同一网络观看」徽标：显示本机实际 IP:端口。
 *
 * 场景：安装版跑在本机，同一 WiFi 下的手机/平板用浏览器打开这个地址就能看片。
 * 点一下弹面板：二维码 + 可复制地址 + 多网卡选择 + 注意事项。
 * 拿不到局域网地址（或未登录）时什么都不渲染，不占位。
 */
export function LanBadge({ className, showOnMobile = false }: { className?: string; showOnMobile?: boolean }) {
  const { toast } = useToast();
  const [info, setInfo] = useState<LanInfo | null>(null);
  const [open, setOpen] = useState(false);

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
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          // 顺手说一句这个地址是干嘛的，避免用户以为是给自己看的
          if (window.innerWidth < 640) toast('同一 WiFi 下，别的设备用浏览器打开这个地址就能看', 'info');
        }}
        title={`同一 WiFi 下的手机 / 平板 / 电视，用浏览器打开 ${info.url} 即可观看（点开看二维码）`}
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
      <LanDialog open={open} info={info} onClose={() => setOpen(false)} />
    </>
  );
}
