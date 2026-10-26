'use client';

import { useEffect, useState } from 'react';
import { isFavorite, toggleFavorite, type FavoriteItem } from '@/lib/favorites';
import { useToast } from './toast';
import { cn } from '@/lib/utils';

/**
 * 收藏按钮（「＋ 我的清单」/「✓ 已在清单」）。
 * 资料页两处（豆瓣、采集源）共用；样式跟着资料页的黑底走，不用主题 token。
 */
export function FavoriteButton({
  item,
  className,
}: {
  item: Omit<FavoriteItem, 'ts'>;
  className?: string;
}) {
  const { toast } = useToast();
  const [on, setOn] = useState(false);

  useEffect(() => {
    setOn(isFavorite(item.key));
  }, [item.key]);

  return (
    <button
      type="button"
      onClick={() => {
        const next = toggleFavorite(item);
        setOn(next);
        toast(next ? '已加入我的清单' : '已从清单移除', next ? 'success' : 'info');
      }}
      aria-pressed={on}
      title={on ? '从我的清单移除' : '加入我的清单'}
      className={cn(
        'inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-[15px] font-semibold transition-colors',
        on
          ? 'bg-white/25 text-white hover:bg-white/30'
          : 'bg-white/15 text-white/90 backdrop-blur hover:bg-white/25',
        className
      )}
    >
      {on ? (
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden>
          <path d="m5 13 4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden>
          <path d="M12 5v14M5 12h14" strokeLinecap="round" />
        </svg>
      )}
      {on ? '已在清单' : '我的清单'}
    </button>
  );
}
