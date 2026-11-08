'use client';

import { cn } from '@/lib/utils';
import type { DanmakuCandidate, DanmakuPrefs } from '@/lib/danmaku';
import type { DanmakuStatus } from './use-danmaku';

/**
 * 弹幕面板（播放器内浮层）。
 *
 * 三件事：开/关选源模式、调观感、手动挑一条B站视频。
 * 观感四件套（不透明度 / 字号 / 速度 / 密度）＋ 显示区域，都是即时生效并记住的——
 * 调一次就够，不用每集重来。
 */

export interface DanmakuPanelProps {
  prefs: DanmakuPrefs;
  setPrefs: (patch: Partial<DanmakuPrefs>) => void;
  status: DanmakuStatus;
  error?: string;
  matched?: { bvid: string; title: string; part?: string; count: number };
  candidates: DanmakuCandidate[];
  pickedBvid?: string;
  pick: (bvid: string) => void;
  reload: () => void;
  onClose: () => void;
}

function formatDuration(seconds: number): string {
  if (!seconds) return '--:--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex gap-1 rounded-xl bg-white/5 p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            'flex-1 rounded-lg px-2 py-1.5 text-xs transition-colors',
            value === option.value
              ? 'bg-accent font-semibold text-on-accent'
              : 'text-white/70 hover:bg-white/10 hover:text-white'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Slider({
  label,
  value,
  display,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center justify-between text-xs text-white/70">
        <span>{label}</span>
        <span className="tabular-nums text-white/90">{display}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/20 accent-accent"
      />
    </label>
  );
}

const STATUS_TEXT: Record<DanmakuStatus, string> = {
  off: '已关闭',
  loading: '正在匹配弹幕…',
  ready: '已加载',
  empty: '这一集没匹配到弹幕',
  error: '弹幕获取失败',
};

export function DanmakuPanel({
  prefs,
  setPrefs,
  status,
  error,
  matched,
  candidates,
  pickedBvid,
  pick,
  reload,
  onClose,
}: DanmakuPanelProps) {
  const manual = prefs.mode === 'manual';
  return (
    <div
      className="w-full overflow-hidden rounded-t-3xl border border-white/10 bg-[#0d141f] shadow-2xl sm:max-w-lg sm:rounded-3xl"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <p className="text-sm font-medium text-white">弹幕</p>
        <button
          type="button"
          className="rounded-full p-1 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          onClick={onClose}
          aria-label="关闭弹幕设置"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div className="scrollbar-thin max-h-[62vh] space-y-4 overflow-y-auto p-4">
        <Segmented
          value={prefs.mode}
          onChange={(mode) => setPrefs({ mode })}
          options={[
            { value: 'off', label: '关闭' },
            { value: 'auto', label: '自动匹配' },
            { value: 'manual', label: '手动选源' },
          ]}
        />

        <div className="flex items-center justify-between gap-3 rounded-xl bg-white/5 px-3 py-2 text-xs">
          <span className="min-w-0 flex-1 truncate text-white/70">
            {status === 'error' && error ? error : STATUS_TEXT[status]}
            {status === 'ready' && matched ? ` · ${matched.count} 条` : ''}
          </span>
          {prefs.mode !== 'off' && (
            <button
              type="button"
              onClick={reload}
              className="shrink-0 rounded-lg bg-white/10 px-2 py-1 text-white/85 transition-colors hover:bg-white/20"
            >
              重新匹配
            </button>
          )}
        </div>

        {status === 'ready' && matched && (
          <p className="-mt-2 line-clamp-2 text-[11px] leading-relaxed text-white/45">
            来源：{matched.part ? `${matched.title} · ${matched.part}` : matched.title}
          </p>
        )}

        {manual && (
          <div className="space-y-1.5">
            <p className="text-xs text-white/60">
              {candidates.length ? '挑一条弹幕最全的视频：' : '还没拿到候选，点上面的「重新匹配」'}
            </p>
            {candidates.map((candidate) => (
              <button
                key={candidate.bvid}
                type="button"
                onClick={() => pick(candidate.bvid)}
                className={cn(
                  'block w-full rounded-xl border px-3 py-2 text-left transition-colors',
                  pickedBvid === candidate.bvid
                    ? 'border-accent/60 bg-accent/15'
                    : 'border-white/10 bg-white/[0.03] hover:border-white/25 hover:bg-white/10'
                )}
              >
                <p className="line-clamp-2 text-xs leading-relaxed text-white/90">{candidate.title}</p>
                <p className="mt-1 flex items-center gap-2 text-[11px] text-white/45">
                  <span className="tabular-nums">{formatDuration(candidate.duration)}</span>
                  <span className="truncate">{candidate.author || '未知UP主'}</span>
                  {candidate.play > 0 && <span className="tabular-nums">{(candidate.play / 10000).toFixed(1)}万播放</span>}
                </p>
              </button>
            ))}
          </div>
        )}

        <div className="space-y-3 border-t border-white/10 pt-3">
          <Slider
            label="不透明度"
            value={prefs.opacity}
            display={`${Math.round(prefs.opacity * 100)}%`}
            min={0.15}
            max={1}
            step={0.05}
            onChange={(opacity) => setPrefs({ opacity })}
          />
          <Slider
            label="字号"
            value={prefs.fontScale}
            display={`${Math.round(prefs.fontScale * 100)}%`}
            min={0.6}
            max={1.8}
            step={0.1}
            onChange={(fontScale) => setPrefs({ fontScale })}
          />
          <Slider
            label="速度"
            value={prefs.speed}
            display={`${prefs.speed.toFixed(1)}×`}
            min={0.5}
            max={2}
            step={0.1}
            onChange={(speed) => setPrefs({ speed })}
          />
          <Slider
            label="同屏密度"
            value={prefs.density}
            display={`${prefs.density} 条`}
            min={10}
            max={120}
            step={5}
            onChange={(density) => setPrefs({ density })}
          />
          <div>
            <p className="mb-1 text-xs text-white/70">显示区域</p>
            <Segmented
              value={prefs.area}
              onChange={(area) => setPrefs({ area })}
              options={[
                { value: 'full', label: '全屏' },
                { value: 'top', label: '上半屏' },
                { value: 'bottom', label: '下半屏' },
              ]}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
