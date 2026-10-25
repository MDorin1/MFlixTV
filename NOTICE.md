# 第三方声明 / Third-Party Notices

`lihongguotv Desktop` 在以下项目基础上构建。各组件的版权归其各自作者所有，本项目按各自许可使用。

本文件只做**归属与许可声明**，不构成对任何第三方内容的授权。若你是某个组件的权利人并认为本项目的使用方式不当，请通过仓库 Issue 联系。

---

## 1. LibreSpark/LibreTV — AGPL-3.0

- 仓库：https://github.com/LibreSpark/LibreTV
- 许可：GNU Affero General Public License v3.0（全文见仓库根目录 [LICENSE](LICENSE)）
- 使用范围：`app/` 下的 Next.js 应用整体派生自该项目，本项目对其做了以下修改：
  - 新增短剧专区页面（`app/src/app/hongguo/`）
  - 新增观看历史同步接口（`app/src/app/api/history/`）
  - 首页海报墙、播放器控制条改造，`/hg-api/*` 同源转发
- **AGPL-3.0 第 13 条**：通过网络使用本软件的用户有权获得对应源码。本仓库即修改后的完整源码。

## 2. sunnysky123/hongguo-web — MIT

- 仓库：https://github.com/sunnysky123/hongguo-web
- 许可：MIT License，Copyright (c) 2026 sunnysky123（全文见 [LICENSES/MIT-hongguo-web.txt](LICENSES/MIT-hongguo-web.txt)）
- 使用方式：
  - **本仓库不包含其源码**，只提供补丁脚本与说明（`hongguo/`）。开发者自行 `git clone` 使用。
  - **发布的安装包内含其运行时源码**（`hongguo/server/src`、`hongguo/web`），以便离线可用；按 MIT 要求，安装包内同时附带上述许可全文（`LICENSES/MIT-hongguo-web.txt`）。
  - 本项目对其打了一个补丁（透传 `content_type` 字段），仅新增两行赋值，不改变其许可与版权声明。

## 3. 运行时与构建产物

| 组件 | 版本 | 许可 | 说明 |
| --- | --- | --- | --- |
| Node.js | 22.20.0 | MIT | 随包提供可执行文件；全文见 [LICENSES/Node.js.txt](LICENSES/Node.js.txt) |
| FFmpeg | Windows / macOS 静态构建 | LGPL-2.1-or-later 或 GPL（取决于构建） | 仅用于本地视频格式转换；见 [LICENSES/FFmpeg.txt](LICENSES/FFmpeg.txt) |
| Inno Setup | 6.x | 修改版 zlib/libpng | 仅构建期使用，不进入产物 |

> **关于 FFmpeg**：随包使用的是启用了 GPL 组件的静态构建。如果你再分发本安装包，请遵守 GPL 的相应义务（提供对应源码或书面要约）。对应源码：https://ffmpeg.org/download.html 与 https://github.com/BtbN/FFmpeg-Builds

## 4. npm 依赖（随 `app/` 一同分发）

| 包 | 版本 | 许可 |
| --- | --- | --- |
| next | 15.5.28 | MIT |
| react / react-dom | 19.3.1 | MIT |
| zustand | 5.0.16 | MIT |
| @tanstack/react-query | 5.x | MIT |
| @tanstack/react-virtual | 3.x | MIT |
| artplayer | 5.4.0 | MIT |
| hls.js | 1.7.3 | Apache-2.0 |
| mpegts.js | 1.8.2 | Apache-2.0 |
| mux.js | 6.3.0 | Apache-2.0 |
| dexie / dexie-react-hooks | 4.x / 1.x | Apache-2.0 |

完整的依赖树与版本以 `app/package-lock.json` 为准；每个包的许可文本随其 npm 包一同存在于 `app/node_modules/<包名>/LICENSE*`。

## 5. 开发期工具（不进入产物）

ESLint、TypeScript、Tailwind CSS、PostCSS、Vitest 等仅用于开发与构建，不随安装包分发，各自遵循其开源许可。

---

## 关于第三方名称与商标

本项目在文档中会提及第三方平台、产品或数据源的名称，**仅用于客观说明数据结构与来源**。这些名称与商标归其各自所有者，本项目与其不存在隶属、合作、赞助或授权关系，也不代表其认可本项目。
