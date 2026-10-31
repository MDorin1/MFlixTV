import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '遥控器',
  // 手机扫码打开的纯工具页：别被搜索引擎收进去，也不需要 manifest
  robots: { index: false, follow: false },
};

export default function RcLayout({ children }: { children: React.ReactNode }) {
  return children;
}
