/**
 * 弹幕：数据模型、解析、匹配打分、偏好记忆。
 *
 * 数据源是 B 站（公共接口：搜索 → 分P → 弹幕 XML），所以这里只做两件事——
 * 把 XML 变成能画的数组，以及在一堆同名视频里挑出「这一集」。
 * 渲染与请求在 danmaku-layer.tsx / app/api/danmaku/route.ts，本文件不碰 DOM。
 */

export interface DanmakuItem {
  /** 出现时间（秒，视频时间轴） */
  time: number;
  /** 1/2/3 = 滚动；4 = 底部固定；5 = 顶部固定 */
  mode: 1 | 2 | 3 | 4 | 5;
  /** #rrggbb */
  color: string;
  /** 字号缩放：1 = 25px（B 站默认档） */
  size: number;
  text: string;
}

export interface DanmakuCandidate {
  bvid: string;
  title: string;
  author: string;
  /** 秒 */
  duration: number;
  /** 分P 数（多P 时按集数挑 P） */
  pages: number;
  /** 从标题里认出来的集数，0 = 没认出来 */
  episode: number;
  /** 匹配分，越大越像这一集 */
  score: number;
  /** 播放量（B 站 search 结果里带，用来辅助判断） */
  play: number;
  /** 弹幕数：0 基本等于「挑它也没弹幕可看」 */
  danmaku: number;
}

export interface DanmakuPayload {
  ok: boolean;
  /** 实际使用的视频 */
  bvid?: string;
  cid?: number;
  /** 实际使用的视频标题（手动选源时前端要回显） */
  title?: string;
  /** 实际使用的分P 名（多P 时） */
  part?: string;
  count: number;
  items: DanmakuItem[];
  /** 候选列表（手动模式用） */
  candidates?: DanmakuCandidate[];
  error?: string;
}

/** 单次返回的弹幕上限：超过这个量级画面上根本放不下，只会拖慢解析与绘制 */
export const DANMAKU_MAX_ITEMS = 6000;

// ---------------------------------------------------------------- XML 解析

/** XML 里只有这五个实体是常见写法，手写替换比引 DOMParser 更省（服务端也能跑） */
const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] ?? m);
}

/** B 站颜色是十进制整数（16777215 = 白），转成 CSS 十六进制 */
function colorOf(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 0xffffff) return '#ffffff';
  return `#${value.toString(16).padStart(6, '0')}`;
}

/**
 * 解析 `<i><d p="时间,模式,字号,颜色,...">正文</d>...</i>`。
 * 分页的 XML 里没有 XML 命名空间，正文里可能带 `<` `>` 的转义，用正则足够稳。
 */
export function parseDanmakuXml(xml: string): DanmakuItem[] {
  const items: DanmakuItem[] = [];
  const re = /<d p="([^"]*)">([\s\S]*?)<\/d>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const attrs = match[1].split(',');
    const time = Number(attrs[0]);
    const mode = Number(attrs[1]) as DanmakuItem['mode'];
    const size = Number(attrs[2]);
    const color = Number(attrs[3]);
    const text = decodeEntities(match[2]).trim();
    if (!Number.isFinite(time) || time < 0) continue;
    if (!text) continue;
    // B 站模式：1/2/3 滚动（2、3 是老版本写法，行为同 1）、4 底部、5 顶部
    if (mode !== 1 && mode !== 2 && mode !== 3 && mode !== 4 && mode !== 5) continue;
    items.push({
      time,
      mode: mode === 2 || mode === 3 ? 1 : mode,
      color: colorOf(color),
      // 字号按 25px 归一：XML 里的 25 是标准档，18 小、36 大
      size: Number.isFinite(size) ? Math.min(1.6, Math.max(0.86, size / 25)) : 1,
      text: text.length > 120 ? `${text.slice(0, 120)}…` : text,
    });
    if (items.length >= DANMAKU_MAX_ITEMS * 2) break;
  }
  items.sort((a, b) => a.time - b.time);
  return items;
}

// ---------------------------------------------------------------- 匹配

const PUNCT = /[\s\u3000·•:：,，.。、!！?？'"“”‘’()（）[\]【】《》<>/\\|~—\-_+=*#@&$%^;；]+/g;

/** 归一化片名：去掉标点空格、全角转半角，只留中文/字母/数字 */
export function normalizeTitle(raw: string): string {
  return (raw || '')
    .replace(/\u3000/g, '')
    .replace(PUNCT, '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase();
}

const CN_NUM: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/** 中文数字转阿拉伯（只覆盖 1–99，剧集集数够用） */
function cnToNumber(text: string): number {
  if (/^\d+$/.test(text)) return parseInt(text, 10);
  if (text.length === 1) return CN_NUM[text] ?? 0;
  if (text.length === 2) {
    if (text[1] === '十') return (CN_NUM[text[0]] ?? 0) * 10;
    if (text[0] === '十') return 10 + (CN_NUM[text[1]] ?? 0);
    return (CN_NUM[text[0]] ?? 0) * 10 + (CN_NUM[text[1]] ?? 0);
  }
  if (text.length === 3 && text[1] === '十') {
    return (CN_NUM[text[0]] ?? 0) * 10 + (CN_NUM[text[2]] ?? 0);
  }
  return 0;
}

/**
 * 从标题里认集数。顺序很重要：
 * 「第 12 集」「第十二集」是明确信号；「EP12」「E12」「S01E12」也认；
 * 裸数字（如「繁花12」）最后才认，且要求前面不是年份/分辨率。
 */
export function guessEpisode(raw: string): number {
  const text = raw || '';
  let m = text.match(/第\s*([0-9]{1,4}|[一二三四五六七八九十]{1,3})\s*[集话話期回]/);
  if (m) return cnToNumber(m[1]);
  m = text.match(/[Ee][Pp]?\s*(\d{1,4})(?!\d)/) || text.match(/[Ss]\d{1,2}\s*[Ee](\d{1,3})/);
  if (m) return parseInt(m[1], 10);
  m = text.match(/[（(【\[]\s*(\d{1,3})\s*[)）】\]]/);
  if (m) return parseInt(m[1], 10);
  return 0;
}

/** 两个标题的字符重合度（0–1）：用于「片名对得上但带前后缀」的情况 */
export function overlapRatio(a: string, b: string): number {
  const setA = new Set(normalizeTitle(a));
  const setB = new Set(normalizeTitle(b));
  if (!setA.size || !setB.size) return 0;
  let hit = 0;
  for (const ch of setA) if (setB.has(ch)) hit++;
  return hit / setA.size;
}

export interface MatchQuery {
  title: string;
  /** 1 起 */
  episode: number;
  /** 已知单集时长（秒），0 = 不知道 */
  duration?: number;
}

/**
 * 淘洗关键词：B 站上「片名对得上」的视频绝大多数是解说/二创/预告。
 * 这类视频的弹幕是「看解说的反应」，贴到正片上完全对不上，必须重罚而不是小扣分。
 */
const NOISE_RE =
  /解说|讲剧|讲讲剧|解析|解读|影评|吐槽|盘点|分析|速看|看剧|追剧|预告|花絮|彩蛋|幕后|采访|发布会|首映|直播回放|混剪|剪辑|二创|漫剪|reaction|recap|review|trailer|片段|名场面|合集|上集|下集|第[一二三四五六七八九十\d]+期/i;

/** 自动匹配的最低分：低于这个分宁可不显示，也别把「解说的弹幕」盖到正片上 */
export function minScoreFor(query: MatchQuery): number {
  return query.episode > 0 ? 55 : 35;
}

/**
 * 给候选打分。目标：在几十个同名视频里挑「集数对得上、片名对得上、时长像一集」的那个。
 * 返回 -1 表示基本不可能是它（片名差太远 / 时长差太多），调用方可以直接丢掉。
 */
export function scoreDanmakuCandidate(
  candidate: Pick<DanmakuCandidate, 'title' | 'duration' | 'episode' | 'play' | 'pages' | 'danmaku'>,
  query: MatchQuery
): number {
  const wantTitle = normalizeTitle(query.title);
  const candTitle = normalizeTitle(candidate.title);
  if (!wantTitle || !candTitle) return -1;

  let score = 0;
  // 片名：完全包含最强；否则按字符重合度，低于 0.6 基本是别的剧
  if (candTitle.includes(wantTitle)) {
    score += 40;
    // 只多出「合集/预告/解说」这类前缀后缀时再加一点
    if (candTitle.length <= wantTitle.length + 8) score += 6;
  } else {
    const overlap = overlapRatio(query.title, candidate.title);
    if (overlap < 0.6) return -1;
    score += Math.round(overlap * 30);
  }

  // 解说/预告/二创：这类视频的弹幕是「看解说的反应」，贴到正片上完全对不上，重罚
  if (NOISE_RE.test(candidate.title)) score -= query.episode > 0 ? 60 : 45;

  const wantEpisode = query.episode > 0 ? query.episode : 0;
  const episodeMatched = wantEpisode > 0 && candidate.episode === wantEpisode;
  if (wantEpisode > 0) {
    if (episodeMatched) score += 40;
    else if (candidate.episode > 0) score -= 35; // 明确是别的集
    // 认不出集数：多P 视频（一个合集）还能靠挑 P 补救，单P 视频基本不是这一集
    else if (candidate.pages > 1) score += 4;
    else score -= 30;
  } else if (candidate.episode > 0) {
    // 用户看的是一部电影/整季合集，候选却是某一集 → 不匹配
    score -= 12;
  }

  // 时长：已知单集时长时按接近程度加分；差太多直接判死（解说往往只有几分钟）
  const duration = candidate.duration || 0;
  const target = query.duration && query.duration > 60 ? query.duration : 0;
  if (target > 0) {
    const diff = Math.abs(duration - target) / target;
    if (diff <= 0.12) score += 24;
    else if (diff <= 0.3) score += 10;
    else if (diff > 0.5 && !episodeMatched) return -1;
    else if (diff > 0.5) score -= 20;
  } else if (duration >= 90 && duration <= 60 * 150) {
    score += Math.min(10, Math.round(duration / 600));
  } else if (duration > 0 && duration < 45) {
    return -1; // 几秒钟的切片，弹幕肯定是野生的
  }

  // 弹幕数：这个才是「挑了有没有东西看」的直接指标，按对数加权（1 万条和 10 万条差别没那么大）
  if (candidate.danmaku > 0) score += Math.round(Math.min(10, Math.log10(1 + candidate.danmaku) * 3));

  // 播放量只做轻微加权：热门视频的弹幕确实更密
  if (candidate.play > 500000) score += 4;
  else if (candidate.play > 50000) score += 2;

  return score;
}

/**
 * 官方季（番剧/国创/影视）与片名的匹配分。
 *
 * 比用户投稿简单得多：官方标题就是片名本身，可能带「第二季 / 剧场版 / 国语版」。
 * 只要片名对得上就算命中，季号对不上才扣分——用户在哪一季就看哪一季。
 */
export function scoreSeason(seasonTitle: string, queryTitle: string): number {
  const want = normalizeTitle(queryTitle);
  const have = normalizeTitle(seasonTitle);
  if (!want || !have) return -1;
  if (!have.includes(want)) {
    // 官方标题常带副标题（「灵笼 第二季」），去掉季号后再比一次
    const stripped = normalizeTitle(seasonTitle.replace(/第[一二三四五六七八九十\d]+季|Season\s*\d+|S\d+/gi, ''));
    if (!stripped.includes(want) && overlapRatio(stripped, want) < 0.85) return -1;
  }
  let score = 50;

  // 片名不在开头：「弹速狂飙」这种蹭词条的栏目/速看合集，弹幕和正片对不上
  if (have.indexOf(want) > 0) score -= 12;
  // 标题比片名长出一大截：多半是「犯人犯泽先生」这类番外/衍生，不是正片
  if (have.length > want.length + 6) score -= 15;
  // 栏目化内容（速看/解说/盘点/弹幕精选）不是正片；剧场版/纪录片是正经条目，不在罚则里
  if (/速看|解说|盘点|混剪|弹幕精选|名场面|高能|片段|合集|预告|花絮|特辑|番外|舞台剧|采访|总集篇|动态漫画/i.test(seasonTitle)) {
    score -= 30;
  }

  const seasonMark = (text: string) => {
    const m = text.match(/第([一二三四五六七八九十\d]+)季|Season\s*(\d+)|S(\d+)/i);
    if (!m) return 0;
    return cnToNumber(m[1] || m[2] || m[3] || '0');
  };
  const wantSeason = seasonMark(queryTitle);
  const haveSeason = seasonMark(seasonTitle);
  if (wantSeason && haveSeason && wantSeason !== haveSeason) score -= 40;
  else if (!wantSeason && haveSeason > 1) score -= 10;
  else if (wantSeason && !haveSeason) score -= 8;

  // 剧场版 / 番外 / 特辑 这类条目不是正片连载，弹幕也少
  if (/剧场版|特别篇|特辑|番外|PV|预告|花絮|合辑|总集篇|舞台剧|采访/i.test(seasonTitle)) score -= 20;
  return score;
}

/** 排序后取前 N 个（分数相同则弹幕潜力大的先） */export function rankCandidates<T extends { score: number; duration: number; play: number }>(
  list: T[],
  limit = 8
): T[] {
  return [...list]
    .filter((c) => c.score >= 0)
    .sort((a, b) => b.score - a.score || b.play - a.play || b.duration - a.duration)
    .slice(0, limit);
}

// ---------------------------------------------------------------- 偏好

/** 弹幕显示模式：关 / 自动匹配 / 手动选源 */
export type DanmakuMode = 'off' | 'auto' | 'manual';
/** 显示区域 */
export type DanmakuArea = 'full' | 'top' | 'bottom';

export interface DanmakuPrefs {
  mode: DanmakuMode;
  /** 0.15 – 1 */
  opacity: number;
  /** 0.6 – 1.8，字号缩放 */
  fontScale: number;
  /** 0.5 – 2，越大飘得越快 */
  speed: number;
  /** 同屏密度上限（条） */
  density: number;
  area: DanmakuArea;
}

export const DANMAKU_STORAGE_KEY = 'mfl:danmaku:prefs';

export const DEFAULT_DANMAKU_PREFS: DanmakuPrefs = {
  mode: 'auto',
  opacity: 0.85,
  fontScale: 1,
  speed: 1,
  density: 60,
  area: 'full',
};

const clamp = (v: number, min: number, max: number) => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min);

function pickNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

function pickMode(value: unknown): DanmakuMode {
  return value === 'off' || value === 'auto' || value === 'manual' ? value : DEFAULT_DANMAKU_PREFS.mode;
}

function pickArea(value: unknown): DanmakuArea {
  return value === 'full' || value === 'top' || value === 'bottom' ? value : DEFAULT_DANMAKU_PREFS.area;
}

let prefsCache: DanmakuPrefs | null = null;

export function readDanmakuPrefs(): DanmakuPrefs {
  if (prefsCache) return { ...prefsCache };
  if (typeof window === 'undefined') return { ...DEFAULT_DANMAKU_PREFS };
  try {
    const raw = window.localStorage.getItem(DANMAKU_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<DanmakuPrefs> | null) : null;
    prefsCache = {
      mode: pickMode(parsed?.mode),
      opacity: pickNumber(parsed?.opacity, DEFAULT_DANMAKU_PREFS.opacity, 0.15, 1),
      fontScale: pickNumber(parsed?.fontScale, DEFAULT_DANMAKU_PREFS.fontScale, 0.6, 1.8),
      speed: pickNumber(parsed?.speed, DEFAULT_DANMAKU_PREFS.speed, 0.5, 2),
      density: Math.round(pickNumber(parsed?.density, DEFAULT_DANMAKU_PREFS.density, 10, 120)),
      area: pickArea(parsed?.area),
    };
  } catch {
    prefsCache = { ...DEFAULT_DANMAKU_PREFS };
  }
  return { ...prefsCache };
}

export function saveDanmakuPrefs(patch: Partial<DanmakuPrefs>): DanmakuPrefs {
  const next: DanmakuPrefs = { ...readDanmakuPrefs(), ...patch };
  next.mode = pickMode(next.mode);
  next.opacity = Math.round(pickNumber(next.opacity, DEFAULT_DANMAKU_PREFS.opacity, 0.15, 1) * 100) / 100;
  next.fontScale = Math.round(pickNumber(next.fontScale, 1, 0.6, 1.8) * 10) / 10;
  next.speed = Math.round(pickNumber(next.speed, 1, 0.5, 2) * 10) / 10;
  next.density = Math.round(pickNumber(next.density, DEFAULT_DANMAKU_PREFS.density, 10, 120));
  next.area = pickArea(next.area);
  prefsCache = next;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(DANMAKU_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* 写不进去不影响本集使用 */
    }
  }
  return { ...next };
}

/** 手动选源的记忆：`剧名#集数 → bvid`，换集回来还选同一个 UP 主的那条 */
const MANUAL_KEY = 'mfl:danmaku:manual';

function manualMap(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(MANUAL_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, string> | null) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function manualKeyOf(title: string, episode: number): string {
  return `${normalizeTitle(title)}#${episode > 0 ? episode : 0}`;
}

export function readManualPick(title: string, episode: number): string | undefined {
  return manualMap()[manualKeyOf(title, episode)] || undefined;
}

export function saveManualPick(title: string, episode: number, bvid: string): void {
  if (typeof window === 'undefined') return;
  try {
    const map = manualMap();
    const key = manualKeyOf(title, episode);
    if (bvid) map[key] = bvid;
    else delete map[key];
    // 只留最近 200 条，避免 localStorage 越滚越大
    const keys = Object.keys(map);
    if (keys.length > 200) for (const old of keys.slice(0, keys.length - 200)) delete map[old];
    window.localStorage.setItem(MANUAL_KEY, JSON.stringify(map));
  } catch {
    /* 忽略 */
  }
}
