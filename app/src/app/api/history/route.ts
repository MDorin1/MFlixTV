import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';
import { guardRequest } from '@/lib/api-guard';

/**
 * 观看历史同步接口（跨浏览器 / 局域网多设备共用）。
 *
 * 存储：<cwd>/.data/history.json —— 安装版里就是 <安装目录>\app\.data\，
 * 属于用户可写目录，卸载时随程序一起清掉。
 *
 * 合并规则与前端一致：同一部剧取 updatedAt 较新的那条，集级进度逐集取最大，
 * 收藏取"任一是 true"。这样两端各自看过的内容不会互相覆盖掉。
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_ITEMS = 200;

interface ShowProgress {
  seriesId: string;
  title: string;
  cover?: string;
  eps: Record<string, number>;
  durs: Record<string, number>;
  lastEp: number;
  lastPos: number;
  updatedAt: number;
  fav?: boolean;
}

function dataFile(): string {
  const dir = process.env.HISTORY_DIR || path.join(process.cwd(), '.data');
  return path.join(dir, 'history.json');
}

async function readAll(): Promise<ShowProgress[]> {
  try {
    const raw = await fs.readFile(dataFile(), 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as ShowProgress[]).filter((x) => x && x.seriesId) : [];
  } catch {
    return [];
  }
}

function mergeLists(a: ShowProgress[], b: ShowProgress[]): ShowProgress[] {
  const map = new Map<string, ShowProgress>();
  for (const item of [...a, ...b]) {
    if (!item || !item.seriesId) continue;
    const prev = map.get(item.seriesId);
    if (!prev) {
      map.set(item.seriesId, { ...item, eps: { ...(item.eps || {}) }, durs: { ...(item.durs || {}) } });
      continue;
    }
    const fresher = (item.updatedAt || 0) >= (prev.updatedAt || 0) ? item : prev;
    const eps: Record<string, number> = { ...(prev.eps || {}) };
    for (const [k, v] of Object.entries(item.eps || {})) {
      if (!Number.isFinite(v)) continue;
      eps[k] = Math.max(eps[k] || 0, v);
    }
    const durs: Record<string, number> = { ...(prev.durs || {}), ...(item.durs || {}) };
    map.set(item.seriesId, {
      ...fresher,
      eps,
      durs,
      fav: !!(prev.fav || item.fav),
    });
  }
  return [...map.values()].sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0)).slice(0, MAX_ITEMS);
}

function sanitize(list: unknown): ShowProgress[] {
  if (!Array.isArray(list)) return [];
  return (list as ShowProgress[])
    .filter((x) => x && typeof x.seriesId === 'string' && x.seriesId)
    .slice(0, MAX_ITEMS)
    .map((x) => ({
      seriesId: String(x.seriesId),
      title: String(x.title || ''),
      cover: typeof x.cover === 'string' ? x.cover : undefined,
      eps: typeof x.eps === 'object' && x.eps ? x.eps : {},
      durs: typeof x.durs === 'object' && x.durs ? x.durs : {},
      lastEp: Number(x.lastEp) || 1,
      lastPos: Number(x.lastPos) || 0,
      updatedAt: Number(x.updatedAt) || Date.now(),
      fav: x.fav === true,
    }));
}

export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const items = await readAll();
  return NextResponse.json({ items });
}

export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: { items?: unknown } = {};
  try {
    body = (await req.json()) as { items?: unknown };
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }

  const incoming = sanitize(body.items);
  const existing = await readAll();
  const merged = mergeLists(existing, incoming);

  try {
    const file = dataFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(merged, null, 2), 'utf8');
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '写入失败' },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, count: merged.length });
}
