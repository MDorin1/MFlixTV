/**
 * 豆瓣影视资料的只读取数层（服务端专用）。
 *
 * 用的是豆瓣自己网页/App 在用的 rexxar 接口，不需要 key，但要求带上 UA 与 Referer，
 * 并且对同一 IP 有频率限制 —— 所以这里做了进程内缓存，且所有请求串行 + 最小间隔。
 *
 * 取到的字段（简介 / 评分 / 类型 / 地区 / 演员头像 / 演员作品）用于 Netflix 风格的
 * 详情页与演员页；播放仍然走原来的采集源流程，两者互不影响。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REFERER = 'https://m.douban.com/';
const BASE = 'https://m.douban.com/rexxar/api/v2';

/** 缓存 TTL：影视资料基本不变，10 分钟足够，也能挡住频繁点击 */
const TTL_MS = 10 * 60 * 1000;
/** 两次上游请求的最小间隔：豆瓣对 rexxar 有节流，压太猛会 418/403 */
const MIN_GAP_MS = 260;

const cache = new Map<string, { at: number; data: unknown }>();
let lastCall = 0;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getJson<T>(path: string): Promise<T | null> {
  const key = path;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data as T;

  const wait = MIN_GAP_MS - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();

  try {
    const res = await fetch(BASE + path, {
      // 豆瓣会 301 到 tv/… 分支，交给 fetch 自动跟随
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        Referer: REFERER,
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.trim().startsWith('{')) return null;
    const data = JSON.parse(text) as T;
    cache.set(key, { at: Date.now(), data });
    return data;
  } catch {
    return null;
  }
}

export interface SubjectInfo {
  id: string;
  title: string;
  year: string;
  type: 'movie' | 'tv';
  rating: number | null;
  ratingCount: number;
  genres: string[];
  countries: string[];
  languages: string[];
  durations: string[];
  episodes: number | null;
  intro: string;
  cover: string;
  cardSubtitle: string;
  pubdate: string;
  aka: string[];
}

export interface CastMember {
  id: string;
  name: string;
  latinName: string;
  character: string;
  avatar: string;
}

export interface Cast {
  directors: CastMember[];
  actors: CastMember[];
}

export interface PersonWork {
  id: string;
  title: string;
  year: string;
  type: 'movie' | 'tv';
  rating: number | null;
  ratingCount: number;
  cover: string;
  genres: string[];
  cardSubtitle: string;
  roles: string[];
}

export interface Person {
  id: string;
  name: string;
  latinName: string;
  avatar: string;
  subtitle: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function num(v: any): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function str(v: any): string {
  return typeof v === 'string' ? v : '';
}

function arr(v: any): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}

function normSubject(raw: any): SubjectInfo | null {
  if (!raw || typeof raw.title !== 'string' || !raw.title) return null;
  const isTv = raw.type === 'tv' || raw.is_tv === true;
  return {
    id: String(raw.id ?? ''),
    title: raw.title,
    year: str(raw.year),
    type: isTv ? 'tv' : 'movie',
    rating: num(raw.rating?.value),
    ratingCount: Number(raw.rating?.count) || 0,
    genres: arr(raw.genres),
    countries: arr(raw.countries),
    languages: arr(raw.languages),
    durations: arr(raw.durations),
    episodes: num(raw.episodes_count),
    intro: str(raw.intro).trim(),
    cover: str(raw.cover_url) || str(raw.pic?.large) || str(raw.pic?.normal),
    cardSubtitle: str(raw.card_subtitle),
    pubdate: arr(raw.pubdate)[0] || str(raw.release_date),
    aka: arr(raw.aka).slice(0, 6),
  };
}

function normCastMember(raw: any): CastMember | null {
  if (!raw || typeof raw.id !== 'string' || !raw.id) return null;
  return {
    id: raw.id,
    name: str(raw.name),
    latinName: str(raw.latin_name),
    // 豆瓣的 character 自带「饰 」前缀，剥掉再拼，避免出现「饰 饰 阿宝」
    character: (str(raw.character) || str(raw.simple_character)).replace(/^饰\s*/, ''),
    avatar: str(raw.avatar?.large) || str(raw.avatar?.normal),
  };
}

/** 影视详情（电影走 movie/，剧集会被 301 到 tv/，由 fetch 自动跟随） */
export async function fetchSubject(id: string): Promise<SubjectInfo | null> {
  if (!/^\d+$/.test(id)) return null;
  const raw = await getJson<any>(`/movie/${id}?for_mobile=1`);
  return normSubject(raw);
}

/** 演职员（导演 + 演员，含头像与人物 id） */
export async function fetchCast(id: string): Promise<Cast> {
  const raw = await getJson<any>(`/movie/${id}/celebrities?for_mobile=1`);
  const directors = Array.isArray(raw?.directors) ? raw.directors : [];
  const actors = Array.isArray(raw?.actors) ? raw.actors : [];
  return {
    directors: directors.map(normCastMember).filter(Boolean) as CastMember[],
    actors: actors.map(normCastMember).filter(Boolean) as CastMember[],
  };
}

/** 人物资料 */
export async function fetchPerson(id: string): Promise<Person | null> {
  if (!/^\d+$/.test(id)) return null;
  const raw = await getJson<any>(`/celebrity/${id}?for_mobile=1`);
  if (!raw) return null;
  // 豆瓣 detail 里名字在 title，外文名在 latin_title；头像 cover.normal 是个对象（带 url）
  const name = str(raw.title) || str(raw.name);
  const cover = raw.cover || {};
  const avatar =
    str(raw.cover_img) || str(cover.normal?.url) || str(cover.large?.url) || str(cover.url) || '';
  return {
    id,
    name,
    latinName: str(raw.latin_title) || str(raw.latin_name),
    avatar,
    subtitle: str(raw.subtitle) || str(raw.card_subtitle) || str(raw.extra?.short_info) || '',
  };
}

/**
 * 人物作品。sort=hot 按热度、time 按时间。
 * 豆瓣的 works 接口 sortby 支持 hot / time；拿不到时退化成默认顺序（不报错）。
 */
export async function fetchPersonWorks(
  id: string,
  sort: 'hot' | 'time',
  start = 0,
  count = 40
): Promise<{ total: number; works: PersonWork[] }> {
  if (!/^\d+$/.test(id)) return { total: 0, works: [] };
  const raw = await getJson<any>(
    `/celebrity/${id}/works?sortby=hot&start=${start}&count=${Math.max(count, 120)}&for_mobile=1`
  );
  const list = Array.isArray(raw?.works) ? raw.works : [];
  const works: PersonWork[] = [];
  for (const it of list) {
    const w = it?.work;
    if (!w || !w.id) continue;
    works.push({
      id: String(w.id),
      title: str(w.title),
      year: str(w.year),
      type: w.type === 'tv' ? 'tv' : 'movie',
      rating: num(w.rating?.value),
      ratingCount: Number(w.rating?.count) || 0,
      cover: str(w.cover_url) || str(w.pic?.normal) || str(w.pic?.large),
      genres: arr(w.genres),
      cardSubtitle: str(w.card_subtitle),
      roles: arr(it?.roles),
    });
  }
  if (sort === 'time') {
    works.sort((a, b) => {
      const ya = Number(a.year) || 0;
      const yb = Number(b.year) || 0;
      if (yb !== ya) return yb - ya;
      return b.ratingCount - a.ratingCount;
    });
  }
  return { total: Number(raw?.total) || works.length, works: works.slice(0, count) };
}
