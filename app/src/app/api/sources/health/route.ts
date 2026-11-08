import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { checkUpstreamAllowed } from '@/lib/ssrf';
import { fetchUpstream } from '@/lib/fetch-utils';
import { parseSearchList } from '@/lib/cms-parser';

export const runtime = 'nodejs';

interface ProbeItem {
  key: string;
  name: string;
  url: string;
}

interface ProbeResult {
  key: string;
  name: string;
  ok: boolean;
  ms: number;
  count: number;
  error?: string;
  /** 这条源最新一期（集/期）的日期：YYYY-MM-DD */
  latestDate?: string;
  /** 最新一期距今多少天；拿不到日期时为 undefined */
  ageDays?: number;
  /** 归档源：探活通、但内容早已停更，不参与新片排序 */
  archived?: boolean;
  /** 距离归档门槛还差多少天，方便在设置页直接说清「多久没更新」 */
  archiveAfterDays?: number;
}

/** 备注里的日期：20251020 / 2025-10-20 / 2025.10.20 都认 */
const EPISODE_DATE = /(20\d{2})[-./]?(\d{1,2})[-./]?(\d{1,2})/;

/** 归档门槛（天）：最新一期比这还旧，说明上游早不采了，只是接口还活着 */
const ARCHIVE_DAYS = 90;

/** 这批条目里最新的一期日期（只有合法日历的 8 位数字才算） */
function latestDateIn(list: Array<{ remarks?: string }>): string | undefined {
  let best = '';
  for (const it of list) {
    const m = String(it?.remarks || '').match(EPISODE_DATE);
    if (!m) continue;
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    const iso = `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (iso > best) best = iso;
  }
  return best || undefined;
}

/** 最新一期距今天数（本地日历口径，跨时区差一天不影响判档） */
function ageInDays(iso: string): number | undefined {
  const t = Date.parse(`${iso}T00:00:00`);
  if (!Number.isFinite(t)) return undefined;
  return Math.max(0, Math.round((Date.now() - t) / 86400000));
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36';

async function probeOne(item: ProbeItem): Promise<ProbeResult> {
  const url = (item.url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(url)) {
    return { key: item.key, name: item.name, ok: false, ms: 0, count: 0, error: '地址无效' };
  }
  const verdict = await checkUpstreamAllowed(url);
  if (!verdict.ok) {
    return { key: item.key, name: item.name, ok: false, ms: 0, count: 0, error: verdict.reason };
  }
  const start = Date.now();
  try {
    const res = await fetchUpstream(`${url}?ac=videolist&wd=test`, {
      timeoutMs: 6000,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    const ms = Date.now() - start;
    if (!res.ok) return { key: item.key, name: item.name, ok: false, ms, count: 0, error: `HTTP ${res.status}` };
    const data = await res.json();
    const list = parseSearchList(data, { key: item.key, name: item.name, url });
    // 第二道闸：探活只说明接口还活着，还要看它最新采到哪一天。
    // 只探活会把「接口通、内容停在半年前」的源当成好源排在最前面。
    let latestDate: string | undefined;
    let ageDays: number | undefined;
    let archived = false;
    try {
      const latestRes = await fetchUpstream(`${url}?ac=videolist&pg=1`, {
        timeoutMs: 6000,
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      });
      if (latestRes.ok) {
        const latestData = await latestRes.json();
        const latestList = parseSearchList(latestData, { key: item.key, name: item.name, url });
        latestDate = latestDateIn(latestList as unknown as Array<{ remarks?: string }>);
        ageDays = latestDate ? ageInDays(latestDate) : undefined;
        archived = ageDays !== undefined && ageDays > ARCHIVE_DAYS;
      }
    } catch {
      // 新鲜度这一路失败不影响「能不能用」的判定，只是没有日期可比
    }
    return {
      key: item.key,
      name: item.name,
      ok: true,
      ms,
      count: list.length,
      latestDate,
      ageDays,
      archived,
      archiveAfterDays: ARCHIVE_DAYS,
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    return {
      key: item.key,
      name: item.name,
      ok: false,
      ms: Date.now() - start,
      count: 0,
      error: name === 'TimeoutError' || name === 'AbortError' ? '超时' : err instanceof Error ? err.message : '请求失败',
    };
  }
}

/**
 * 片源体检：一次把前端手上的源全测一遍（并发 6 个，单源 6 秒超时）。
 *
 * 为什么由前端把源清单传上来：安装版的源配置本来就存在浏览器里（IndexedDB），
 * 服务端并不知道用户选了哪些源；如果把清单放服务端就要多一份状态和同步。
 * 这里只做「给一批地址、回一批结果」，不落盘、不留状态。
 */
export async function POST(req: Request) {
  const denied = guardRequest(req);
  if (denied) return denied;

  let items: ProbeItem[] = [];
  try {
    const body = (await req.json()) as { items?: ProbeItem[] };
    items = Array.isArray(body.items) ? body.items.slice(0, 40) : [];
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }
  if (!items.length) return NextResponse.json({ list: [], ok: 0, total: 0 });

  const out: ProbeResult[] = [];
  const CONCURRENCY = 6;
  let at = 0;
  async function worker() {
    for (;;) {
      const i = at++;
      if (i >= items.length) return;
      out[i] = await probeOne(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));

  const okList = out.filter((x) => x && x.ok);
  const archivedList = okList.filter((x) => x.archived);
  const fastest = okList.filter((x) => x.ms > 0).sort((a, b) => a.ms - b.ms)[0];
  return NextResponse.json({
    list: out,
    total: out.length,
    ok: okList.length,
    archived: archivedList.map((x) => x.name),
    live: okList.length - archivedList.length,
    fastest: fastest ? `${fastest.name} ${fastest.ms}ms` : '—',
    checkedAt: Date.now(),
  });
}
