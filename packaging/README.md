# 打包手册

仓库只放**源码与打包脚本**，安装包（`.exe` / `.zip`）作为 Release 附件分发。

打包机的必备件：

| 工具 | 用途 | 备注 |
| --- | --- | --- |
| Node.js 22 | 构建 Next.js + 充当内置运行时 | 便携包直接把 `node.exe` 塞进去 |
| ffmpeg | 红果转码 | 只需要可执行文件 |
| .NET Framework `csc.exe` | 编译托盘启动器 | Windows 自带：`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` |
| Inno Setup 6 | 出 Windows 安装包 | 需要中文语言包 `ChineseSimplified.isl` |

---

## Windows 安装包

### 1) 组装便携目录

```powershell
powershell -ExecutionPolicy Bypass -File packaging\build-portable.ps1 `
  -Out D:\Build\lihongguotv\stage `
  -NodeExe D:\Tools\nodejs\node.exe `
  -FfmpegBin D:\Tools\ffmpeg\bin `
  -HongguoDir ..\hongguo-web
```

脚本做的事：

1. `npm ci` + `next build`（**要 devDependencies**，别用 `--omit=dev`）
2. 复制 `.next`（去掉 `.next\cache`，运行时用不到但占一半体积）、`node_modules`、`public`、`next.config.mjs`
3. 生成中性 `.env`：`PASSWORD=lihongguotv`、`PROXY_SECRET=lihongguotv-desktop-secret`
4. 复制红果内核并**自动重打 `content_type` 补丁**，删掉 `apikeys.json`（首次启动自动生成，不该带别人的设备身份）
5. 复制 `node.exe`、`ffmpeg.exe`、`tools\update.ps1`、启动器源码与图标、使用说明

> 便携目录里 `next.config.mjs` 是**手写的 mjs**，不是仓库里的 `next.config.ts` —— 运行时没有 TypeScript，Next 会试图自动装 typescript 然后失败。

### 2) 编译托盘启动器

```powershell
csc /target:winexe /out:D:\Build\lihongguotv\stage\lihongguotv.exe `
    /win32icon:packaging\app.ico `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll `
    packaging\Launcher.cs
```

放 `stage\` 根目录（不是 `stage\launcher\`）——`Launcher.cs` 里按相对自身路径找 `runtime\node.exe` 和 `app\`。

### 3) 出安装包

```powershell
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" packaging\lihongguotv.iss
```

产物：`dist\lihongguotv-Setup-<版本>.exe`。`lihongguotv.iss` 里 `Source: "stage\*"` 是相对 `packaging\` 解析的，所以要么把 stage 放在 `packaging\stage`，要么改 `OutputDir` / `Source` —— 当前仓库默认在 `packaging\` 同级运行，`stage` 路径写死在 iss 里，最省事的做法是：

```powershell
# 在 D:\Build\lihongguotv 下，stage 与 packaging 同级
cd D:\Build\lihongguotv
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" packaging\lihongguotv.iss
```

### 版本号

改两处：`packaging/lihongguotv.iss` 的 `MyAppVersion`、`app/package.json` 的 `version`。安装包文件名跟着 iss 走。

### 别打进安装包的东西

`build-portable.ps1` 只挑白名单文件，但改脚本时注意别把下面这些带进去：

- `app\.env`（只放中性默认值，绝不能是开发机真密码）
- `app\.data\`（观看历史 JSON）
- `hongguo\server\config\apikeys.json`（设备身份 + 管理口令）
- `hongguo\server\stream-cache\`（转码缓存，几百 MB）
- `logs\`、`*.log`、`src.bak-*`（iss 的 `Excludes` 只管 `*.log,*.cs`，别的靠组装脚本不复制）

---

## macOS 便携包（arm64）

macOS 上不做 `.app`/`.dmg`（那需要签名与公证），发的是**解压即用的目录 + 启动脚本**。

### 目录结构

```
lihongguotv-macOS-arm64/
├── app/                  Next.js 生产产物（.next + node_modules + public + .env + next.config.mjs）
├── hongguo/              红果内核（server/src + server/config + web，已打补丁，无 apikeys.json）
├── runtime/
│   ├── node              node 22 darwin-arm64 可执行文件
│   └── ffmpeg/ffmpeg     ffmpeg 静态构建（arm64）
├── 启动lihongguotv.command    启动脚本
└── 使用说明.txt
```

### 步骤

1. **准备 macOS 版运行时**（在 Windows 上就能下，不用 Mac）
   - node：`https://nodejs.org/dist/v22.20.0/node-v22.20.0-darwin-arm64.tar.gz` → 取 `bin/node`
   - ffmpeg：任一 macOS arm64 静态构建（arm64 原生，别用 x64 的转译版）
   - 两个文件都要**保留可执行位**：在 macOS 上 `chmod +x runtime/node runtime/ffmpeg/ffmpeg`
2. **复制 Windows 同名产物**：`app/`、`hongguo/` 的目录结构与 Windows 便携目录一致，直接把 `stage` 里的这两块拷过来，再换成 mac 的 `runtime/`
3. **放启动脚本与说明**：`packaging/启动lihongguotv.command`、`packaging/使用说明-macOS.txt`（改名成 `使用说明.txt`）
4. **压 zip**

```powershell
Compress-Archive -Path D:\Build\lihongguotv-mac-arm64\* -DestinationPath D:\Build\dist\lihongguotv-macOS-arm64.zip -CompressionLevel Optimal
```

> **两个坑**
> - `.command` 和 `runtime/node` 的可执行位在 Windows 上打的 zip 里会丢，所以 `使用说明.txt` 第一段就是让用户 `chmod +x`，或者右键→打开绕过 Gatekeeper。
> - `.command` 必须是 **LF** 换行。用 CRLF 保存的话 macOS 会报 `bad interpreter: /bin/bash^M`。仓库里 `.gitattributes` 已强制 `*.command text eol=lf`。

### 关于架构

当前只出 arm64（Apple 芯片）。x64 版把运行时换成 `darwin-x64` 的两个二进制、目录名改成 `lihongguotv-macOS-x64` 即可，`启动lihongguotv.command` 不用改。

---

## 发布前验收清单

装完先过一遍，别只看「能打开」：

1. 双击图标 → 托盘出现图标 → 浏览器自动开 `http://localhost:8080`
2. 用 `lihongguotv` 登录成功
3. 首页有豆瓣推荐卡片（说明外网接口通）
4. 搜索一个片名 → 有结果 → 能起播（说明点播源可用）
5. 红果短剧 → 真人剧 / 漫剧 各进一次 → 卡片体裁不串（说明补丁生效）
6. 红果随便一集起播（首次 10–20 秒）→ 播到 30 秒 → 退出 → 重进 → 回到 30 秒附近
7. 托盘 →「检查更新」→ 日志 `logs\update.log` 有输出、服务能自动重启
8. 退出托盘 → 进程清干净（任务管理器里没有残留 `node.exe`）
