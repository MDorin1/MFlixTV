import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { fetchSubject, fetchCast, fetchRecommendations } from '@/lib/douban-api';

export const runtime = 'nodejs';

/**
 * 影视资料（Netflix 风详情页的数据源）。
 * GET /api/douban/info?id=34874646
 * → { subject: { 简介/评分/类型/地区/集数/封面 … }, cast: { directors, actors }, similar: [...] }
 */
export async function GET(req: Request) {
  const denied = guardRequest(req);
  if (denied) return denied;

  const id = new URL(req.url).searchParams.get('id') || '';
  if (!/^\d+$/.test(id)) {
    return NextResponse.json({ error: 'id 无效' }, { status: 400 });
  }

  const [subject, cast] = await Promise.all([fetchSubject(id), fetchCast(id)]);
  if (!subject) {
    return NextResponse.json({ error: '没取到豆瓣资料（可能被限流，稍后再试）' }, { status: 502 });
  }
  // 相似影片是锦上添花：豆瓣那边抽风时返回空数组，不要连累资料页自己也报错
  const similar = await fetchRecommendations(id).catch(() => []);
  return NextResponse.json({ subject, cast, similar });
}
