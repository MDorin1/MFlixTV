// 打包用的运行时配置（等价于 app/next.config.ts）。
//
// 为什么单独放一份 .mjs：安装版运行时只有 node + 构建产物，没有 TypeScript，
// Next 发现 next.config.ts 会尝试自动安装 typescript 然后失败。
import fs from 'node:fs';
import path from 'node:path';

function readAppVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const nextConfig = {
  eslint: { ignoreDuringBuilds: true },
  output: process.env.DOCKER_BUILD === '1' ? 'standalone' : undefined,
  reactStrictMode: true,
  env: { APP_VERSION: readAppVersion() },
  images: { unoptimized: true },
  async rewrites() {
    const base = process.env.HONGGUO_API || 'http://127.0.0.1:8000';
    return [{ source: '/hg-api/:path*', destination: `${base}/:path*` }];
  },
};

export default nextConfig;