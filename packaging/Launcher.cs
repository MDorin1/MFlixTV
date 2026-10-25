using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace lihongguotvLauncher
{
    /// <summary>
    /// lihongguotv 桌面启动器：
    ///  1) 拉起短剧专区服务（Node，127.0.0.1:8000，带 ffmpeg 转码环境）
    ///  2) 拉起 lihongguotv 主站（Node + Next，127.0.0.1:8080）
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

        [STAThread]
        static void Main()
        {
            bool created;
            using (Mutex mutex = new Mutex(true, "lihongguotv.Desktop.SingleInstance", out created))
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
                ThreadPool.QueueUserWorkItem(delegate { Boot(); });
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
            tray.Text = "lihongguotv 影视站";
            tray.Visible = true;

            ContextMenu menu = new ContextMenu();
            menu.MenuItems.Add("打开 lihongguotv", delegate { OpenBrowser("http://localhost:8080"); });
            menu.MenuItems.Add("打开短剧专区", delegate { OpenBrowser("http://localhost:8080/hongguo"); });
            menu.MenuItems.Add("-");
            menu.MenuItems.Add("复制访问密码", delegate { CopyPassword(); });
            menu.MenuItems.Add("打开安装目录", delegate { OpenFolder(baseDir); });
            menu.MenuItems.Add("查看更新日志", delegate { OpenText(Path.Combine(baseDir, @"logs\update.log")); });
            menu.MenuItems.Add("-");
            menu.MenuItems.Add("检查更新（短剧内核 + 点播源）", delegate { RunUpdater(); });
            menu.MenuItems.Add("-");
            menu.MenuItems.Add("退出", delegate { Shutdown(); });
            tray.ContextMenu = menu;
            tray.DoubleClick += delegate { OpenBrowser("http://localhost:8080"); };
        }

        static void Boot()
        {
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
                        tray.ShowBalloonTip(5000, "lihongguotv", "主站启动超时，请查看 logs\\web.log", ToolTipIcon.Error);
                        return;
                    }
                }

                SetStatus("运行中");
                OpenBrowser("http://localhost:8080");
                tray.ShowBalloonTip(4000, "lihongguotv", "已启动：浏览器正在打开 http://localhost:8080", ToolTipIcon.Info);
            }
            catch (Exception ex)
            {
                tray.ShowBalloonTip(6000, "lihongguotv 启动失败", ex.Message, ToolTipIcon.Error);
            }
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

        static void StartWeb()
        {
            string appDir = Path.Combine(baseDir, "app");
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
                tray.ShowBalloonTip(4000, "lihongguotv", "正在后台检查点播源（每天一次），完成后会提示", ToolTipIcon.Info);
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
                    tray.ShowBalloonTip(4000, "lihongguotv", "找不到更新脚本 tools\\update.ps1", ToolTipIcon.Warning);
                    return;
                }
                ProcessStartInfo psi = new ProcessStartInfo("powershell.exe",
                    "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\" -Part all -Silent");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                Process.Start(psi);
                tray.ShowBalloonTip(5000, "lihongguotv", "正在检查更新（短剧内核 + 点播源），完成后会弹窗提示", ToolTipIcon.Info);
            }
            catch (Exception ex)
            {
                tray.ShowBalloonTip(5000, "lihongguotv", "更新启动失败：" + ex.Message, ToolTipIcon.Error);
            }
        }

        static void OpenText(string path)
        {
            try
            {
                if (File.Exists(path)) Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
                else tray.ShowBalloonTip(3000, "lihongguotv", "还没有更新记录", ToolTipIcon.Info);
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
            try { tray.Text = "lihongguotv 影视站 · " + text; } catch { }
        }

        static void OpenBrowser(string url)
        {
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
            catch { }
        }

        static void OpenFolder(string path)
        {
            try { Process.Start("explorer.exe", "\"" + path + "\""); } catch { }
        }

        static void CopyPassword()
        {
            string pw = ReadPassword();
            try
            {
                Clipboard.SetText(pw);
                tray.ShowBalloonTip(3000, "lihongguotv", "访问密码已复制：" + pw, ToolTipIcon.Info);
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
