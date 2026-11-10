// Shows one Windows notification and stays alive to hear its click. Windows takes a notification
// back when the program that raised it ends, and a click only reaches that program while it runs,
// so this waits (hidden) for a click, then brings the window forward and opens the session with
// claude-open-link.ps1.
//   ToastHost.exe <window> <session> <title> <body> <minutes> <path of claude-open-link.ps1> [<app pid>] [<logo png>]
// Built by install.ps1 with the csc.exe that comes with Windows; it needs no other install.
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using Windows.Data.Xml.Dom;
using Windows.UI.Notifications;

namespace Xt
{
    public static class ToastHost
    {
        public static int Main(string[] a)
        {
            if (a.Length < 6) return 2;
            string window = a[0].ToLowerInvariant(), session = a[1], title = a[2], body = a[3], opener = a[5];
            int minutes;
            if (!int.TryParse(a[4], out minutes) || minutes < 1 || minutes > 60) minutes = 15;
            if (!Regex.IsMatch(window, "^[a-z0-9][a-z0-9_-]{0,30}$") || !Regex.IsMatch(session, "^local_[A-Za-z0-9-]{1,64}$")) return 3;
            int appPid = 0;
            if (a.Length > 6) int.TryParse(a[6], out appPid);
            string logo = a.Length > 7 ? a[7] : "";

            // The Claude logo beside the text, when there is a copy of it.
            string image = "";
            if (logo != "" && System.IO.File.Exists(logo))
                image = "<image placement=\"appLogoOverride\" src=\"" + Esc(new Uri(logo).AbsoluteUri) + "\"/>";
            var doc = new XmlDocument();
            doc.LoadXml("<toast><visual><binding template=\"ToastGeneric\">" + image + "<text>" + Esc(title) + "</text><text>" + Esc(body) + "</text></binding></visual></toast>");
            var toast = new ToastNotification(doc);
            toast.Tag = session.Replace("_", "-");
            toast.Group = window;
            var clicked = new ManualResetEvent(false);
            var logFile = System.IO.Path.Combine(System.IO.Path.GetDirectoryName(System.IO.Path.GetDirectoryName(opener)), "toast-host.log");
            toast.Activated += delegate (ToastNotification s, object e) { Log(logFile, window + ": clicked"); clicked.Set(); };
            toast.Dismissed += delegate (ToastNotification s, ToastDismissedEventArgs e) { Log(logFile, window + ": dismissed " + e.Reason); };
            toast.Failed += delegate (ToastNotification s, ToastFailedEventArgs e) { Log(logFile, window + ": failed " + e.ErrorCode); };
            var notifier = ToastNotificationManager.CreateToastNotifier("Crosstalk.Claude." + window);
            notifier.Show(toast);

            if (clicked.WaitOne(TimeSpan.FromMinutes(minutes)))
            {
                // The click is the person's, so this process may take the foreground; the app,
                // reached through PowerShell and a second launch of itself, may not, and Windows
                // only flashes its taskbar button. So the window is brought forward here first.
                Log(logFile, window + ": " + Raise(appPid));
                var link = "crosstalk-window://open?window=" + window + "&session=" + session;
                var p = new ProcessStartInfo("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + opener + "\" \"" + link + "\"");
                p.CreateNoWindow = true;
                p.UseShellExecute = false;
                Process.Start(p);
                Thread.Sleep(1500);
            }
            try { ToastNotificationManager.History.Remove(toast.Tag, toast.Group, "Crosstalk.Claude." + window); } catch { }
            return 0;
        }

        // ---- Bringing the app's window forward ----

        delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
        [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int pid);
        [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
        const uint GW_OWNER = 4;
        const int SW_RESTORE = 9;
        const byte VK_MENU = 0x12;
        const uint KEYEVENTF_KEYUP = 2;

        // The app's main window: a visible, titled, unowned top-level window of its main process.
        static IntPtr MainWindowOf(int pid)
        {
            IntPtr found = IntPtr.Zero;
            EnumWindows(delegate (IntPtr h, IntPtr l)
            {
                uint owner;
                GetWindowThreadProcessId(h, out owner);
                if (owner == pid && IsWindowVisible(h) && GetWindow(h, GW_OWNER) == IntPtr.Zero && GetWindowTextLength(h) > 0)
                {
                    found = h;
                    return false;
                }
                return true;
            }, IntPtr.Zero);
            return found;
        }

        // Says what happened, for the log.
        static string Raise(int pid)
        {
            // Whatever comes next may take the foreground too (the app's own focus, once the link reaches it).
            AllowSetForegroundWindow(-1);
            if (pid <= 0) return "no window process given";
            try
            {
                if (!Process.GetProcessById(pid).ProcessName.Equals("claude", StringComparison.OrdinalIgnoreCase)) return "window process " + pid + " has ended";
            }
            catch { return "window process " + pid + " has ended"; }
            IntPtr hWnd = MainWindowOf(pid);
            if (hWnd == IntPtr.Zero) return "no window found for process " + pid;
            if (IsIconic(hWnd)) ShowWindow(hWnd, SW_RESTORE);
            if (SetForegroundWindow(hWnd) && GetForegroundWindow() == hWnd) return "brought forward";
            // Windows refuses while another program holds the foreground; a key press (Alt, down and
            // up, which does nothing on its own) counts as input here and lifts that lock.
            keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
            keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            SetForegroundWindow(hWnd);
            return GetForegroundWindow() == hWnd ? "brought forward (after a key press)" : "Windows kept another window in front";
        }

        // One line per event, so "nothing happened" can be told from "it ran and went elsewhere".
        static void Log(string file, string text)
        {
            try { System.IO.File.AppendAllText(file, DateTime.Now.ToString("s") + " " + text + "\r\n"); } catch { }
        }

        static string Esc(string s)
        {
            return System.Security.SecurityElement.Escape(s ?? "");
        }
    }
}
