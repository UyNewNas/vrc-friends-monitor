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
    readonly Label feedback = new() { AutoSize = false, Height = 64, ForeColor = Theme.Muted };
    readonly Button login, browser, cancel;
    readonly CancellationTokenSource lifetime = new();
    CancellationTokenSource? attempt;
    public VrcApi? Api { get; private set; }
    public JsonElementResult? User { get; private set; }
    public LoginDialog()
    {
        Theme.Style(this); Text = "登录 VRChat"; ClientSize = new Size(490, 440); FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = MinimizeBox = false; StartPosition = FormStartPosition.CenterParent;
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(26), ColumnCount = 1, RowCount = 9 };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.Controls.Add(new Label { Text = "使用 VRChat 账号登录", AutoSize = true, Font = new Font(Font, FontStyle.Bold) });
        layout.Controls.Add(new Label { Text = "用户名（不是显示名称）", AutoSize = true });
        Theme.Input(username); Theme.Input(password); username.Dock = DockStyle.Top; layout.Controls.Add(username);
        layout.Controls.Add(new Label { Text = "密码", AutoSize = true });
        password.Dock = DockStyle.Top; layout.Controls.Add(password);
        layout.Controls.Add(new Label { Text = "支持身份验证器、邮箱验证码和恢复码。\n密码不保存，会话由 Windows 加密后保存在本机。", AutoSize = true, MaximumSize = new Size(430, 0), ForeColor = Theme.Muted });
        var actions = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Top, WrapContents = false };
        login = Theme.Button("账号登录", async (_, _) => await SignIn(false));
        browser = Theme.Button("浏览器登录", async (_, _) => await SignIn(true));
        cancel = Theme.Button("取消", (_, _) => attempt?.Cancel()); cancel.Enabled = false;
        actions.Controls.AddRange([login, browser, cancel]); layout.Controls.Add(actions);
        layout.Controls.Add(new Label { Text = "浏览器登录会打开独立的 Edge / Chrome 窗口。\n在 VRChat 官网完成登录和验证后，程序自动连接。", AutoSize = true, MaximumSize = new Size(430, 0), ForeColor = Theme.Muted });
        feedback.Dock = DockStyle.Fill; layout.Controls.Add(feedback); Controls.Add(layout); AcceptButton = login;
        FormClosing += (_, _) => lifetime.Cancel();
        FormClosed += (_, _) => lifetime.Dispose();
    }
    async Task SignIn(bool useBrowser)
    {
        if (attempt != null) return;
        if (!useBrowser && (string.IsNullOrWhiteSpace(username.Text) || password.Text.Length == 0)) { feedback.Text = "请输入用户名和密码。"; return; }
        using var pending = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token); attempt = pending;
        login.Enabled = browser.Enabled = username.Enabled = password.Enabled = false; cancel.Enabled = true;
        feedback.Text = useBrowser ? "请在打开的浏览器中登录并完成验证。等待期间可取消。" : "正在登录…";
        VrcApi? candidate = null;
        try
        {
            System.Text.Json.JsonElement user;
            if (useBrowser)
            {
                password.Clear();
                (candidate, user) = await BrowserLogin.SignIn(pending.Token);
            }
            else
            {
                candidate = new();
                user = await candidate.Login(username.Text.Trim(), password.Text, pending.Token); password.Clear();
                while (AuthChallenge.Required(user))
                {
                    var methods = AuthChallenge.Methods(user);
                    if (methods.Length == 0) throw new InvalidOperationException("此验证方式暂不支持，请尝试浏览器登录。");
                    pending.Token.ThrowIfCancellationRequested();
                    using var code = new CodeDialog(methods);
                    if (code.ShowDialog(this) != DialogResult.OK) { feedback.Text = "登录已取消。"; return; }
                    feedback.Text = "正在验证…";
                    try { await candidate.Verify(code.Method, code.Code, pending.Token); }
                    catch (Exception ex) when (ex is InvalidOperationException || ex is ApiException ae && ae.Status is System.Net.HttpStatusCode.Unauthorized or System.Net.HttpStatusCode.BadRequest)
                    {
                        pending.Token.ThrowIfCancellationRequested();
                        if (!IsDisposed) MessageBox.Show(this, "验证码未通过，请重新输入；也可以选择恢复码或取消登录。", "两步验证");
                        continue;
                    }
                    user = await candidate.Request("auth/user", pending.Token);
                }
            }
            pending.Token.ThrowIfCancellationRequested();
            var id = PresenceTracker.Str(user, "id");
            if (id.Length == 0 || AuthChallenge.Required(user)) throw new InvalidOperationException("登录未完成，请重试。");
            Storage.SaveSession(candidate.Session); Api = candidate; candidate = null;
            User = new(id, PresenceTracker.Str(user, "displayName")); DialogResult = DialogResult.OK; Close();
        }
        catch (OperationCanceledException) { if (!IsDisposed) feedback.Text = pending.IsCancellationRequested ? "登录已取消。" : "登录等待超时，请重试。"; }
        catch (Exception ex) { if (!IsDisposed) feedback.Text = ex is ApiException or InvalidOperationException ? ex.Message : "无法登录，浏览器可能已关闭；请检查网络后重试。"; }
        finally
        {
            candidate?.Dispose(); attempt = null;
            if (!IsDisposed) { password.Clear(); login.Enabled = browser.Enabled = username.Enabled = password.Enabled = true; cancel.Enabled = false; }
        }
    }
}
record JsonElementResult(string Id, string Name);
sealed class CodeDialog : Form
{
    readonly TextBox code = new() { Dock = DockStyle.Top, MaxLength = 64 };
    readonly ComboBox method = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 345, BackColor = Theme.Panel, ForeColor = Theme.Text };
    readonly string[] methods;
    public string Code => code.Text.Trim();
    public string Method => methods[method.SelectedIndex];
    public CodeDialog(string type) : this([type]) { }
    public CodeDialog(string[] types)
    {
        methods = types;
        Theme.Style(this); Text = "两步验证"; ClientSize = new Size(395, 240); FormBorderStyle = FormBorderStyle.FixedDialog; StartPosition = FormStartPosition.CenterParent; MaximizeBox = MinimizeBox = false;
        var layout = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(22), FlowDirection = FlowDirection.TopDown };
        foreach (var type in methods) method.Items.Add(type switch { "emailotp" => "邮箱验证码", "otp" => "一次性恢复码", _ => "身份验证器验证码" });
        var hint = new Label { AutoSize = true, MaximumSize = new Size(345, 0), Margin = new Padding(3, 8, 3, 8) };
        method.SelectedIndexChanged += (_, _) => { code.Clear(); hint.Text = Method switch { "emailotp" => "输入 VRChat 发到邮箱的验证码", "otp" => "输入 VRChat 账号设置中生成的未使用恢复码", _ => "输入身份验证器中的六位验证码" }; };
        method.SelectedIndex = 0; layout.Controls.Add(method); layout.Controls.Add(hint);
        Theme.Input(code); code.Width = 345; layout.Controls.Add(code);
        var actions = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(0, 12, 0, 0) };
        var ok = Theme.Button("验证", (_, _) => { if (Code.Length > 0) DialogResult = DialogResult.OK; });
        var cancel = Theme.Button("取消", (_, _) => DialogResult = DialogResult.Cancel);
        actions.Controls.AddRange([ok, cancel]); layout.Controls.Add(actions); Controls.Add(layout); AcceptButton = ok; CancelButton = cancel;
        Shown += (_, _) => code.Focus();
    }
}
