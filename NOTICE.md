# 第三方声明 / Third-Party Notices

本项目（lihongguotv Desktop）在以下开源项目基础上构建，遵循各自的许可协议。

## 1. LibreSpark/LibreTV — AGPL-3.0

- 仓库：https://github.com/LibreSpark/LibreTV
- 许可：GNU Affero General Public License v3.0
- 使用范围：`app/` 目录下的 Next.js 应用整体派生自该项目；本项目对其做了以下修改：
  - 新增红果短剧专区（`app/src/app/hongguo/`）
  - 新增观看历史同步接口（`app/src/app/api/history/`）
  - 首页海报墙与播放器控制条改造、`/hg-api/*` 反向代理转发
- 依据 AGPL-3.0，本仓库完整包含上述修改后的源码；分发二进制时请一并提供本仓库源码。

## 2. sunnysky123/hongguo-web — MIT

- 仓库：https://github.com/sunnysky123/hongguo-web
- 许可：MIT License, Copyright (c) 2026 sunnysky123
- 使用范围：作为**运行时依赖**由用户自行下载/由 `tools/update.ps1` 拉取，**不随本仓库分发**。
- 本项目对该项目打了一个补丁（透传 `content_type` 字段），补丁脚本与说明见 `hongguo/`。
  补丁仅新增两行赋值，不改变原项目许可与版权声明。

## 3. ArtPlayer — MIT

- 仓库：https://github.com/zhw2590582/ArtPlayer
- 通过 npm 依赖引入（`app/package.json`）

## 4. hls.js — Apache-2.0

- 仓库：https://github.com/video-dev/hls.js
- 通过 npm 依赖引入

## 5. Node.js — MIT

- 站点：https://nodejs.org/
- 打包产物中包含 Node.js 运行时（`runtime/node.exe` 或 macOS 版 `node`），其许可文本随官方发行包提供。

## 6. FFmpeg — LGPL-2.1+ / GPL（取决于构建）

- 站点：https://ffmpeg.org/
- 本项目使用 BtbN 的 Windows GPL 构建与 macOS 静态构建，仅用于视频转码（HEVC → H.264）。
- 相关许可文本见 https://ffmpeg.org/legal.html 。

## 7. Inno Setup — 修改版 zlib/libpng 许可

- 站点：https://jrsoftware.org/isinfo.php
- 仅用于生成 Windows 安装程序（构建期工具，不进入产物）。

---

如果你的使用场景需要更宽松的许可（例如闭源分发），请注意本项目整体受 AGPL-3.0 约束。
