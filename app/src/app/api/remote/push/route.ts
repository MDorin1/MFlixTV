import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { pushCmd } from '@/lib/remote-bus';

export const runtime = 'nodejs';

/**
 * 手机遥控：把一条指令塞进本机队列。
 * 只在本机/局域网里有意义（服务跑在用户自己电脑上），不对外暴露任何端口。
 */
export async function GET(req: Request) {
  const denied = guardRequest(req);
  if (denied) return denied;

  const p = new URL(req.url).searchParams;
  const cmd = (p.get('cmd') || '').trim();
  if (!cmd) return NextResponse.json({ error: '缺少 cmd' }, { status: 400 });

  const id = pushCmd(cmd, p.get('arg') || '', p.get('to') || 'any', p.get('from') || 'phone');
  return NextResponse.json({ ok: true, id });
}

export async function POST(req: Request) {
  const denied = guardRequest(req);
  if (denied) return denied;

  let body: { cmd?: string; arg?: string; to?: string; from?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }
  const cmd = (body.cmd || '').trim();
  if (!cmd) return NextResponse.json({ error: '缺少 cmd' }, { status: 400 });

  const id = pushCmd(cmd, body.arg || '', body.to || 'any', body.from || 'phone');
  return NextResponse.json({ ok: true, id });
}
