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
    // 多数接口回对象，推荐接口回数组，两种都要能解析
    const head = text.trim()[0];
    if (head !== '{' && head !== '[') return null;
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

/** 相似影片（豆瓣推荐接口回的是数组，结构比 subject 精简） */
export interface SimilarTitle {
  id: string;
  title: string;
  cover: string;
  rating: string;
  isTv: boolean;
  subtitle: string;
}

/**
 * 拉一部片的相似推荐。
 * 只取前 limit 条：资料页那一行是横向滑动的，多了既没人看也浪费豆瓣的节流额度。
 */
export async function fetchRecommendations(id: string, limit = 12): Promise<SimilarTitle[]> {
  interface Raw {
    id?: string | number;
    title?: string;
    type?: string;
    card_subtitle?: string;
    pic?: { normal?: string; large?: string };
    rating?: { value?: number };
  }
  const raw = await getJson<Raw[]>(`/movie/${id}/recommendations`);
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, limit)
    .map((item) => ({
      id: String(item.id ?? ''),
      title: (item.title || '').trim(),
      cover: item.pic?.large || item.pic?.normal || '',
      rating: typeof item.rating?.value === 'number' ? item.rating.value.toFixed(1) : '',
      isTv: item.type === 'tv',
      subtitle: item.card_subtitle || '',
    }))
    .filter((item) => item.id && item.title);
}
/* ============================ 演员检索 ============================ */

const SUGGEST_URL = 'https://movie.douban.com/j/subject_suggest';
/** suggest 接口的独立节流：和 rexxar 那套分开算，免得两边互相卡住 */
let lastSuggest = 0;
const SUGGEST_GAP_MS = 800;
const suggestCache = new Map<string, { at: number; data: PersonHit[] }>();

export interface PersonHit {
  id: string;
  name: string;
  latinName: string;
  avatar: string;
  /** 命中方式：suggest 直出，还是从影片演职员表里模糊匹配出来的 */
  via: 'suggest' | 'cast';
}

interface SuggestRaw {
  id?: string;
  title?: string;
  sub_title?: string;
  img?: string;
  type?: string;
}

/**
 * 演员名联想（模糊）。
 *
 * 豆瓣的 subject_suggest 只认「姓+名」这种完整片段（搜「刘德」不出刘德华），
 * 所以这里做两层：
 *  1. 先打 suggest，命中的 celebrity 直接收下；
 *  2. 不足 3 条时，退化成「按人名搜影片 → 拉这几部片的演职员表 → 名字包含关键词的挑出来」，
 *     这一层才真正实现「模糊」：搜「刘德」能出刘德华，搜「译」能出张译。
 * 两层都有 10 分钟缓存 + 节流，翻来覆去搜同一个词不会把豆瓣打成 418。
 */
export async function searchPersons(query: string, limit = 8): Promise<PersonHit[]> {
  const q = query.trim();
  if (!q) return [];
  const hit = suggestCache.get(q);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  const found = new Map<string, PersonHit>();

  // 1) suggest
  await sleep(Math.max(0, SUGGEST_GAP_MS - (Date.now() - lastSuggest)));
  lastSuggest = Date.now();
  try {
    const res = await fetch(`${SUGGEST_URL}?q=${encodeURIComponent(q)}`, {
      headers: {
        'User-Agent': UA,
        Referer: 'https://movie.douban.com/',
        'X-Requested-With': 'XMLHttpRequest',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const raw = (await res.json()) as SuggestRaw[];
      for (const item of Array.isArray(raw) ? raw : []) {
        if (item.type !== 'celebrity' || !item.id || !item.title) continue;
        found.set(String(item.id), {
          id: String(item.id),
          name: item.title,
          latinName: item.sub_title || '',
          avatar: item.img || '',
          via: 'suggest',
        });
      }
    }
  } catch {
    /* 拉不到就走第二层 */
  }

  // 2) 模糊兜底：按人名搜影片 → 演职员表里挑名字包含关键词的人。
  //    只在 suggest 一条都没给时才走——suggest 命中说明用户输的就是完整人名，
  //    再补三层请求只是白等（实测会让 1.4s 变成 2.5s）。
  if (found.size === 0) {
    try {
      const movieRes = await getJson<{ items?: { target?: { id?: string | number; title?: string } }[] }>(
        `/search/movie?q=${encodeURIComponent(q)}&start=0&count=10`
      );
      const items = movieRes?.items || [];
      // 搜的就是片名（首条命中标题与关键词一致）：说明用户想找影片而不是演员，别再翻演职员表
      const topTitle = (items[0]?.target?.title || '').trim();
      const looksLikeFilm = topTitle === q;
      if (!looksLikeFilm) {
        const ids = items
          .map((i) => String(i.target?.id ?? ''))
          .filter((id) => /^\d+$/.test(id))
          .slice(0, 3);
        for (const id of ids) {
          const cast = await fetchCast(id);
          for (const member of [...cast.directors, ...cast.actors]) {
            if (!member.id || !member.name) continue;
            // 双向包含：搜「刘德」命中「刘德华」，搜「刘德华」也不漏
            const matched = member.name.includes(q) || q.includes(member.name);
            if (!matched) continue;
            if (found.has(member.id)) continue;
            found.set(member.id, {
              id: member.id,
              name: member.name,
              latinName: member.latinName || '',
              avatar: member.avatar || '',
              via: 'cast',
            });
          }
          if (found.size >= limit) break;
        }
      }
    } catch {
      /* 兜底失败就只给第一层的结果 */
    }
  }

  const data = [...found.values()].slice(0, limit);
  suggestCache.set(q, { at: Date.now(), data });
  return data;
}
/* ============================ 片名检索（豆瓣条目） ============================ */

export interface TitleHit {
  id: string;
  title: string;
  cover: string;
  rating: string;
  year: string;
  subtitle: string;
}

/**
 * 按片名搜豆瓣条目（首页「豆瓣条目」那一行的数据源）。
 * 和演员检索共用 rexxar 那条节流队列，缓存 10 分钟——
 * 首页每搜一次只多一个请求，且同一个词重复搜命中缓存，不影响点播源的搜索与预取。
 */
export async function searchTitles(query: string, limit = 10): Promise<TitleHit[]> {
  const q = query.trim();
  if (!q) return [];
  interface Raw {
    target?: {
      id?: string | number;
      title?: string;
      year?: string;
      card_subtitle?: string;
      cover_url?: string;
      rating?: { value?: number };
    };
  }
  const res = await getJson<{ items?: Raw[] }>(
    `/search/movie?q=${encodeURIComponent(q)}&start=0&count=${limit}`
  );
  const items = res?.items || [];
  return items
    .map((i) => i.target)
    .filter((t): t is NonNullable<typeof t> => Boolean(t?.id && t?.title))
    .map((t) => ({
      id: String(t.id),
      title: String(t.title),
      cover: t.cover_url || '',
      rating: typeof t.rating?.value === 'number' ? t.rating.value.toFixed(1) : '',
      year: t.year || '',
      subtitle: t.card_subtitle || '',
    }))
    .slice(0, limit);
}