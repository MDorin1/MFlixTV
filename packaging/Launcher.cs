using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace MFlixTVLauncher
{
    /// <summary>
    /// MFlixTV 桌面启动器：
    ///  1) 拉起短剧专区服务（Node，127.0.0.1:8000，带 ffmpeg 转码环境）
    ///  2) 拉起 MFlixTV 主站（Node + Next，127.0.0.1:8080）
    ///  3) 等端口就绪后用默认浏览器打开
    ///  4) 常驻托盘：打开页面 / 检查更新 / 退出
    /// </summary>
    static class Program
    {
        static string baseDir;
        static string nodeExe;
        static Process hongguoProc;
        static Process webProc;
        static NotifyIcon tray;
        static bool shuttingDown;
        static MenuItem statusItem;
        static MenuItem startItem;
        static MenuItem stopItem;
        static MenuItem restartItem;
        static System.Windows.Forms.Timer statusTimer;
        static bool busy;

        [STAThread]
        static void Main()
        {
            bool created;
            using (Mutex mutex = new Mutex(true, "MFlixTV.Desktop.SingleInstance", out created))
            {
                if (!created)
                {
                    OpenBrowser("http://localhost:8080");
                    return;
                }

                baseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
                nodeExe = Path.Combine(baseDir, @"runtime\node.exe");

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                BuildTray();
                ThreadPool.QueueUserWorkItem(delegate { Boot(true); });
                Application.Run();
            }
        }

        static void BuildTray()
        {
            tray = new NotifyIcon();
            try
            {
                string ico = Path.Combine(baseDir, @"launcher\app.ico");
                tray.Icon = File.Exists(ico) ? new Icon(ico) : SystemIcons.Application;
            }
            catch { tray.Icon = SystemIcons.Application; }
            tray.Text = "MFlixTV 影视站";
            tray.Visible = true;

            ContextMenu menu = new ContextMenu();

            statusItem = new MenuItem("状态：检测中…");
            statusItem.Enabled = false;
            menu.MenuItems.Add(statusItem);
            menu.MenuItems.Add("-");

            menu.MenuItems.Add("打开 MFlixTV（全屏窗口）", delegate { OpenOrStart(""); });
            menu.MenuItems.Add("打开短剧专区（全屏窗口）", delegate { OpenOrStart("/hongguo"); });
            menu.MenuItems.Add("用普通浏览器打开", delegate { OpenOrStartPlain(""); });
            menu.MenuItems.Add("-");

            startItem = new MenuItem("启动服务", delegate { Queue(delegate { Boot(false); }); });
            stopItem = new MenuItem("停止服务", delegate { Queue(delegate { StopAll(true); }); });
            restartItem = new MenuItem("重启服务", delegate { Queue(delegate { StopAll(false); Boot(false); }); });
            menu.MenuItems.Add(startItem);
            menu.MenuItems.Add(stopItem);
            menu.MenuItems.Add(restartItem);
            menu.MenuItems.Add("-");

            menu.MenuItems.Add("复制访问密码", delegate { CopyPassword(); });
            menu.MenuItems.Add("复制局域网地址", delegate { CopyLanUrl(); });
            menu.MenuItems.Add("打开安装目录", delegate { OpenFolder(baseDir); });
            menu.MenuItems.Add("查看更新日志", delegate { OpenText(Path.Combine(baseDir, @"logs\update.log")); });
            menu.MenuItems.Add("-");
            menu.MenuItems.Add("检查更新（短剧内核 + 点播源）", delegate { RunUpdater(); });
            menu.MenuItems.Add("-");
            menu.MenuItems.Add("退出（并停止服务）", delegate { Shutdown(); });

            menu.Popup += delegate { RefreshMenu(); };
            tray.ContextMenu = menu;
            tray.DoubleClick += delegate { OpenOrStart(""); };

            statusTimer = new System.Windows.Forms.Timer();
            statusTimer.Interval = 4000;
            statusTimer.Tick += delegate { RefreshStatusText(); };
            statusTimer.Start();
        }

        /// <summary>把两个服务拉起来；openBrowser 控制是否自动开浏览器</summary>
        static void Boot(bool openBrowser)
        {
            if (busy) return;
            busy = true;
            try
            {
                SetStatus("正在启动…");

                if (!PortOpen(8000))
                {
                    StartHongguo();
                    WaitPort(8000, 25000);
                }

                if (!PortOpen(8080))
                {
                    StartWeb();
                    if (!WaitPort(8080, 45000))
                    {
                        tray.ShowBalloonTip(5000, "MFlixTV", "主站启动超时，请查看 logs\\web.log", ToolTipIcon.Error);
                        return;
                    }
                }

                SetStatus("运行中");
                if (openBrowser) OpenBrowser("http://localhost:8080");
                tray.ShowBalloonTip(4000, "MFlixTV",
                    openBrowser ? "已启动：正在打开全屏窗口 http://localhost:8080" : "服务已启动，可从托盘打开网页",
                    ToolTipIcon.Info);
            }
            catch (Exception ex)
            {
                tray.ShowBalloonTip(6000, "MFlixTV 启动失败", ex.Message, ToolTipIcon.Error);
            }
            finally
            {
                busy = false;
                RefreshStatusText();
            }
        }

        static void Queue(ThreadStart work)
        {
            ThreadPool.QueueUserWorkItem(delegate { work(); });
        }

        /// <summary>打开网页：没起就先拉起再开（默认走全屏应用窗口）</summary>
        static void OpenOrStart(string subPath)
        {
            OpenUrl("http://localhost:8080" + subPath, true);
        }

        /// <summary>托盘里的「用普通浏览器打开」：带地址栏的正常窗口</summary>
        static void OpenOrStartPlain(string subPath)
        {
            OpenUrl("http://localhost:8080" + subPath, false);
        }

        static void OpenUrl(string url, bool fullscreenWindow)
        {
            if (PortOpen(8080)) { OpenBrowser(url, fullscreenWindow); return; }
            OpenBrowser(url, fullscreenWindow);
            Queue(delegate { Boot(false); });
        }

        /// <summary>停掉两个服务（自己也兜底清掉遗留的 node 进程）</summary>
        static void StopAll(bool notify)
        {
            if (busy) return;
            busy = true;
            try
            {
                SetStatus("正在停止…");
                KillProc(webProc);
                KillProc(hongguoProc);
                KillOrphanNodes();
                webProc = null;
                hongguoProc = null;
                WaitPortClosed(8080, 8000, 8000);
            }
            finally
            {
                busy = false;
                RefreshStatusText();
                if (notify)
                    tray.ShowBalloonTip(3000, "MFlixTV",
                        PortOpen(8080) ? "还在运行（可能是别的程序占用 8080）" : "服务已停止", ToolTipIcon.Info);
            }
        }

        /// <summary>杀掉用本包 runtime\node.exe 跑起来的遗留进程（上次异常退出等）</summary>
        static void KillOrphanNodes()
        {
            try
            {
                string self = Path.GetFullPath(nodeExe).ToLowerInvariant();
                foreach (Process pr in Process.GetProcessesByName("node"))
                {
                    try
                    {
                        if (pr.Id == Process.GetCurrentProcess().Id) continue;
                        string path = null;
                        try { path = Path.GetFullPath(pr.MainModule.FileName).ToLowerInvariant(); } catch { }
                        if (path != null && path == self) KillProc(pr);
                    }
                    catch { }
                }
            }
            catch { }
        }

        static void WaitPortClosed(int timeoutMs, params int[] ports)
        {
            int waited = 0;
            while (waited < timeoutMs)
            {
                bool any = false;
                foreach (int p in ports) if (PortOpen(p)) { any = true; break; }
                if (!any) return;
                Thread.Sleep(300);
                waited += 300;
            }
        }

        static void RefreshMenu()
        {
            bool web = PortOpen(8080);
            bool hg = PortOpen(8000);
            try
            {
                statusItem.Text = "状态：" + (web ? "主站运行中" : "主站已停止")
                                + " · " + (hg ? "短剧运行中" : "短剧已停止");
                startItem.Enabled = !web || !hg;
                stopItem.Enabled = web || hg;
                restartItem.Enabled = web || hg;
            }
            catch { }
            RefreshStatusText();
        }

        static void RefreshStatusText()
        {
            bool web = PortOpen(8080);
            try { tray.Text = "MFlixTV 影视站 · " + (web ? "运行中 :8080" : "已停止（右键启动）"); }
            catch { }
        }

        static void StartHongguo()
        {
            string hgDir = Path.Combine(baseDir, "hongguo");
            string script = Path.Combine(hgDir, @"server\src\main.js");
            if (!File.Exists(script)) return;

            ProcessStartInfo psi = new ProcessStartInfo(nodeExe, "\"" + script + "\"");
            psi.WorkingDirectory = hgDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.EnvironmentVariables["PORT"] = "8000";
            psi.EnvironmentVariables["BIND_HOST"] = "127.0.0.1";
            psi.EnvironmentVariables["HG_TRANSCODE"] = "1";
            psi.EnvironmentVariables["HG_CACHE_MAX_FILES"] = "120";
            psi.EnvironmentVariables["HG_OPEN_BROWSER"] = "0";
            psi.EnvironmentVariables["PATH"] = Path.Combine(baseDir, @"runtime\ffmpeg") + ";" +
                                               Environment.GetEnvironmentVariable("PATH");
            try { hongguoProc = Process.Start(psi); }
            catch { /* 短剧服务起不来不影响主站 */ }
        }

        /// <summary>
        /// 运行时配置自愈：安装版必须带 app\.env，否则主站会提示「必须设置 PASSWORD」。
        /// 文件被误删 / 装的时候漏了，都在这里补一份默认的（密码 MFlixTV）。
        /// </summary>
        static void EnsureEnv()
        {
            try
            {
                string appDir = Path.Combine(baseDir, "app");
                string envPath = Path.Combine(appDir, ".env");
                if (File.Exists(envPath))
                {
                    string text = File.ReadAllText(envPath);
                    if (text.IndexOf("PASSWORD=", StringComparison.Ordinal) >= 0 &&
                        !System.Text.RegularExpressions.Regex.IsMatch(text, @"(?m)^PASSWORD=\s*$"))
                        return;
                }
                Directory.CreateDirectory(appDir);
                string seed = "PASSWORD=MFlixTV" + Environment.NewLine +
                              "PROXY_SECRET=MFlixTV-secret" + Environment.NewLine +
                              "DEFAULT_RECOMMEND_SOURCE=douban" + Environment.NewLine;
                File.WriteAllText(envPath, seed, new UTF8Encoding(false));
                try { tray.ShowBalloonTip(4000, "MFlixTV", "已生成默认配置（密码 MFlixTV），可在 app\\.env 里修改", ToolTipIcon.Info); }
                catch { }
            }
            catch { }
        }

        /// <summary>
        /// 首页健康检查：端口通但返回 404，多半是装到别的盘后 .next 没就位、
        /// 或者 8080 被上一个残留实例占着（那个实例指向旧目录，所以页面 404）。
        /// </summary>
        static bool WebHealthy()
        {
            try
            {
                using (var wc = new System.Net.WebClient())
                {
                    wc.Headers.Add("User-Agent", "MFlixTV-Launcher");
                    string body = wc.DownloadString("http://127.0.0.1:8080/api/status");
                    return body.Contains("version");
                }
            }
            catch { return false; }
        }

        static void StartWeb()
        {
            string appDir = Path.Combine(baseDir, "app");
            EnsureEnv();
            string nextBin = Path.Combine(appDir, @"node_modules\next\dist\bin\next");
            if (!File.Exists(nextBin)) throw new Exception("缺少 app\\node_modules\\next，安装可能不完整");

            ProcessStartInfo psi = new ProcessStartInfo(nodeExe, "\"" + nextBin + "\" start -p 8080");
            psi.WorkingDirectory = appDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;

            string logDir = Path.Combine(baseDir, "logs");
            Directory.CreateDirectory(logDir);
            string logPath = Path.Combine(logDir, "web.log");
            // 装到非默认盘时空目录/权限问题最常见：每次启动把关键路径写进日志，出 404 能直接定位
            try
            {
                File.AppendAllText(logPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss ")
                    + "starting: base=" + baseDir + " app=" + appDir
                    + " next=" + (File.Exists(nextBin) ? "ok" : "MISSING")
                    + " nextBuild=" + (Directory.Exists(Path.Combine(appDir, ".next")) ? "ok" : "MISSING")
                    + " port8080=" + (PortOpen(8080) ? "busy" : "free") + Environment.NewLine, Encoding.UTF8);
            }
            catch { }

            webProc = new Process();
            webProc.StartInfo = psi;
            DataReceivedEventHandler sink = delegate(object s, DataReceivedEventArgs e)
            {
                if (e.Data == null) return;
                try { File.AppendAllText(logPath, DateTime.Now.ToString("HH:mm:ss ") + e.Data + Environment.NewLine, Encoding.UTF8); }
                catch { }
            };
            webProc.OutputDataReceived += sink;
            webProc.ErrorDataReceived += sink;
            webProc.Start();
            webProc.BeginOutputReadLine();
            webProc.BeginErrorReadLine();
        }

        /// <summary>每天第一次启动时后台跑一次"点播源体检 + 补新源"，不打扰用户</summary>
        static void MaybeAutoUpdateSources()
        {
            try
            {
                string stamp = Path.Combine(baseDir, @"logs\last-source-update.txt");
                Directory.CreateDirectory(Path.GetDirectoryName(stamp));
                if (File.Exists(stamp))
                {
                    DateTime last;
                    if (DateTime.TryParse(File.ReadAllText(stamp).Trim(), out last) &&
                        (DateTime.Now - last).TotalHours < 24) return;
                }
                string script = Path.Combine(baseDir, @"tools\update.ps1");
                if (!File.Exists(script)) return;
                ProcessStartInfo psi = new ProcessStartInfo("powershell.exe",
                    "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\" -Part sources -Silent");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                Process.Start(psi);
                File.WriteAllText(stamp, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
                tray.ShowBalloonTip(4000, "MFlixTV", "正在后台检查点播源（每天一次），完成后会提示", ToolTipIcon.Info);
            }
            catch { /* 自动更新失败不影响使用 */ }
        }

        /// <summary>托盘「检查更新」：调 tools\update.ps1，脚本结束会弹窗汇总</summary>
        static void RunUpdater()
        {
            try
            {
                string script = Path.Combine(baseDir, @"tools\update.ps1");
                if (!File.Exists(script))
                {
                    tray.ShowBalloonTip(4000, "MFlixTV", "找不到更新脚本 tools\\update.ps1", ToolTipIcon.Warning);
                    return;
                }
                ProcessStartInfo psi = new ProcessStartInfo("powershell.exe",
                    "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\" -Part all -Silent");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                Process.Start(psi);
                tray.ShowBalloonTip(5000, "MFlixTV", "正在检查更新（短剧内核 + 点播源），完成后会弹窗提示", ToolTipIcon.Info);
            }
            catch (Exception ex)
            {
                tray.ShowBalloonTip(5000, "MFlixTV", "更新启动失败：" + ex.Message, ToolTipIcon.Error);
            }
        }

        static void OpenText(string path)
        {
            try
            {
                if (File.Exists(path)) Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
                else tray.ShowBalloonTip(3000, "MFlixTV", "还没有更新记录", ToolTipIcon.Info);
            }
            catch { }
        }

        static bool WaitPort(int port, int timeoutMs)
        {
            int waited = 0;
            while (waited < timeoutMs)
            {
                if (PortOpen(port)) return true;
                Thread.Sleep(400);
                waited += 400;
            }
            return false;
        }

        static bool PortOpen(int port)
        {
            try
            {
                using (TcpClient c = new TcpClient())
                {
                    IAsyncResult ar = c.BeginConnect(IPAddress.Loopback, port, null, null);
                    if (!ar.AsyncWaitHandle.WaitOne(400)) return false;
                    c.EndConnect(ar);
                    return true;
                }
            }
            catch { return false; }
        }

        static void SetStatus(string text)
        {
            try { tray.Text = "MFlixTV 影视站 · " + text; } catch { }
        }

        static void OpenBrowser(string url)
        {
            OpenBrowser(url, true);
        }

        /// <summary>
        /// 打开页面。默认用 Edge / Chrome 的「应用窗口 + 全屏」打开，而不是直接
        /// <c>Process.Start(url)</c>。
        ///
        /// 为什么：遥控指令来自轮询，没有用户手势，浏览器的 <c>requestFullscreen()</c> 一定被拒，
        /// 页面只能退到网页全屏（CSS 铺满视口）。普通窗口里那意味着「视频铺满了窗口，窗口外面
        /// 还压着地址栏、标签栏和任务栏」——用户看到的就是「只是网页全屏」。
        /// 应用窗口一打开就是无边框全屏，网页全屏铺满的正是整块屏幕，遥控按一下就真的满屏了。
        /// 找不到 Edge / Chrome 才退回默认浏览器（那时页面会提示按 F 键进系统全屏）。
        /// </summary>
        static void OpenBrowser(string url, bool fullscreenWindow)
        {
            if (fullscreenWindow && TryOpenAppWindow(url)) return;
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
            catch { }
        }

        /// <summary>用 Edge / Chrome 的 app 模式开一个全屏无边框窗口</summary>
        static bool TryOpenAppWindow(string url)
        {
            foreach (string exe in AppBrowserCandidates())
            {
                try
                {
                    if (!File.Exists(exe)) continue;
                    ProcessStartInfo psi = new ProcessStartInfo(exe,
                        "--app=" + url + " --start-fullscreen --window-position=0,0" +
                        " --no-first-run --no-default-browser-check --disable-features=Translate");
                    psi.UseShellExecute = false;
                    Process.Start(psi);
                    return true;
                }
                catch { }
            }
            return false;
        }

        /// <summary>能当「应用窗口」用的浏览器，按装的概率排序</summary>
        static System.Collections.Generic.IEnumerable<string> AppBrowserCandidates()
        {
            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            yield return Path.Combine(pf86, @"Microsoft\Edge\Application\msedge.exe");
            yield return Path.Combine(pf, @"Microsoft\Edge\Application\msedge.exe");
            yield return Path.Combine(pf, @"Google\Chrome\Application\chrome.exe");
            yield return Path.Combine(pf86, @"Google\Chrome\Application\chrome.exe");
            yield return Path.Combine(local, @"Google\Chrome\Application\chrome.exe");
        }

        static void OpenFolder(string path)
        {
            try { Process.Start("explorer.exe", "\"" + path + "\""); } catch { }
        }

        /// <summary>取第一个私有网段 IPv4（192.168 / 10 / 172.16-31）</summary>
        static string GetLanIp()
        {
            string fallback = null;
            try
            {
                foreach (NetworkInterface ni in NetworkInterface.GetAllNetworkInterfaces())
                {
                    if (ni.OperationalStatus != OperationalStatus.Up) continue;
                    if (ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                    foreach (UnicastIPAddressInformation ua in ni.GetIPProperties().UnicastAddresses)
                    {
                        if (ua.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                        string ip = ua.Address.ToString();
                        if (ip.StartsWith("169.254.")) continue;
                        bool priv = ip.StartsWith("192.168.") || ip.StartsWith("10.") ||
                                    (ip.StartsWith("172.") && Is172Private(ip));
                        if (priv) return ip;
                        if (fallback == null) fallback = ip;
                    }
                }
            }
            catch { }
            return fallback;
        }

        static bool Is172Private(string ip)
        {
            string[] parts = ip.Split('.');
            if (parts.Length < 2) return false;
            int second;
            if (!int.TryParse(parts[1], out second)) return false;
            return second >= 16 && second <= 31;
        }

        static void CopyLanUrl()
        {
            string ip = GetLanIp();
            if (ip == null)
            {
                tray.ShowBalloonTip(4000, "MFlixTV", "没检测到局域网地址（是不是没连 WiFi / 网线）", ToolTipIcon.Warning);
                return;
            }
            string url = "http://" + ip + ":8080";
            try
            {
                Clipboard.SetText(url);
                tray.ShowBalloonTip(4000, "MFlixTV", "已复制：" + url, ToolTipIcon.Info);
            }
            catch { }
        }

        static void CopyPassword()
        {
            string pw = ReadPassword();
            try
            {
                Clipboard.SetText(pw);
                tray.ShowBalloonTip(3000, "MFlixTV", "访问密码已复制：" + pw, ToolTipIcon.Info);
            }
            catch { }
        }

        static string ReadPassword()
        {
            try
            {
                string env = Path.Combine(baseDir, @"app\.env");
                if (!File.Exists(env)) return "(未设置)";
                foreach (string line in File.ReadAllLines(env, Encoding.UTF8))
                {
                    if (line.StartsWith("PASSWORD=")) return line.Substring("PASSWORD=".Length).Trim();
                }
            }
            catch { }
            return "(未设置)";
        }

        static void Shutdown()
        {
            if (shuttingDown) return;
            shuttingDown = true;
            try { tray.Visible = false; } catch { }
            KillProc(webProc);
            KillProc(hongguoProc);
            Application.Exit();
        }

        static void KillProc(Process p)
        {
            if (p == null) return;
            try
            {
                if (!p.HasExited)
                {
                    try { Process.Start(new ProcessStartInfo("taskkill", "/PID " + p.Id + " /T /F") { CreateNoWindow = true, UseShellExecute = false }); }
                    catch { p.Kill(); }
                }
            }
            catch { }
        }
    }
}
