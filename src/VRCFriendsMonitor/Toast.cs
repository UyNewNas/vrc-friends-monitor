using System.Drawing.Drawing2D;

namespace VrcNotify;

sealed class Toast : Form
{
    readonly System.Windows.Forms.Timer animation = new() { Interval = 16 };
    readonly DateTime started = DateTime.UtcNow;
    readonly int seconds;
    readonly Rectangle area;
    readonly string name;
    readonly bool online;
    protected override bool ShowWithoutActivation => true;
    protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x08000000 | 0x80; return p; } }
    public Toast(string name, bool online, int seconds)
    {
        this.name = name; this.online = online; this.seconds = seconds;
        AutoScaleMode = AutoScaleMode.Dpi; Theme.Style(this);
        FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true; DoubleBuffered = true;
        ClientSize = new Size(350, 112);
        area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1920, 1080);
        Location = new Point(area.Right - Width - 18, area.Bottom + 4); Opacity = 0;
        animation.Tick += (_, _) =>
        {
            double elapsed = (DateTime.UtcNow - started).TotalSeconds;
            double fade = Math.Min(1, elapsed / .25);
            if (elapsed > seconds) fade = Math.Max(0, 1 - (elapsed - seconds) / .3);
            Opacity = fade; Left = area.Right - Width - 18; Top = area.Bottom - Height - 18 + (int)((1 - fade) * 32);
            Invalidate(); if (elapsed > seconds + .3) Close();
        };
        Shown += (_, _) => animation.Start(); MouseDown += (_, _) => Close();
    }
    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias; g.Clear(Theme.Panel);
        using var stripe = new SolidBrush(online ? Theme.Accent : Theme.Muted); g.FillRectangle(stripe, 0, 0, 4, Height);
        using var badge = new SolidBrush(Color.FromArgb(43, 59, 73)); g.FillEllipse(badge, 20, 27, 48, 48);
        using var initialFont = new Font("Microsoft YaHei UI", 18, FontStyle.Bold);
        TextRenderer.DrawText(g, name.Length > 0 ? name[..1] : "V", initialFont, new Rectangle(20, 28, 48, 45), Theme.Text, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
        using var small = new Font("Microsoft YaHei UI", 8); using var bold = new Font("Microsoft YaHei UI", 11, FontStyle.Bold);
        TextRenderer.DrawText(g, "VRCHAT  ·  好友动态", small, new Point(84, 14), Theme.Muted);
        TextRenderer.DrawText(g, name, bold, new Rectangle(82, 36, Width - 110, 25), Theme.Text, TextFormatFlags.EndEllipsis | TextFormatFlags.SingleLine);
        TextRenderer.DrawText(g, online ? "已上线，正在玩 VRChat" : "已下线，离开了 VRChat", Font, new Point(84, 67), online ? Theme.Accent : Theme.Muted);
        TextRenderer.DrawText(g, "×", Font, new Point(Width - 24, 10), Theme.Muted);
        var remaining = Math.Clamp(1 - (DateTime.UtcNow - started).TotalSeconds / seconds, 0, 1);
        g.FillRectangle(stripe, 0, Height - 2, (int)(Width * remaining), 2);
    }
    protected override void Dispose(bool disposing) { if (disposing) animation.Dispose(); base.Dispose(disposing); }
}
sealed class ToastQueue : IDisposable
{
    readonly Queue<(string Name, bool Online)> pending = new();
    Toast? current;
    readonly Settings settings;
    public ToastQueue(Settings settings) => this.settings = settings;
    public void Enqueue(string name, bool online)
    {
        if (pending.Count >= 30) pending.Dequeue();
        pending.Enqueue((name, online)); Next();
    }
    void Next()
    {
        if (current != null || pending.Count == 0) return;
        var item = pending.Dequeue(); current = new Toast(item.Name, item.Online, Math.Clamp(settings.Seconds, 3, 15));
        current.FormClosed += (_, _) => { current?.Dispose(); current = null; Next(); };
        if (settings.Sound) System.Media.SystemSounds.Asterisk.Play(); current.Show();
    }
    public void Clear() { pending.Clear(); current?.Close(); }
    public void Dispose() => Clear();
}
