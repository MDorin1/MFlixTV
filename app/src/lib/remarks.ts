/**
 * 播放备注（CMS 的 vod_remarks）归一化。
 *
 * 这个字段由各采集源自由填写，同一部剧的不同源常常各写各的：
 * 「全34集」「完结」「已完结」「第34集已完结」说的是同一件事，
 * 直接原样显示，会让用户以为这些源的状态不一样。
 *
 * 只归一「集数」与「完结状态」两类信息，其余（HD国语 / 正片 / 年份等）
 * 原样返回——它们不是集数信息，强行改写只会把内容丢掉。
 */

/** 集数：「全34集」「第34集」「更新至12集」「共24集」都能取出数字 */
const EPISODE_COUNT = /(\d+)\s*集/;
/**
 * 期号日期：「更新至20251020期」「第20250224期」这类写法没有「集」字。
 *
 * 综艺、新闻、长播节目普遍按播出日期标进度，采集源各写各的：
 * 20251020 / 2025-10-20 / 2025.10.20 三种都出现过。
 * 单独拎出来是因为它同时决定「这部还在更新吗」和「它该排在多新」——
 * 小明星大跟班的 vod_year 固定写 2016（首播年），只按年份排会被当成十年前的旧片。
 */
const EPISODE_DATE = /(20\d{2})[-./]?(\d{2})[-./]?(\d{2})/;
/** 完结的明确表述。「剧终」而不单是「终」——否则「终极版」会被误判成已完结 */
const FINISHED_WORD = /完结|大结局|全集|剧终/;
/** 前置全称：「全34集」「共24集」 */
const FINISHED_PREFIX = /(?:全|共)\s*\d+\s*集/;
/** 后置全称：「34集全」 */
const FINISHED_SUFFIX = /\d+\s*集\s*全/;

function isFinished(text: string): boolean {
  return FINISHED_WORD.test(text) || FINISHED_PREFIX.test(text) || FINISHED_SUFFIX.test(text);
}

function episodeCount(text: string): number {
  return Number(EPISODE_COUNT.exec(text)?.[1] ?? 0);
}

/**
 * 从备注里取出「最新一期」的播出日期，返回 `YYYY-MM-DD`。
 *
 * 只认能落到合法日历的 8 位日期：`2026` 这种纯年份、`第12集` 这种集数都不匹配，
 * 免得把「2026」「终极版」之类误认成期号。取文中**最晚**的一个日期，
 * 兼容「20240101-20251020」这种区间写法。
 */
export function latestEpisodeDate(raw?: string): string | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  let best: string | undefined;
  for (const m of text.matchAll(new RegExp(EPISODE_DATE.source, 'g'))) {
    const [, y, mo, d] = m;
    const mi = Number(mo);
    const di = Number(d);
    if (mi < 1 || mi > 12 || di < 1 || di > 31) continue;
    const iso = `${y}-${mo}-${d}`;
    if (!best || iso > best) best = iso;
  }
  return best;
}

/**
 * 归一备注文案。输出只有三种形态：
 * - `全N集`：已完结且知道总集数
 * - `更新至N集`：连载中且知道当前集数
 * - `已完结`：完结但没有集数信息
 * 以及原样返回的非集数备注（如 `HD国语`、`正片`）。
 *
 * 幂等：已归一化的文案再跑一次结果不变，因此聚合阶段与渲染阶段都调它也不会变样。
 */
export function formatRemarks(raw?: string): string | undefined {
  const text = raw?.trim();
  if (!text) return undefined;

  const finished = isFinished(text);
  const count = episodeCount(text);
  if (count > 0) return finished ? `全${count}集` : `更新至${count}集`;
  // 综艺/长播节目按播出日期标进度：统一成「更新至 2025-10-20」，比原始的
  // 「更新至20251020期」好读，也让「这部到底还更不更新」一眼可见
  const date = latestEpisodeDate(text);
  if (date) return `更新至 ${date}`;
  // 没有集数时，只有「完结」类表述能归一，别的保持原样
  if (finished) return '已完结';
  return text;
}

/**
 * 数据时间提示：告诉用户「内容是旧的」还是「源不更新了」。
 *
 * 详情页只写 `2016` 会让人以为这部没新内容直接退出，实际是上游断采。
 * 这里给出 `最新一集 2025-10-20 · 源 13 个月前更新`：
 * - 距今 < 30 天：只报日期（在更的节目不用加这句话）；
 * - ≥ 30 天：加上「源 N 个月前更新」，一眼看出是数据旧，不是内容没有。
 */
export function episodeFreshness(
  raw?: string,
  now: number = Date.now()
): { date: string; days: number; label: string } | undefined {
  const date = latestEpisodeDate(raw);
  if (!date) return undefined;
  const t = Date.parse(`${date}T00:00:00`);
  if (!Number.isFinite(t)) return undefined;
  const days = Math.max(0, Math.round((now - t) / 86400000));
  const months = Math.floor(days / 30);
  const aged = months >= 1 ? ` · 源 ${months} 个月前更新` : '';
  return { date, days, label: `最新一集 ${date}${aged}` };
}

/**
 * 搜索结果排序用的「新旧年份」。
 *
 * 一般影片取 vod_year；连载综艺/新闻的 vod_year 是首播年（「小明星大跟班」永远 2016），
 * 用它排序会把今天还在更新的节目压到十年前那一档。所以最新一期跨了年份时，
 * 以最新一期的年份为准。
 */
export function recencyYear(year?: string, latestDate?: string): number {
  const latestYear = Number(latestDate?.slice(0, 4));
  if (latestYear > 0) {
    const base = Number(year);
    return base > latestYear ? base : latestYear;
  }
  return Number(year) || 0;
}

/**
 * 选源列表里的紧凑备注。
 *
 * 「更新至1277集」在「源名 / 画质 / 集数」这一行里，前缀没有任何信息量，
 * 却吃掉三分之一宽度并挤掉画质的存在感——压成「1277 集」即可。
 * 非集数备注（HD国语 / 正片）剥掉无意义前缀后原样保留；
 * 单集影片不显示集数（没有「更新到第几集」这回事）。
 */
export function compactRemarks(raw?: string): string | undefined {
  const text = formatRemarks(raw);
  if (!text) return undefined;
  const episode = /^(?:全|更新至)(\d+)集$/.exec(text);
  if (episode) {
    const count = parseInt(episode[1], 10);
    return count > 1 ? `${count} 集` : undefined;
  }
  const prefixed = /^(?:全|更(?:新至|新|至))\s*(.+)$/.exec(text);
  if (prefixed) return prefixed[1].trim() || undefined;
  return text;
}

/**
 * 推断整组（同一部剧的所有来源）的统一备注。
 *
 * 单看一个源补不出集数：标「已完结」的源就是没写总集数。但同一部剧的总集数是客观的，
 * 组内只要有源写了「全34集」，就能确定这部剧是 34 集，把成果推到同组其他源上。
 * 这正是「有的是已完结、有的是全34集」的解法。
 *
 * 优先级：总集数 > 完结 > 进度。
 * 反过来（完结 > 总集数）会丢掉集数；而拿「更新至N集」当总集数是错的——
 * 那是进度，12 集的进度不代表这部只有 12 集。
 *
 * 注意这是**推断**：若某源实际只更到 20 集而组内已有源完结，它也会显示总集数。
 * 该源自己的原始标注保留在按钮 tooltip 里，信息不丢。
 */
export function inferGroupRemarks(raws: Array<string | undefined>): string | undefined {
  let total = 0;
  let progress = 0;
  let finished = false;
  let fallback: string | undefined;

  for (const raw of raws) {
    const text = formatRemarks(raw);
    if (!text) continue;
    fallback ??= text;

    const totalMatch = /^全(\d+)集$/.exec(text);
    if (totalMatch) {
      total = Math.max(total, Number(totalMatch[1]));
      continue;
    }
    const progressMatch = /^更新至(\d+)集$/.exec(text);
    if (progressMatch) {
      progress = Math.max(progress, Number(progressMatch[1]));
      continue;
    }
    if (text === '已完结') finished = true;
  }

  if (total > 0) return `全${total}集`;
  if (finished) return '已完结';
  if (progress > 0) return `更新至${progress}集`;
  return fallback;
}
