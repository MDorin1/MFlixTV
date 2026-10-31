'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Artplayer from 'artplayer';
import Hls, { type HlsConfig } from 'hls.js';

import { PlaybackRecovery, describeHlsError } from '@/lib/playback-recovery';
import { createHlsLoader } from '@/lib/hls-loader';
import {
  getVideoPrefetcher,
  getNextEpisodePrefetcher,
} from '@/lib/video-prefetcher';
import { loadCacheSettings } from '@/lib/video-cache';
import { formatTime, cn } from '@/lib/utils';
import { prefersTouchPointer } from '@/lib/touch-pointer';
import {
  BRIGHT_MAX,
  BRIGHT_MIN,
  RATE_STEP,
  clampNum,
  normalizeRate,
  readPlayerPrefs,
  savePlayerPrefs,
  type PlayerPrefs,
} from '@/lib/player-prefs';
import {
  findActiveSegment,
  findCrossedEnding,
  resolveSegments,
  SEGMENT_COLORS,
  SEGMENT_LABELS,
  type ResolvedSegment,
  type SkipMark,
  type SkipSegment,
} from '@/lib/skip-marks';
import {
  ART_DEFAULT_CONTROL_HIDE_MS,
  DESKTOP_CONTROL_HIDE_MS,
  TOUCH_CONTROL_HIDE_MS,
} from '@/lib/control-hide';

/** 片段时间统一保留 1 位小数：与面板展示保持一致，避免浮点尾巴 */
const round1 = (v: number) => Math.round(v * 10) / 10;

/** 手势反馈条上的标题（横滑进度 / 竖滑音量 / 竖滑亮度） */
const GESTURE_HUD_TITLES: Record<'seek' | 'volume' | 'brightness', string> = {
  seek: '进度',
  volume: '音量',
  brightness: '亮度',
};

/**
 * 播放器外壳：ArtPlayer + hls.js（旧版 player.js 的 React 化）。
 * 保留：广告分片过滤、自动连播回调、进度回调、快捷键、移动端长按倍速、错误恢复。
 * 移除：DOM 手工操作、watch.html 跳转链、localStorage 状态总线。
 *
 * 关键设计：ArtPlayer 实例只在挂载时创建一次，换集（url 变化）只「切换 HLS 源」
 * 而不销毁重建。否则在「网页全屏（页面全屏）」下整实例重建会丢失全屏上下文、
 * 重建 <video> 元素，触发「黑屏有声」的渲染竞态。
 */

/** 暴露给播放页的读取接口：「记录当前」需要比 5s 节流进度回调更精确的位置 */
export interface PlayerSkipApi {
  getCurrentTime(): number;
  getDuration(): number;
  /** 跳转到指定位置（「试跳」/标记片段起点用） */
  seek(seconds: number): void;
  /** 暂停播放：记录标记前先定格，避免点击到读取之间视频继续走 */
  pause(): void;
  /** 当前是否处于暂停状态 */
  isPaused(): boolean;
}

interface PlayerShellProps {
  url: string;
  title: string;
  adFilter: boolean;
  autoplayNext: boolean;
  /** 当前剧的跳过片段标记（父级按归一化剧名查好后传入，换集/换源不变） */
  skipMark?: SkipMark;
  /**
   * 自动跳过标记的片段：片头/中段跳到片段末尾，片尾（连续播放越过起点）结束本集。
   * 是否连播下一集仍由 autoplayNext 决定。
   */
  autoSkipSegments: boolean;
  /** 中段两步态的起点：由页面层持有，面板与快捷键共用同一份状态 */
  pendingStart: number | null;
  /** 更新中段起点；null 表示取消或已消费 */
  onPendingStart: (start: number | null) => void;
  /** 播放器创建/销毁时回调，供播放页读取精确播放位置 */
  onPlayerApi?: (api: PlayerSkipApi | null) => void;
  /** 快捷键（Shift+I/O/S/E）记录片段时回调，由父级做校验与写入 */
  onRecordSegment?: (segment: SkipSegment) => void;
  /** 剧集标识 `${source}:${vodId}:${episodeIndex}`（片段缓存按集淘汰的分组键） */
  episodeKey?: string;
  /** 下一集 m3u8 地址：当前集预取完成后预热下一集前 7 分钟 */
  nextUrl?: string;
  nextEpisodeKey?: string;
  /** 进度恢复：优先 URL position，其次查询该回调（返回 0 表示无记录） */
  getRestorePosition?: () => number | Promise<number>;
  onTimeUpdate?: (position: number, duration: number) => void;
  onEnded?: () => void;
  onPause?: (position: number, duration: number) => void;
  /**
   * 实测画质（视频高度，像素）。
   * 单码率 m3u8 / 直链的分辨率只能等解码后才知道，播放一次后回写缓存，
   * 下次搜索同一部剧就能直接显示画质，不必再探测。
   */
  onQuality?: (height: number) => void;
  /** 恢复策略判源不可用（重试耗尽/格式硬失败）时回调：父级弹出换源面板 */
  onRequestSwitchSource?: (reason: string) => void;
  /** 控制条上的上一集 / 下一集：不在播放器里也能切集，省得回到页面按钮 */
  onPrevEpisode?: () => void;
  onNextEpisode?: () => void;
  hasPrevEpisode?: boolean;
  hasNextEpisode?: boolean;
  /** 选集面板：总集数与当前集索引（0-based），由播放页提供 */
  episodeCount?: number;
  episodeIndex?: number;
  onSelectEpisode?: (index: number) => void;
  /** 播放器内浮层当前显示哪个面板 */
  panel?: PlayerPanel;
  onPanelChange?: (panel: PlayerPanel) => void;
  /** 换源面板节点：由父级渲染后塞进播放器内部，这样全屏下也看得见 */
  sourcePanel?: ReactNode;
}

/** 播放器内部浮层：选集 / 换源。两者都渲染在播放器 DOM 里，全屏时不会被裁掉 */
export type PlayerPanel = 'none' | 'episodes' | 'source';

export function PlayerShell({
  url,
  title,
  adFilter,
  autoplayNext,
  skipMark,
  autoSkipSegments,
  pendingStart,
  onPendingStart,
  onPlayerApi,
  onRecordSegment,
  episodeKey,
  nextUrl,
  nextEpisodeKey,
  getRestorePosition,
  onTimeUpdate,
  onEnded,
  onPause,
  onQuality,
  onRequestSwitchSource,
  onPrevEpisode,
  onNextEpisode,
  hasPrevEpisode,
  hasNextEpisode,
  episodeCount,
  episodeIndex,
  onSelectEpisode,
  panel = 'none',
  onPanelChange,
  sourcePanel,
}: PlayerShellProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const artRef = useRef<any>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  /** 快捷键帮助面板：按 ? 呼出。这套键一直在，但从来没人告诉过用户有哪些 */
  const [helpOpen, setHelpOpen] = useState(false);
  // 起播前的品牌占位图（沿用旧版 nomedia 素材），实际开始播放后隐藏
  const [showPoster, setShowPoster] = useState(true);
  /**
   * 开场品牌动画：和安卓端同一套（红渐变 MFlixTV 字标 + 红线 + PLEASE ENJOY）。
   * 进播放器先亮，第一帧画面出来或 3.2 秒后自动撤；连播下一集不重复闪（组件不重建）。
   */
  const [branding, setBranding] = useState(true);
  /**
   * 换集/换源瞬间的「上一帧」：切换时把当前画面抓成一张图盖在上面，
   * 新分片进 buffer 再淡出。比直接露黑底 + 通用占位图体感快得多——
   * 用户看到的是「接着上一集」，而不是「黑屏了，在等」。
   */
  const [switchFrame, setSwitchFrame] = useState<string | null>(null);
  const [switchLabel, setSwitchLabel] = useState('');
  /** 键盘事件监听器是在老闭包里跑的，读 helpOpen 要走 ref，否则永远读到 false */
  const helpRef = useRef(false);
  helpRef.current = helpOpen;
  /** 长按临时 2 倍速：画面角上给个明确提示，否则用户不知道速度被改了 */
  const [rateBoost, setRateBoost] = useState(false);
  /**
   * 手势 HUD：横滑拖进度 / 竖滑调音量 / 竖滑调亮度时，屏幕正中那条反馈条。
   * 手机上没有实体键，光靠画面明暗变化看不出「现在到底多少」，必须给数字和进度。
   */
  const [gestureHud, setGestureHud] = useState<{
    kind: 'seek' | 'volume' | 'brightness';
    label: string;
    ratio: number;
  } | null>(null);
  /** 缓冲提示：卡住超过 1.2 秒才出，避免每次换分片都闪一下 */
  const [buffering, setBuffering] = useState(false);
  /** 卡超过 8 秒 → 提示换源（多半是源站自己慢，继续等没意义） */
  const [bufferingSlow, setBufferingSlow] = useState(false);
  /** 选集面板里的滚动容器：打开时回到顶部，别停在上次看到的位置 */
  const episodeListRef = useRef<HTMLDivElement>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 始终持有最新 props/回调，避免重建播放器
  const propsRef = useRef({
    url, title, adFilter, autoplayNext, skipMark, autoSkipSegments,
    pendingStart, onPendingStart, onPlayerApi, onRecordSegment,
    episodeKey, nextUrl, nextEpisodeKey,
    getRestorePosition, onTimeUpdate, onEnded, onPause, onQuality, onRequestSwitchSource,
    onPrevEpisode, onNextEpisode, hasPrevEpisode, hasNextEpisode,
    panel, onPanelChange, episodeIndex,
  });
  propsRef.current = {
    url, title, adFilter, autoplayNext, skipMark, autoSkipSegments,
    pendingStart, onPendingStart, onPlayerApi, onRecordSegment,
    episodeKey, nextUrl, nextEpisodeKey,
    getRestorePosition, onTimeUpdate, onEnded, onPause, onQuality, onRequestSwitchSource,
    onPrevEpisode, onNextEpisode, hasPrevEpisode, hasNextEpisode,
    panel, onPanelChange, episodeIndex,
  };

  /** 挂载 ArtPlayer 之后拿到的浮层容器（portal 目标），全屏时依然在播放器内部 */
  const [layerEl, setLayerEl] = useState<HTMLElement | null>(null);

  const togglePanel = (next: PlayerPanel) => {
    const cur = propsRef.current.panel ?? 'none';
    propsRef.current.onPanelChange?.(cur === next ? 'none' : next);
  };

  /** 面板打开时锁住播放器点击穿透（ArtPlayer 点视频会 toggle 播放） */
  const stopPlayerGesture = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
  };

  /** 上报实测画质：多次上报取大值由调用方决定，这里只管把拿到的高度传出去 */
  const reportQuality = (height: number) => {
    if (height > 0) propsRef.current.onQuality?.(height);
  };

  // 跨集共享、每次换集重置的播放链路状态
  // 媒体健康度：音频轨可播不代表视频轨正常（「黑屏但有声」的假死态）。
  // 仅当有分片真正进入 MSE buffer 后才视为恢复，错误遮罩才能被清除。
  const mediaHealthyRef = useRef(true);
  const playbackStartedRef = useRef(false);
  // 起播阶段的 video 元素级错误允许自愈重试一次（重建 hls/MSE）
  const videoErrorRetryUsedRef = useRef(false);
  // 进度恢复每集只执行一次（MANIFEST_PARSED 可能因代理回退再次触发）
  const restoredRef = useRef(false);
  // 某些 HLS 源在 MANIFEST_PARSED 时 duration 仍未就绪，延迟到媒体元数据可用后恢复
  const restoreCleanupRef = useRef<(() => void) | null>(null);
  // timeupdate 续跑预取的游标：必须按集清零，否则会沿用上一集的时间戳推迟首次续跑
  const lastPrefetchEnsureRef = useRef(0);
  // setupHls 可能改走代理形式，video:error 重试要用最近一次的地址
  const currentMediaUrlRef = useRef(url);
  // 本集的恢复策略实例：跨直连/代理两级重建共享计数
  const recoveryRef = useRef<PlaybackRecovery | null>(null);
  // 自然播完标记，卸载时不回写进度（避免覆盖「已看完」记录）
  const endedRef = useRef(false);
  // 跳过片段：每集已处理的片段（按 type:start 去重），换集时重置（见 loadEpisode）
  const handledSegmentsRef = useRef<Set<string>>(new Set());
  // 被「撤销」过的片段：本集不再自动跳（否则撤回到片段内会被立刻再跳走），但仍保留提示按钮
  const suppressedAutoRef = useRef<Set<string>>(new Set());
  // 上一次 timeupdate 的位置：用于区分「连续播放越过片尾」与「拖动进度条」
  const lastSampleRef = useRef(0);
  // 跳过按钮提示；用 ref 比较，避免 timeupdate 每 250ms 触发重渲染
  const [skipPrompt, setSkipPrompt] = useState<ResolvedSegment | null>(null);
  const skipPromptRef = useRef<ResolvedSegment | null>(null);
  // 刚跳过的片段：给一个撤销窗口，误标导致跳掉正片时不必手动拖回去
  const [undoSkip, setUndoSkip] = useState<{ from: number; segment: ResolvedSegment } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showHint = (text: string) => {
    setHint(text);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setHint(''), 2500);
  };

  /** 相对跳转（秒）：越界夹在 0 ~ 时长-0.3s，避免直接跳到结尾触发连播 */
  const seekBySeconds = (delta: number) => {
    const art = artRef.current;
    if (!art) return;
    const duration = Number(art.duration) || 0;
    const current = Number(art.currentTime) || 0;
    const upper = duration > 0 ? Math.max(0, duration - 0.3) : Number.MAX_SAFE_INTEGER;
    try {
      art.currentTime = Math.max(0, Math.min(upper, current + delta));
    } catch {
      return;
    }
    showHint(`${delta > 0 ? '快进' : '后退'} ${Math.abs(delta)} 秒`);
  };

  // 片段缓存开启时调大 hls.js 自身缓冲，缓冲之外的空窗由预取器补齐
  const buildHlsConfig = (): Partial<HlsConfig> => {
    const p = propsRef.current;
    const cacheSettings = loadCacheSettings();
    const cacheEnabled = cacheSettings.enabled && !!p.episodeKey;
    return {
      debug: false,
      enableWorker: true,
      // 回看缓冲不用留太长：留 90s 会一直占着已解码的帧，长剧集播到后面内存吃紧会掉帧
      backBufferLength: 30,
      // 前向缓冲：非缓存模式也给到 60s，源一旦抖一下不至于立刻卡住（原来只有 30s）
      maxBufferLength: cacheEnabled ? 120 : 60,
      maxMaxBufferLength: cacheEnabled ? 600 : 180,
      maxBufferSize: (cacheEnabled ? 90 : 60) * 1000 * 1000,
      maxBufferHole: 0.5,
      // 起播阶段就把第一片捞下来，与 manifest 解析并行，首帧能早几百毫秒
      startFragPrefetch: true,
      fragLoadingMaxRetry: 8,
      fragLoadingRetryDelay: 500,
      fragLoadingTimeOut: 20000,
      manifestLoadingMaxRetry: 3,
      manifestLoadingRetryDelay: 800,
      manifestLoadingTimeOut: 15000,
      // 按播放器实际尺寸挑档位：手机/小窗不再硬拉 4K 分片，卡顿大头就在这里
      capLevelToPlayerSize: true,
      startLevel: -1,
      abrEwmaDefaultEstimate: 1_200_000,
      appendErrorMaxRetry: 5,
      // 组合 loader：广告过滤（blockAd 随设置）+ 片段缓存命中（cacheEnabled）
      loader: createHlsLoader(Hls, { blockAd: p.adFilter }) as unknown as HlsConfig['loader'],
    };
  };

  /**
   * 抓当前帧做切换遮罩。hls.js 走 MSE blob，画布不会被跨域污染，toDataURL 可用；
   * 万一浏览器拒绝（无 MSE / 视频还没元数据）就退回原来的品牌占位图。
   */
  const captureFrame = (): string | null => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const video = artRef.current?.video as HTMLVideoElement | undefined;
    if (!video || !video.videoWidth || !video.videoHeight) return null;
    try {
      const width = 640;
      const height = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * width));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, width, height);
      return canvas.toDataURL('image/jpeg', 0.6);
    } catch {
      return null;
    }
  };

  // 当前集预取（episodeKey 缺省 = 关闭，见 ensure 内部 settings.enabled 判断）
  const ensurePrefetch = (mediaUrl: string, currentTime: number, horizonSeconds?: number) => {
    const p = propsRef.current;
    if (!p.episodeKey) return;
    getVideoPrefetcher().ensure({
      m3u8Url: mediaUrl,
      currentTime,
      episodeKey: p.episodeKey,
      horizonSeconds,
      onProgress: (stats) => {
        // 当前集预取完成且存在下一集：用独立预取器预热下一集前 7 分钟
        if (stats.state === 'done' && p.nextUrl && p.nextEpisodeKey) {
          getNextEpisodePrefetcher().ensure({
            m3u8Url: p.nextUrl,
            currentTime: 0,
            episodeKey: p.nextEpisodeKey,
            horizonSeconds: 420,
          });
        }
      },
    });
  };

  /** 切换提示状态；值相同直接返回，避免 timeupdate 高频 setState */
  const updateSkipPrompt = (next: ResolvedSegment | null) => {
    const prev = skipPromptRef.current;
    const same =
      prev === next ||
      (prev !== null &&
        next !== null &&
        prev.type === next.type &&
        prev.start === next.start &&
        prev.end === next.end);
    if (same) return;
    skipPromptRef.current = next;
    setSkipPrompt(next);
  };

  /** 片段去重键：按类型 + 起点，同一集内每段只处理一次 */
  const segmentKey = (s: ResolvedSegment) => `${s.type}:${s.start}`;

  /** 进度条区间可视化：在进度条轨道叠加半透明色带（颜色与面板图例共用 SEGMENT_COLORS） */
  const renderSkipMarks = () => {
    const art = artRef.current;
    const progress = art?.template.$progress;
    if (!progress) return;
    progress.querySelectorAll('[data-skip-segment]').forEach((el: Element) => el.remove());
    const duration = art.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const segments = resolveSegments(propsRef.current.skipMark, duration);
    for (const seg of segments) {
      const el = document.createElement('div');
      el.dataset.skipSegment = '1';
      el.title = `跳过${SEGMENT_LABELS[seg.type]}`;
      const left = (seg.start / duration) * 100;
      const width = Math.max(0.4, ((seg.end - seg.start) / duration) * 100);
      el.style.cssText = `position:absolute;left:${left}%;width:${width}%;top:0;bottom:0;background:${SEGMENT_COLORS[seg.type]};pointer-events:none;`;
      progress.appendChild(el);
    }
  };

  /**
   * 跳到片段末尾并续跑预取；同步 lastSampleRef，避免下一拍被误判为「连续越过片尾」。
   * 返回是否成功：媒体未就绪导致赋值失败时返回 false，调用方不置已处理标记，
   * 下一次 timeupdate 会重新判定（保证「可重试」）。
   */
  const skipTo = (seconds: number): boolean => {
    const art = artRef.current;
    if (!art || !Number.isFinite(seconds) || seconds < 0) return false;
    try {
      art.currentTime = seconds;
    } catch {
      return false;
    }
    lastSampleRef.current = seconds;
    ensurePrefetch(currentMediaUrlRef.current, seconds);
    return true;
  };

  /** 记录一次跳过（跳转前的位置）：给 12s 撤销窗口，误标导致跳掉正片时不用手动拖回去 */
  const rememberSkip = (from: number, segment: ResolvedSegment) => {
    setUndoSkip({ from, segment });
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = setTimeout(() => setUndoSkip(null), 12_000);
  };

  const undoLastSkip = () => {
    const last = undoSkip;
    if (!last) return;
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    // 撤销后把片段从「已处理」移除（按钮会重新出现），同时本集不再自动跳它：
    // 否则回到片段内会被下一次 timeupdate 立刻再跳走，形成"撤销→又被跳过"的死循环
    handledSegmentsRef.current.delete(segmentKey(last.segment));
    suppressedAutoRef.current.add(segmentKey(last.segment));
    skipTo(last.from);
    setUndoSkip(null);
    showHint('已撤回跳过');
  };

  /**
   * 跳过片尾：与自然播完共用 onEnded 链路（清进度 + 依 autoplayNext 连播下一集）。
   * endedRef 置 true 同时阻止 video:ended 重复回调，也避免卸载时把片尾进度回写。
   */
  const finishBySkip = (ending?: ResolvedSegment) => {
    const art = artRef.current;
    if (ending) handledSegmentsRef.current.add(segmentKey(ending));
    endedRef.current = true;
    updateSkipPrompt(null);
    setUndoSkip(null);
    try {
      art?.pause();
    } catch {
      /* 忽略 */
    }
    showHint('已跳过片尾');
    propsRef.current.onEnded?.();
  };

  /**
   * 初始化/切换 HLS。allowProxyFallback：直连致命网络错误（CORS/防盗链/分片被拒）时，
   * 自动改走同源 cookie 鉴权的 /api/proxy 重试一次。
   * 注意：不销毁 ArtPlayer，只销毁并重建 hls，从而保留网页全屏等播放器状态。
   */
  const setupHls = (video: HTMLVideoElement, mediaUrl: string, allowProxyFallback: boolean) => {
    restoreCleanupRef.current?.();
    restoreCleanupRef.current = null;
    hlsRef.current?.destroy();
    currentMediaUrlRef.current = mediaUrl;
    const hls = new Hls(buildHlsConfig());
    hlsRef.current = hls;

    let restoreInFlight = false;
    const restoreAndStart = async () => {
      if (restoredRef.current || restoreInFlight) return;

      // MANIFEST_PARSED 早于 loadedmetadata 的 HLS 源很常见；没有有效时长时
      // 先不消费 restoredRef，等 loadedmetadata/durationchange 后再重试。
      const duration = artRef.current?.duration || video.duration || 0;
      if (!Number.isFinite(duration) || duration <= 0) return;

      restoreInFlight = true;
      try {
        const saved = (await propsRef.current.getRestorePosition?.()) ?? 0;
        const currentDuration = artRef.current?.duration || video.duration || duration;
        let prefetchAnchor = video.currentTime;
        if (saved > 10 && Number.isFinite(currentDuration) && saved < currentDuration - 2) {
          if (artRef.current) artRef.current.currentTime = saved;
          prefetchAnchor = saved;
          showHint(`已从 ${formatTime(saved)} 继续播放`);
        }
        restoredRef.current = true;
        restoreCleanupRef.current?.();
        restoreCleanupRef.current = null;
        ensurePrefetch(mediaUrl, prefetchAnchor);
        video.play().catch(() => {});
      } catch {
        // IndexedDB 读取失败时不阻塞播放，后续事件仍可再次尝试恢复。
      } finally {
        restoreInFlight = false;
      }
    };

    const restoreEvents = ['loadedmetadata', 'durationchange', 'canplay'] as const;
    const onRestoreEvent = () => { void restoreAndStart(); };
    restoreEvents.forEach((event) => video.addEventListener(event, onRestoreEvent));
    restoreCleanupRef.current = () => {
      restoreEvents.forEach((event) => video.removeEventListener(event, onRestoreEvent));
    };

    hls.loadSource(mediaUrl);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      recoveryRef.current?.markHealthy();
      // master playlist 的档位高度：多码率源在这里就能拿到上限
      const heights = hls.levels
        .map((level) => level.height)
        .filter((h): h is number => typeof h === 'number' && h > 0);
      if (heights.length > 0) reportQuality(Math.max(...heights));
      // 进度恢复改由 restoreAndStart 处理：duration 未就绪时不消费标记，挂事件重试
      void restoreAndStart();
    });
    // 播放链路恢复（FRAG_LOADED / MANIFEST_PARSED）：静默窗外清零连续失败计数
    hls.on(Hls.Events.FRAG_LOADED, () => recoveryRef.current?.markHealthy());
    // 单码率源在 MANIFEST 阶段拿不到 height（清单尚未解析），这里补一次。
    // 注意 data.level 是档位下标，分辨率在 levelInfo 上
    hls.on(Hls.Events.LEVEL_LOADED, (_evt, data) => {
      const height = data.levelInfo?.height;
      if (typeof height === 'number') reportQuality(height);
    });
    // 分片真正进入 MSE buffer 才算媒体恢复：此时视频轨可渲染，错误态可解除
    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      mediaHealthyRef.current = true;
    });

    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (!data.fatal) return;
      const recovery = recoveryRef.current;
      if (!recovery) return;
      const decision = recovery.onFatal(data.type, data.details);
      switch (decision.action) {
        case 'ignore':
          break;
        case 'retry': {
          // 前两次重试保留直连；达到退避阈值或清单级错误时升级为代理形式
          // （同源 cookie 鉴权，规避 CORS/防盗链/分片被拒）
          if (
            allowProxyFallback &&
            !mediaUrl.startsWith('/api/proxy') &&
            (decision.attempt >= 2 || data.details === 'manifestLoadError')
          ) {
            showHint('直连失败，改用代理重试...');
            setupHls(video, `/api/proxy?url=${encodeURIComponent(mediaUrl)}`, false);
            return;
          }
          showHint(`${decision.reason}（第 ${decision.attempt} 次）...`);
          recovery.schedule(decision.delayMs, () => hls.startLoad());
          break;
        }
        case 'recover-media': {
          showHint(`${decision.reason}（第 ${decision.attempt} 次）...`);
          if (decision.swapAudio) hls.swapAudioCodec?.();
          hls.recoverMediaError();
          break;
        }
        case 'switch-source': {
          // 覆盖播放开始后的场景：起播失败走 setError 遮罩；
          // 播放中失败走回调弹换源面板（父级未提供回调时同样 setError）
          const message = `${describeHlsError(data.type, data.details)}：${decision.reason}`;
          if (playbackStartedRef.current) {
            showHint(message);
            propsRef.current.onRequestSwitchSource?.(decision.reason);
          } else {
            setError(`视频加载失败，${message}，请尝试其他视频源`);
          }
          break;
        }
      }
    });
  };

  /** 换集：重置每集状态并切换到新 HLS 源（不重建 ArtPlayer）。 */
  const loadEpisode = (targetUrl: string, label?: string) => {
    if (!targetUrl) return;
    // 先抓上一帧再拆旧链路：拆除后 video 就只剩黑底了，抓不到东西
    const frame = captureFrame();
    setSwitchFrame(frame);
    setSwitchLabel(label || '');
    mediaHealthyRef.current = true;
    playbackStartedRef.current = false;
    videoErrorRetryUsedRef.current = false;
    restoredRef.current = false;
    lastPrefetchEnsureRef.current = 0;
    // 跳过片段按集重置：上一集已处理过不意味新一集也处理过
    handledSegmentsRef.current.clear();
    suppressedAutoRef.current.clear();
    lastSampleRef.current = 0;
    endedRef.current = false;
    updateSkipPrompt(null);
    setUndoSkip(null);
    recoveryRef.current = new PlaybackRecovery();
    // 换集时清掉上一集的预取窗口，避免带宽被旧集占用
    getVideoPrefetcher().stop();
    setError('');
    setShowPoster(true);
    const art = artRef.current;
    if (!art) return;
    setupHls(art.video, targetUrl, true);
  };

  // —— 创建播放器（仅一次，挂载即创建） ——
  useEffect(() => {
    if (!containerRef.current || !propsRef.current.url) return;
    const initialUrl = propsRef.current.url;
    // ArtPlayer 默认 3 秒才隐藏控制栏；桌面失去鼠标悬停后缩短为 0.8 秒。
    // 触屏没有 hover，自动隐藏会让按钮来不及点（issue #937）：改为常驻，
    // 由「点按视频 toggle」收起。CONTROL_HIDE_TIME 是 static，创建后修改立即生效。
    const touchPointer = prefersTouchPointer();
    Artplayer.CONTROL_HIDE_TIME = touchPointer ? TOUCH_CONTROL_HIDE_MS : DESKTOP_CONTROL_HIDE_MS;
    // 双击交给我们的「±10 秒」：ArtPlayer 默认双击是切全屏，会和快进一起触发
    // （实测双击右侧 ⇒ 快进 10s 且整页进全屏），这里关掉它的默认行为。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Artplayer as any).DBCLICK_FULLSCREEN = false;

    // 初始化每集状态
    mediaHealthyRef.current = true;
    playbackStartedRef.current = false;
    videoErrorRetryUsedRef.current = false;
    restoredRef.current = false;
    recoveryRef.current = new PlaybackRecovery();
    endedRef.current = false;
    handledSegmentsRef.current.clear();
    suppressedAutoRef.current.clear();
    lastSampleRef.current = 0;

    let lastSave = 0;

    // 上次看到哪儿的音量/静音/倍速/亮度：进播放器先恢复，再谈别的
    const initialPrefs = readPlayerPrefs();

    const art = new Artplayer({
      container: containerRef.current,
      url: initialUrl,
      type: 'm3u8',
      volume: initialPrefs.muted ? 0 : initialPrefs.volume,
      muted: initialPrefs.muted,
      autoplay: true,
      pip: true,
      autoMini: true,
      screenshot: true,
      setting: true,
      playbackRate: true,
      aspectRatio: true,
      fullscreen: true,
      fullscreenWeb: true,
      miniProgressBar: true,
      mutex: true,
      backdrop: true,
      playsInline: true,
      airplay: true,
      hotkey: false,
      theme: '#2563eb',
      lang: navigator.language.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en',
      moreVideoAttr: { crossOrigin: 'anonymous', playsInline: true },
      // 上/下集放在播放键右侧：换集是看剧最高频的动作，不该让用户滚回页面下方找按钮
      controls: [
        {
          name: 'prev-episode',
          index: 11,
          position: 'left',
          html: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"><path fill="currentColor" d="M6 6h2v12H6V6zm3.5 6l8.5 6V6l-8.5 6z"/></svg>',
          tooltip: '上一集 (Alt+←)',
          click: () => {
            if (propsRef.current.hasPrevEpisode) propsRef.current.onPrevEpisode?.();
          },
        },
        {
          name: 'next-episode',
          index: 12,
          position: 'left',
          html: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"><path fill="currentColor" d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>',
          tooltip: '下一集 (Alt+→)',
          click: () => {
            if (propsRef.current.hasNextEpisode) propsRef.current.onNextEpisode?.();
          },
        },
        {
          // 选集：面板直接开在播放器里，全屏也能用（不用滚回页面下方）
          name: 'episode-picker',
          index: 13,
          position: 'left',
          html: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"><path fill="currentColor" d="M4 6h2v2H4V6zm4 0h12v2H8V6zM4 11h2v2H4v-2zm4 0h12v2H8v-2zm-4 5h2v2H4v-2zm4 0h12v2H8v-2z"/></svg>',
          tooltip: '选集',
          click: () => togglePanel('episodes'),
        },
        {
          // 切换资源：把页面上的换源面板搬进播放器
          name: 'source-picker',
          index: 14,
          position: 'left',
          html: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"><path fill="currentColor" d="M6.99 11 3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z"/></svg>',
          tooltip: '切换资源',
          click: () => togglePanel('source'),
        },
      ],
      // 播放器内浮层容器：选集/换源的 React 面板 portal 到这里，
      // 全屏时它仍在播放器 DOM 内部，所以不会被全屏元素裁掉。
      layers: [
        {
          name: 'lcs-panel',
          html: '<div data-lcs-panel></div>',
          style: {
            position: 'absolute',
            inset: '0',
            pointerEvents: 'none',
            zIndex: '100',
          },
        },
      ],
      customType: {
        m3u8: (video: HTMLVideoElement, mediaUrl: string) => {
          setupHls(video, mediaUrl, true);
        },
      },
    });
    artRef.current = art;

    // 浮层挂载点：直接挂到 .art-video-player 根节点上并给足 z-index。
    // 不用 ArtPlayer 的 layers 容器——它是 .art-layers（z-index 40）的子节点，
    // 会被 .art-mask(50)/.art-bottom(60) 这些原生层压住，中央播放键会盖在面板上。
    const playerEl = containerRef.current?.querySelector('.art-video-player') as HTMLElement | null;
    let lcsLayer: HTMLElement | null = null;
    if (playerEl) {
      const host = document.createElement('div');
      host.setAttribute('data-lcs-overlay', '');
      host.style.cssText = 'position:absolute;inset:0;z-index:105;pointer-events:none;';
      playerEl.appendChild(host);
      lcsLayer = host;
    }
    setLayerEl(lcsLayer);

    /**
     * —— 手势引擎（触摸端一套、鼠标端一套） ——
     *
     * 触摸（手机 / 平板 / 安卓 WebView）：
     *   双击左 35% → 退 10 秒；双击右 35% → 进 10 秒；双击中间 → 播放/暂停
     *   画面内横向拖动 → 拖进度（跟手给目标时间，松手才真正 seek）
     *   右半屏纵向拖动 → 音量；左半屏纵向拖动 → 亮度
     *   长按 450ms → 2 倍速，松开恢复
     * 鼠标：只留双击左右 ±10 秒（拖进度有进度条，画面手势只会添乱）。
     *
     * 触摸事件挂在容器上、用非 passive 的 touchmove：只有它能 preventDefault，
     * 否则横滑会连带把整页一起滚走（手机上最典型的「拖进度结果页面乱跑」）。
     * 控制条 / 设置面板在兄弟层里，拖动它们不会被当成画面手势。
     *
     * 双击会被浏览器算作两次点击，ArtPlayer 因此触发两次「暂停/播放」，
     * 所以记住第一拍之前的播放状态，第二拍快进完再用一次 play() 兜回来。
     */
    const gestureVideo = art.video as HTMLVideoElement | undefined;
    const gestureEl = containerRef.current;

    // 长按倍速
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let holding = false;
    let rateBeforeHold = 1;

    // 单指拖动状态机
    type GestureMode = 'none' | 'seek' | 'volume' | 'brightness';
    let mode: GestureMode = 'none';
    let startX = 0;
    let startY = 0;
    let startAt = 0;
    let volStart = 0.8;
    let brightStart = 1;
    let seekPreview = 0;
    let dragVolume = 0.8;
    let dragBright = 1;
    let lastHudAt = 0;
    let lastTouchGestureAt = 0;

    // 双击识别
    let lastTapAt = 0;
    let lastTapX = 0;
    let playingBeforeTap = false;
    /** 第一拍之前的播放状态：第二拍结束用它决定要不要把画面兜回播放 */
    let pairStartPlaying = false;

    // 缓冲/卡顿提示的定时器（慢提示要等 8 秒才升级文案）
    let bufferTimer: ReturnType<typeof setTimeout> | null = null;
    let slowBufferTimer: ReturnType<typeof setTimeout> | null = null;
    let prefsTimer: ReturnType<typeof setTimeout> | null = null;

    /** 亮度当前值：video 元素上的 filter 只是表象，真值记在这里 */
    let brightness = initialPrefs.brightness;
    const applyBrightnessToVideo = (value: number) => {
      const next = clampNum(value, BRIGHT_MIN, BRIGHT_MAX);
      brightness = next;
      // 手势松手时要落盘这个值（dragBright 只在拖动中有意义，两者保持同步）
      dragBright = next;
      if (!gestureVideo) return next;
      // 只在压暗时叠 filter：1.0 时清空字符串，别给解码链留无谓的合成层
      gestureVideo.style.filter = next < 0.995 ? `brightness(${next.toFixed(2)})` : '';
      return next;
    };

    const clearHold = () => {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
      if (holding) {
        holding = false;
        try {
          if (gestureVideo) gestureVideo.playbackRate = rateBeforeHold;
        } catch {
          /* 忽略 */
        }
        setRateBoost(false);
      }
    };

    /** 拖动过程中的 HUD：限流 60ms，不然每个 move 都 setState 会把主线程拖住 */
    const pushHud = (
      kind: 'seek' | 'volume' | 'brightness',
      label: string,
      ratio: number,
      force = false
    ) => {
      const now = Date.now();
      if (!force && now - lastHudAt < 60) return;
      lastHudAt = now;
      setGestureHud({ kind, label, ratio: clampNum(ratio, 0, 1) });
    };

    const setVolumeTo = (value: number) => {
      const next = clampNum(value, 0, 1);
      dragVolume = next;
      const player = artRef.current;
      if (player) {
        try {
          player.volume = next;
          if (next > 0 && player.muted) player.muted = false;
        } catch {
          /* 忽略 */
        }
      }
      return next;
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        mode = 'none';
        clearHold();
        return;
      }
      const target = e.target as HTMLElement | null;
      // 控制条 / 设置面板 / 我们自己的浮层上的拖动不算画面手势
      if (target?.closest?.('.art-controls, .art-settings, [data-lcs-overlay]')) return;
      const touch = e.touches[0];
      mode = 'none';
      startX = touch.clientX;
      startY = touch.clientY;
      startAt = Number(artRef.current?.currentTime) || 0;
      volStart = Number(artRef.current?.volume) || 0.8;
      brightStart = brightness;
      dragVolume = volStart;
      dragBright = brightness;
      playingBeforeTap = !(gestureVideo?.paused ?? true);
      clearHold();
      rateBeforeHold = Number(gestureVideo?.playbackRate) || 1;
      holdTimer = setTimeout(() => {
        // 暂停时「长按倍速」没有意义，只在播放中生效
        if (!gestureVideo || gestureVideo.paused || mode !== 'none') return;
        holding = true;
        try {
          gestureVideo.playbackRate = 2;
        } catch {
          /* 忽略 */
        }
        setRateBoost(true);
      }, 450);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      // 长按倍速期间锁住页面滚动，否则手指微动会把页面拖走、倍速提示也跟着断
      if (holding) {
        e.preventDefault();
        return;
      }
      if (mode === 'none') {
        // 14px 以内是点按的抖动，不算拖动
        if (Math.abs(dx) < 14 && Math.abs(dy) < 14) return;
        if (holdTimer) {
          clearTimeout(holdTimer);
          holdTimer = null;
        }
        const rect = gestureVideo?.getBoundingClientRect();
        if (Math.abs(dx) >= Math.abs(dy) * 1.15) {
          mode = 'seek';
        } else if (Math.abs(dy) >= Math.abs(dx) * 1.15) {
          const halfWidth = (rect?.width ?? window.innerWidth) / 2;
          mode = touch.clientX - (rect?.left ?? 0) > halfWidth ? 'volume' : 'brightness';
        } else {
          // 斜着晃：先不表态，等手指选出主方向
          return;
        }
      }
      // 手势成立后才吃事件：不成立时页面照常能滚
      e.preventDefault();
      lastTouchGestureAt = Date.now();
      const rect = gestureVideo?.getBoundingClientRect();
      const width = rect?.width || window.innerWidth;
      const height = rect?.height || window.innerHeight;

      if (mode === 'seek') {
        const duration = Number(artRef.current?.duration) || 0;
        if (duration <= 0) return;
        // 一屏宽 ≈ 90 秒：横滑半屏是常见的「跳几分钟」
        const delta = (dx / width) * 90;
        seekPreview = clampNum(startAt + delta, 0, Math.max(0, duration - 0.3));
        const sign = delta >= 0 ? '+' : '-';
        pushHud(
          'seek',
          `${formatTime(seekPreview)} / ${formatTime(duration)}   ${sign}${Math.abs(Math.round(delta))}s`,
          duration > 0 ? seekPreview / duration : 0
        );
        return;
      }
      if (mode === 'volume') {
        const next = setVolumeTo(volStart - dy / height);
        pushHud('volume', `音量 ${Math.round(next * 100)}%`, next);
        return;
      }
      const next = applyBrightnessToVideo(brightStart - dy / height);
      pushHud(
        'brightness',
        `亮度 ${Math.round(next * 100)}%`,
        (next - BRIGHT_MIN) / (BRIGHT_MAX - BRIGHT_MIN)
      );
    };

    const onTouchEnd = (e: TouchEvent) => {
      const wasHolding = holding;
      const finishedMode = mode;
      clearHold();
      mode = 'none';
      setGestureHud(null);
      lastTouchGestureAt = Date.now();

      if (finishedMode === 'seek') {
        const delta = seekPreview - startAt;
        if (Math.abs(delta) >= 1) seekBySeconds(delta);
        return;
      }
      if (finishedMode === 'volume') {
        savePlayerPrefs({ volume: dragVolume, muted: dragVolume === 0 });
        return;
      }
      if (finishedMode === 'brightness') {
        savePlayerPrefs({ brightness: dragBright });
        return;
      }
      if (wasHolding) return; // 长按结束，不当作点击

      const touch = e.changedTouches[0];
      if (!touch) return;
      // 手指在原地抖了两下：不当点按处理，免得误触发双击快进
      if (Math.abs(touch.clientX - startX) > 12 || Math.abs(touch.clientY - startY) > 12) {
        lastTapAt = 0;
        return;
      }
      const now = Date.now();
      if (now - lastTapAt < 300 && Math.abs(touch.clientX - lastTapX) < 90) {
        lastTapAt = 0;
        const rect = gestureVideo?.getBoundingClientRect();
        if (rect) {
          const x = touch.clientX - rect.left;
          if (x <= rect.width * 0.35) seekBySeconds(-10);
          else if (x >= rect.width * 0.65) seekBySeconds(10);
        }
        // 两拍把播放器切了两次（暂停→播放），本来就暂停着的要兜回来
        setTimeout(() => {
          const video = artRef.current?.video as HTMLVideoElement | undefined;
          if (video && (pairStartPlaying || playingBeforeTap) && video.paused) {
            void video.play().catch(() => {});
          }
        }, 150);
        return;
      }
      lastTapAt = now;
      lastTapX = touch.clientX;
      pairStartPlaying = playingBeforeTap;
    };

    /** 鼠标双击左右两侧：±10 秒（触摸的双击已经在 onTouchEnd 算过，这里要跳过） */
    const onVideoDblClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (Date.now() - lastTouchGestureAt < 800) return;
      const rect = gestureVideo?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left;
      if (x <= rect.width * 0.35) seekBySeconds(-10);
      else if (x >= rect.width * 0.65) seekBySeconds(10);
    };

    // ArtPlayer 默认双击是切全屏，会和我们的快进一起触发，统一在构造前关掉
    const onContextMenu = (e: Event) => e.preventDefault();

    gestureEl?.addEventListener('touchstart', onTouchStart, { passive: false });
    gestureEl?.addEventListener('touchmove', onTouchMove, { passive: false });
    gestureEl?.addEventListener('touchend', onTouchEnd);
    gestureEl?.addEventListener('touchcancel', onTouchEnd);
    gestureEl?.addEventListener('contextmenu', onContextMenu);
    gestureVideo?.addEventListener('dblclick', onVideoDblClick);

    // —— 偏好记忆：音量 / 静音 / 倍速 / 亮度 ——
    // 合并攒批：音量、倍速往往前后脚各自触发一次，如果后一次直接把前一次顶掉，
    // 「调了倍速再按音量键」就会把倍速丢掉（实测过：1.25 倍存成 1）
    let pendingPrefs: Partial<PlayerPrefs> = {};
    const persistPrefs = (patch: Partial<PlayerPrefs>) => {
      pendingPrefs = { ...pendingPrefs, ...patch };
      if (prefsTimer) clearTimeout(prefsTimer);
      prefsTimer = setTimeout(() => {
        prefsTimer = null;
        const toSave = pendingPrefs;
        pendingPrefs = {};
        savePlayerPrefs(toSave);
      }, 400);
    };
    const onVolumeChange = () => {
      const video = art.video as HTMLVideoElement | undefined;
      if (!video) return;
      persistPrefs({ volume: video.volume, muted: video.muted });
    };
    const onRateChange = () => {
      // 长按倍速是临时状态，存下来会让下次一进播放器就是 2 倍
      if (holding) return;
      const rate = Number(gestureVideo?.playbackRate);
      if (!rate || rate <= 0) return;
      persistPrefs({ rate: normalizeRate(rate) });
    };
    const applyPreferredRate = () => {
      if (holding) return;
      const { rate } = readPlayerPrefs();
      try {
        if (gestureVideo && Math.abs((gestureVideo.playbackRate || 1) - rate) > 0.01) {
          art.playbackRate = rate;
        }
      } catch {
        /* 忽略 */
      }
    };
    gestureVideo?.addEventListener('volumechange', onVolumeChange);
    gestureVideo?.addEventListener('ratechange', onRateChange);
    art.on('video:loadedmetadata', applyPreferredRate);
    art.on('ready', applyPreferredRate);
    // 上次压暗过就接着压暗：换集/全屏都不会重置 video 元素的 style
    applyBrightnessToVideo(brightness);

    // 进度条区间可视化：初始渲染一次，换集 duration 变化时重绘
    renderSkipMarks();
    art.on('video:durationchange', renderSkipMarks);
    // 全屏切换 / 播放器尺寸变化会重建控件，色带随之被清掉，这里补一次重绘
    art.on('fullscreen', renderSkipMarks);
    art.on('fullscreenWeb', renderSkipMarks);
    art.on('resize', renderSkipMarks);

    // 播放页「记录当前」需要精确时间：不能依赖 5s 节流的 onTimeUpdate
    propsRef.current.onPlayerApi?.({
      getCurrentTime: () => {
        const current = artRef.current?.currentTime;
        return typeof current === 'number' && Number.isFinite(current) ? current : 0;
      },
      getDuration: () => {
        const duration = artRef.current?.duration;
        return typeof duration === 'number' && Number.isFinite(duration) ? duration : 0;
      },
      seek: (seconds) => {
        if (!Number.isFinite(seconds) || seconds < 0) return;
        try {
          artRef.current.currentTime = seconds;
        } catch {
          /* 忽略 */
        }
      },
      pause: () => {
        try {
          artRef.current?.pause();
        } catch {
          /* 忽略 */
        }
      },
      isPaused: () => artRef.current?.video?.paused ?? true,
    });

    /**
     * 读解码后的真实分辨率。
     * 单码率 m3u8 / mp4 直链的清单里没有画质字段，服务端无论如何探测不到，
     * 只有 video 元素的 videoHeight 是真的——这是「播放一次即记住画质」链路的唯一数据源。
     * loadedmetadata 在部分浏览器上 videoHeight 仍为 0，因此 resize / canplay / playing
     * 各补一次机会，不能只赌单一事件时机。
     */
    const reportVideoHeight = () => {
      const height = art.video?.videoHeight;
      if (typeof height === 'number' && height > 0) reportQuality(height);
    };
    art.on('video:loadedmetadata', reportVideoHeight);
    art.on('video:canplay', reportVideoHeight);
    // resize 不在 ArtPlayer 的视频事件转发表里，直接挂原生事件
    art.video?.addEventListener('resize', reportVideoHeight);

    art.on('video:loadedmetadata', () => {
      // ArtPlayer 运行时支持 title 选项（类型定义未覆盖），用于界面标题展示
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (art as any).title = propsRef.current.title;
      } catch { /* 忽略 */ }
    });

    art.on('video:playing', () => {
      playbackStartedRef.current = true;
      setShowPoster(false);
      // 第一帧上屏：开场品牌动画撤掉，不遮挡画面
      setBranding(false);
      // 新画面上屏了，切换遮罩（上一帧）可以撤了
      setSwitchFrame(null);
      setSwitchLabel('');
      // 仅在媒体真正恢复（有分片进入 buffer）后清错误遮罩：
      // 否则「视频轨挂了、音频轨先播出来」时会清掉遮罩，留下黑屏假死态
      if (mediaHealthyRef.current) setError('');
      reportVideoHeight();
    });
    art.on('video:error', () => {
      mediaHealthyRef.current = false;
      // 出错时也别让品牌页挡着错误提示
      setBranding(false);
      // 起播阶段的 video 元素级错误（MSE/解码偶发失败）：重建一次播放链路自愈，
      // 而不是直接钉死错误遮罩——重建后视频轨重新 append，黑屏有声即可解除
      if (!playbackStartedRef.current && !videoErrorRetryUsedRef.current) {
        videoErrorRetryUsedRef.current = true;
        showHint('播放异常，正在重试...');
        setupHls(art.video, currentMediaUrlRef.current, true);
        return;
      }
      setError('视频播放失败，请尝试其他视频源');
    });
    art.on('video:timeupdate', () => {
      const now = Date.now();
      if (now - lastSave > 5000) {
        lastSave = now;
        propsRef.current.onTimeUpdate?.(art.currentTime, art.duration);
      }
      // 每 30s 续跑一次前向预取窗口（ensure 幂等，窗口未覆盖足够余量才会重建）
      if (now - lastPrefetchEnsureRef.current > 30_000) {
        lastPrefetchEnsureRef.current = now;
        // 用 currentMediaUrlRef（代理回退后的实际地址）：否则预取的 key 与
        // loader 读取的 key 不一致，缓存永不命中且直连 fetch 白耗流量
        ensurePrefetch(currentMediaUrlRef.current, art.currentTime);
      }

      // —— 跳过片段判定 ——
      const p = propsRef.current;
      const current = art.currentTime;
      const duration = art.duration;
      const previous = lastSampleRef.current;
      lastSampleRef.current = current;
      const segments = resolveSegments(p.skipMark, duration);

      // 结尾片段：只认连续播放越过起点；拖动进度条、刚写入标记、进度恢复造成的大跳变
      // 都不自动结束，只显示按钮由用户决定。是否结束由合并后的 autoSkipSegments 控制
      // （片头/中段跳段，片尾结束本集，是否连播下一集仍看 autoplayNext）。
      if (
        p.autoSkipSegments &&
        restoredRef.current &&
        playbackStartedRef.current &&
        findCrossedEnding(segments, previous, current)
      ) {
        const ending = segments.find(
          (s) => s.type === 'ending' && previous < s.start && current >= s.start
        );
        finishBySkip(ending);
        return;
      }

      // 片头/中段片段：命中则自动跳到末尾（同一类操作，共用 autoSkipSegments 开关）；
      // 已处理过的片段本集不再反复拉扯。
      const active = findActiveSegment(segments, current);
      if (
        active &&
        active.type !== 'ending' &&
        p.autoSkipSegments &&
        !handledSegmentsRef.current.has(segmentKey(active)) &&
        !suppressedAutoRef.current.has(segmentKey(active)) &&
        restoredRef.current &&
        playbackStartedRef.current
      ) {
        if (skipTo(active.end)) {
          handledSegmentsRef.current.add(segmentKey(active));
          rememberSkip(current, active);
          showHint(active.type === 'opening' ? '已跳过片头' : '已跳过中段');
        }
      }

      // 按钮提示：当前落在某个未处理片段内（结尾片段显示「跳过片尾」）
      const prompt =
        active && !handledSegmentsRef.current.has(segmentKey(active)) ? active : null;
      updateSkipPrompt(prompt);
    });
    art.on('video:seeked', () => {
      ensurePrefetch(currentMediaUrlRef.current, art.currentTime);
      // seek 是用户主动行为：拉平采样基准，避免下一拍被误判为「连续越过片尾」。
      // 暂停中 seek 不会触发 timeupdate，这里也同步刷新按钮的显隐。
      const current = art.currentTime;
      lastSampleRef.current = current;
      const segments = resolveSegments(propsRef.current.skipMark, art.duration);
      const active = findActiveSegment(segments, current);
      const prompt =
        active && !handledSegmentsRef.current.has(segmentKey(active)) ? active : null;
      updateSkipPrompt(prompt);
    });
    art.on('video:pause', () => {
      // 跳过片尾会主动 pause：此时已按「看完」处理，不能再把片尾位置写回进度
      if (!endedRef.current) propsRef.current.onPause?.(art.currentTime, art.duration);
      // 暂停 = 预取黄金窗口：解除限速并无限铺满整集（用户主动行为，带宽占用可接受）
      // waiting 触发的限速在此解除，否则黄金窗口会被 500ms 轮询冻结
      getVideoPrefetcher().setThrottled(false);
      ensurePrefetch(currentMediaUrlRef.current, art.currentTime, 0);
    });
    art.on('video:waiting', () => {
      // 卡顿：预取临时让出带宽给播放
      getVideoPrefetcher().setThrottled(true);
      // 缓冲提示延后 1.2 秒：正常换分片的几十毫秒抖动不该闪一个「缓冲中」
      if (bufferTimer) return;
      bufferTimer = setTimeout(() => {
        bufferTimer = null;
        setBuffering(true);
        if (slowBufferTimer) clearTimeout(slowBufferTimer);
        slowBufferTimer = setTimeout(() => {
          slowBufferTimer = null;
          setBufferingSlow(true);
        }, 8000);
      }, 1200);
    });
    art.on('video:playing', () => {
      getVideoPrefetcher().setThrottled(false);
      if (bufferTimer) { clearTimeout(bufferTimer); bufferTimer = null; }
      if (slowBufferTimer) { clearTimeout(slowBufferTimer); slowBufferTimer = null; }
      setBuffering(false);
      setBufferingSlow(false);
    });
    art.on('video:ended', () => {
      // finishBySkip 已经手动走过结束链路：这里不能重复触发 onEnded
      if (endedRef.current) return;
      endedRef.current = true;
      updateSkipPrompt(null);
      propsRef.current.onEnded?.();
    });

    // —— 键盘快捷键（旧版 hotkey:false + 自定义逻辑的移植） ——
    const shortcuts = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // 输入框或按钮获得焦点时不劫持按键：否则空格会吞掉按钮的默认激活。
      // 遥控端会往 document 上派发合成按键，那时 e.target 是 document（没有 closest），
      // 必须用可选链兜住，否则处理器直接抛错、遥控指令全部失效
      const tag = target?.tagName ?? '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.closest?.('button')) return;
      const current = artRef.current;
      if (!current) return;
      // ? 呼出快捷键表：这是唯一「所有键都能被看见」的地方
      if (e.key === '?' || (e.shiftKey && e.code === 'Slash')) {
        // ref 立刻改：state 要等下一次渲染，紧接着按的键会以为表还没开
        setHelpOpen((v) => {
          helpRef.current = !v;
          return !v;
        });
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape' && helpRef.current) {
        helpRef.current = false;
        setHelpOpen(false);
        e.preventDefault();
        return;
      }
      // 表开着就不要再动底下的画面：J/L/0–9 这些键一按就会改播放位置
      if (helpRef.current) {
        e.preventDefault();
        return;
      }
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); return; } // 由父层处理集数切换
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); return; }
      // 数字键 0–9：跳到整集的百分比位置（0 = 片头，5 = 一半，9 = 九成）
      if (/^[0-9]$/.test(e.key) && !e.altKey && !e.ctrlKey && !e.metaKey) {
        const duration = Number(current.duration) || 0;
        if (duration > 0) {
          const ratio = Number(e.key) / 10;
          const target = Math.max(0, Math.min(duration - 0.5, duration * ratio));
          try {
            current.currentTime = target;
          } catch {
            /* 忽略 */
          }
          showHint(`跳到 ${Math.round(ratio * 100)}% · ${formatTime(target)}`);
          e.preventDefault();
        }
        return;
      }
      switch (e.key) {
        case 'ArrowLeft':
          if (current.currentTime > 5) { current.currentTime -= 5; showHint('快退 5s'); e.preventDefault(); }
          break;
        case 'ArrowRight':
          if (current.duration - current.currentTime > 5) { current.currentTime += 5; showHint('快进 5s'); e.preventDefault(); }
          break;
        case 'ArrowUp':
          // 静音状态下按音量键要先解除静音，否则调了没声音还以为音量键坏了
          if (current.muted) current.muted = false;
          if (current.volume < 1) { current.volume = Math.min(1, current.volume + 0.1); showHint(`音量 ${Math.round(current.volume * 100)}%`); e.preventDefault(); }
          break;
        case 'ArrowDown':
          if (current.muted) current.muted = false;
          if (current.volume > 0) { current.volume = Math.max(0, current.volume - 0.1); showHint(`音量 ${Math.round(current.volume * 100)}%`); e.preventDefault(); }
          break;
        case ' ':
          current.toggle(); showHint('播放/暂停'); e.preventDefault();
          break;
        case 'f': case 'F':
          current.fullscreen = !current.fullscreen; e.preventDefault();
          break;
        // —— 下面这些和各类 PC 播放器（PotPlayer / IINA / B 站）的习惯对齐 ——
        case 'k': case 'K':
          current.toggle(); showHint('播放/暂停'); e.preventDefault();
          break;
        case 'm': case 'M':
          current.muted = !current.muted;
          showHint(current.muted ? '已静音' : '已取消静音');
          e.preventDefault();
          break;
        case 'j': case 'J':
          seekBySeconds(-10); e.preventDefault();
          break;
        case 'l': case 'L':
          seekBySeconds(10); e.preventDefault();
          break;
        case 'p': case 'P':
          // 画中画：手机上和系统手势配合「边看边聊」，桌面端可以挂小窗
          // 老浏览器没有 PiP 接口，setter 会抛错，这里兜住别让快捷键炸掉播放器
          try {
            current.pip = !current.pip;
          } catch {
            showHint('这个浏览器不支持画中画');
          }
          e.preventDefault();
          break;
        case ',': case '<':
          current.playbackRate = normalizeRate((current.playbackRate || 1) - RATE_STEP);
          showHint(`倍速 ${current.playbackRate}×`); e.preventDefault();
          break;
        case '.': case '>':
          current.playbackRate = normalizeRate((current.playbackRate || 1) + RATE_STEP);
          showHint(`倍速 ${current.playbackRate}×`); e.preventDefault();
          break;
        case 'Escape':
          // 全屏里按 Esc 先退全屏，不要直接跳出播放页
          if (current.fullscreen) { current.fullscreen = false; e.preventDefault(); }
          else if (current.fullscreenWeb) { current.fullscreenWeb = false; e.preventDefault(); }
          break;
        // 标记类快捷键一律要求 Shift：这几键会直接写盘并影响整部剧，
        // 单键太容易误触（误记片头 = 之后每集都被跳过一大段）
        case 'i': case 'I':
          if (!e.shiftKey) break;
          propsRef.current.onRecordSegment?.({
            type: 'opening',
            start: 0,
            end: round1(current.currentTime),
          });
          e.preventDefault();
          break;
        case 'o': case 'O':
          if (!e.shiftKey) break;
          propsRef.current.onRecordSegment?.({
            type: 'ending',
            start: round1(current.currentTime),
            end: -1,
          });
          e.preventDefault();
          break;
        case 's': case 'S':
          if (!e.shiftKey) break;
          propsRef.current.onPendingStart(round1(current.currentTime));
          showHint('片段起点已记录，播放到终点后按 Shift+E');
          e.preventDefault();
          break;
        case 'e': case 'E': {
          if (!e.shiftKey) break;
          const start = propsRef.current.pendingStart;
          if (start === null) {
            showHint('请先按 Shift+S 记录片段起点');
          } else {
            const end = round1(current.currentTime);
            propsRef.current.onPendingStart(null);
            propsRef.current.onRecordSegment?.({ type: 'middle', start, end });
          }
          e.preventDefault();
          break;
        }
      }
    };
    document.addEventListener('keydown', shortcuts);

    /**
     * 遥控端拖进度条 → 绝对位置跳转。
     * 键盘快捷键只能「相对跳」，手机遥控器上拖到某个位置必须按绝对时间 seek，
     * 所以走一条自定义事件，由播放器自己执行（换集/全屏都不受影响）。
     */
    const onRemoteSeekTo = (e: Event) => {
      const to = Number((e as CustomEvent).detail);
      if (!Number.isFinite(to) || to < 0) return;
      const player = artRef.current;
      if (!player) return;
      const duration = Number(player.duration) || 0;
      const upper = duration > 0 ? Math.max(0, duration - 0.3) : to;
      const target = Math.min(upper, to);
      try {
        player.currentTime = target;
      } catch {
        return;
      }
      showHint(`遥控：跳到 ${formatTime(target)}`);
    };
    window.addEventListener('mfl:rc-seekto', onRemoteSeekTo);

    /**
     * 遥控端按「全屏」→ 切 Artplayer 的**网页全屏**（fullscreenWeb）。
     *
     * 为什么不用原生全屏：浏览器只允许用户手势触发 requestFullscreen，
     * 而遥控指令来自 fetch 轮询，永远没有手势——直接调必被拒，
     * 连脚本去点页面上的全屏按钮也一样（合成 click 不算激活）。
     * 网页全屏是纯 CSS 撑满视口，不挑手势，画面一样铺满，退出也干净。
     * 顺手把当前状态写到 <html data-mfl-fs>，被控端上报 fs 时读它。
     */
    const syncFsFlag = () => {
      const on = !!art.fullscreen || !!art.fullscreenWeb || !!document.fullscreenElement;
      document.documentElement.dataset.mflFs = on ? '1' : '0';
    };
    const onRemoteFullscreen = (e: Event) => {
      const detail = (e as CustomEvent<{ handled?: boolean }>).detail;
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      else art.fullscreenWeb = !art.fullscreenWeb;
      if (detail) detail.handled = true;
      window.setTimeout(syncFsFlag, 80);
    };
    window.addEventListener('mfl:rc-fullscreen', onRemoteFullscreen);
    art.on('fullscreen', syncFsFlag);
    art.on('fullscreenWeb', syncFsFlag);
    art.on('fullscreenWebExit', syncFsFlag);
    syncFsFlag();

    // 长按倍速、双击、横竖滑统一在「手势引擎」里处理（见上方），
    // 这里只留一对鼠标控制条显隐的监听。
    const el = containerRef.current;

    // 全屏时播放器覆盖整个视口，无法依赖 mouseleave 判断“移出播放器”。
    // 改为按鼠标活动计时：停止移动后快速收起控制栏，移动时立即显示。
    let controlHideTimer: ReturnType<typeof setTimeout> | null = null;
    const showControlsOnPointerMove = () => {
      art.controls.show = true;
      if (controlHideTimer) clearTimeout(controlHideTimer);
      controlHideTimer = setTimeout(() => {
        if (!art.setting.show) art.controls.show = false;
      }, 800);
    };
    const hideControlsOnMouseLeave = () => {
      if (controlHideTimer) clearTimeout(controlHideTimer);
      controlHideTimer = null;
      art.controls.show = false;
    };
    // 触屏不监听 mousemove/mouseleave，也跳过初始显示：iOS 点按视频的合成事件
    // 序列是 mousemove → click，若 mousemove 先把 show 置 true，紧跟的 ArtPlayer
    // click toggle 会把它翻回 false——控制栏「闪一下即隐」，正是 issue #937 的病灶
    if (!touchPointer) {
      el?.addEventListener('mousemove', showControlsOnPointerMove);
      el?.addEventListener('mouseleave', hideControlsOnMouseLeave);
      showControlsOnPointerMove();
    }

    // 卸载与页面隐藏时保存进度
    const saveOnHide = () => {
      if (document.visibilityState === 'hidden' && !endedRef.current) {
        propsRef.current.onPause?.(art.currentTime, art.duration);
      }
    };
    document.addEventListener('visibilitychange', saveOnHide);

    return () => {
      // 卸载前刷一次最终进度，避免丢失最后几秒。
      // 已自然播完的集数不回写，避免覆盖 onEnded 里清除的「已看完」记录
      if (!endedRef.current) {
        try {
          propsRef.current.onPause?.(art.currentTime, art.duration);
        } catch { /* 忽略 */ }
      }
      document.removeEventListener('keydown', shortcuts);
      window.removeEventListener('mfl:rc-seekto', onRemoteSeekTo);
      window.removeEventListener('mfl:rc-fullscreen', onRemoteFullscreen);
      delete document.documentElement.dataset.mflFs;
      document.removeEventListener('visibilitychange', saveOnHide);
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      el?.removeEventListener('touchstart', onTouchStart);
      el?.removeEventListener('touchend', onTouchEnd);
      el?.removeEventListener('touchcancel', onTouchEnd);
      el?.removeEventListener('touchmove', onTouchMove);
      el?.removeEventListener('contextmenu', onContextMenu);
      art.video?.removeEventListener('resize', reportVideoHeight);
      gestureVideo?.removeEventListener('dblclick', onVideoDblClick);
      gestureVideo?.removeEventListener('volumechange', onVolumeChange);
      gestureVideo?.removeEventListener('ratechange', onRateChange);
      if (holdTimer) clearTimeout(holdTimer);
      if (prefsTimer) clearTimeout(prefsTimer);
      if (bufferTimer) clearTimeout(bufferTimer);
      if (slowBufferTimer) clearTimeout(slowBufferTimer);
      el?.removeEventListener('mousemove', showControlsOnPointerMove);
      el?.removeEventListener('mouseleave', hideControlsOnMouseLeave);
      if (controlHideTimer) clearTimeout(controlHideTimer);
      restoreCleanupRef.current?.();
      restoreCleanupRef.current = null;
      Artplayer.CONTROL_HIDE_TIME = ART_DEFAULT_CONTROL_HIDE_MS;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      recoveryRef.current?.dispose();
      getVideoPrefetcher().stop();
      // 播放页可能仍持有读取接口：销毁前显式置空，避免「记录当前」读到已销毁实例
      propsRef.current.onPlayerApi?.(null);
      // 摘掉我们自己挂的浮层宿主（否则 portal 目标随 art 一起被销毁会留下空壳）
      const overlayHost = containerRef.current?.querySelector('[data-lcs-overlay]');
      overlayHost?.remove();
      art.destroy();
      artRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // —— 上/下集禁用态：走 ArtPlayer 的 controls API 更新样式，不直接改 DOM ——
  // 直接 querySelector 改 style 在控件重建（切全屏/播放器重绘）后不会恢复，且依赖内部 class 名。
  useEffect(() => {
    const controls = artRef.current?.controls;
    if (!controls) return;
    controls.update({
      name: 'prev-episode',
      style: { opacity: hasPrevEpisode ? '1' : '0.4', pointerEvents: hasPrevEpisode ? 'auto' : 'none' },
    });
    controls.update({
      name: 'next-episode',
      style: { opacity: hasNextEpisode ? '1' : '0.4', pointerEvents: hasNextEpisode ? 'auto' : 'none' },
    });
  }, [hasPrevEpisode, hasNextEpisode, url]);

  // —— 标记变化：重置采样基准并立即刷新提示 ——
  // 刚写入片段时当前时间可能恰好等于新边界，若沿用上一拍采样会被判成
  // 「连续越过」而当场触发；把基准拉平后本集只保留手动按钮，下一集才自动。
  // 顺带覆盖暂停中修改标记的场景（没有 timeupdate 也要让按钮即时出现/消失）。
  useEffect(() => {
    const art = artRef.current;
    if (!art) return;
    const current = art.currentTime;
    lastSampleRef.current = Number.isFinite(current) ? current : 0;
    const segments = resolveSegments(skipMark, art.duration);
    const active = findActiveSegment(segments, current);
    const prompt =
      active && !handledSegmentsRef.current.has(segmentKey(active)) ? active : null;
    updateSkipPrompt(prompt);
    renderSkipMarks();
  }, [skipMark]);

  // —— 换集：仅切换 HLS 源，不重建播放器（保留网页全屏等状态） ——
  const firstUrlRef = useRef(true);
  useEffect(() => {
    // 挂载时的首次由创建 effect 的 customType 触发，跳过避免重复加载
    if (firstUrlRef.current) { firstUrlRef.current = false; return; }
    const idx = propsRef.current.episodeIndex;
    loadEpisode(url, typeof idx === 'number' ? `第 ${idx + 1} 集` : '正在切换');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // —— 广告过滤开关变化：重建 HLS loader（无需重建整个播放器） ——
  const firstAdFilterRef = useRef(true);
  useEffect(() => {
    if (firstAdFilterRef.current) { firstAdFilterRef.current = false; return; }
    if (artRef.current && hlsRef.current) {
      // 用当前实际媒体地址：代理回退生效时切广告过滤不应跳回直连形式
      loadEpisode(currentMediaUrlRef.current || propsRef.current.url, '重新加载');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adFilter]);

  // —— 选集面板打开时定位到当前集 ——
  // 30 集的剧直接从头排会让用户每次都要往下翻；把「正在看的这一集」滚到中间，
  // 顺便避免浏览器因为焦点跳转把容器滚到莫名其妙的位置（手机上实测会吞掉第一行）。
  useEffect(() => {
    if (panel !== 'episodes') return;
    const box = episodeListRef.current;
    if (!box) return;
    const active = box.querySelector<HTMLElement>('[data-episode-active="true"]');
    if (active) {
      box.scrollTop = Math.max(0, active.offsetTop - box.clientHeight / 2 + active.clientHeight / 2);
    } else {
      box.scrollTop = 0;
    }
  }, [panel]);

  // 开场品牌兜底：源站慢、一直没出画面时，3.2 秒后也要撤掉，别让黑底字标一直挂着
  useEffect(() => {
    if (!branding) return;
    const t = window.setTimeout(() => setBranding(false), 3200);
    return () => window.clearTimeout(t);
  }, [branding]);

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" style={{ WebkitTouchCallout: 'none' }} />
      {showPoster && !error && switchFrame && (
        // 换集/换源：上一帧盖在上面，画面不黑、观感上是「接着上一集」。
        // 加载中的转圈交给 ArtPlayer 自己的中心指示器，这里只留一个小标签，
        // 不再叠第二个 spinner，避免和播放器原生占位打架。
        <div className="pointer-events-none absolute inset-0 overflow-hidden bg-black">
          <img
            src={switchFrame}
            alt=""
            aria-hidden
            className="h-full w-full scale-105 object-cover opacity-55 blur-[3px]"
          />
          <div className="absolute bottom-20 left-4 rounded-full bg-black/65 px-3 py-1.5 text-xs text-white/85 backdrop-blur">
            {switchLabel || '正在切换'}
          </div>
        </div>
      )}
      {showPoster && !error && !switchFrame && (
        <div
          className="absolute inset-0 bg-black pointer-events-none"
          style={{
            backgroundImage: 'url(/player-poster.png)',
            backgroundSize: 'contain',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
          }}
        />
      )}
      {branding && !error && (
        // 开场品牌动画：和安卓端同一套（红渐变大字标 + 红线 + PLEASE ENJOY），
        // 第一帧画面出来或 3.2 秒后自动撤；连播下一集组件不重建，所以只亮一次。
        <div className="pointer-events-none absolute inset-0 z-[9] flex flex-col items-center justify-center gap-4 bg-black">
          <div className="brand-splash-word">MFlixTV</div>
          <div className="brand-splash-bar" />
          <div className="brand-splash-sub">PLEASE ENJOY</div>
        </div>
      )}
      {helpOpen && (
        // 快捷键表：按 ? 呼出。这些键一直都在，但没有任何地方写出来过
        <div
          className="absolute inset-0 z-30 flex items-center justify-center bg-black/78 p-6 backdrop-blur-sm"
          onClick={() => setHelpOpen(false)}
          role="dialog"
          aria-label="快捷键"
        >
          <div
            className="w-full max-w-2xl rounded-2xl border border-white/10 bg-[#101013] p-5 text-[13px] text-white/80 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[14px] font-semibold text-white">快捷键</span>
              <button
                type="button"
                className="rounded-md px-2 py-1 text-[12px] text-white/50 hover:bg-white/10 hover:text-white"
                onClick={() => setHelpOpen(false)}
              >
                关闭 · Esc
              </button>
            </div>
            <div className="grid grid-cols-2 gap-x-8 gap-y-1.5">
              {[
                ['空格 / K', '播放 / 暂停'],
                ['J / L', '快退 / 快进 10 秒'],
                ['← / →', '快退 / 快进 5 秒'],
                ['↑ / ↓', '音量'],
                ['M', '静音'],
                ['0 – 9', '跳到 0% – 90%'],
                [', / .', '倍速 - / +'],
                ['F', '全屏'],
                ['P', '画中画'],
                ['Esc', '退出全屏 / 关面板'],
                ['Shift + I', '把当前位置记成片头结尾'],
                ['Shift + O', '把当前位置记成片尾起点'],
                ['Shift + S', '记片段起点'],
                ['Shift + E', '记片段终点'],
                ['?', '打开 / 关闭这张表'],
                ['Alt + ← / →', '上一集 / 下一集'],
              ].map(([k, v]) => (
                <div key={k} className="flex items-baseline gap-3">
                  <kbd className="min-w-[76px] shrink-0 rounded-md border border-white/15 bg-white/[0.06] px-2 py-[3px] text-center font-mono text-[11px] text-white/85">
                    {k}
                  </kbd>
                  <span className="text-white/60">{v}</span>
                </div>
              ))}
            </div>
            <div className="mt-4 text-[11.5px] leading-relaxed text-white/35">
              标记类（Shift 开头）会写进本机、影响整部剧的自动跳过，所以故意要求按住 Shift；手机上是横滑拖进度、左右半屏竖滑调亮度与音量、双击左右 ±10 秒、长按 2 倍速。
            </div>
          </div>
        </div>
      )}

      {!error && skipPrompt && (
        <button
          type="button"
          className="absolute bottom-16 left-1/2 -translate-x-1/2 z-10 rounded-full bg-black/70 px-4 py-2 text-sm text-white transition-colors hover:bg-black/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          onClick={() => {
            if (skipPrompt.type === 'ending') {
              finishBySkip(skipPrompt);
              return;
            }
            const from = artRef.current?.currentTime ?? 0;
            if (skipTo(skipPrompt.end)) {
              handledSegmentsRef.current.add(segmentKey(skipPrompt));
              rememberSkip(from, skipPrompt);
              updateSkipPrompt(null);
              showHint(skipPrompt.type === 'opening' ? '已跳过片头' : '已跳过中段');
            }
          }}
        >
          {skipPrompt.type === 'ending'
            ? '跳过片尾'
            : skipPrompt.type === 'opening'
              ? '跳过片头'
              : '跳过中段'}
        </button>
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80">
          <p className="text-danger text-sm">{error}</p>
          <button className="btn-ghost text-xs" onClick={() => location.reload()}>
            重新加载
          </button>
        </div>
      )}
      {rateBoost && (
        // 长按倍速期间常驻左上角：速度被临时改掉，必须让用户看得见
        <div className="pointer-events-none absolute left-4 top-4 z-10 flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-sm font-semibold text-white animate-fade-in">
          <span className="tabular-nums">2×</span>
          <span className="text-xs font-normal text-white/70">松开恢复</span>
        </div>
      )}
      {buffering && !error && !rateBoost && (
        // 卡顿提示：手机上没有转圈就只剩黑屏，用户会以为播放器死了
        <div className="pointer-events-none absolute left-4 top-4 z-10 flex max-w-[calc(100%-2rem)] items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-xs text-white/90 animate-fade-in">
          <span className="inline-block size-3 shrink-0 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          <span className="truncate">
            {bufferingSlow ? '网络较慢，可在「切换资源」里换源' : '缓冲中…'}
          </span>
        </div>
      )}
      {gestureHud && (
        // 手势反馈条：手机上没有实体键，调了多少必须给数字
        <div className="pointer-events-none absolute left-1/2 top-1/2 z-20 w-[min(70%,260px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-black/70 px-4 py-3 backdrop-blur animate-fade-in">
          <div className="mb-2 flex items-center justify-between gap-3 text-white/90">
            <span className="text-xs text-white/70">{GESTURE_HUD_TITLES[gestureHud.kind]}</span>
            <span className="text-xs tabular-nums">{gestureHud.label}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/20">
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${Math.round(gestureHud.ratio * 100)}%` }}
            />
          </div>
        </div>
      )}
      {(hint || undoSkip) && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-sm text-white animate-fade-in">
          {/* 撤销窗口比普通提示长：hint 已淡出时仍要让用户知道刚才跳过了什么 */}
          <span className="pointer-events-none">
            {hint || (undoSkip ? `已跳过${SEGMENT_LABELS[undoSkip.segment.type]}` : '')}
          </span>
          {undoSkip && (
            <button
              type="button"
              className="pointer-events-auto shrink-0 rounded-full bg-white/20 px-2 py-0.5 text-xs font-medium transition-colors hover:bg-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              onClick={undoLastSkip}
            >
              撤销
            </button>
          )}
        </div>
      )}
      {autoplayNext && !error && (
        <div className="absolute bottom-16 right-3 text-[10px] text-muted bg-black/50 px-2 py-0.5 rounded pointer-events-none">
          自动连播已开启
        </div>
      )}

      {/* 播放器内浮层：选集 / 换源。portal 进 ArtPlayer 的 layer，全屏下依然可见 */}
      {layerEl &&
        panel === 'episodes' &&
        createPortal(
          <div
            className="fixed inset-0 z-[120] flex items-end justify-center bg-black/90 backdrop-blur-md sm:items-center sm:p-6"
            style={{ pointerEvents: 'auto' }}
            onClick={(e) => {
              stopPlayerGesture(e);
              onPanelChange?.('none');
            }}
            onKeyDown={stopPlayerGesture}
            role="dialog"
            aria-label="选集"
          >
            <div
              className="w-full overflow-hidden rounded-t-3xl border border-white/10 bg-[#0d141f] shadow-2xl sm:max-w-lg sm:rounded-3xl"
              onClick={stopPlayerGesture}
            >
              <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                <p className="text-sm font-medium text-white">
                  选集{episodeCount ? ` · 共 ${episodeCount} 集` : ''}
                </p>
                <button
                  type="button"
                  className="rounded-full p-1 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                  onClick={() => onPanelChange?.('none')}
                  aria-label="关闭选集"
                >
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
              <div
                ref={episodeListRef}
                className="scrollbar-thin grid max-h-[62vh] grid-cols-[repeat(auto-fill,minmax(52px,1fr))] gap-1.5 overflow-y-auto p-3"
              >
                {Array.from({ length: episodeCount || 0 }, (_, i) => (
                  <button
                    key={i}
                    type="button"
                    className={cn(
                      'rounded-lg py-2 text-xs tabular-nums transition-colors',
                      i === episodeIndex
                        ? 'bg-accent font-semibold text-on-accent'
                        : 'bg-white/5 text-white/80 hover:bg-white/15 hover:text-white'
                    )}
                    data-episode-active={i === episodeIndex ? 'true' : undefined}
                    onClick={() => {
                      onSelectEpisode?.(i);
                      onPanelChange?.('none');
                    }}
                  >
                    {i + 1}
                  </button>
                ))}
              </div>
            </div>
          </div>,
          layerEl
        )}

      {layerEl &&
        panel === 'source' &&
        createPortal(
          <div className="absolute inset-0" style={{ pointerEvents: 'auto' }} onClick={stopPlayerGesture}>
            {sourcePanel}
          </div>,
          layerEl
        )}
    </div>
  );
}
