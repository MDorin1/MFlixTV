/**
 * B 站公开接口的最小封装：搜索（WBI 签名）→ 分P → 弹幕 XML。
 *
 * 为什么要自己签 WBI：`/x/web-interface/search/type` 从 2023 年起要求 `w_rid`，
 * 直接把 keyword 拼上去会返回 -403。签名算法是公开的（nav 接口拿两张图的名字，
 * 按固定表打乱取前 32 位当密钥，参数排序后 md5），这里照做，不需要 Cookie。
 *
 * 所有请求都走 fetchUpstream：带超时、过 SSRF 校验、手动跟随跳转。
 */

import { fetchUpstream } from './fetch-utils';

const API = 'https://api.bilibili.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';

/** WBI 打乱表（B 站前端固定值，2019 年后未变） */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
  12, 38, 41, 13, 37, 48, 7, 16, 49, 4, 51, 25, 0, 24, 17, 20, 21, 26, 34, 40, 1, 44, 6, 36, 11, 52, 30, 55,
  22, 54, 56, 57, 59, 60, 61, 62, 63,
];

const HEADERS = {
  'user-agent': UA,
  referer: REFERER,
  accept: 'application/json, text/plain, */*',
  'accept-language': 'zh-CN,zh;q=0.9',
};

interface WbiKeys {
  imgKey: string;
  subKey: string;
  at: number;
}

let wbiCache: WbiKeys | null = null;
/** nav 的密钥一天才换一次，缓存 30 分钟足够，且不必每次搜索都多打一跳 */
const WBI_TTL_MS = 30 * 60 * 1000;

function baseName(url: string): string {
  const clean = url.split('?')[0];
  const file = clean.slice(clean.lastIndexOf('/') + 1);
  const dot = file.lastIndexOf('.');
  return dot > 0 ? file.slice(0, dot) : file;
}

async function getWbiKeys(force = false): Promise<WbiKeys> {
  if (!force && wbiCache && Date.now() - wbiCache.at < WBI_TTL_MS) return wbiCache;
  const res = await fetchUpstream(`${API}/x/web-interface/nav`, {
    headers: HEADERS,
    timeoutMs: 6000,
    // nav 未登录也返回 -101，但 wbi_img 照样给，所以不检查 code
  });
  const data = (await res.json()) as { data?: { wbi_img?: { img_url?: string; sub_url?: string } } };
  const imgUrl = data.data?.wbi_img?.img_url || '';
  const subUrl = data.data?.wbi_img?.sub_url || '';
  if (!imgUrl || !subUrl) throw new Error('拿不到 WBI 密钥');
  wbiCache = { imgKey: baseName(imgUrl), subKey: baseName(subUrl), at: Date.now() };
  return wbiCache;
}

/** md5：Node 端用内置 crypto；这里只在服务端跑，import 要按需（避免打进客户端包） */
async function md5Hex(text: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('md5').update(text).digest('hex');
}

async function signQuery(params: Record<string, string | number>): Promise<string> {
  const keys = await getWbiKeys();
  const raw = keys.imgKey + keys.subKey;
  const mixinKey = MIXIN_KEY_ENC_TAB.map((n) => raw[n] || '').join('').slice(0, 32);

  const withTs: Record<string, string | number> = {
    ...params,
    wts: Math.floor(Date.now() / 1000),
  };
  const query = Object.keys(withTs)
    .sort()
    .map((key) => {
      // 值里的 !'()* 必须剔除，否则签名对不上（B 站前端也是这么处理的）
      const value = String(withTs[key]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    })
    .join('&');
  const wRid = await md5Hex(query + mixinKey);
  return `${query}&w_rid=${wRid}`;
}

export interface BiliVideo {
  bvid: string;
  title: string;
  author: string;
  /** 秒 */
  duration: number;
  play: number;
  /** 弹幕数：太少的视频挑它等于没弹幕 */
  danmaku: number;
}

/** "12:34" / "1:02:03" → 秒 */
function parseDuration(text: string): number {
  const parts = (text || '').split(':').map((p) => parseInt(p, 10) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

/** 去掉搜索结果里高亮的 <em class="keyword"> */
function stripTags(text: string): string {
  return (text || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').trim();
}

interface SearchItem {
  bvid?: string;
  title?: string;
  author?: string;
  duration?: string;
  play?: number;
  /** 弹幕数（B 站字段名就叫 video_review） */
  video_review?: number;
  is_union_video?: number;
}

/** 按关键词搜视频（20 条一页）。失败不抛：弹幕是增强功能，搜不到就当作没有 */
export async function searchVideos(keyword: string, page = 1): Promise<BiliVideo[]> {
  const trimmed = keyword.trim();
  if (!trimmed) return [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const query = await signQuery({ search_type: 'video', keyword: trimmed, page });
      const res = await fetchUpstream(`${API}/x/web-interface/wbi/search/type?${query}`, {
        headers: HEADERS,
        timeoutMs: 8000,
      });
      const data = (await res.json()) as {
        code?: number;
        data?: { result?: SearchItem[] };
      };
      // -403 签名过期（密钥轮换）：清缓存重签一次
      if (data.code === -403 && attempt === 0) {
        wbiCache = null;
        await getWbiKeys(true);
        continue;
      }
      const list = data.data?.result;
      if (!Array.isArray(list)) return [];
      return list
        .filter((item) => typeof item.bvid === 'string' && item.bvid.startsWith('BV'))
        .map((item) => ({
          bvid: item.bvid as string,
          title: stripTags(item.title || ''),
          author: item.author || '',
          duration: parseDuration(item.duration || ''),
          play: typeof item.play === 'number' ? item.play : 0,
          danmaku: typeof item.video_review === 'number' ? item.video_review : 0,
        }));
    } catch {
      if (attempt === 1) return [];
    }
  }
  return [];
}

export interface BiliPage {
  cid: number;
  /** 1 起 */
  page: number;
  part: string;
  duration: number;
}

/** 分P 列表：单P 视频也返回一条，part 是视频标题 */
export async function fetchPages(bvid: string): Promise<BiliPage[]> {
  const res = await fetchUpstream(`${API}/x/player/pagelist?bvid=${encodeURIComponent(bvid)}`, {
    headers: HEADERS,
    timeoutMs: 8000,
  });
  const data = (await res.json()) as {
    code?: number;
    data?: { cid?: number; page?: number; part?: string; duration?: number }[];
  };
  if (data.code !== 0 || !Array.isArray(data.data)) return [];
  return data.data
    .filter((p) => typeof p.cid === 'number')
    .map((p) => ({
      cid: p.cid as number,
      page: p.page || 1,
      part: p.part || '',
      duration: p.duration || 0,
    }));
}

/** 弹幕 XML（历史接口，未登录可读；上限 1000 条/分页由服务端控制） */
export async function fetchDanmakuXml(cid: number): Promise<string> {
  const res = await fetchUpstream(`https://comment.bilibili.com/${cid}.xml`, {
    headers: { 'user-agent': UA, referer: REFERER, 'accept-encoding': 'gzip, deflate' },
    timeoutMs: 10000,
  });
  if (!res.ok) throw new Error(`弹幕接口 ${res.status}`);
  return res.text();
}

// ---------------------------------------------------------------- 番剧 / 影视（PGC）

export interface BiliSeason {
  seasonId: number;
  title: string;
  /** 番剧 / 国创 / 电影 / 纪录片 … */
  type: string;
}

interface SeasonSearchItem {
  season_id?: number;
  title?: string;
  season_type_name?: string;
}

/**
 * 搜「官方番剧/影视」条目（不是用户投稿）。
 *
 * 为什么要这条路：正版番剧的弹幕动辄几万条，而用户投稿的单集往往是二次上传、
 * 弹幕寥寥。片名对上时优先用官方季，观感差别非常大。
 * 没上架（多数国产剧/日剧）时返回空数组，走用户投稿的老路。
 */
export async function searchSeasons(keyword: string): Promise<BiliSeason[]> {
  const trimmed = keyword.trim();
  if (!trimmed) return [];
  const out: BiliSeason[] = [];
  const seen = new Set<number>();
  for (const type of ['media_bangumi', 'media_ft']) {
    try {
      const query = await signQuery({ search_type: type, keyword: trimmed, page: 1 });
      const res = await fetchUpstream(`${API}/x/web-interface/wbi/search/type?${query}`, {
        headers: HEADERS,
        timeoutMs: 7000,
      });
      const data = (await res.json()) as { data?: { result?: SeasonSearchItem[] } };
      for (const item of data.data?.result || []) {
        if (typeof item.season_id !== 'number' || seen.has(item.season_id)) continue;
        seen.add(item.season_id);
        out.push({
          seasonId: item.season_id,
          title: stripTags(item.title || ''),
          type: item.season_type_name || '',
        });
      }
    } catch {
      /* 一路失败不影响另一路 */
    }
  }
  return out;
}

export interface BiliEpisode {
  cid: number;
  /** 官方给的集号文本，如 "1" / "001" / "PV1" */
  title: string;
  /** 这一集的副标题，如「墨彩环」 */
  longTitle: string;
}

/** 官方季的分集（含每集 cid）。未登录可读，付费集也只给 cid，弹幕照常能取 */
export async function fetchSeasonEpisodes(seasonId: number): Promise<BiliEpisode[]> {
  const res = await fetchUpstream(`${API}/pgc/view/web/season?season_id=${seasonId}`, {
    headers: HEADERS,
    timeoutMs: 8000,
  });
  const data = (await res.json()) as {
    code?: number;
    result?: { episodes?: { cid?: number; title?: string; long_title?: string }[] };
  };
  const list = data.result?.episodes;
  if (!Array.isArray(list)) return [];
  return list
    .filter((ep) => typeof ep.cid === 'number')
    .map((ep) => ({
      cid: ep.cid as number,
      title: ep.title || '',
      longTitle: ep.long_title || '',
    }));
}
