# 打包手册

仓库只放**源码与打包脚本**，安装包（`.exe` / `.zip`）作为 Release 附件分发。

打包机的必备件：

| 工具 | 用途 | 备注 |
| --- | --- | --- |
| Node.js 22 | 构建 Next.js + 充当内置运行时 | 便携包直接把 `node.exe` 塞进去 |
| ffmpeg | 短剧转码 | 只需要可执行文件 |
| .NET Framework `csc.exe` | 编译托盘启动器 | Windows 自带：`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` |
| Inno Setup 6 | 出 Windows 安装包 | 需要中文语言包 `ChineseSimplified.isl` |

---

## Windows 安装包

### 1) 组装便携目录

```powershell
powershell -ExecutionPolicy Bypass -File packaging\build-portable.ps1 `
  -Out D:\Build\MFlixTV\stage `
  -NodeExe D:\Tools\nodejs\node.exe `
  -FfmpegBin D:\Tools\ffmpeg\bin `
  -HongguoDir ..\hongguo-web
```

脚本做的事：

1. `npm ci` + `next build`（**要 devDependencies**，别用 `--omit=dev`）
2. 复制 `.next`（去掉 `.next\cache`，运行时用不到但占一半体积）、`node_modules`、`public`、`next.config.mjs`
3. 生成中性 `.env`：`PASSWORD=MFlixTV`、`PROXY_SECRET=MFlixTV-secret`
4. 复制短剧内核并**自动重打 `content_type` 补丁**，删掉 `apikeys.json`（首次启动自动生成，不该带别人的设备身份）
5. 复制 `node.exe`、`ffmpeg.exe`、`tools\update.ps1`、启动器源码与图标、使用说明

> 便携目录里 `next.config.mjs` 是**手写的 mjs**，不是仓库里的 `next.config.ts` —— 运行时没有 TypeScript，Next 会试图自动装 typescript 然后失败。

### 2) 编译托盘启动器

```powershell
csc /target:winexe /out:D:\Build\MFlixTV\stage\MFlixTV.exe `
    /win32icon:packaging\app.ico `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll `
    packaging\Launcher.cs
```

放 `stage\` 根目录（不是 `stage\launcher\`）——`Launcher.cs` 里按相对自身路径找 `runtime\node.exe` 和 `app\`。

### 3) 出安装包

```powershell
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" packaging\MFlixTV.iss
```

产物：`dist\MFlixTV-Setup-<版本>.exe`。`MFlixTV.iss` 里 `Source: "stage\*"` 是相对 `packaging\` 解析的，所以要么把 stage 放在 `packaging\stage`，要么改 `OutputDir` / `Source` —— 当前仓库默认在 `packaging\` 同级运行，`stage` 路径写死在 iss 里，最省事的做法是：

```powershell
# 在 D:\Build\MFlixTV 下，stage 与 packaging 同级
cd D:\Build\MFlixTV
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" packaging\MFlixTV.iss
```

### 版本号

改两处：`packaging/MFlixTV.iss` 的 `MyAppVersion`、`app/package.json` 的 `version`。安装包文件名跟着 iss 走。

### 别打进安装包的东西

`build-portable.ps1` 只挑白名单文件，但改脚本时注意别把下面这些带进去：

- `app\.env`（只放中性默认值，绝不能是开发机真密码）
- `app\.data\`（观看历史 JSON）
- `hongguo\server\config\apikeys.json`（设备身份 + 管理口令）
- `hongguo\server\stream-cache\`（转码缓存，几百 MB）
- `logs\`、`*.log`、`src.bak-*`（iss 的 `Excludes` 只管 `*.log,*.cs`，别的靠组装脚本不复制）

---

## macOS 便携包（Intel + Apple 芯片一个包）

macOS 上不做 `.app`/`.dmg`（那需要 Apple 开发者签名与公证），发的是**解压即用的目录 + 启动脚本**。

### 目录结构

```
MFlixTV-macOS/
├── app/                    Next.js 生产产物（.next + node_modules + public + .env + next.config.mjs）
├── hongguo/                短剧内核（server/src + server/config + web，已打补丁，无 apikeys.json）
├── runtime/
│   ├── node-arm64          node 22 darwin-arm64（Apple 芯片）
│   ├── node-x64            node 22 darwin-x64（Intel）
│   └── ffmpeg/
│       ├── ffmpeg-arm64    ffmpeg 静态构建（arm64）
│       └── ffmpeg-x64      ffmpeg 静态构建（x86_64）
├── 启动MFlixTV.command      启动脚本：按 uname -m 选运行时，起 8000 + 8080 再开浏览器
├── 使用说明.txt
├── LICENSE / NOTICE.md / LICENSES/ / 合规与免责.md
```

### 一条命令出包

```powershell
powershell -ExecutionPolicy Bypass -File packaging\build-macos.ps1 `
    -Stage packaging\stage -Out D:\Build\mac\root -Dist D:\Build\dist\MFlixTV-macOS.zip `
    -NodeArmDir D:\Build\mac\dl\node-arm -NodeX64Dir D:\Build\mac\dl\node-x64 `
    -FfmpegArm D:\Build\mac\dl\ffmpeg-arm64 -FfmpegX64 D:\Build\mac\dl\ffmpeg-x64
```

脚本做的事：清空输出目录 → 从 `stage` 复制 `app/`、`hongguo/` → 剪掉用不上的
`@next/swc-win32-x64-msvc`、`@img/sharp-win32-x64`（省 170MB）→ 放两套运行时、启动脚本、说明、许可 →
`python packaging\zip-macos.py` 写带 `external_attr` 的 zip（可执行位 0755、其余 0644）。
实测载荷 **11,727 个文件 / 548.7 MB**，zip **172.3 MB**。

### 运行时来源（Windows 上直接下，不用 Mac）

| 组件 | 地址 |
| --- | --- |
| Node arm64 | `https://nodejs.org/dist/v22.20.0/node-v22.20.0-darwin-arm64.tar.gz`（取 `bin/node`，改名 `node`） |
| Node x64 | `https://nodejs.org/dist/v22.20.0/node-v22.20.0-darwin-x64.tar.gz` |
| ffmpeg arm64 | `https://www.osxexperts.net/ffmpeg7arm.zip` |
| ffmpeg x64 | `https://www.osxexperts.net/ffmpeg71intel.zip` |

> evermeet.cx 已下线（返回 410，`API endpoint removed due to exorbitant abuse`），别再当来源。
> 下完用 `Get-Content -Encoding Byte ... 0..3` 或 `otool`/`file` 核对架构：Mach-O 的
> `CPUFAMILY_ARM64` 与 `x86_64` 不能混，arm64 包放进 x64 机器会报 `Bad CPU type`。

### 三个坑

- **可执行位**：`Compress-Archive` 写出的条目 `external_attr` 全是 0，解压后 `.command` 双击没反应、
  `runtime/node-*` 也起不来。所以必须用 `packaging\zip-macos.py`（`create_system=3` + 0755）。
- **`.command` 必须是 LF**：CRLF 会让 macOS 报 `bad interpreter: /bin/bash^M`。
  `.gitattributes` 已强制 `*.command text eol=lf`，`build-macos.ps1` 里还会再转一次。
- **`.ps1` 要带 UTF-8 BOM**：Windows PowerShell 5.1 读无 BOM 的 `.ps1` 会按 GBK 解，中文注释与字符串直接
  解析报错（`Unexpected token`）。仓库里的 `.ps1` 全部带 BOM。

### 关于架构

一个包同时出 arm64 与 x86_64，启动脚本 `uname -m` 自动选，不做两个包。真机验证只能在 Mac 上做
（Windows 只能验结构与二进制架构，不能验运行），发包前建议找一台 M 芯片 + 一台 Intel 各跑一次。

---


## 发布前验收清单

装完先过一遍，别只看「能打开」：

1. 双击图标 → 托盘出现图标 → 浏览器自动开 `http://localhost:8080`
2. 用 `MFlixTV` 登录成功
3. 首页有豆瓣推荐卡片（说明外网接口通）
4. 搜索一个片名 → 有结果 → 能起播（说明点播源可用）
5. 短剧专区 → 真人剧 / 漫剧 各进一次 → 卡片体裁不串（说明补丁生效）
6. 短剧随便一集起播（首次 10–20 秒）→ 播到 30 秒 → 退出 → 重进 → 回到 30 秒附近
7. 托盘 →「检查更新」→ 日志 `logs\update.log` 有输出、服务能自动重启
8. 退出托盘 → 进程清干净（任务管理器里没有残留 `node.exe`）
