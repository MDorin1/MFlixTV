'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';

/**
 * 首页搜索框下方的「热门搜索」胶囊。
 *
 * 从 kanju.ai 抄的取向：胶囊不是「分类入口」，而是**搜索建议**——
 * 点一下就直接开搜，省掉用户从分类里猜关键词这一步（见 REPORT-kanju-home.md §3.1）。
 * 词语来自热播剧榜（服务端缓存 1 小时），不额外打豆瓣。
 */
export function HotSearchChips({
  onPick,
  max = 8,
}: {
  onPick: (word: string) => void;
  max?: number;
}) {
  const { data } = useQuery({
    queryKey: ['hot-chips'],
    queryFn: async () => {
      try {
        const r = await api.hotList('baidu_teleplay');
        if (r.items?.length) return r.items.map((i) => i.title).filter(Boolean);
      } catch {
        /* 百度榜不可用时退回豆瓣电影周榜 */
      }
      try {
        const r = await api.hotList('douban_movie_weekly');
        return r.items.map((i) => i.title).filter(Boolean);
      } catch {
        return [];
      }
    },
    staleTime: 30 * 60_000,
  });

  const words = (data ?? []).slice(0, max);
  if (words.length === 0) return null;

  return (
    <div className="mt-3 flex max-w-2xl flex-wrap items-center justify-center gap-1.5">
      <span className="mr-0.5 text-[11.5px] text-faint">热门搜索</span>
      {words.map((w) => (
        <button
          key={w}
          type="button"
          onClick={() => onPick(w)}
          className="chip border border-line/80 bg-chip/50 px-2.5 py-1 text-[12px] text-muted transition-colors hover:border-accent/60 hover:bg-accent/10 hover:text-content"
          title={`搜索「${w}」`}
        >
          {w}
        </button>
      ))}
    </div>
  );
}
