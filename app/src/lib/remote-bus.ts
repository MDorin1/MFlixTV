/**
 * 手机遥控的服务端总线（只在局域网内走）。
 *
 * 手机打开「这台电脑的网页版」→ 点遥控 → 按键经 /api/remote/push 进队列，
 * 电脑上的页面（/api/remote/poll，role=pc）每 0.8 秒取一次并执行。
 * 指令只存在这个 Node 进程的内存里：服务一停就清空，不需要落盘。
 *
 * 和安卓端 Remote.kt 的行为保持一致（id 自增、只留最近 64 条、目标匹配 to）。
 */

export interface RemoteCmd {
  id: number;
  cmd: string;
  arg: string;
  to: string;
  from: string;
  ts: number;
}

interface Bus {
  seq: number;
  queue: RemoteCmd[];
  beats: Map<string, number>;
}

const MAX = 64;
const ALIVE_MS = 15_000;

function bus(): Bus {
  const g = globalThis as typeof globalThis & { __mflRemote?: Bus };
  if (!g.__mflRemote) g.__mflRemote = { seq: 0, queue: [], beats: new Map() };
  return g.__mflRemote;
}

export function pushCmd(cmd: string, arg: string, to: string, from: string): number {
  const b = bus();
  const id = ++b.seq;
  b.queue.push({
    id,
    cmd: cmd.slice(0, 24),
    arg: arg.slice(0, 200),
    to: (to || 'any').slice(0, 8),
    from: (from || '').slice(0, 24),
    ts: Date.now(),
  });
  while (b.queue.length > MAX) b.queue.shift();
  beat('app', from);
  return id;
}

export function pollCmds(since: number, role: string, who: string): { now: number; cmds: RemoteCmd[]; devices: number } {
  const b = bus();
  const now = b.seq;
  const out = b.queue.filter((c) => c.id > since && (c.to === 'any' || c.to === role));
  // 已经确认过的旧条目顺手丢掉，长挂机不会越攒越多
  b.queue = b.queue.filter((c) => c.id > since - 32);
  beat(role, who);
  return { now, cmds: out, devices: activeDevices() };
}

function beat(role: string, who: string) {
  const b = bus();
  b.beats.set(`${role}|${who || '-'}`, Date.now());
}

export function activeDevices(): number {
  const b = bus();
  const now = Date.now();
  let n = 0;
  for (const [k, v] of b.beats) {
    if (now - v < ALIVE_MS) n++;
    else b.beats.delete(k);
  }
  return n;
}
