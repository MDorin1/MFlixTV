'use client';

import { useEffect, useState } from 'react';
import { useToast } from '@/components/toast';
import { readParental, writeParental, type ParentalCfg } from '@/lib/parental';

/**
 * 家长控制的设置面板（电脑端）。
 * 密码 + 屏蔽词 + 限时时段，存在这台设备的浏览器里；手机 / 电视端的配置在各自设备上设置。
 */
export function ParentalSettings() {
  const { toast } = useToast();
  const [cfg, setCfg] = useState<ParentalCfg>({ on: false, pin: '', kids: [], from: null, to: null });
  const [pin, setPin] = useState('');
  const [kids, setKids] = useState('');
  const [time, setTime] = useState('');

  useEffect(() => {
    const c = readParental();
    setCfg(c);
    setPin(c.pin);
    setKids(c.kids.join(','));
    setTime(c.from != null && c.to != null ? `${c.from}-${c.to}` : '');
  }, []);

  const save = () => {
    if (!/^\d{4}$/.test(pin.trim())) {
      toast('密码要 4 位数字', 'warning');
      return;
    }
    let from: number | null = null;
    let to: number | null = null;
    const t = time.trim();
    if (t) {
      const m = t.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
      if (!m) {
        toast('时段写成 22-7 这样', 'warning');
        return;
      }
      from = Number(m[1]);
      to = Number(m[2]);
      if (from > 23 || to > 23) {
        toast('小时要在 0-23 之间', 'warning');
        return;
      }
    }
    const next: ParentalCfg = {
      on: true,
      pin: pin.trim(),
      kids: kids.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean),
      from,
      to,
    };
    writeParental(next);
    setCfg(next);
    toast('家长控制已开启：命中的内容播放前要密码', 'success');
  };

  const off = () => {
    const next = { ...cfg, on: false };
    writeParental(next);
    setCfg(next);
    toast('家长控制已关闭', 'info');
  };

  return (
    <div className="space-y-3">
      <p>
        给家里小孩用的那台设备加一道门槛：命中<strong className="text-white/85">屏蔽词</strong>的片子在列表里不显示、
        播放前要密码；<strong className="text-white/85">限时时段</strong>内看任何内容都要密码。输对密码后 30 分钟内不再问。
        它挡的是「随手点开就播」，不是安全机制。
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-white/50">状态</span>
        <span className={cfg.on ? 'text-xs font-semibold text-success' : 'text-xs text-white/60'}>
          {cfg.on ? '已开启' : '关闭'}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <input
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
          inputMode="numeric"
          placeholder="4 位密码"
          className="rounded-lg bg-white/8 px-3 py-2 text-sm text-white placeholder:text-white/35 outline-none focus:ring-2 focus:ring-accent/60"
        />
        <input
          value={kids}
          onChange={(e) => setKids(e.target.value)}
          placeholder="屏蔽词，逗号分隔"
          className="rounded-lg bg-white/8 px-3 py-2 text-sm text-white placeholder:text-white/35 outline-none focus:ring-2 focus:ring-accent/60"
        />
        <input
          value={time}
          onChange={(e) => setTime(e.target.value)}
          placeholder="限时时段，如 22-7"
          className="rounded-lg bg-white/8 px-3 py-2 text-sm text-white placeholder:text-white/35 outline-none focus:ring-2 focus:ring-accent/60"
        />
      </div>
      <div className="flex gap-2">
        <button className="btn text-sm text-on-accent bg-accent hover:bg-accent-hover" onClick={save}>
          保存并开启
        </button>
        <button className="btn-ghost text-sm" onClick={off} disabled={!cfg.on}>
          关闭
        </button>
      </div>
    </div>
  );
}
