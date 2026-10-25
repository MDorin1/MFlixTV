import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { fetchPerson, fetchPersonWorks } from '@/lib/douban-api';

export const runtime = 'nodejs';

/**
 * 演员/导演主页：资料 + 参演作品（两种排序）。
 * GET /api/douban/person?id=1274477&sort=hot|time
 */
export async function GET(req: Request) {
  const denied = guardRequest(req);
  if (denied) return denied;

  const sp = new URL(req.url).searchParams;
  const id = sp.get('id') || '';
  const sort = sp.get('sort') === 'time' ? 'time' : 'hot';
  if (!/^\d+$/.test(id)) {
    return NextResponse.json({ error: 'id 无效' }, { status: 400 });
  }

  const [person, works] = await Promise.all([fetchPerson(id), fetchPersonWorks(id, sort)]);
  if (!person) {
    return NextResponse.json({ error: '没取到人物资料（可能被限流，稍后再试）' }, { status: 502 });
  }
  return NextResponse.json({ person, sort, total: works.total, works: works.works });
}
