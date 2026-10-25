import type { NextConfig } from 'next';
import fs from 'node:fs';
import path from 'node:path';

/** 版本号以 package.json 为单一来源，构建时注入 process.env.APP_VERSION（/api/status 使用） */
function readAppVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const nextConfig: NextConfig = {
  // 本机环境缺 @eslint/eslintrc（扁平配置依赖未随 pnpm 提升），构建期跳过 ESLint；
  // 类型检查仍然保留（tsc 由 build 强制执行），lint 需要时单独跑 `next lint`。
  eslint: { ignoreDuringBuilds: true },
  // standalone 输出仅供 Docker 镜像构建使用（DOCKER_BUILD=1）；
  // 本地 next start 在 standalone 模式下不受支持，故按环境切换
  output: process.env.DOCKER_BUILD === '1' ? 'standalone' : undefined,
  reactStrictMode: true,
  env: { APP_VERSION: readAppVersion() },
  // 采集站/豆瓣等上游地址在运行时由用户配置，构建期无法枚举，关闭图片优化改用 <img>
  images: { unoptimized: true },
  /**
   * 短剧专区：本机 hongguo-web 服务（127.0.0.1:8000）同源转发到 /hg-api/*。
   * 这样浏览器只跟 8080 打交道：不用额外开端口、不撞 CORS，局域网设备也能用。
   */
  async rewrites() {
    const base = process.env.HONGGUO_API || 'http://127.0.0.1:8000';
    return [
      {
        source: '/hg-api/:path*',
        destination: `${base}/:path*`,
      },
    ];
  },
};

export default nextConfig;
