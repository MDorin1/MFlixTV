import { beforeEach, describe, expect, it } from 'vitest';
import { activeDevices, pollCmds, pushCmd } from './remote-bus';

describe('手机遥控总线', () => {
  beforeEach(() => {
    // 每个用例从一个干净的队列开始
    const g = globalThis as typeof globalThis & { __mflRemote?: unknown };
    delete g.__mflRemote;
  });

  it('since 之后的指令才会被取走（同一条不会执行两次）', () => {
    const id1 = pushCmd('search', '测试', 'any', 'phone');
    const first = pollCmds(0, 'tv', 'tv-a');
    expect(first.cmds.map((c) => c.id)).toEqual([id1]);

    const second = pollCmds(first.now, 'tv', 'tv-a');
    expect(second.cmds).toHaveLength(0);
  });

  it('to 指定了角色时只有那个角色拿得到', () => {
    pushCmd('pause', '', 'tv', 'phone');
    expect(pollCmds(0, 'pc', 'pc-a').cmds).toHaveLength(0);
    const tv = pollCmds(0, 'tv', 'tv-a');
    expect(tv.cmds).toHaveLength(1);
    expect(tv.cmds[0].cmd).toBe('pause');
  });

  it('参数过长会截断，避免一条指令撑爆队列', () => {
    pushCmd('search', 'x'.repeat(500), 'any', 'phone');
    const { cmds } = pollCmds(0, 'tv', 'tv-a');
    expect(cmds[0].arg.length).toBeLessThanOrEqual(200);
  });

  it('心跳能反映出有几台设备连着', () => {
    pollCmds(0, 'tv', 'tv-a');
    pollCmds(0, 'pc', 'pc-a');
    expect(activeDevices()).toBeGreaterThanOrEqual(2);
  });

  it('队列只保留最近 64 条', () => {
    for (let i = 0; i < 80; i++) pushCmd('ok', String(i), 'any', 'phone');
    const { cmds } = pollCmds(0, 'tv', 'tv-a');
    expect(cmds.length).toBeLessThanOrEqual(64);
  });
});
