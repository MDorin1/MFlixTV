import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { searchTitles } from '@/lib/douban-api';

export const runtime = 'nodejs';

/**
 * 片名检索（豆瓣条目）。
 * GET /api/douban/title-search?q=<片名>
 * → { titles: [{ id, title, cover, rating, year, subtitle }] }
 *
 * 首页用它给搜索结果配一行「豆瓣条目」：采集源只有片名和海报，
 * 想看简介/演员/相似影片，得有个能点进资料页的入口。
 */
export async function GET(req: Request) {
  const denied = guardRequest(req);
  if (denied) return denied;

  const q = (new URL(req.url).searchParams.get('q') || '').trim().slice(0, 60);
  if (!q) return NextResponse.json({ titles: [] });

  const titles = await searchTitles(q).catch(() => []);
  return NextResponse.json({ titles });
}
