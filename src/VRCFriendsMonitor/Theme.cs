namespace VrcNotify;

static class Theme
{
    public static readonly Color Background = Color.FromArgb(19, 25, 34), Panel = Color.FromArgb(29, 38, 50), Text = Color.FromArgb(229, 237, 244), Muted = Color.FromArgb(148, 167, 184), Accent = Color.FromArgb(80, 220, 181);
    public static void Style(Control control)
    {
        control.BackColor = Background; control.ForeColor = Text;
        control.Font = new Font("Microsoft YaHei UI", 10);
    }
    public static Button Button(string text, EventHandler click)
    {
        var b = new Button { Text = text, AutoSize = true, Height = 36, FlatStyle = FlatStyle.Flat, BackColor = Panel, ForeColor = Text, Margin = new Padding(0, 0, 10, 0), Padding = new Padding(8, 2, 8, 2) };
        b.FlatAppearance.BorderColor = Color.FromArgb(60, 77, 95); b.Click += click; return b;
    }
    public static void Input(TextBox box) { box.BackColor = Panel; box.ForeColor = Text; box.BorderStyle = BorderStyle.FixedSingle; }
}
sealed class LoginDialog : Form
{
    readonly TextBox username = new(), password = new() { UseSystemPasswordChar = true };
    readonly Label feedback = new() { AutoSize = false, Height = 62, ForeColor = Theme.Muted };
    readonly Button login;
    public VrcApi? Api { get; private set; }
    public JsonElementResult? User { get; private set; }
    public LoginDialog()
    {
        Theme.Style(this); Text = "登录 VRChat"; ClientSize = new Size(450, 375); FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = MinimizeBox = false; StartPosition = FormStartPosition.CenterParent;
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(26), ColumnCount = 1, RowCount = 8 };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.Controls.Add(new Label { Text = "使用 VRChat 账号登录", AutoSize = true, Font = new Font(Font, FontStyle.Bold) });
        layout.Controls.Add(new Label { Text = "用户名（不是显示名称）", AutoSize = true });
        Theme.Input(username); Theme.Input(password); username.Dock = DockStyle.Top; layout.Controls.Add(username);
        layout.Controls.Add(new Label { Text = "密码", AutoSize = true });
        password.Dock = DockStyle.Top; layout.Controls.Add(password);
        layout.Controls.Add(new Label { Text = "密码不保存。会话由 Windows 加密后保存在本机。\n仅有 Steam / Meta 登录时，请先绑定 VRChat 账号。", AutoSize = true, MaximumSize = new Size(390, 0), ForeColor = Theme.Muted });
        login = Theme.Button("登录", async (_, _) => await SignIn()); layout.Controls.Add(login);
        feedback.Dock = DockStyle.Fill; layout.Controls.Add(feedback); Controls.Add(layout); AcceptButton = login;
    }
    async Task SignIn()
    {
        if (string.IsNullOrWhiteSpace(username.Text) || password.Text.Length == 0) { feedback.Text = "请输入用户名和密码。"; return; }
        login.Enabled = false; username.Enabled = password.Enabled = false; feedback.Text = "正在登录…";
        VrcApi? candidate = new();
        try
        {
            var user = await candidate.Login(username.Text.Trim(), password.Text);
            password.Clear();
            while (user.TryGetProperty("requiresTwoFactorAuth", out var factors))
            {
                var types = factors.EnumerateArray().Select(v => v.GetString()).ToList();
                var type = types.Contains("emailOtp") ? "emailotp" : "totp";
                using var code = new CodeDialog(type);
                if (code.ShowDialog(this) != DialogResult.OK) { feedback.Text = "登录已取消。"; return; }
                try { await candidate.Verify(type, code.Code); }
                catch (Exception ex) when (ex is InvalidOperationException || ex is ApiException ae && ae.Status == System.Net.HttpStatusCode.Unauthorized)
                { MessageBox.Show(this, "验证码未通过，请重新输入；也可以取消登录。", "两步验证"); continue; }
                user = await candidate.Request("auth/user");
            }
            var id = PresenceTracker.Str(user, "id");
            if (id.Length == 0) throw new InvalidOperationException("登录未完成，请重试。");
            Storage.SaveSession(candidate.Session); Api = candidate; candidate = null;
            User = new(id, PresenceTracker.Str(user, "displayName")); DialogResult = DialogResult.OK; Close();
        }
        catch (Exception ex) { feedback.Text = ex is ApiException or InvalidOperationException ? ex.Message : "无法登录，请检查网络后重试。"; }
        finally { candidate?.Dispose(); password.Clear(); login.Enabled = true; username.Enabled = password.Enabled = true; }
    }
}
record JsonElementResult(string Id, string Name);
sealed class CodeDialog : Form
{
    readonly TextBox code = new() { Dock = DockStyle.Top, MaxLength = 12 };
    public string Code => code.Text.Trim();
    public CodeDialog(string type)
    {
        Theme.Style(this); Text = "两步验证"; ClientSize = new Size(370, 180); FormBorderStyle = FormBorderStyle.FixedDialog; StartPosition = FormStartPosition.CenterParent; MaximizeBox = MinimizeBox = false;
        var layout = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(22), FlowDirection = FlowDirection.TopDown };
        layout.Controls.Add(new Label { Text = type == "emailotp" ? "输入 VRChat 发到邮箱的验证码" : "输入身份验证器中的六位验证码", AutoSize = true });
        Theme.Input(code); code.Width = 315; layout.Controls.Add(code);
        var ok = Theme.Button("验证", (_, _) => { if (Code.Length > 0) DialogResult = DialogResult.OK; });
        layout.Controls.Add(ok); Controls.Add(layout); AcceptButton = ok;
    }
}
