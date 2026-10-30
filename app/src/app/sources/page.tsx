'use client';

import { useMemo, useState } from 'react';
import { Header } from '@/components/header';
import { SiteFooter } from '@/components/site-footer';
import { useToast } from '@/components/toast';
import { useAppStore, isSourceDisabled } from '@/lib/store';
import { cn } from '@/lib/utils';
import type { SourceConfig } from '@/lib/types';

interface ProbeRow {
  key: string;
  name: string;
  ok: boolean;
  ms: number;
  count: number;
  error?: string;
}

/**
 * 片源健康页。
 *
 * 三件事：看到每个源现在通不通、快不快；一键停用/恢复（停用 = 不参与搜索与首页取数，
 * 和「体检自动停用」是同一份状态）；把整套源配置导出成一段 JSON 带走。
 *
 * 体检是当场并发打一遍源站（单源 6 秒超时），结果只存在这个页面里，不落盘——
 * 服务端不需要知道用户选了哪些源，也就没有第二份状态要同步。
 */
export default function SourcesPage() {
  const { toast } = useToast();
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const sourceHealth = useAppStore((s) => s.sourceHealth);
  const toggleSourceSelected = useAppStore((s) => s.toggleSourceSelected);
  const setSelectedKeys = useAppStore((s) => s.setSelectedKeys);
  const addCustomApi = useAppStore((s) => s.addCustomApi);

  const [rows, setRows] = useState<Record<string, ProbeRow>>({});
  const [probing, setProbing] = useState(false);
  const [io, setIo] = useState('');

  const all = useMemo<SourceConfig[]>(() => {
    const seen = new Set<string>();
    const out: SourceConfig[] = [];
    for (const s of [...customAPIs, ...envSources]) {
      if (!s || seen.has(s.key)) continue;
      seen.add(s.key);
      out.push(s);
    }
    return out;
  }, [customAPIs, envSources]);

  const probeAll = async () => {
    if (!all.length) {
      toast('还没有片源：先在首页右上角「片源」里加一个', 'warning');
      return;
    }
    setProbing(true);
    try {
      const r = await fetch('/api/sources/health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: all.map((s) => ({ key: s.key, name: s.name, url: s.url })) }),
      });
      const d = (await r.json()) as { list?: ProbeRow[] };
      const map: Record<string, ProbeRow> = {};
      for (const x of d.list || []) map[x.key] = x;
      setRows(map);
      const ok = (d.list || []).filter((x) => x.ok).length;
      toast(`体检完成：${ok}/${(d.list || []).length} 个源可用`, ok > 0 ? 'success' : 'error');
    } catch {
      toast('体检失败：服务没应答', 'error');
    } finally {
      setProbing(false);
    }
  };

  const exportCfg = () => {
    const payload = {
      app: 'MFlixTV',
      kind: 'sources',
      version: 1,
      exportedAt: new Date().toISOString(),
      sources: all.map((s) => ({ name: s.name, url: s.url, detail: s.detail, isAdult: s.isAdult === true })),
      selected: selectedKeys,
    };
    setIo(JSON.stringify(payload, null, 2));
    toast('已导出，复制文本框里的内容即可', 'success');
  };

  const importCfg = () => {
    try {
      const o = JSON.parse(io) as { sources?: { name?: string; url?: string }[]; selected?: string[] };
      if (!Array.isArray(o.sources) || !o.sources.length) throw new Error('没有 sources');
      let added = 0;
      for (const s of o.sources) {
        if (!s || typeof s.url !== 'string' || !/^https?:\/\//.test(s.url)) continue;
        const exists = all.find((x) => x.url.replace(/\/+$/, '') === s.url!.replace(/\/+$/, ''));
        if (exists) continue;
        addCustomApi({ name: (s.name || s.url).slice(0, 40), url: s.url });
        added++;
      }
      toast(added > 0 ? `已导入 ${added} 个源` : '这些源都已经有了', added > 0 ? 'success' : 'info');
    } catch {
      toast('导入失败：不是合法的配置 JSON', 'error');
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">
        <h1 className="text-2xl font-bold text-content">片源健康</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          每个源现在通不通、快不快，一眼看到。停用的源不参与搜索和首页取数（照样留在列表里，随时能恢复）；
          体检连续失败的源也会被自动停一段时间，到期自己回来。
        </p>

        <div className="mt-5 flex flex-wrap gap-2">
          <button className="btn text-sm text-on-accent bg-accent hover:bg-accent-hover disabled:opacity-50" disabled={probing} onClick={() => void probeAll()}>
            {probing ? '正在测（约 5 秒）…' : '全部重测'}
          </button>
          <button className="btn-ghost text-sm" onClick={exportCfg}>
            导出配置
          </button>
          <button className="btn-ghost text-sm" onClick={() => selectedKeys.length && setSelectedKeys(all.map((s) => s.key))}>
            全部启用
          </button>
        </div>

        <div className="mt-5 overflow-hidden rounded-xl border border-line/60">
          <table className="w-full text-sm">
            <thead className="bg-surface-raised text-xs text-muted">
              <tr>
                <th className="px-3 py-2 text-left font-medium">源</th>
                <th className="px-3 py-2 text-left font-medium">状态</th>
                <th className="px-3 py-2 text-left font-medium">参与搜索</th>
              </tr>
            </thead>
            <tbody>
              {all.length === 0 && (
                <tr>
                  <td className="px-3 py-6 text-center text-muted" colSpan={3}>
                    还没有片源。回首页右上角「片源」里加一个，或者把别处的配置粘到下面导入。
                  </td>
                </tr>
              )}
              {all.map((s) => {
                const r = rows[s.key];
                const disabled = isSourceDisabled({ sourceHealth }, s.key);
                const on = selectedKeys.includes(s.key);
                const state = r ? (r.ok ? `${r.ms}ms · ${r.count} 条` : `不通：${r.error || '未知'}`) : '未测';
                return (
                  <tr key={s.key} className="border-t border-line/40">
                    <td className="px-3 py-2 text-content">
                      <div className="font-medium">{s.name}</div>
                      <div className="text-[11px] text-muted break-all">{s.url}</div>
                    </td>
                    <td className={cn('px-3 py-2', r ? (r.ok ? 'text-success' : 'text-danger') : 'text-muted')}>
                      {state}
                      {disabled && <span className="ml-2 text-[11px] text-warning">体检自动停用中</span>}
                    </td>
                    <td className="px-3 py-2">
                      <button
                        className={cn(
                          'rounded-md px-2 py-1 text-xs border transition-colors',
                          on ? 'border-accent/70 text-content bg-accent/12' : 'border-line/60 text-muted hover:text-content'
                        )}
                        onClick={() => toggleSourceSelected(s.key)}
                      >
                        {on ? '已启用' : '已停用'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-6">
          <div className="text-sm font-semibold text-content">导入 / 导出</div>
          <p className="mt-1 text-xs text-muted">
            导出的 JSON 里是源地址与勾选状态，不含任何账号或密码；换设备时把它粘到下面点导入即可。
          </p>
          <textarea
            value={io}
            onChange={(e) => setIo(e.target.value)}
            placeholder="点「导出配置」生成；或粘贴别处的配置后点「导入」"
            className="mt-2 h-32 w-full rounded-lg bg-surface-raised px-3 py-2 text-xs text-content placeholder:text-muted outline-none border border-line/60 focus:ring-2 focus:ring-accent/50"
          />
          <div className="mt-2 flex gap-2">
            <button className="btn-ghost text-xs" onClick={importCfg}>
              导入
            </button>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
