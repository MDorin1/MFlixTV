import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { pollCmds } from '@/lib/remote-bus';

export const runtime = 'nodejs';

/**
 * 页面侧取指令（长轮询的轻量版：客户端自己每 0.8 秒来一次）。
 * role=pc 的页面只会拿到 to=any / to=pc 的指令，不会被手机自己发的指令带跑。
 */
export async function GET(req: Request) {
  const denied = guardRequest(req);
  if (denied) return denied;

  const p = new URL(req.url).searchParams;
  const since = Number(p.get('since') || 0) || 0;
  const role = (p.get('role') || 'pc').slice(0, 8);
  const who = p.get('who') || '';
  return NextResponse.json(pollCmds(since, role, who));
}
