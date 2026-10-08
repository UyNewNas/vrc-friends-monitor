namespace VrcNotify;

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        if (args.Contains("--self-test")) { SelfTest.Run(args.Last()); return; }
        if (args.Contains("--render-preview"))
        {
            var output = args.Last(); Directory.CreateDirectory(output);
            using var form = new MainForm(true); form.Show(); Application.DoEvents(); form.DemoData(); Application.DoEvents();
            form.VerifyFriendPreview(); Application.DoEvents();
            using var bitmap = new Bitmap(form.Width, form.Height); form.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size)); bitmap.Save(Path.Combine(output, "settings-preview.png"));
            form.ShowLogTab(); Application.DoEvents(); form.VerifyLogPreview(); Application.DoEvents();
            using var logBitmap = new Bitmap(form.Width, form.Height); form.DrawToBitmap(logBitmap, new Rectangle(Point.Empty, logBitmap.Size)); logBitmap.Save(Path.Combine(output, "logs-preview.png"));
            using var toast = new Toast("Mochi", true, 6); toast.Show(); Application.DoEvents();
            using var toastBitmap = new Bitmap(toast.Width, toast.Height); toast.DrawToBitmap(toastBitmap, new Rectangle(Point.Empty, toastBitmap.Size)); toastBitmap.Save(Path.Combine(output, "toast-preview.png"));
            using var dialog = new LoginDialog(); dialog.Show(); Application.DoEvents();
            using var loginBitmap = new Bitmap(dialog.Width, dialog.Height); dialog.DrawToBitmap(loginBitmap, new Rectangle(Point.Empty, loginBitmap.Size)); loginBitmap.Save(Path.Combine(output, "login-preview.png"));
            return;
        }
        using var mutex = new Mutex(true, @"Local\VRChatFriendNotifier", out var first);
        if (!first) { MessageBox.Show("程序已在运行，请双击右下角托盘图标打开设置。", "VRChat 好友通知"); return; }
        Application.Run(new MainForm());
    }
}
