'use client';

import { useMemo } from 'react';
import { useAppStore, resolveSource, isInDisabledSubscription, isSourceDisabled } from '@/lib/store';
import { validateSourceUrl } from '@/lib/utils';
import type { SourceConfig } from '@/lib/types';

/**
 * 当前参与「搜片 / 取更新」的源列表。
 *
 * 与首页搜索用完全同一套口径（勾选 + 未停用 + 未关订阅 + 地址合法 + 去重），
 * 否则会出现「搜索结果里有、追剧日历里没有」这种自相矛盾。
 */
export function useSelectedSources(): SourceConfig[] {
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const sourceHealth = useAppStore((s) => s.sourceHealth);
  const subscriptions = useAppStore((s) => s.subscriptions);

  return useMemo(() => {
    const seen = new Set<string>();
    return selectedKeys
      .map((key) => resolveSource({ customAPIs, envSources }, key))
      .filter((s): s is NonNullable<typeof s> => {
        if (!s || !validateSourceUrl(s.url) || seen.has(s.key)) return false;
        seen.add(s.key);
        return true;
      })
      .filter((s) => !isSourceDisabled({ sourceHealth }, s.key))
      .filter((s) => !isInDisabledSubscription({ subscriptions }, s.key));
  }, [customAPIs, envSources, selectedKeys, sourceHealth, subscriptions]);
}
