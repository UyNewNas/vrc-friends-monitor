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
    readonly CheckBox remember = new() { Text = "记住账号密码", AutoSize = true, Margin = new Padding(0, 6, 12, 0) };
    readonly Label feedback = new() { AutoSize = false, Height = 64, ForeColor = Theme.Muted };
    readonly Button login, browser, cancel, forget;
    readonly CancellationTokenSource lifetime = new();
    CancellationTokenSource? attempt;
    readonly Func<VrcApi> createApi;
    readonly Action<string> saveSession;
    readonly ICredentialStore credentialStore;
    readonly Func<CancellationToken, Task<(VrcApi Api, System.Text.Json.JsonElement User)>> browserSignIn;
    bool changingRemember;
    string? filledAccount;
    public VrcApi? Api { get; private set; }
    public JsonElementResult? User { get; private set; }
    public string? PersistenceWarning { get; private set; }
    internal bool SilentTest;
    public LoginDialog(Func<VrcApi>? createApi = null, Action<string>? saveSession = null,
        ICredentialStore? credentialStore = null,
        Func<CancellationToken, Task<(VrcApi Api, System.Text.Json.JsonElement User)>>? browserSignIn = null)
    {
        this.createApi = createApi ?? (() => new VrcApi()); this.saveSession = saveSession ?? Storage.SaveSession;
        this.credentialStore = credentialStore ?? new CredentialStore();
        this.browserSignIn = browserSignIn ?? BrowserLogin.SignIn;
        Theme.Style(this); Text = $"登录 VRChat · {AppVersion.Display}"; ClientSize = new Size(520, 530); FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = MinimizeBox = false; StartPosition = FormStartPosition.CenterParent;
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(26), ColumnCount = 1, RowCount = 10 };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        for (int row = 0; row < 9; row++) layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.Controls.Add(new Label { Text = "使用 VRChat 账号登录", AutoSize = true, Font = new Font(Font, FontStyle.Bold) });
        layout.Controls.Add(new Label { Text = "注册用户名或邮箱（不是显示名称）", AutoSize = true });
        Theme.Input(username); Theme.Input(password); username.Dock = DockStyle.Top; layout.Controls.Add(username);
        layout.Controls.Add(new Label { Text = "密码", AutoSize = true });
        password.Dock = DockStyle.Top; layout.Controls.Add(password);
        var credentials = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Top, WrapContents = false, Margin = new Padding(0, 8, 0, 8) };
        forget = Theme.Button("忘记已保存账号密码", (_, _) => ForgetCredentials(true));
        credentials.Controls.AddRange([remember, forget]); layout.Controls.Add(credentials);
        layout.Controls.Add(new Label { Text = "勾选后，登录成功才会在本机加密保存账号密码。\n下次自动填入；两步验证仍需按提示完成。\n退出登录保留已记住的账号，可用上方按钮清除。", AutoSize = true, MaximumSize = new Size(460, 0), ForeColor = Theme.Muted });
        var actions = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Top, WrapContents = false };
        login = Theme.Button("账号登录", async (_, _) => await SignIn(false));
        browser = Theme.Button("浏览器登录", async (_, _) => await SignIn(true));
        cancel = Theme.Button("取消", (_, _) => attempt?.Cancel()); cancel.Enabled = false;
        actions.Controls.AddRange([login, browser, cancel]); layout.Controls.Add(actions);
        layout.Controls.Add(new Label { Text = "浏览器登录会打开独立的 Edge / Chrome 窗口。\n在官网完成验证后自动连接，仅保存加密会话。", AutoSize = true, MaximumSize = new Size(460, 0), ForeColor = Theme.Muted });
        feedback.Dock = DockStyle.Fill; layout.Controls.Add(feedback); Controls.Add(layout); AcceptButton = login;
        LoadCredentials();
        username.TextChanged += (_, _) =>
        {
            if (filledAccount != null && username.Text.Trim() != filledAccount)
            { password.Clear(); filledAccount = null; }
        };
        remember.CheckedChanged += (_, _) =>
        {
            if (changingRemember) return;
            if (!remember.Checked) ForgetCredentials(false);
            else feedback.Text = "账号登录成功后，将记住本次账号密码。";
        };
        FormClosing += (_, _) => { password.Clear(); filledAccount = null; lifetime.Cancel(); };
        FormClosed += (_, _) => lifetime.Dispose();
    }
    void LoadCredentials()
    {
        try
        {
            var saved = credentialStore.Load();
            if (saved == null) return;
            username.Text = saved.Username; password.Text = saved.Password; filledAccount = saved.Username;
            remember.Checked = true; feedback.Text = "已填入上次记住的账号密码，点击“账号登录”即可。";
        }
        catch { feedback.Text = "无法读取已保存的账号密码，请重新输入，或点击“忘记已保存账号密码”清除旧数据。"; }
    }
    void SetRemember(bool value)
    {
        changingRemember = true;
        try { remember.Checked = value; }
        finally { changingRemember = false; }
    }
    void ForgetCredentials(bool clearFields)
    {
        try
        {
            credentialStore.Delete(); SetRemember(false);
            if (clearFields) { filledAccount = null; username.Clear(); password.Clear(); }
            feedback.Text = "已清除保存的账号密码。当前登录会话不受影响。";
        }
        catch
        {
            feedback.Text = "无法删除已保存的账号密码，请检查磁盘或文件权限后重试；旧数据可能仍在本机。";
        }
    }
    async Task SignIn(bool useBrowser)
    {
        if (attempt != null) return;
        if (!useBrowser && (string.IsNullOrWhiteSpace(username.Text) || password.Text.Length == 0)) { feedback.Text = "请输入用户名和密码。"; return; }
        // Keep only this attempt's snapshot until full authentication (including 2FA) completes.
        SavedCredentials? credentials = useBrowser ? null : new(username.Text.Trim(), password.Text);
        PersistenceWarning = null;
        using var pending = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token); attempt = pending;
        login.Enabled = browser.Enabled = username.Enabled = password.Enabled = remember.Enabled = forget.Enabled = false; cancel.Enabled = true;
        feedback.Text = useBrowser ? "请在打开的浏览器中登录并完成验证。等待期间可取消。" : "正在登录…";
        VrcApi? candidate = null;
        try
        {
            System.Text.Json.JsonElement user;
            if (useBrowser)
            {
                password.Clear();
                (candidate, user) = await browserSignIn(pending.Token);
            }
            else
            {
                candidate = createApi();
                user = await candidate.Login(credentials!.Username, credentials.Password, pending.Token); password.Clear();
                string verificationError = "";
                while (AuthChallenge.Required(user))
                {
                    var methods = AuthChallenge.Methods(user);
                    if (methods.Length == 0) throw new InvalidOperationException("此验证方式暂不支持，请尝试浏览器登录。");
                    pending.Token.ThrowIfCancellationRequested();
                    feedback.Text = "账号已验证，等待输入两步验证码…";
                    using var code = new CodeDialog(methods, verificationError);
                    if (SilentTest) code.Opacity = 0;
                    if (code.ShowDialog(this) != DialogResult.OK) { feedback.Text = "登录已取消。"; return; }
                    feedback.Text = "正在验证…";
                    try { await candidate.Verify(code.Method, code.Code, pending.Token); }
                    catch (Exception ex) when (ex is InvalidOperationException || ex is ApiException ae && ae.Status is System.Net.HttpStatusCode.Unauthorized or System.Net.HttpStatusCode.BadRequest && !ae.Message.StartsWith("验证会话已失效", StringComparison.Ordinal))
                    {
                        pending.Token.ThrowIfCancellationRequested();
                        feedback.Text = ex.Message;
                        verificationError = ex.Message;
                        continue;
                    }
                    user = await candidate.Request("auth/user", pending.Token);
                }
            }
            pending.Token.ThrowIfCancellationRequested();
            var id = PresenceTracker.Str(user, "id");
            if (id.Length == 0 || AuthChallenge.Required(user)) throw new InvalidOperationException("登录未完成，请重试。");
            var warnings = new List<string>();
            try { saveSession(candidate.Session); }
            catch { warnings.Add("登录成功，但会话未能保存在本机，下次启动可能需要重新登录。"); }
            if (!useBrowser && remember.Checked)
            {
                try { credentialStore.Save(credentials!); }
                catch { warnings.Add("本次账号密码未能保存，请检查磁盘或文件权限；下次仍可能需要重新输入。"); }
            }
            else if (!useBrowser)
            {
                // Also remove an unreadable older file when signing in without remembering.
                try { credentialStore.Delete(); }
                catch { warnings.Add("无法删除以前保存的账号密码，请在托盘菜单中重试清除；旧数据可能仍在本机。"); }
            }
            PersistenceWarning = warnings.Count == 0 ? null : string.Join("\n", warnings);
            Api = candidate; candidate = null;
            User = new(id, PresenceTracker.Str(user, "displayName")); DialogResult = DialogResult.OK; Close();
        }
        catch (OperationCanceledException) { if (!IsDisposed) feedback.Text = pending.IsCancellationRequested ? "登录已取消。" : "登录等待超时，请重试。"; }
        catch (Exception ex) { if (!IsDisposed) feedback.Text = ex is ApiException or InvalidOperationException ? ex.Message : "无法登录，浏览器可能已关闭；请检查网络后重试。"; }
        finally
        {
            credentials = null; candidate?.Dispose(); attempt = null;
            if (!IsDisposed) { password.Clear(); filledAccount = null; login.Enabled = browser.Enabled = username.Enabled = password.Enabled = remember.Enabled = forget.Enabled = true; cancel.Enabled = false; }
        }
    }
    internal string Feedback => feedback.Text;
    internal string FilledUsername => username.Text;
    internal string FilledPassword => password.Text;
    internal bool RemembersCredentials => remember.Checked;
    internal bool PasswordMasked => password.UseSystemPasswordChar;
    internal Task TestAccountLogin(string loginName = "synthetic-user", string loginPassword = "synthetic-password", bool rememberCredentials = false)
    { username.Text = loginName; password.Text = loginPassword; remember.Checked = rememberCredentials; return SignIn(false); }
    internal Task TestFilledAccountLogin() => SignIn(false);
    internal Task TestBrowserLogin() => SignIn(true);
    internal void TestSetUsername(string value) => username.Text = value;
    internal void TestSetRemember(bool value) => remember.Checked = value;
    internal void TestForgetCredentials() => ForgetCredentials(true);
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
    public CodeDialog(string[] types, string? error = null)
    {
        methods = types;
        Theme.Style(this); Text = "两步验证"; ClientSize = new Size(395, error == null || error.Length == 0 ? 240 : 290); FormBorderStyle = FormBorderStyle.FixedDialog; StartPosition = FormStartPosition.CenterParent; MaximizeBox = MinimizeBox = false;
        var layout = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(22), FlowDirection = FlowDirection.TopDown };
        foreach (var type in methods) method.Items.Add(type switch { "emailotp" => "邮箱验证码", "otp" => "一次性恢复码", _ => "身份验证器验证码" });
        var hint = new Label { AutoSize = true, MaximumSize = new Size(345, 0), Margin = new Padding(3, 8, 3, 8) };
        method.SelectedIndexChanged += (_, _) => { code.Clear(); hint.Text = Method switch { "emailotp" => "输入 VRChat 发到邮箱的验证码", "otp" => "输入 VRChat 账号设置中生成的未使用恢复码", _ => "输入身份验证器中的六位验证码" }; };
        method.SelectedIndex = 0; layout.Controls.Add(method); layout.Controls.Add(hint);
        Theme.Input(code); code.Width = 345; layout.Controls.Add(code);
        if (!string.IsNullOrEmpty(error)) layout.Controls.Add(new Label { Text = error, AutoSize = true, MaximumSize = new Size(345, 0), ForeColor = Color.Salmon });
        var actions = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(0, 12, 0, 0) };
        var ok = Theme.Button("验证", (_, _) => { if (Code.Length > 0) DialogResult = DialogResult.OK; });
        var cancel = Theme.Button("取消", (_, _) => DialogResult = DialogResult.Cancel);
        actions.Controls.AddRange([ok, cancel]); layout.Controls.Add(actions); Controls.Add(layout); AcceptButton = ok; CancelButton = cancel;
        Shown += (_, _) => { Activate(); BringToFront(); code.Focus(); };
    }
    internal void TestSubmit(string type, string value)
    { method.SelectedIndex = Array.IndexOf(methods, type); code.Text = value; ((Button)AcceptButton!).PerformClick(); }
}
