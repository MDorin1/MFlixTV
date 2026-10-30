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
    return { key: item.key, name: item.name, ok: true, ms, count: list.length };
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
  const fastest = okList.filter((x) => x.ms > 0).sort((a, b) => a.ms - b.ms)[0];
  return NextResponse.json({
    list: out,
    total: out.length,
    ok: okList.length,
    fastest: fastest ? `${fastest.name} ${fastest.ms}ms` : '—',
    checkedAt: Date.now(),
  });
}
