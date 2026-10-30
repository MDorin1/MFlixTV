'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAppStore } from '@/lib/store';
import { copyToClipboard } from '@/lib/clipboard';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';

const SEEN_KEY = 'mfl:welcome';

/**
 * 首次打开的三步向导。
 *
 * 之前新用户装完打开是一片「什么都没有」的首页：没片源就搜不到片、不知道手机也能看、
 * 也不知道默认密码是什么。三步各自解决一个，全部可以跳过，看过一次就不再打扰。
 */
export function FirstRun() {
  const { toast } = useToast();
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [lan, setLan] = useState<string>('');

  useEffect(() => {
    let seen = '1';
    try {
      seen = localStorage.getItem(SEEN_KEY) || '';
    } catch {
      seen = '1';
    }
    if (!seen) setOpen(true);
  }, []);

  useEffect(() => {
    if (!open || step !== 2) return;
    fetch('/api/lan')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { url?: string | null } | null) => setLan(d?.url || ''))
      .catch(() => setLan(''));
  }, [open, step]);

  const done = () => {
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch {
      /* 隐私模式就每次都提示，不致命 */
    }
    setOpen(false);
  };

  if (!open) return null;

  const srcCount = (customAPIs.length + envSources.length) || selectedKeys.length;

  const steps = [
    {
      title: '第一步：先有片源',
      body:
        srcCount > 0
          ? `这台设备上已经有 ${srcCount} 个片源。首页搜不到片时，去「片源健康」里点一下全部重测，就知道是源挂了还是关键词没命中。`
          : '还没有片源。片源是苹果 CMS 那类采集接口，填进去才能搜到片；片源健康页里可以粘贴别人给的配置一键导入。',
      action: (
        <Link href="/sources" className="btn text-sm text-on-accent bg-accent hover:bg-accent-hover" onClick={done}>
          去片源健康
        </Link>
      ),
    },
    {
      title: '第二步：改掉默认密码',
      body:
        '默认访问密码是 MFlixTV，同一网络里知道这个地址的人都能用。改法是在安装目录的 .env 里改 PASSWORD 再重启服务；改完手机再打开会要新密码。',
      action: (
        <Link href="/about" className="btn-ghost text-sm" onClick={done}>
          看看说明
        </Link>
      ),
    },
    {
      title: '第三步：手机、平板、电视也能看',
      body: lan
        ? `同一 WiFi 下，用浏览器打开 ${lan} 就是完整的网页版（点右上角地址可以出二维码给手机扫）。第一次要输访问密码，之后会记住。`
        : '这台设备现在没取到局域网地址：确认已经连上 WiFi / 有线网，然后点右上角的地址看二维码。',
      action: lan ? (
        <button
          className="btn text-sm text-on-accent bg-accent hover:bg-accent-hover"
          onClick={async () => {
            const ok = await copyToClipboard(lan);
            toast(ok ? `已复制：${lan}` : '复制失败', ok ? 'success' : 'error');
          }}
        >
          复制地址
        </button>
      ) : null,
    },
  ];

  const cur = steps[step];

  return (
    <div className="fixed inset-0 z-[85] grid place-items-center bg-black/75 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-line/60 bg-surface-raised p-5 shadow-2xl">
        <div className="flex items-center gap-1.5">
          {steps.map((_, i) => (
            <span
              key={i}
              className={cn('h-1 flex-1 rounded-full transition-colors', i <= step ? 'bg-accent' : 'bg-line/60')}
            />
          ))}
        </div>
        <h2 className="mt-4 text-base font-semibold text-content">{cur.title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">{cur.body}</p>
        <div className="mt-5 flex items-center justify-between gap-2">
          <button className="btn-ghost text-xs" onClick={done}>
            以后再说
          </button>
          <div className="flex gap-2">
            {cur.action}
            {step < steps.length - 1 ? (
              <button className="btn text-sm text-on-accent bg-accent hover:bg-accent-hover" onClick={() => setStep(step + 1)}>
                下一步
              </button>
            ) : (
              <button className="btn text-sm text-on-accent bg-accent hover:bg-accent-hover" onClick={done}>
                开始用
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
