'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Header } from '@/components/header';
import { cn } from '@/lib/utils';
import { toggleNativeFullscreen } from '@/lib/native-fullscreen';
import { ShortFeed } from './short-feed';

/**
 * MFlixTV短剧
 *
 * 两层导航：体裁（真人剧 / 漫剧 / AI短剧）→ 榜单（推荐 / 热播 / 新剧）
 *
 * 数据来源说明（重要）：
 * - 上游这套接口只有「漫剧」的官方榜单（comic_series_*），真人剧/AI短剧的
 *   landpage 接口目前返回空，所以这两个体裁用「关键词聚合计」拿到真实片目，
 *   再按播放量/评分排序；漫剧走官方三榜。
 * - 播放：/stream?vid= 由本机第三方内核转换格式后直出。
 */

const API = '/hg-api';

type Board = 'recommend' | 'hot' | 'new';
type GenreKey = 'short_play' | 'comic_series' | 'ai_series';

const GENRES: { key: GenreKey; label: string; hint: string }[] = [
  { key: 'short_play', label: '真人剧', hint: '真人拍摄' },
  { key: 'comic_series', label: '漫剧', hint: '官方榜单' },
  { key: 'ai_series', label: 'AI短剧', hint: '合成画面' },
];

const BOARDS: { key: Board; label: string }[] = [
  { key: 'recommend', label: '推荐' },
  { key: 'hot', label: '热播' },
  { key: 'new', label: '新剧' },
];

/** 真人剧/AI短剧没有官方目录，用一组高频题材词做聚合搜索（并发 3 路） */
const SEEDS: Record<GenreKey, string[]> = {
  short_play: ['皇后', '闪婚', '离婚', '复仇', '婆婆', '千金', '重生', '退婚', '豪门', '神医', '妻子', '逆袭'],
  comic_series: [],
  ai_series: ['修仙', '玄幻', '系统', '末世', '脑洞', '逆袭', '重生', '强者'],
};

interface Item {
  rank?: number;
  series_id: string;
  title: string;
  episode_cnt: number;
  score?: string;
  play_cnt?: number;
  hot?: string;
  copyright?: string;
  cover?: string;
  abstract?: string;
  tags?: string[];
  /** 上游体裁：1=真人短剧，1004=漫剧/AI短剧 */
  content_type?: number;
}

interface Episode {
  index: number;
  vid: string;
  title?: string;
  duration?: number;
  cover?: string;
}

interface Meta {
  series_id: string;
  title: string;
  abstract?: string;
  episode_cnt: number;
  status?: string;
  cover?: string;
  category?: string;
  tags?: string[];
  play_cnt?: number;
}

/**
 * 观看记录：一部剧一条，但**每一集**都单独记秒数（eps[集号] = 秒）。
 * 这样切回第 3 集还能接着 18:32 看，而不是从头开始。
 */
interface ShowProgress {
  seriesId: string;
  title: string;
  cover?: string;
  /** 集号 -> 已看秒数 */
  eps: Record<string, number>;
  /** 集号 -> 该集总时长（用于进度条与"已看完"判断） */
  durs: Record<string, number>;
  lastEp: number;
  lastPos: number;
  updatedAt: number;
  /** 收藏（追剧） */
  fav?: boolean;
}

/** 旧版单条记录（迁移用） */
interface LegacyEntry {
  seriesId: string;
  title: string;
  cover?: string;
  epIndex: number;
  pos: number;
  dur: number;
  updatedAt: number;
}

const HIST_KEY = 'hg_progress_v2';
const LEGACY_KEY = 'hg_watch_history_v1';
const HIST_MAX = 120;

function loadProgress(): ShowProgress[] {
  try {
    const raw = localStorage.getItem(HIST_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as ShowProgress[];
      if (Array.isArray(arr)) return arr.filter((x) => x && x.seriesId);
    }
  } catch {
    /* 落回旧格式 */
  }
  try {
    const rawOld = localStorage.getItem(LEGACY_KEY);
    if (!rawOld) return [];
    const arr = JSON.parse(rawOld) as LegacyEntry[];
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && x.seriesId && x.epIndex > 0)
      .map((x) => ({
        seriesId: x.seriesId,
        title: x.title,
        cover: x.cover,
        eps: { [String(x.epIndex)]: x.pos },
        durs: x.dur ? { [String(x.epIndex)]: x.dur } : {},
        lastEp: x.epIndex,
        lastPos: x.pos,
        updatedAt: x.updatedAt || Date.now(),
      }));
  } catch {
    return [];
  }
}

function saveProgress(list: ShowProgress[]) {
  try {
    localStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, HIST_MAX)));
  } catch {
    /* 隐私模式下写不进去就算了 */
  }
}

function upsertProgress(list: ShowProgress[], next: ShowProgress): ShowProgress[] {
  return [next, ...list.filter((x) => x.seriesId !== next.seriesId)].slice(0, HIST_MAX);
}

/**
 * 记录只留在这台设备（这个浏览器）里。
 *
 * 0.35 之前这份记录会推到服务端、进页面时再拉回来合并，本意是「换设备接着看」，
 * 代价却是反过来的：同一台电脑上，安装版和别的设备开的网页版会互相串记录，
 * 别人看过什么你这边也冒出来。现在彻底不连服务端 —— localStorage 本来就是
 * 「每个客户端各一份」，和手机端（index.html）的做法一致。
 */

/** 播放器偏好：倍速与音量，跨集/跨次记住 */
const PREFS_KEY = 'hg_player_prefs';

function loadPrefs(): { rate: number; volume: number } {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const o = JSON.parse(raw) as { rate?: number; volume?: number };
      return {
        rate: Number.isFinite(o.rate) && (o.rate as number) >= 0.5 && (o.rate as number) <= 3 ? (o.rate as number) : 1,
        volume: Number.isFinite(o.volume) ? Math.min(1, Math.max(0, o.volume as number)) : 0.8,
      };
    }
  } catch {
    /* 忽略 */
  }
  return { rate: 1, volume: 0.8 };
}

function savePrefs(p: { rate: number; volume: number }) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* 忽略 */
  }
}

const RATES = [1, 1.25, 1.5, 1.75, 2];

const fmtTime = (s: number) => {
  if (!Number.isFinite(s) || s <= 0) return '00:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};

/** 剧名归一化：去掉季数/番外/标点，用于判断「是不是同一部剧」 */
const normTitle = (s: string) =>
  String(s || '')
    .replace(/[《》【】[\]()（）·・,，。!！?？:：\s]/g, '')
    .replace(/第[一二三四五六七八九十百\d]{1,3}季/g, '')
    .replace(/(前传|后传|番外|特别篇|合集|完整版)/g, '');

const sameShow = (a: string, b: string) => {
  const x = normTitle(a);
  const y = normTitle(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
};

const fmtCount = (n?: number) => {
  if (!n || n <= 0) return '';
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(0)}万`;
  return String(n);
};

export default function HongguoPage() {
  const [key, setKey] = useState('');
  const [genre, setGenre] = useState<GenreKey>('comic_series');
  const [board, setBoard] = useState<Board>('recommend');
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState('');

  const [detail, setDetail] = useState<{ meta: Meta; episodes: Episode[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailErr, setDetailErr] = useState('');

  const [playing, setPlaying] = useState<{ index: number; vid: string; title: string } | null>(null);
  const [playerLoading, setPlayerLoading] = useState(true);
  const [playerErr, setPlayerErr] = useState('');
  /** 加载已等待秒数：让"卡住"和"正在准备"看起来不一样 */
  const [loadingSec, setLoadingSec] = useState(0);
  const [episodeSheet, setEpisodeSheet] = useState(false);
  const [history, setHistory] = useState<ShowProgress[]>([]);
  const [rate, setRate] = useState(1);
  const [volume, setVolume] = useState(0.8);
  /** 播完后的自动连播倒计时（秒），null 表示不显示 */
  const [nextCountdown, setNextCountdown] = useState<number | null>(null);
  const [histTab, setHistTab] = useState<'recent' | 'fav'>('recent');
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** 触屏手势：滑动快进 / 长按 3 倍速 */
  const gestureRef = useRef<{
    x: number;
    y: number;
    t: number;
    timer: ReturnType<typeof setTimeout> | null;
    rate: number;
  } | null>(null);
  const [sourceSheet, setSourceSheet] = useState<{ items: Item[]; loading: boolean; error: string } | null>(null);
  const [resumeHint, setResumeHint] = useState('');
  /** 流地址附加的 nonce：出错重试时 +1，强制视频重新拉流 */
  const [streamNonce, setStreamNonce] = useState(0);
  /** 刷剧流（竖向整屏翻页）是否打开 */
  const [feedOpen, setFeedOpen] = useState(false);
  /** 从刷剧流点了播放：等这部剧的集数拉回来就自动起播 */
  const autoPlayRef = useRef<string | null>(null);
  /** 清晰度：1080p 兼容性最好（服务端会转 H.264），失败时可降档重试 */
  const [quality, setQuality] = useState<'1080p' | '720p' | '540p'>('1080p');
  const retriedRef = useRef(false);
  /** 下一次 metadata 就绪时要跳到的秒数（换集/换源续播） */
  const pendingSeekRef = useRef<number | null>(null);
  const lastSaveRef = useRef(0);
  /** 历史同步到服务端的防抖定时器 */
  const videoRef = useRef<HTMLVideoElement>(null);
  const reqIdRef = useRef(0);
  /** 漫剧榜 series_id 黑名单：搜索接口不带体裁字段，靠它把漫剧从真人剧/AI短剧里剔掉 */
  const comicIdsRef = useRef<Set<string> | null>(null);
  /** 漫剧榜标题：上游偶有漫剧被标成 content_type=1，按剧名再兜一层 */
  const comicTitlesRef = useRef<Set<string> | null>(null);

  /* ------------------------------ 本地密钥 ------------------------------ */
  const ensureKey = useCallback(async (force = false) => {
    if (key && !force) return key;
    const cached = typeof window !== 'undefined' ? localStorage.getItem('hg_api_key') || '' : '';
    if (cached && !force) {
      setKey(cached);
      return cached;
    }
    const res = await fetch(`${API}/api-key`);
    const json = await res.json();
    if (!json?.api_key) throw new Error('拿不到本地密钥');
    localStorage.setItem('hg_api_key', json.api_key);
    setKey(json.api_key);
    return json.api_key as string;
  }, [key]);

  const hg = useCallback(
    async <T,>(path: string, retry = true): Promise<T> => {
      const k = await ensureKey();
      const sep = path.includes('?') ? '&' : '?';
      const res = await fetch(`${API}${path}${sep}api_key=${encodeURIComponent(k)}`, {
        headers: { 'x-api-key': k },
      });
      if (res.status === 401 && retry) {
        await ensureKey(true);
        return hg<T>(path, false);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    },
    [ensureKey]
  );

  /* --------------------------- 数据加载 --------------------------- */

  /** 漫剧：官方榜单（支持 offset，用于把黑名单拉全） */
  const loadRank = useCallback(
    async (b: Board, offset = 0) => {
      const data = await hg<{ items: Item[] }>(`/rank?board=${b}&limit=42&offset=${offset}`);
      return data.items || [];
    },
    [hg]
  );

  /** 真人剧 / AI短剧：关键词聚合搜索（并发 3 路，边到边合并） */
  const loadAggregate = useCallback(
    async (g: GenreKey, b: Board, onPartial?: (items: Item[]) => void) => {
      const seeds = SEEDS[g] || [];
      const seen = new Map<string, Item>();
      const queue = seeds.slice();
      let inflight = 0;
      let finished = 0;


      // 先拿到漫剧榜的全量 id 当黑名单：搜索接口不带体裁字段，只能这样区分
      let comicIds = comicIdsRef.current;
      let comicTitles = comicTitlesRef.current;
      if (!comicIds) {
        comicIds = new Set<string>();
        comicTitles = new Set<string>();
        try {
          const jobs: Promise<Item[]>[] = [];
          (['recommend', 'hot', 'new'] as Board[]).forEach((bd) => {
            [0, 42, 84].forEach((off) => jobs.push(loadRank(bd, off)));
          });
          const boards = await Promise.all(jobs);
          boards.forEach((list) =>
            (list || []).forEach((it) => {
              comicIds!.add(it.series_id);
              if (it.title) comicTitles!.add(it.title.trim());
            })
          );
        } catch {
          /* 拿不到黑名单就按关键词原样展示 */
        }
        comicIdsRef.current = comicIds;
        comicTitlesRef.current = comicTitles;
      }
      if (!comicIds) comicIds = new Set<string>();
      if (!comicTitles) comicTitles = new Set<string>();
      const sortItems = (list: Item[]) => {
        const arr = list.slice();
        if (b === 'hot') arr.sort((x, y) => (y.play_cnt || 0) - (x.play_cnt || 0));
        else if (b === 'recommend') arr.sort((x, y) => Number(y.score || 0) - Number(x.score || 0));
        // new：保持搜索返回顺序（上游按新鲜度给）
        return arr;
      };

      return new Promise<Item[]>((resolve) => {
        const next = () => {
          if (queue.length === 0) {
            if (inflight === 0) resolve(sortItems([...seen.values()]).slice(0, 60));
            return;
          }
          const word = queue.shift() as string;
          inflight += 1;
          hg<{ results: Item[] }>(`/search?q=${encodeURIComponent(word)}&page=1`)
            .then((r) => {
              (r.results || []).forEach((it) => {
                if (!it?.series_id) return;
                if (g === 'short_play') {
                  // 真人剧：上游 content_type=1 才是真实拍摄，其余是合成画面
                  if (it.content_type !== 1) return;
                  if (comicTitles.has((it.title || '').trim())) return;
                } else {
                  // AI短剧：合成类(1004) 且不在官方漫剧榜里
                  if (it.content_type !== 1004) return;
                  if (comicIds.has(it.series_id)) return;
                }
                if (!seen.has(it.series_id)) seen.set(it.series_id, it);
              });
              onPartial?.(sortItems([...seen.values()]).slice(0, 60));
            })
            .catch(() => {})
            .finally(() => {
              inflight -= 1;
              finished += 1;
              next();
            });
          if (inflight < 3) next();
        };
        next();
        // 兜底：全部词都失败时别永远转圈
        setTimeout(() => {
          if (finished === 0 && inflight === 0) resolve([]);
        }, 30000);
      });
    },
    [hg, loadRank]
  );

  const load = useCallback(
    async (g: GenreKey, b: Board) => {
      const myId = ++reqIdRef.current;
      setLoading(true);
      setErr('');
      // 先上上次的缓存：进专区不该每次白屏重排，缓存就位后再后台刷新（stale-while-revalidate）
      const cacheKey = 'mflixtv:hongguo:' + g + ':' + b;
      let cachedArr: Item[] = [];
      try {
        const raw = localStorage.getItem(cacheKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) cachedArr = parsed as Item[];
        }
      } catch {
        cachedArr = [];
      }
      setItems(cachedArr);
      try {
        if (g === 'comic_series') {
          const list = await loadRank(b);
          if (myId === reqIdRef.current) setItems(list);
        } else {
          const list = await loadAggregate(g, b, (partial) => {
            if (myId === reqIdRef.current) setItems(partial);
          });
          if (myId === reqIdRef.current) setItems(list);
          try {
            localStorage.setItem(cacheKey, JSON.stringify(list.slice(0, 120)));
          } catch {
            /* 配额满就算了，下次照样重新拉 */
          }
        }
      } catch (e) {
        if (myId === reqIdRef.current) {
          setErr(e instanceof Error ? e.message : '加载失败');
          setItems([]);
        }
      } finally {
        if (myId === reqIdRef.current) setLoading(false);
      }
    },
    [loadRank, loadAggregate]
  );

  useEffect(() => {
    if (!searched) void load(genre, board);
  }, [genre, board, searched, load]);

  const doSearch = async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setErr('');
    try {
      const data = await hg<{ results: Item[] }>(`/search?q=${encodeURIComponent(q)}&page=1`);
      setItems(data.results || []);
      setSearched(q);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '搜索失败');
      setItems([]);
    } finally {
      setSearching(false);
    }
  };

  /* ------------------------------- 详情 -------------------------------- */
  const openDetail = async (item: Item, autoPlay = false) => {
    // 从刷剧流点「看第 1 集 / 继续第 N 集」时，集数还没拉回来，
    // 先把意图记下来，等 detail 到位后的 effect 里起播。
    autoPlayRef.current = autoPlay ? item.series_id : null;
    setDetail({
      meta: {
        series_id: item.series_id,
        title: item.title,
        abstract: item.abstract,
        episode_cnt: item.episode_cnt,
        cover: item.cover,
        tags: item.tags,
      },
      episodes: [],
    });
    setDetailLoading(true);
    setDetailErr('');
    try {
      const data = await hg<{ meta: Meta; episodes: Episode[] }>(`/episodes?series_id=${item.series_id}`);
      setDetail({ meta: data.meta, episodes: data.episodes || [] });
      // 进详情页就先把第 1 集转好：看完简介点播放时通常已经就绪
      const firstEp = (data.episodes || [])[0];
      // 不在进详情页时预热第 1 集：用户往往马上点播放，预热会和播放抢同一集的下载
    } catch (e) {
      setDetailErr(e instanceof Error ? e.message : '剧集加载失败');
    } finally {
      setDetailLoading(false);
    }
  };

  /* ------------------------------- 播放 -------------------------------- */
  /** 记录进度：剧级 + 集级双写，切回哪一集都能接上（只写本机） */
  const persistProgress = (pos: number, dur: number) => {
    if (!detail || !playing) return;
    if (!Number.isFinite(pos) || pos < 3) return;
    const nearEnd = Number.isFinite(dur) && dur > 0 && pos > dur - 20;
    const list = loadProgress();
    const prev = list.find((x) => x.seriesId === detail.meta.series_id);
    const eps = { ...(prev?.eps || {}) };
    const durs = { ...(prev?.durs || {}) };
    if (!nearEnd) eps[String(playing.index)] = Math.round(pos);
    if (Number.isFinite(dur) && dur > 0) durs[String(playing.index)] = Math.round(dur);
    const entry: ShowProgress = {
      seriesId: detail.meta.series_id,
      title: detail.meta.title,
      cover: detail.meta.cover,
      eps,
      durs,
      lastEp: playing.index,
      lastPos: nearEnd ? 0 : Math.round(pos),
      updatedAt: Date.now(),
      fav: prev?.fav ?? false,
    };
    const next = upsertProgress(list, entry);
    saveProgress(next);
    setHistory(next);
  };

  const flushProgress = () => {
    const v = videoRef.current;
    if (v && detail && playing) persistProgress(v.currentTime, v.duration);
  };

  // 加载计时：只在"加载中且没报错"时走，用来显示已等待时长
  useEffect(() => {
    if (!playerLoading || playerErr) {
      setLoadingSec(0);
      return;
    }
    const id = window.setInterval(() => setLoadingSec((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [playerLoading, playerErr, playing?.index]);

  const play = (ep: Episode, title: string, startAt?: number) => {
    flushProgress();
    clearCountdown();
    setPlayerErr('');
    setPlayerLoading(true);
    pendingSeekRef.current = typeof startAt === 'number' && startAt > 0 ? startAt : null;
    retriedRef.current = false;
    setStreamNonce(0);
    setPlaying({ index: ep.index, vid: ep.vid, title });
    setEpisodeSheet(false);
    // 预热由「当前这集真的开始播之后」触发，见 onPlaying —— 播放前预热只会抢带宽
    warmPendingRef.current = ep.index;
  };

  /**
   * 拼某一集的播放地址。预取和播放必须用完全相同的参数（quality / api_key），
   * 否则命中的是内核里两份不同的解密产物，预热就白做了。
   */
  const streamUrlFor = (vid: string, nonce = 0) =>
    key
      ? `${API}/stream?vid=${encodeURIComponent(vid)}&quality=${quality}&api_key=${encodeURIComponent(key)}${
          nonce > 0 ? `&r=${nonce}` : ''
        }`
      : '';

  const warmAbortRef = useRef<AbortController | null>(null);
  /** 等当前这集真正出画后再开始预热下一集，避免抢带宽 */
  const warmPendingRef = useRef<number | null>(null);
  const warmStartedRef = useRef<number | null>(null);

  /**
   * 预热后面 4 集（用户点了第 1 集，第 2–5 集就要能直接秒播）：
   *  1. `/prewarm` 让内核开始下载并解密这一集（落盘后 /stream 就是本机文件 + Range）；
   *  2. 再顺序拉每集前 1.5MB —— 把解密产物推到「已经就绪」的状态，浏览器也顺手存下首段。
   * 严格串行 + 600ms 间隔：不跟正在播的这集抢带宽，也不至于把 5 集同时压进解密队列。
   * 换集/退出时 abort 掉，避免旧剧的预热继续占着连接。
   */
  const warmUpcoming = (fromIndex: number) => {
    // 不再取消上一次的排程：换集时把旧循环 abort 掉，会导致「下一集预热发了一半就断了」，
    // 从第二次切集起队列永远是空的，于是每集都要等。内核那边已经按 vid 去重，重复发不会重复下载。
    if (!key) return;
    const ctrl = new AbortController();
    warmAbortRef.current = ctrl;
    const eps = detail?.episodes || [];
    const at = eps.findIndex((e) => e.index === fromIndex);
    if (at < 0) return;
    void (async () => {
      // 只热 3 集，且把带宽压在「下一集」上：内核是逐集整包下载+解密，
      // 同时发 5 集等于切成 5 份，下一集迟迟好不了，切集就还得等。
      // 第 1 集立刻发，第 2 集等 12s（当前集已起播），第 3 集再等 25s。
      // 现在当前这集是「内核本地文件 → ffmpeg 切片」，播放不占网络；
      // 所以下一集的下载/解密可以立刻开跑，不会跟正在播的这集抢带宽。
      // 3 集依次错开 2 秒发出，避免内核一次性开三个下载把上游打慢。
      // 留 6 集缓冲：看到第 5-6 集时，6-10 集应该已经备好
      const delays = [0, 1200, 2400, 3600, 4800, 6000];
      for (let k = 1; k <= 6; k++) {
        const nx = eps[at + k];
        if (!nx || ctrl.signal.aborted) break;
        await new Promise((r) => window.setTimeout(r, delays[k - 1] ?? 25000));
        if (ctrl.signal.aborted) break;
        // 下一集插队：用户最可能点的就是它
        void hg(`/prewarm?vid=${encodeURIComponent(nx.vid)}${k === 1 ? '&priority=1' : ''}`).catch(() => {});
        if (ctrl.signal.aborted) break;
        // 只发内核侧预热：实测浏览器侧再抢一遍 Range 会跟当前这集的取流抢带宽，
        // 反而把「正在播」的那集拖到超时（表现为「这一集没能加载出来」）。

      }
    })();
  };

  // 离开播放器/换集时收掉预热请求
  useEffect(() => () => warmAbortRef.current?.abort(), [playing?.vid]);

  /** 切集：没显式指定起点时，自动接上这一集上次看到的位置（回退 3 秒） */
  const playEpisode = (index: number, startAt?: number) => {
    if (!detail) return;
    const ep = detail.episodes.find((e) => e.index === index);
    if (!ep) return;
    let start = startAt;
    if (start === undefined) {
      const prev = loadProgress().find((x) => x.seriesId === detail.meta.series_id);
      const saved = prev?.eps?.[String(index)];
      if (saved && saved > 5) start = Math.max(0, saved - 3);
    }
    play(ep, detail.meta.title, start);
  };

  /**
   * 刷剧流里点了「看第 1 集 / 继续第 N 集」：
   * 集数拉回来之后自动起播（有进度就接着上次那集）。
   */
  useEffect(() => {
    const want = autoPlayRef.current;
    if (!want || !detail || detail.episodes.length === 0) return;
    if (String(detail.meta.series_id) !== String(want)) return;
    autoPlayRef.current = null;
    const prev = loadProgress().find((x) => x.seriesId === detail.meta.series_id);
    if (prev && prev.lastEp > 0) playEpisode(prev.lastEp, Math.max(0, prev.lastPos - 5));
    else playEpisode(detail.episodes[0].index);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail]);

  /** 播完：默认 5 秒倒计时自动下一集，可取消 */
  const clearCountdown = () => {
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    setNextCountdown(null);
  };

  /** 播完直接接下一集：短剧连着看，不要倒计时打断 */
  const playNextNow = () => {
    const nextIndex = (playing?.index ?? 0) + 1;
    const next = episodes.find((e) => e.index === nextIndex);
    if (!next) return;
    setResumeHint(`▶ 第  集`);
    setTimeout(() => setResumeHint(''), 1500);
    playEpisode(nextIndex, 0);
  };

  const startCountdown = () => {
    const nextIndex = (playing?.index ?? 0) + 1;
    const next = episodes.find((e) => e.index === nextIndex);
    if (!next) return;
    clearCountdown();
    setNextCountdown(5);
    countdownTimerRef.current = setInterval(() => {
      setNextCountdown((n) => {
        if (n === null) return null;
        if (n <= 1) {
          clearCountdown();
          playEpisode(nextIndex);
          return null;
        }
        return n - 1;
      });
    }, 1000);
  };

  /** 收藏 / 取消收藏（当前正在看的这一部） */
  const toggleFavCurrent = () => {
    if (!detail) return;
    const list = loadProgress();
    const id = detail.meta.series_id;
    const idx = list.findIndex((x) => x.seriesId === id);
    if (idx >= 0) {
      list[idx] = { ...list[idx], fav: !list[idx].fav, updatedAt: Date.now() };
    } else {
      list.unshift({
        seriesId: id,
        title: detail.meta.title,
        cover: detail.meta.cover,
        eps: {},
        durs: {},
        lastEp: playing?.index ?? 1,
        lastPos: 0,
        updatedAt: Date.now(),
        fav: true,
      });
    }
    saveProgress(list);
    setHistory([...list]);
  };

  /** 从「继续观看」恢复：优先用该剧最后观看位置 */
  const resumeFrom = async (h: ShowProgress) => {
    setErr('');
    try {
      const data = await hg<{ meta: Meta; episodes: Episode[] }>(`/episodes?series_id=${h.seriesId}`);
      const eps = data.episodes || [];
      if (!eps.length) throw new Error('剧集为空');
      const ep = eps.find((e) => e.index === h.lastEp) || eps[0];
      setDetail({ meta: data.meta, episodes: eps });
      play(ep, data.meta.title, Math.max(0, h.lastPos - 5));
      return;
    } catch {
      /* 原来源失效，往下走同名兜底 */
    }
    // 兜底：按剧名找同名其他条目，能看就用（并提示已换源）
    try {
      const r = await hg<{ results: Item[] }>(`/search?q=${encodeURIComponent(h.title)}&page=1`);
      const cands = (r.results || []).filter((x) => x.series_id !== h.seriesId && sameShow(x.title, h.title)).slice(0, 3);
      for (const c of cands) {
        try {
          const d = await hg<{ meta: Meta; episodes: Episode[] }>(`/episodes?series_id=${c.series_id}`);
          const eps = d.episodes || [];
          if (!eps.length) continue;
          const ep = eps.find((e) => e.index === h.lastEp) || eps[0];
          setDetail({ meta: d.meta, episodes: eps });
          play(ep, d.meta.title, Math.max(0, h.lastPos - 15));
          setResumeHint(`原来源失效，已自动切换到「${d.meta.title}」，从 ${fmtTime(Math.max(0, h.lastPos - 15))} 继续`);
          setTimeout(() => setResumeHint(''), 8000);
          return;
        } catch {
          continue;
        }
      }
    } catch {
      /* 搜索也失败 */
    }
    setErr('这部剧暂时看不了（来源可能已下架），可以在「继续观看」里删掉这条记录');
    const list = loadProgress().filter((x) => x.seriesId !== h.seriesId);
    saveProgress(list);
    setHistory(list);
  };

  /** 换源：按剧名找同一部剧的其他来源，切换后回到同一集、只往前挪 */
  const openSourceSheet = async () => {
    if (!detail) return;
    setSourceSheet({ items: [], loading: true, error: '' });
    try {
      const r = await hg<{ results: Item[] }>(`/search?q=${encodeURIComponent(detail.meta.title)}&page=1`);
      const items = (r.results || []).filter(
        (x) => x.series_id !== detail.meta.series_id && sameShow(x.title, detail.meta.title)
      );
      setSourceSheet({ items: items.slice(0, 24), loading: false, error: '' });
    } catch (e) {
      setSourceSheet({ items: [], loading: false, error: e instanceof Error ? e.message : '搜索失败' });
    }
  };

  const switchSource = async (item: Item) => {
    const v = videoRef.current;
    const prevPos = v && Number.isFinite(v.currentTime) ? v.currentTime : 0;
    const prevEp = playing?.index ?? 1;
    try {
      const data = await hg<{ meta: Meta; episodes: Episode[] }>(`/episodes?series_id=${item.series_id}`);
      const eps = data.episodes || [];
      if (!eps.length) throw new Error('该源没有剧集');
      const exact = eps.find((e) => e.index === prevEp);
      const nearest = eps.reduce((a, b) => (Math.abs(b.index - prevEp) < Math.abs(a.index - prevEp) ? b : a), eps[0]);
      const target = exact || nearest;
      setDetail({ meta: data.meta, episodes: eps });
      setSourceSheet(null);
      // 只往前挪 10 秒：不同源码率不同，往后挪必然对不上剧情
      play(target, data.meta.title, Math.max(0, prevPos - 10));
      setResumeHint(`已切换来源，从 ${fmtTime(Math.max(0, prevPos - 10))} 继续`);
      setTimeout(() => setResumeHint(''), 6000);
    } catch (e) {
      setSourceSheet({ items: [], loading: false, error: e instanceof Error ? e.message : '切换失败' });
    }
  };

  /** 删除单条观看记录（连同服务端一起删） */
  const removeOne = (seriesId: string) => {
    const list = loadProgress().filter((x) => x.seriesId !== seriesId);
    saveProgress(list);
    setHistory(list);
  };

  const clearHistory = () => {
    saveProgress([]);
    setHistory([]);
  };

  const streamUrl =
    playing && key
      ? `${API}/stream?vid=${encodeURIComponent(playing.vid)}&quality=${quality}&api_key=${encodeURIComponent(key)}${streamNonce > 0 ? `&r=${streamNonce}` : ""}`
      : '';

  /**
   * 短剧播放：走内核的 /hg-api/hls（2 秒 fMP4 分片，分片就绪即播）。
   * 原来直接把整集 MP4 塞给 <video>，必须等整集下载+解密，才出现「每集都像首播」；
   * 换成 HLS 后切集只是换一份播放列表，第一个分片命中缓存就是秒切。
   * 浏览器不支持 MSE 时退回原来的整集直链，保证还能播。
   */
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !playing || !key) return;
    const hlsUrl = `${API}/hls?vid=${encodeURIComponent(playing.vid)}&quality=${quality}&api_key=${encodeURIComponent(key)}`;
    let hls: { destroy: () => void } | null = null;
    let cancelled = false;
    void (async () => {
      const mod = await import('hls.js').catch(() => null);
      const Hls = (mod as { default?: { isSupported: () => boolean; new (cfg?: unknown): any } } | null)?.default;
      if (cancelled) return;
      if (Hls && Hls.isSupported()) {
        const inst = new Hls({ maxBufferLength: 30, backBufferLength: 15 });
        hls = inst;
        inst.loadSource(hlsUrl);
        inst.attachMedia(v);
        inst.on((Hls as unknown as { Events: { ERROR: string } }).Events.ERROR, (_e: unknown, data: { fatal?: boolean }) => {
          if (!data?.fatal) return;
          // 分片通道出问题（ffmpeg 没找到 / 切片失败）时，自动退回原来的整集直链：
          // 宁可慢一点，也不能让用户面对一个放不出来的播放器。
          try {
            inst.destroy();
          } catch {
            /* 忽略 */
          }
          hls = null;
          v.src = `${API}/stream?vid=${encodeURIComponent(playing.vid)}&quality=${quality}&api_key=${encodeURIComponent(key)}`;
          v.load();
          void v.play().catch(() => {});
        });
      } else {
        // 兜底：老浏览器无 MSE 时仍用整集直链
        v.src = `${API}/stream?vid=${encodeURIComponent(playing.vid)}&quality=${quality}&api_key=${encodeURIComponent(key)}`;
      }
    })();
    return () => {
      cancelled = true;
      hls?.destroy();
    };
  }, [playing?.vid, quality, key]);
  // 播放时禁止页面滚动：竖屏短剧很高，否则会撑出滚动条、只看到视频上半截
  useEffect(() => {
    if (!playing) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [playing]);
  // 播放器快捷键：空格暂停、←/→ 快退快进 5 秒、F 全屏、Esc 退出全屏
  useEffect(() => {
    if (!playing) return;
    const onKey = (e: KeyboardEvent) => {
      const v = videoRef.current;
      if (!v) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === ' ') {
        e.preventDefault();
        if (v.paused) void v.play();
        else v.pause();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        v.currentTime = Math.max(0, v.currentTime - 5);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        v.currentTime = Math.min(v.duration || 0, v.currentTime + 5);
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        // App 里走原生桥（真全屏，遥控也能触发），浏览器里才用 HTML5 全屏
        const want = !document.fullscreenElement;
        if (!toggleNativeFullscreen(want)) {
          if (document.fullscreenElement) void document.exitFullscreen();
          else void document.documentElement.requestFullscreen?.();
        }
      } else if (e.key === 'Escape') {
        if (document.fullscreenElement) void document.exitFullscreen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playing]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !streamUrl) return;
    setPlayerLoading(true);
    v.load();
    v.play().catch(() => {});
  }, [streamUrl]);

  // 首次挂载读一次本地历史
  useEffect(() => {
    // 记住上次浏览的体裁与榜单，下次进来直接落在原位置
    try {
      const lg = localStorage.getItem('hg_last_genre');
      const lb = localStorage.getItem('hg_last_board');
      if (lg === 'short_play' || lg === 'comic_series' || lg === 'ai_series') setGenre(lg);
      if (lb === 'recommend' || lb === 'hot' || lb === 'new') setBoard(lb);
    } catch {
      /* 忽略 */
    }
    setHistory(loadProgress());
    const p = loadPrefs();
    setRate(p.rate);
    setVolume(p.volume);
    // 记录只读本机这一份（不连服务端）：这台设备看过的就是这台设备的，
    // 别的设备开网页版也看不到这边的记录，反过来也一样。
    // 首页「继续观看」点过来会带 ?resume=<seriesId>，就地接着上次的位置播。
    try {
      const q = new URLSearchParams(window.location.search);
      const rid = q.get('resume');
      if (rid) {
        q.delete('resume');
        const qs = q.toString();
        window.history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
        const rec = loadProgress().find((x) => x.seriesId === rid);
        if (rec) void resumeFrom(rec);
      }
    } catch {
      /* 参数坏了就当普通进入 */
    }
  }, []);

  const activeGenre = useMemo(() => GENRES.find((g) => g.key === genre)!, [genre]);

  /** 当前剧的进度记录（收藏态 / 已看集数） */
  const currentProgress = useMemo(
    () => (detail ? history.find((h) => h.seriesId === detail.meta.series_id) : undefined),
    [detail, history]
  );
  const isFav = !!currentProgress?.fav;
  const watchedCount = currentProgress ? Object.keys(currentProgress.eps || {}).length : 0;
  const favList = useMemo(() => history.filter((h) => h.fav), [history]);
  const episodes = detail?.episodes || [];

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        {/* 标题 + 搜索 */}
        <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-content">
              短剧<span className="brand-gradient">专区</span>
            </h1>
            <p className="mt-1 text-xs text-faint">
              {activeGenre.label} · {activeGenre.hint} · 数据与格式转换均在本机完成
            </p>
          </div>
          <form
            className="flex min-h-10 items-stretch rounded-2xl border border-line bg-chip shadow-sm focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/30"
            onSubmit={(e) => {
              e.preventDefault();
              void doSearch();
            }}
          >
            <input
              className="w-44 bg-transparent px-4 text-sm text-content placeholder:text-faint focus:outline-none sm:w-64"
              placeholder="搜索短剧，例如：皇后"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              maxLength={40}
            />
            <button
              type="submit"
              className="my-1 mr-1 rounded-xl bg-accent px-4 text-sm font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-50"
              disabled={searching}
            >
              {searching ? '搜索中' : '搜索'}
            </button>
          </form>
        </div>

        {/* 继续观看：直接接着上次的时间点看 */}
        {history.length > 0 && !searched && (
          <section className="mb-6">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                {[
                  { k: 'recent' as const, label: '继续观看' },
                  { k: 'fav' as const, label: '我的收藏' },
                ].map((tab) => (
                  <button
                    key={tab.k}
                    className={
                      'rounded-full px-3 py-1 text-xs transition-colors ' +
                      (histTab === tab.k ? 'bg-accent font-medium text-on-accent' : 'text-muted hover:bg-chip hover:text-content')
                    }
                    onClick={() => setHistTab(tab.k)}
                  >
                    {tab.label}
                    {tab.k === 'fav' && favList.length > 0 ? ' ' + favList.length : ''}
                  </button>
                ))}
              </div>
              <button className="text-xs text-faint transition-colors hover:text-content" onClick={clearHistory}>
                清空本机记录
              </button>
            </div>
            <p className="mb-2 text-[11px] text-faint">
              记录只存在这台设备（这个浏览器）里：别的设备打开同一个地址是各自的一份，互不影响。
            </p>
            {(histTab === 'fav' ? favList : history).length === 0 ? (
              <p className="rounded-xl border border-line/60 bg-chip/60 px-4 py-6 text-center text-xs text-faint">
                {histTab === 'fav' ? '还没有收藏：播放时点右上角「☆ 收藏」就会出现在这里' : '还没有观看记录，随便点一部开始看吧'}
              </p>
            ) : (
            <div className="scrollbar-thin flex gap-3 overflow-x-auto pb-2">
              {(histTab === 'fav' ? favList : history).slice(0, 12).map((h) => {
                const total = h.durs?.[String(h.lastEp)] || 0;
                const pct = total > 0 ? Math.min(100, Math.round((h.lastPos / total) * 100)) : 0;
                return (
                  <button
                    key={h.seriesId}
                    className="group/c w-[104px] shrink-0 text-left"
                    onClick={() => void resumeFrom(h)}
                    title={`${h.title} · 第 ${h.lastEp} 集 · ${fmtTime(h.lastPos)}`}
                  >
                    <div className="relative aspect-[3/4] overflow-hidden rounded-xl bg-chip ring-1 ring-line/60 transition-all group-hover/c:-translate-y-0.5 group-hover/c:ring-accent/50">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`${API}/img?url=${encodeURIComponent(h.cover || '')}`}
                        alt={h.title}
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                      <span className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
                        <span className="block h-full bg-accent" style={{ width: `${pct}%` }} />
                      </span>
                      <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1 text-[10px] tabular-nums text-white">
                        {fmtTime(h.lastPos)}
                      </span>
                      <span
                        role="button"
                        tabIndex={-1}
                        className="absolute right-1 top-1 hidden h-5 w-5 cursor-pointer place-items-center rounded-full bg-black/70 text-[12px] leading-none text-white/85 hover:bg-red-500/90 group-hover/c:grid"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeOne(h.seriesId);
                        }}
                        title="删除这条记录"
                      >
                        ×
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-1 text-[11px] text-content">{h.title}</p>
                    <p className="text-[10px] text-faint">看到第 {h.lastEp} 集{h.fav ? " · 收藏" : ""}</p>
                  </button>
                );
              })}
            </div>
            )}
          </section>
        )}

        {/* 第一层：体裁 */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {GENRES.map((g) => (
            <button
              key={g.key}
              onClick={() => {
                setSearched('');
                setBoard('recommend');
                setGenre(g.key);
                try {
                  localStorage.setItem('hg_last_genre', g.key);
                  localStorage.setItem('hg_last_board', 'recommend');
                } catch {
                  /* 忽略 */
                }
              }}
              className={cn(
                'rounded-full px-4 py-2 text-sm transition-all',
                genre === g.key && !searched
                  ? 'bg-accent font-semibold text-on-accent shadow-lg shadow-accent/20'
                  : 'bg-chip text-muted hover:bg-hover hover:text-content'
              )}
            >
              {g.label}
            </button>
          ))}
          {searched && (
            <span className="ml-2 rounded-full bg-chip px-3 py-1.5 text-xs text-muted">
              “{searched}” 的搜索结果
              <button
                className="ml-2 text-accent hover:underline"
                onClick={() => {
                  setSearched('');
                  setQuery('');
                  void load(genre, board);
                }}
              >
                清除
              </button>
            </span>
          )}
        </div>

        {/* 第二层：榜单（搜索时隐藏） */}
        {!searched && (
          <div className="mb-4 flex items-center gap-1.5 border-l-2 border-accent/40 pl-3">
            {BOARDS.map((b) => (
              <button
                key={b.key}
                onClick={() => {
                  setBoard(b.key);
                  try {
                    localStorage.setItem('hg_last_board', b.key);
                  } catch {
                    /* 忽略 */
                  }
                }}
                className={cn(
                  'rounded-lg px-3 py-1 text-xs transition-colors',
                  board === b.key ? 'bg-accent/15 font-medium text-accent' : 'text-muted hover:bg-chip hover:text-content'
                )}
              >
                {activeGenre.label}
                {b.label}
              </button>
            ))}
            {/* 刷剧：一整屏一部，上下翻（kanju 短剧流那一套手感） */}
            {items.length > 0 && (
              <button
                type="button"
                onClick={() => setFeedOpen(true)}
                className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-line bg-chip/60 px-3 py-1 text-xs text-muted transition-colors hover:border-accent/50 hover:text-content"
                title="一屏一部，上下滑动换剧"
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path d="M7 4v16M12 4v16M17 4v16" strokeLinecap="round" />
                </svg>
                刷剧
              </button>
            )}
          </div>
        )}

        {err && (
          <div className="rounded-2xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
            短剧服务没响应：{err}
            <p className="mt-1 text-xs text-faint">确认 hongguo-web 服务在 127.0.0.1:8000 运行。</p>
          </div>
        )}

        {/* 列表 */}
        {loading && items.length === 0 ? (
          <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-7">
            {Array.from({ length: 14 }).map((_, i) => (
              <div key={i}>
                <div className="aspect-[3/4] animate-pulse rounded-2xl bg-chip" />
                <div className="mt-2 h-3 w-3/4 animate-pulse rounded bg-chip" />
              </div>
            ))}
          </div>
        ) : (
          <div key={`${genre}-${board}-${searched}`} className="poster-grid grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-7">
            {items.map((it) => (
              <button key={it.series_id} className="group/poster text-left" onClick={() => void openDetail(it)}>
                <div className="relative aspect-[3/4] overflow-hidden rounded-2xl bg-chip ring-1 ring-line/70 transition-all duration-300 group-hover/poster:-translate-y-1 group-hover/poster:ring-accent/50 group-hover/poster:shadow-[0_22px_45px_-18px_rgba(0,0,0,.85)]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`${API}/img?url=${encodeURIComponent(it.cover || '')}`}
                    alt={it.title}
                    loading="lazy"
                    className="h-full w-full object-cover transition-transform duration-500 group-hover/poster:scale-[1.07]"
                  />
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/90 via-black/40 to-transparent" />
                  {it.rank && it.rank <= 3 && genre === 'comic_series' && !searched && (
                    <span className="absolute left-2 top-2 grid h-6 w-6 place-items-center rounded-full bg-black/60 text-[11px] font-bold text-white ring-1 ring-white/20">
                      {it.rank}
                    </span>
                  )}
                  {it.score && <span className="badge-glass absolute right-2 top-2 text-rating">★ {it.score}</span>}
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 p-2">
                    <p className="line-clamp-2 text-[12px] font-medium leading-snug text-white drop-shadow-[0_1px_3px_rgba(0,0,0,.9)]">
                      {it.title}
                    </p>
                    <p className="mt-0.5 truncate text-[10px] text-white/65">
                      {it.episode_cnt ? `全${it.episode_cnt}集` : ''}
                      {it.hot ? ` · ${it.hot}` : ''}
                    </p>
                  </div>
                  <span className="pointer-events-none absolute inset-0 grid place-items-center opacity-0 transition-opacity duration-300 group-hover/poster:opacity-100">
                    <span className="grid h-11 w-11 place-items-center rounded-full bg-white/20 text-white ring-1 ring-white/35 backdrop-blur-md">
                      <svg className="h-4 w-4 translate-x-[1px]" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.4-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14z" />
                      </svg>
                    </span>
                  </span>
                </div>
                <p className="mt-1.5 line-clamp-1 text-[11px] text-faint">{it.copyright || 'MFlixTV短剧'}</p>
              </button>
            ))}
          </div>
        )}

        {loading && items.length > 0 && <p className="mt-4 text-center text-xs text-faint">继续加载中…</p>}
        {!loading && !err && items.length === 0 && (
          <p className="py-16 text-center text-sm text-faint">这个分类暂时没有内容，换个体裁或关键词试试</p>
        )}
      </main>

      {/* 详情弹层 */}
      {detail && (
        <div
          className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/75 px-4 py-10 backdrop-blur-sm"
          onClick={() => setDetail(null)}
        >
          <div
            className="w-full max-w-3xl overflow-hidden rounded-3xl border border-line/70 bg-surface-raised shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col items-center gap-3 p-4 sm:flex-row sm:items-start sm:gap-4 sm:p-5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`${API}/img?url=${encodeURIComponent(detail.meta.cover || '')}`}
                alt={detail.meta.title}
                className="h-40 flex-none rounded-2xl bg-chip object-cover ring-1 ring-line/60"
                style={{ width: 120 }}
              />
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-semibold text-content">{detail.meta.title}</h2>
                <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-faint">
                  <span>{detail.meta.episode_cnt ? `共 ${detail.meta.episode_cnt} 集` : ''}</span>
                  {detail.meta.status && <span>{detail.meta.status}</span>}
                  {detail.meta.category && <span>{detail.meta.category}</span>}
                  {detail.meta.play_cnt ? <span>{fmtCount(detail.meta.play_cnt)} 播放</span> : null}
                  {watchedCount > 0 ? <span className="text-accent">已看 {watchedCount} 集</span> : null}
                </p>
                <p className="mt-2 line-clamp-4 text-xs leading-relaxed text-muted">{detail.meta.abstract || '暂无简介'}</p>
                {episodes.length > 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {currentProgress && currentProgress.lastEp > 0 ? (
                      <>
                        <button
                          className="rounded-xl bg-accent px-4 py-1.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-hover"
                          onClick={() => playEpisode(currentProgress.lastEp, Math.max(0, currentProgress.lastPos - 5))}
                        >
                          继续第 {currentProgress.lastEp} 集 · {fmtTime(currentProgress.lastPos)}
                        </button>
                        <button
                          className="rounded-xl bg-chip px-3 py-1.5 text-sm text-muted transition-colors hover:bg-hover hover:text-content"
                          onClick={() => playEpisode(episodes[0].index)}
                        >
                          从第 1 集开始
                        </button>
                      </>
                    ) : (
                      <button
                        className="rounded-xl bg-accent px-4 py-1.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-hover"
                        onClick={() => playEpisode(episodes[0].index)}
                      >
                        播放第 1 集
                      </button>
                    )}
                  </div>
                )}
              </div>
              <button
                className="shrink-0 rounded-full p-1.5 text-muted transition-colors hover:bg-hover hover:text-content"
                onClick={() => setDetail(null)}
                aria-label="关闭"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>

            <div className="border-t border-line/60 px-5 py-4">
              {detailLoading ? (
                <p className="py-6 text-center text-xs text-faint">正在拉取剧集…</p>
              ) : detailErr ? (
                <p className="py-6 text-center text-xs text-danger">{detailErr}</p>
              ) : (
                <div className="scrollbar-thin grid max-h-[42vh] grid-cols-[repeat(auto-fill,minmax(48px,1fr))] gap-1.5 overflow-y-auto">
                  {episodes.map((ep) => {
                    const watched = !!currentProgress?.eps?.[String(ep.index)];
                    const isCur = !!playing && playing.index === ep.index;
                    const base = 'relative rounded-lg py-2 text-xs tabular-nums transition-colors ';
                    const cls = isCur
                      ? 'bg-accent font-semibold text-on-accent'
                      : watched
                        ? 'bg-accent/15 text-accent hover:bg-accent/25'
                        : 'bg-chip text-muted hover:bg-accent hover:text-on-accent';
                    return (
                      <button
                        key={ep.vid}
                        className={base + cls}
                        onClick={() => playEpisode(ep.index)}
                        title={watched ? '已看到 ' + fmtTime(currentProgress?.eps?.[String(ep.index)] || 0) : '第 ' + ep.index + ' 集'}
                      >
                        {ep.index}
                        {watched && !isCur && (
                          <span className="absolute right-0.5 top-0.5 text-[9px] leading-none">✓</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 播放器 */}
      {playing && (
        <div className="fixed inset-0 z-[70] flex flex-col bg-black" style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
          <div className="flex items-center gap-2 px-3 py-2 sm:px-4 sm:py-3">
            <button
              className="rounded-full p-1.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
              onClick={() => {
                flushProgress();
                setPlaying(null);
              }}
              aria-label="关闭播放器"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
            <p className="min-w-0 flex-1 truncate text-sm text-white/90">
              {playing.title} · 第 {playing.index} 集
              {episodes.length > 0 && (
                <span className="text-white/50">
                  {' / 共 '}
                  {episodes.length} 集
                  {watchedCount > 0 ? ' · 已看 ' + watchedCount : ''}
                </span>
              )}
            </p>
            {episodes.length > 0 && (
              <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto">
                <button
                  className="rounded-lg whitespace-nowrap bg-white/10 px-2 py-1 text-xs tabular-nums text-white/80 transition-colors hover:bg-white/20 sm:px-2.5"
                  title="播放速度（会记住上次选择）"
                  onClick={() => {
                    const at = RATES.indexOf(rate);
                    const nr = RATES[(at + 1) % RATES.length] ?? 1;
                    setRate(nr);
                    const v = videoRef.current;
                    if (v) {
                      try {
                        v.playbackRate = nr;
                      } catch {
                        /* 忽略 */
                      }
                    }
                    savePrefs({ rate: nr, volume });
                  }}
                >
                  {rate === 1 ? '倍速' : rate + 'x'}
                </button>
                <button
                  className={
                    'rounded-lg whitespace-nowrap px-2 py-1 text-xs transition-colors sm:px-2.5 ' +
                    (isFav ? 'bg-yellow-400/20 text-yellow-300' : 'bg-white/10 text-white/80 hover:bg-white/20')
                  }
                  onClick={toggleFavCurrent}
                  title={isFav ? '取消收藏' : '收藏'}
                >
                  {isFav ? '★ 已收藏' : '☆ 收藏'}
                </button>
                {/* 「最近更新」快捷入口：追更的人 90% 只想直接看最新一集，
                    不该让他去 80 集的网格里找最后一个 */}
                {episodes.length > 0 && episodes[episodes.length - 1].index !== playing.index && (
                  <button
                    className="rounded-lg whitespace-nowrap bg-accent/15 px-2 py-1 text-xs text-accent transition-colors hover:bg-accent/25 sm:px-2.5"
                    onClick={() => playEpisode(episodes[episodes.length - 1].index)}
                    title={`跳到最新一集：第 ${episodes[episodes.length - 1].index} 集`}
                  >
                    最新 {episodes[episodes.length - 1].index}
                  </button>
                )}
                <button
                  className="rounded-lg whitespace-nowrap bg-white/10 px-2 py-1 text-xs text-white/80 transition-colors hover:bg-white/20 disabled:opacity-30 sm:px-3"
                  disabled={playing.index <= 1}
                  onClick={() => playEpisode(playing.index - 1)}
                >
                  上一集
                </button>
                <button
                  className="rounded-lg whitespace-nowrap bg-white/10 px-2 py-1 text-xs text-white/80 transition-colors hover:bg-white/20 disabled:opacity-30 sm:px-3"
                  disabled={!episodes.some((e) => e.index === playing.index + 1)}
                  onClick={() => playEpisode(playing.index + 1)}
                >
                  下一集
                </button>
                <button
                  className="rounded-lg whitespace-nowrap bg-white/10 px-2 py-1 text-xs text-white/80 transition-colors hover:bg-white/20 sm:px-3"
                  onClick={() => void openSourceSheet()}
                >
                  换源
                </button>
                <button
                  className="rounded-lg whitespace-nowrap bg-accent/90 px-2 py-1 text-xs font-medium text-on-accent transition-colors hover:bg-accent sm:px-3"
                  onClick={() => setEpisodeSheet((v) => !v)}
                >
                  选集
                </button>
              </div>
            )}
          </div>

          {nextCountdown !== null && (
            <div className="absolute inset-x-0 bottom-24 z-20 flex justify-center">
              <div className="flex items-center gap-3 rounded-2xl bg-black/75 px-4 py-2.5 text-sm text-white backdrop-blur">
                <span>
                  {nextCountdown} 秒后播放第 {(playing?.index ?? 0) + 1} 集
                </span>
                <button
                  className="rounded-lg bg-accent px-3 py-1 text-xs font-medium text-on-accent"
                  onClick={() => playEpisode((playing?.index ?? 0) + 1)}
                >
                  立即播放
                </button>
                <button className="rounded-lg bg-white/15 px-3 py-1 text-xs text-white/85" onClick={clearCountdown}>
                  取消
                </button>
              </div>
            </div>
          )}

          {resumeHint && (
            <div className="pointer-events-none absolute left-1/2 top-16 z-20 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1.5 text-xs text-white backdrop-blur">
              {resumeHint}
            </div>
          )}
          <div className="relative flex-1 min-h-0">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              ref={videoRef}
              className="absolute inset-0 h-full w-full bg-black object-contain"
              controls
              autoPlay
              playsInline
              onCanPlay={() => {
                setPlayerLoading(false);
                const v = videoRef.current;
                if (v && v.videoWidth === 0) {
                  setPlayerErr('画面为 HEVC 编码且当前浏览器缺少解码支持，换用最新 Edge/Chrome 或安装 HEVC 视频扩展。');
                }
              }}
              onPlaying={() => setPlayerLoading(false)}
              onLoadedMetadata={() => {
                const v = videoRef.current;
                if (v) {
                  try {
                    v.playbackRate = rate;
                    v.volume = volume;
                  } catch {
                    /* 忽略 */
                  }
                }
                const target = pendingSeekRef.current;
                pendingSeekRef.current = null;
                if (!v || !target || target <= 0) return;
                const dur = v.duration;
                if (Number.isFinite(dur) && target > dur - 5) return;
                try {
                  v.currentTime = target;
                  setResumeHint(`已从 ${fmtTime(target)} 继续播放`);
                  setTimeout(() => setResumeHint(''), 5000);
                } catch {
                  /* 个别源不支持跳转，忽略 */
                }
              }}
              onTimeUpdate={() => {
                const v = videoRef.current;
                if (!v) return;
                const now = Date.now();
                if (now - lastSaveRef.current < 4000) return;
                lastSaveRef.current = now;
                persistProgress(v.currentTime, v.duration);
              }}
              onPause={() => {
                const v = videoRef.current;
                if (v) persistProgress(v.currentTime, v.duration);
              }}
              onError={() => {
                // 首次失败多半是服务端还在排队转码 / 连接被提前掐断，先自动重连一次
                if (!retriedRef.current) {
                  retriedRef.current = true;
                  setPlayerLoading(true);
                  setPlayerErr('');
                  window.setTimeout(() => setStreamNonce((n) => n + 1), 1500);
                  return;
                }
                setPlayerLoading(false);
                setPlayerErr('这一集没能加载出来：源可能失效，或该清晰度不可用');
              }}
              onEnded={() => {
                flushProgress();
                playNextNow();
              }}
              onRateChange={() => {
                const v = videoRef.current;
                if (!v) return;
                setRate(v.playbackRate);
                savePrefs({ rate: v.playbackRate, volume });
              }}
              onVolumeChange={() => {
                const v = videoRef.current;
                if (!v) return;
                setVolume(v.volume);
                savePrefs({ rate, volume: v.volume });
              }}
              onDoubleClick={() => {
                const v = videoRef.current;
                if (!v) return;
                if (v.paused) void v.play();
                else v.pause();
              }}
              onTouchStart={(e) => {
                const v0 = videoRef.current;
                const tt = e.touches[0];
                if (!tt) return;
                gestureRef.current = {
                  x: tt.clientX,
                  y: tt.clientY,
                  t: Date.now(),
                  rate: v0?.playbackRate ?? 1,
                  timer: setTimeout(() => {
                    const el = videoRef.current;
                    if (!el) return;
                    try {
                      el.playbackRate = 3;
                    } catch {
                      /* 忽略 */
                    }
                    setResumeHint('3 倍速播放中（松手恢复）');
                  }, 600),
                };
              }}
              onTouchEnd={(e) => {
                const g = gestureRef.current;
                const v = videoRef.current;
                if (!g || !v) return;
                if (g.timer) clearTimeout(g.timer);
                const tt = e.changedTouches[0];
                const dx = tt ? tt.clientX - g.x : 0;
                const dy = tt ? tt.clientY - g.y : 0;
                const dt = Date.now() - g.t;
                gestureRef.current = null;
                if (dt >= 600) {
                  try {
                    v.playbackRate = g.rate || rate;
                  } catch {
                    /* 忽略 */
                  }
                  setResumeHint('');
                  return;
                }
                if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                  const step = dx > 0 ? 10 : -10;
                  v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + step));
                  setResumeHint(step > 0 ? '前进 10 秒' : '后退 10 秒');
                  setTimeout(() => setResumeHint(''), 1200);
                }
              }}
            />
            {playerLoading && !playerErr && (
              <div className="pointer-events-none absolute inset-0 grid place-items-center">
                <div className="rounded-2xl bg-black/60 px-4 py-3 text-center text-xs text-white/80 backdrop-blur">
                  正在准备第 {playing.index} 集…（已等 {loadingSec} 秒）
                  <br />
                  <span className="text-white/50">
                    {loadingSec < 8
                      ? '正在取流并转换格式，首播通常 10–20 秒'
                      : loadingSec < 25
                        ? '这一集源比较慢，再等等；后面几集已提前在准备'
                        : '源偏慢，还在重试；可以点选集换一集'}
                  </span>
                </div>
              </div>
            )}
            {playerErr && (
              <div className="absolute inset-0 grid place-items-center">
                <div className="rounded-2xl bg-black/75 px-4 py-3 text-center backdrop-blur">
                  <p className="text-sm text-danger">{playerErr}</p>
                  <p className="mt-1 text-[11px] text-white/50">换个清晰度重试（1080p 兼容性最好）</p>
                  <div className="mt-2 flex justify-center gap-2">
                    <button
                      className="rounded-lg bg-white/15 px-3 py-1 text-xs text-white/85 hover:bg-white/25"
                      onClick={() => {
                        setPlayerErr('');
                        setPlayerLoading(true);
                        retriedRef.current = false;
                        setStreamNonce((n) => n + 1);
                      }}
                    >
                      重试
                    </button>
                    {(['1080p', '720p', '540p'] as const).map((q) => (
                      <button
                        key={q}
                        className={
                          'rounded-lg px-3 py-1 text-xs transition-colors ' +
                          (quality === q ? 'bg-accent font-medium text-on-accent' : 'bg-white/10 text-white/80 hover:bg-white/20')
                        }
                        onClick={() => {
                          setQuality(q);
                          setPlayerErr('');
                          setPlayerLoading(true);
                          retriedRef.current = false;
                          setStreamNonce((n) => n + 1);
                        }}
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* 换源面板：同名剧的其他来源，切换后回到同一集、只往前挪 */}
            {sourceSheet && (
              <div
                className="absolute inset-0 z-10 flex items-end justify-center bg-black/80 backdrop-blur-sm sm:items-center sm:p-6"
                onClick={() => setSourceSheet(null)}
              >
                <div
                  className="w-full overflow-hidden rounded-t-3xl border border-white/10 bg-[#0d141f] shadow-2xl sm:max-w-md sm:rounded-3xl"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                    <div>
                      <p className="text-sm font-medium text-white">换源</p>
                      <p className="mt-0.5 text-[11px] text-white/50">
                        {detail?.meta.title} · 当前第 {playing?.index} 集 {fmtTime(videoRef.current?.currentTime ?? 0)}
                      </p>
                    </div>
                    <button
                      className="rounded-full p-1 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                      onClick={() => setSourceSheet(null)}
                      aria-label="关闭换源"
                    >
                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </div>
                  <div className="scrollbar-thin max-h-[50vh] overflow-y-auto p-3">
                    {sourceSheet.loading && <p className="py-6 text-center text-xs text-white/60">正在搜索同名剧…</p>}
                    {sourceSheet.error && <p className="py-6 text-center text-xs text-danger">{sourceSheet.error}</p>}
                    {!sourceSheet.loading && !sourceSheet.error && sourceSheet.items.length === 0 && (
                      <p className="py-6 text-center text-xs text-white/50">没找到其他来源</p>
                    )}
                    <div className="flex flex-col gap-1.5">
                      {sourceSheet.items.map((it) => (
                        <button
                          key={it.series_id}
                          className="flex items-center gap-2.5 rounded-xl bg-white/5 p-2 text-left transition-colors hover:bg-white/12"
                          onClick={() => void switchSource(it)}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`${API}/img?url=${encodeURIComponent(it.cover || '')}`}
                            alt={it.title}
                            className="h-14 w-10 flex-none rounded-md object-cover"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="line-clamp-1 block text-xs text-white/90">{it.title}</span>
                            <span className="mt-0.5 block text-[11px] text-white/45">
                              {it.episode_cnt ? `全 ${it.episode_cnt} 集` : ''}
                              {it.copyright ? ` · ${it.copyright}` : ''}
                            </span>
                          </span>
                          <span className="shrink-0 text-[11px] text-accent">切换</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <p className="border-t border-white/10 px-4 py-2 text-[11px] leading-relaxed text-white/40">
                    换源后会自动回到同一集，并把进度往前挪 10 秒（不同源码率不同，只会往前不会往后）
                  </p>
                </div>
              </div>
            )}

            {/* 播放器内选集面板 */}
            {episodeSheet && episodes.length > 0 && (
              <div
                className="absolute inset-0 z-10 flex items-end justify-center bg-black/80 backdrop-blur-sm sm:items-center sm:p-6"
                onClick={() => setEpisodeSheet(false)}
              >
                <div
                  className="w-full overflow-hidden rounded-t-3xl border border-white/10 bg-[#0d141f] shadow-2xl sm:max-w-lg sm:rounded-3xl"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                    <p className="text-sm font-medium text-white">选集 · 共 {episodes.length} 集</p>
                    <button
                      className="rounded-full p-1 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                      onClick={() => setEpisodeSheet(false)}
                      aria-label="关闭选集"
                    >
                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </div>
                  <div className="scrollbar-thin grid max-h-[55vh] grid-cols-[repeat(auto-fill,minmax(52px,1fr))] gap-1.5 overflow-y-auto p-3">
                    {episodes.map((ep) => (
                      <button
                        key={ep.vid}
                        className={cn(
                          'rounded-lg py-2 text-xs tabular-nums transition-colors',
                          ep.index === playing.index
                            ? 'bg-accent font-semibold text-on-accent'
                            : 'bg-white/5 text-white/80 hover:bg-white/15 hover:text-white'
                        )}
                        onClick={() => play(ep, playing.title)}
                      >
                        {ep.index}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 刷剧流：一屏一部，滚轮/↑↓ 翻，右侧 1/N 计数 */}
      {feedOpen && items.length > 0 && (
        <ShortFeed
          items={items}
          imgBase={API}
          onClose={() => setFeedOpen(false)}
          onPlay={(it) => {
            setFeedOpen(false);
            void openDetail(it as Item, true);
          }}
          onDetail={(it) => {
            setFeedOpen(false);
            void openDetail(it as Item);
          }}
          progressOf={(id) => {
            const p = history.find((h) => h.seriesId === id);
            return p ? { lastEp: p.lastEp, lastPos: p.lastPos } : undefined;
          }}
        />
      )}
    </div>
  );
}
