using Microsoft.Win32;

namespace VrcNotify;

sealed class MainForm : Form
{
    readonly Settings settings;
    readonly PresenceTracker tracker = new();
    readonly ToastQueue toasts;
    readonly PresenceLog presenceLog = new();
    readonly TabControl tabs = new();
    readonly LogView logView;
    readonly NotifyIcon tray;
    readonly DataGridView grid = new();
    readonly TextBox search = new() { PlaceholderText = "搜索好友名称…", Width = 250 };
    readonly Label status = new() { Text = "请先登录 VRChat，选择需要通知的好友。", AutoSize = true, ForeColor = Theme.Muted };
    readonly Label count = new() { AutoSize = true, ForeColor = Theme.Muted };
    readonly ListBox history = new() { Dock = DockStyle.Fill, BorderStyle = BorderStyle.None, BackColor = Theme.Panel, ForeColor = Theme.Muted };
    readonly CheckBox pause = new() { Text = "暂停弹窗", AutoSize = true };
    readonly Button login, refresh, logs;
    VrcApi? api;
    string accountId = "";
    CancellationTokenSource? cancellation;
    Task? monitoring;
    bool exiting, populating, sessionBusy;
    readonly bool demo;
    Dictionary<string, Rule> Rules
    {
        get { if (!settings.Accounts.TryGetValue(accountId, out var rules)) settings.Accounts[accountId] = rules = new(); return rules; }
    }
    public MainForm(bool demo = false)
    {
        this.demo = demo; settings = demo ? new Settings() : Storage.Load(); toasts = new(settings);
        Theme.Style(this); Text = $"VRChat 好友通知 · {AppVersion.Display}"; ClientSize = new Size(900, 740); MinimumSize = new Size(760, 600); StartPosition = FormStartPosition.CenterScreen;
        var root = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(26), ColumnCount = 1, RowCount = 8 };
        root.RowStyles.Add(new(SizeType.Absolute, 48)); root.RowStyles.Add(new(SizeType.Absolute, 42)); root.RowStyles.Add(new(SizeType.Absolute, 38)); root.RowStyles.Add(new(SizeType.Absolute, 42)); root.RowStyles.Add(new(SizeType.Percent, 100)); root.RowStyles.Add(new(SizeType.Absolute, 42)); root.RowStyles.Add(new(SizeType.Absolute, 108)); root.RowStyles.Add(new(SizeType.Absolute, 40));
        var heading = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, Margin = Padding.Empty };
        heading.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); heading.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        var title = new Label { Text = "好友上线，及时知道。", AutoSize = true, Font = new Font("Microsoft YaHei UI", 22, FontStyle.Bold) }; heading.Controls.Add(title);
        heading.Controls.Add(new Label { Text = AppVersion.Display, AutoSize = true, Anchor = AnchorStyles.Right, ForeColor = Theme.Muted }); root.Controls.Add(heading);
        var toolbar = new FlowLayoutPanel { Dock = DockStyle.Fill };
        login = Theme.Button("登录 VRChat", async (_, _) => await ChangeAccount());
        refresh = Theme.Button("刷新好友", async (sender, _) => { if (sessionBusy) return; sessionBusy = true; ((Button)sender!).Enabled = false; try { await StopMonitor(); StartMonitor(); } finally { sessionBusy = false; } }); refresh.Enabled = false;
        logs = Theme.Button("查看日志", (_, _) => ShowLogTab());
        toolbar.Controls.Add(login); toolbar.Controls.Add(refresh); toolbar.Controls.Add(Theme.Button("测试弹窗", (_, _) => toasts.Enqueue("示例好友", true))); toolbar.Controls.Add(Theme.Button("收起到托盘", (_, _) => Hide())); toolbar.Controls.Add(logs); root.Controls.Add(toolbar);
        status.Dock = DockStyle.Fill; status.TextAlign = ContentAlignment.MiddleLeft; root.Controls.Add(status);
        Theme.Input(search); var filter = new FlowLayoutPanel { Dock = DockStyle.Fill }; search.TextChanged += (_, _) => Populate(); filter.Controls.Add(search);
        var selected = new CheckBox { Text = "只看已选好友", AutoSize = true, Margin = new Padding(16, 4, 0, 0) }; selected.CheckedChanged += (_, _) => Populate(); selected.Name = "selected"; filter.Controls.Add(selected); filter.Controls.Add(count); root.Controls.Add(filter);
        grid.Dock = DockStyle.Fill; grid.BackgroundColor = Theme.Panel; grid.BorderStyle = BorderStyle.None; grid.AllowUserToAddRows = grid.AllowUserToDeleteRows = grid.AllowUserToResizeRows = false; grid.RowHeadersVisible = false; grid.MultiSelect = false; grid.SelectionMode = DataGridViewSelectionMode.FullRowSelect;
        grid.EnableHeadersVisualStyles = false; grid.ColumnHeadersDefaultCellStyle = new DataGridViewCellStyle { BackColor = Theme.Panel, ForeColor = Theme.Muted, Padding = new Padding(6) }; grid.ColumnHeadersHeight = 40;
        grid.DefaultCellStyle = new DataGridViewCellStyle { BackColor = Theme.Panel, ForeColor = Theme.Text, SelectionBackColor = Color.FromArgb(42, 65, 77), SelectionForeColor = Theme.Text, Padding = new Padding(6) }; grid.RowTemplate.Height = 40; grid.GridColor = Theme.Background;
        grid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Name", HeaderText = "好友", ReadOnly = true, AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill });
        grid.Columns.Add(new DataGridViewTextBoxColumn { Name = "State", HeaderText = "当前状态", ReadOnly = true, Width = 160 });
        grid.Columns.Add(new DataGridViewCheckBoxColumn { Name = "Online", HeaderText = "上线通知", Width = 120 });
        grid.Columns.Add(new DataGridViewCheckBoxColumn { Name = "Offline", HeaderText = "下线通知", Width = 120 });
        IdCopyButton.Add(grid, 1);
        grid.CurrentCellDirtyStateChanged += (_, _) => { if (grid.IsCurrentCellDirty) grid.CommitEdit(DataGridViewDataErrorContexts.Commit); };
        grid.CellValueChanged += (_, e) =>
        {
            if (populating || e.RowIndex < 0 || e.ColumnIndex < 0 || grid.Columns[e.ColumnIndex].Name is not ("Online" or "Offline")) return;
            var row = grid.Rows[e.RowIndex]; var id = (string)row.Tag!;
            Rules[id] = new Rule { Online = Convert.ToBoolean(row.Cells["Online"].Value), Offline = Convert.ToBoolean(row.Cells["Offline"].Value) }; Save(); UpdateCount();
        };
        root.Controls.Add(grid);
        var options = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(0, 8, 0, 0) };
        options.Controls.Add(pause); pause.CheckedChanged += (_, _) => { if (pause.Checked) toasts.Clear(); };
        var sound = new CheckBox { Text = "提示音", AutoSize = true, Checked = settings.Sound }; sound.CheckedChanged += (_, _) => { settings.Sound = sound.Checked; Save(); }; options.Controls.Add(sound);
        var startup = new CheckBox { Text = "开机启动", AutoSize = true, Checked = !demo && StartupEnabled() };
        startup.CheckedChanged += (_, _) => { if (!demo) try { SetStartup(startup.Checked); } catch { MessageBox.Show(this, "无法设置开机启动，请检查 Windows 权限。", Text); } }; options.Controls.Add(startup);
        options.Controls.Add(new Label { Text = "弹窗时长", AutoSize = true, Padding = new Padding(10, 2, 0, 0) });
        var seconds = new NumericUpDown { Minimum = 3, Maximum = 15, Value = Math.Clamp(settings.Seconds, 3, 15), Width = 52 }; seconds.ValueChanged += (_, _) => { settings.Seconds = (int)seconds.Value; Save(); }; options.Controls.Add(seconds); options.Controls.Add(new Label { Text = "秒", AutoSize = true, Padding = new Padding(0, 2, 0, 0) }); root.Controls.Add(options);
        root.Controls.Add(history);
        root.Controls.Add(new Label { Text = "勾选即保存 · 上线指进入游戏 · 网页活跃单独显示 · 首次同步及重连不补发通知", ForeColor = Theme.Muted, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, Font = new Font(Font.FontFamily, 9) });
        tabs.Dock = DockStyle.Fill; tabs.DrawMode = TabDrawMode.OwnerDrawFixed; tabs.SizeMode = TabSizeMode.Fixed; tabs.ItemSize = new Size(130, 38);
        tabs.DrawItem += (_, e) =>
        {
            using var background = new SolidBrush(e.Index == tabs.SelectedIndex ? Theme.Panel : Theme.Background);
            e.Graphics.FillRectangle(background, e.Bounds);
            TextRenderer.DrawText(e.Graphics, tabs.TabPages[e.Index].Text, Font, e.Bounds, e.Index == tabs.SelectedIndex ? Theme.Accent : Theme.Muted, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
        };
        var friendsTab = new TabPage("好友通知") { BackColor = Theme.Background }; friendsTab.Controls.Add(root);
        var logTab = new TabPage("日志") { BackColor = Theme.Background }; logView = new LogView(presenceLog.DirectoryPath, demo); logTab.Controls.Add(logView);
        tabs.TabPages.Add(friendsTab); tabs.TabPages.Add(logTab); tabs.SelectedIndexChanged += (_, _) => tabs.Invalidate(); Controls.Add(tabs);
        var menu = new ContextMenuStrip(); menu.Items.Add("打开好友设置", null, (_, _) => Restore());
        menu.Items.Add("查看日志", null, (_, _) => ShowLogTab());
        menu.Items.Add("打开日志文件夹", null, (_, _) => OpenLogs());
        var pauseItem = new ToolStripMenuItem("暂停弹窗") { CheckOnClick = true }; pauseItem.CheckedChanged += (_, _) => pause.Checked = pauseItem.Checked; pause.CheckedChanged += (_, _) => pauseItem.Checked = pause.Checked; menu.Items.Add(pauseItem);
        menu.Items.Add("忘记已保存账号密码", null, (_, _) => ForgetCredentials());
        menu.Items.Add("退出程序", null, async (_, _) => await Exit());
        tray = new NotifyIcon { Icon = SystemIcons.Information, Text = $"VRChat 好友通知 · {AppVersion.Display}", Visible = !demo, ContextMenuStrip = menu }; tray.DoubleClick += (_, _) => Restore();
        FormClosing += (_, e) =>
        {
            if (e.CloseReason is CloseReason.WindowsShutDown or CloseReason.TaskManagerClosing) { exiting = true; cancellation?.Cancel(); }
            if (!exiting) { e.Cancel = true; Hide(); }
        };
        Shown += async (_, _) =>
        {
            if (demo) { DemoData(); return; }
            if (Environment.GetCommandLineArgs().Contains("--background")) Hide();
            await RestoreSession();
        };
    }
    void Save()
    {
        if (demo) return;
        try { Storage.Save(settings); } catch { status.Text = "设置保存失败，请检查磁盘空间或文件权限。"; }
    }
    public void VerifyLogPreview() => logView.VerifyPreviewFilters();
    public void ShowLogTab() { Restore(); tabs.SelectedIndex = 1; }
    void OpenLogs()
    {
        try
        {
            Directory.CreateDirectory(presenceLog.DirectoryPath);
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(presenceLog.DirectoryPath) { UseShellExecute = true });
        }
        catch { status.Text = "无法打开日志文件夹，请检查文件权限。"; }
    }
    void UI(Action action)
    {
        if (IsDisposed || !IsHandleCreated || exiting) return;
        try { Invoke(action); } catch (ObjectDisposedException) { } catch (InvalidOperationException) when (exiting) { }
    }
    async Task RestoreSession()
    {
        var session = Storage.LoadSession(); if (session == null) { ConnectionFailure.Report("NoSavedSession"); return; }
        ConnectionFailure.Report("SessionRestore");
        sessionBusy = true; login.Enabled = false; status.Text = "正在恢复登录…";
        VrcApi? saved = null;
        try
        {
            saved = new VrcApi(session);
            var user = await saved.Request("auth/user"); var id = PresenceTracker.Str(user, "id");
            if (id.Length == 0) throw new InvalidOperationException();
            api = saved; accountId = id; login.Text = "退出登录"; StartMonitor();
        }
        catch (Exception ex) { saved?.Dispose(); ConnectionFailure.Report("SessionRestore", ex); status.Text = ConnectionFailure.Describe("Session", ex) + " 请重新登录或稍后重试。"; }
        finally { sessionBusy = false; login.Enabled = true; }
    }
    async Task ChangeAccount()
    {
        if (demo || sessionBusy) return; sessionBusy = true; login.Enabled = false; refresh.Enabled = false;
        try
        {
            await StopMonitor(); toasts.Clear();
            if (api != null)
            {
                try { await api.Request("logout", method: HttpMethod.Put); } catch { }
                api.Dispose(); api = null; Storage.DeleteSession(); accountId = ""; tracker.Friends.Clear(); history.Items.Clear(); Populate(); login.Text = "登录 VRChat"; status.Text = "已退出登录。已记住的账号密码可在登录窗口或托盘菜单中清除。"; return;
            }
            using var dialog = new LoginDialog();
            if (dialog.ShowDialog(this) != DialogResult.OK || dialog.Api == null) return;
            api = dialog.Api; accountId = dialog.User!.Id; login.Text = "退出登录"; StartMonitor();
            if (dialog.PersistenceWarning != null) MessageBox.Show(this, dialog.PersistenceWarning, "已登录 · 保存提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        catch { status.Text = "操作未完成，请重试。"; }
        finally { login.Enabled = true; refresh.Enabled = api != null; sessionBusy = false; }
    }
    void ForgetCredentials()
    {
        if (demo || sessionBusy) return;
        Restore();
        try
        {
            new CredentialStore().Delete();
            MessageBox.Show(this, "已清除保存的账号密码。当前登录会话、好友设置和日志均保留。", "账号密码已清除", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch { MessageBox.Show(this, "无法删除已保存的账号密码，请检查磁盘或文件权限后重试；旧数据可能仍在本机。", "清除失败", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
    }
    void StartMonitor()
    {
        if (api == null) return;
        refresh.Enabled = true; cancellation = new(); var token = cancellation.Token; var activeApi = api;
        monitoring = Task.Run(() => activeApi.Monitor(
            friends => UI(() => { tracker.Baseline(friends); Populate(); }),
            (raw, silent) => UI(() =>
            {
                var change = tracker.Apply(raw);
                if (!demo && change != null)
                {
                    var saved = presenceLog.Record(accountId, change, silent);
                    logs.Text = saved ? "查看日志" : "日志写入失败";
                    logs.ForeColor = saved ? Theme.Text : Color.Salmon;
                }
                if (change != null && !silent)
                {
                    history.Items.Insert(0, $"{DateTime.Now:HH:mm:ss}  {change.Friend.Name}  {(change.Online ? "上线" : "下线")}");
                    while (history.Items.Count > 100) history.Items.RemoveAt(history.Items.Count - 1);
                    if (!pause.Checked && Rules.TryGetValue(change.Friend.Id, out var rule) && (change.Online ? rule.Online : rule.Offline)) toasts.Enqueue(change.Friend.Name, change.Online);
                }
                Populate();
            }),
            text => UI(() => status.Text = text), token));
    }
    async Task StopMonitor()
    {
        cancellation?.Cancel();
        if (monitoring != null) try { await monitoring; } catch { }
        cancellation?.Dispose(); cancellation = null; monitoring = null;
    }
    void UpdateCount() => count.Text = $"  {tracker.Friends.Count} 位好友 · {Rules.Count(r => tracker.Friends.ContainsKey(r.Key) && (r.Value.Online || r.Value.Offline))} 位已选";
    void Populate()
    {
        var selectedId = grid.CurrentRow?.Tag as string;
        var scroll = grid.FirstDisplayedScrollingRowIndex;
        bool selectedOnly = grid.Parent!.Controls.OfType<FlowLayoutPanel>().SelectMany(p => p.Controls.OfType<CheckBox>()).Any(c => c.Name == "selected" && c.Checked);
        populating = true;
        try
        {
            grid.Rows.Clear();
            foreach (var friend in tracker.Friends.Values.Where(f => f.Name.Contains(search.Text.Trim(), StringComparison.CurrentCultureIgnoreCase)).OrderByDescending(f => f.State).ThenBy(f => f.Name))
            {
                Rules.TryGetValue(friend.Id, out var rule);
                if (selectedOnly && rule?.Online != true && rule?.Offline != true) continue;
                int index = grid.Rows.Add(friend.Name, "复制 ID", friend.State switch { Presence.Game => "● 游戏在线", Presence.Web => "● 网页活跃", _ => "○ 离线" }, rule?.Online ?? false, rule?.Offline ?? false);
                grid.Rows[index].Tag = friend.Id;
                grid.Rows[index].Cells["State"].Style.ForeColor = friend.State == Presence.Game ? Theme.Accent : Theme.Muted;
                if (friend.Id == selectedId) grid.CurrentCell = grid.Rows[index].Cells[0];
            }
            if (scroll >= 0 && scroll < grid.Rows.Count) grid.FirstDisplayedScrollingRowIndex = scroll;
            UpdateCount();
        }
        finally { populating = false; }
    }
    public void DemoData()
    {
        history.Items.Clear();
        accountId = "demo"; status.Text = "预览模式 · 下方为示例好友，未连接账号";
        tracker.Baseline(new[] { new Friend("1", "Mochi", Presence.Game), new Friend("2", "星野", Presence.Game), new Friend("3", "小狐狸", Presence.Web), new Friend("4", "Aster", Presence.Offline), new Friend("5", "月亮汽水", Presence.Offline) });
        Rules["1"] = new Rule { Online = true, Offline = true }; Rules["2"] = new Rule { Online = true }; Rules["5"] = new Rule { Offline = true };
        history.Items.Add("20:42:08  Mochi  上线"); history.Items.Add("20:39:21  月亮汽水  下线"); Populate();
    }
    public void VerifyFriendPreview()
    {
        if (!demo) throw new InvalidOperationException("Only preview data can be tested.");
        search.Text = "Mochi";
        var row = grid.Rows[0]; string? copied = null;
        if (!IdCopyButton.Copy(row, id => copied = id) || copied != "1") throw new InvalidOperationException("Filtered friend ID copy failed.");
        row.Cells["Online"].Value = false;
        if (Rules["1"].Online || !Rules["1"].Offline) throw new InvalidOperationException("Independent switches failed after copy column insertion.");
        row.Cells["Online"].Value = true;
        row.Cells["CopyId"].Value = "已复制";
        if (!Rules["1"].Online || !Rules["1"].Offline) throw new InvalidOperationException("Copy feedback changed friend notification preferences.");
        if (IdCopyButton.Copy(row, _ => throw new System.Runtime.InteropServices.ExternalException())) throw new InvalidOperationException("Busy clipboard handling failed.");
        search.Clear();
    }
    void Restore() { Show(); WindowState = FormWindowState.Normal; Activate(); }
    static bool StartupEnabled() { using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"); return key?.GetValue("VRChatFriendNotifier") != null; }
    static void SetStartup(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run");
        if (enabled) key.SetValue("VRChatFriendNotifier", $"\"{Environment.ProcessPath}\" --background"); else key.DeleteValue("VRChatFriendNotifier", false);
    }
    async Task Exit() { exiting = true; tray.Visible = false; toasts.Clear(); await StopMonitor(); Close(); }
    protected override void Dispose(bool disposing) { if (disposing) { tray.Dispose(); toasts.Dispose(); api?.Dispose(); cancellation?.Dispose(); } base.Dispose(disposing); }
}
