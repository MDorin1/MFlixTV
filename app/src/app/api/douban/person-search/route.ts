import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { searchPersons } from '@/lib/douban-api';

export const runtime = 'nodejs';

/**
 * 演员检索（模糊）。
 * GET /api/douban/person-search?q=<名字>
 * → { persons: [{ id, name, latinName, avatar, via }] }
 *
 * 「via=suggest」是豆瓣联想直出，「via=cast」是按人名搜影片后从演职员表里模糊匹配到的，
 * 后者用来兜「名字片段 → 完整姓名」这种只给了名字片段的搜法。
 */
export async function GET(req: Request) {
  const denied = guardRequest(req);
  if (denied) return denied;

  const q = (new URL(req.url).searchParams.get('q') || '').trim().slice(0, 30);
  if (!q) return NextResponse.json({ persons: [] });

  const persons = await searchPersons(q).catch(() => []);
  return NextResponse.json({ persons });
}
