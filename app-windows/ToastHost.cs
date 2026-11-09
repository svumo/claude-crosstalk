// Shows one Windows notification and stays alive to hear its click. Windows takes a notification
// back when the program that raised it ends, and a click only reaches that program while it runs,
// so this waits (hidden) for a click, then opens the window with claude-open-link.ps1.
//   ToastHost.exe <window> <session> <title> <body> <minutes> <path of claude-open-link.ps1>
// Built by install.ps1 with the csc.exe that comes with Windows; it needs no other install.
using System;
using System.Diagnostics;
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

            var doc = new XmlDocument();
            doc.LoadXml("<toast><visual><binding template=\"ToastGeneric\"><text>" + Esc(title) + "</text><text>" + Esc(body) + "</text></binding></visual></toast>");
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
