namespace VrcNotify;

sealed class LogView : UserControl
{
    readonly string directory;
    readonly bool demo;
    readonly DateTimePicker day = new() { Format = DateTimePickerFormat.Custom, CustomFormat = "yyyy-MM-dd", Dock = DockStyle.Fill };
    readonly TextBox search = new() { PlaceholderText = "搜索好友名称或 ID…", Dock = DockStyle.Fill };
    readonly ComboBox kind = new() { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Fill };
    readonly DataGridView grid = new();
    readonly Label summary = new() { AutoSize = true, ForeColor = Theme.Muted, Padding = new Padding(14, 3, 0, 0) };
    readonly CheckBox auto = new() { Text = "自动更新", Checked = true, AutoSize = true };
    readonly System.Windows.Forms.Timer timer = new() { Interval = 2000 };
    LogReadResult data = new([], 0, 0);
    string? signature;
    bool loading, requested;
    public LogView(string directory, bool demo = false)
    {
        this.directory = directory; this.demo = demo; Theme.Style(this); Dock = DockStyle.Fill;
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(26), RowCount = 6, ColumnCount = 1 };
        layout.RowStyles.Add(new(SizeType.Absolute, 46)); layout.RowStyles.Add(new(SizeType.Absolute, 38)); layout.RowStyles.Add(new(SizeType.Absolute, 46)); layout.RowStyles.Add(new(SizeType.Percent, 100)); layout.RowStyles.Add(new(SizeType.Absolute, 38)); layout.RowStyles.Add(new(SizeType.Absolute, 36));
        layout.Controls.Add(new Label { Text = "好友日志", AutoSize = true, Font = new Font("Microsoft YaHei UI", 22, FontStyle.Bold) });
        layout.Controls.Add(new Label { Text = "记录所有好友的上下线变化 · 暂停弹窗时也会继续记录", Dock = DockStyle.Fill, ForeColor = Theme.Muted });
        var filters = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 5, RowCount = 1 };
        filters.ColumnStyles.Add(new(SizeType.Absolute, 44)); filters.ColumnStyles.Add(new(SizeType.Absolute, 152)); filters.ColumnStyles.Add(new(SizeType.Percent, 100)); filters.ColumnStyles.Add(new(SizeType.Absolute, 106)); filters.ColumnStyles.Add(new(SizeType.Absolute, 85));
        filters.Controls.Add(new Label { Text = "日期", AutoSize = false, Dock = DockStyle.Fill, Margin = Padding.Empty, TextAlign = ContentAlignment.MiddleLeft }); filters.Controls.Add(day);
        Theme.Input(search); search.Margin = new Padding(10, 0, 10, 0); filters.Controls.Add(search);
        kind.Items.AddRange(new object[] { "全部变化", "仅上线", "仅下线" }); kind.SelectedIndex = 0; kind.BackColor = Theme.Panel; kind.ForeColor = Theme.Text; filters.Controls.Add(kind);
        filters.Controls.Add(Theme.Button("刷新", async (_, _) => await Reload(true))); layout.Controls.Add(filters);
        grid.Dock = DockStyle.Fill; grid.BackgroundColor = Theme.Panel; grid.BorderStyle = BorderStyle.None; grid.ReadOnly = true; grid.AllowUserToAddRows = grid.AllowUserToDeleteRows = grid.AllowUserToResizeRows = false; grid.RowHeadersVisible = false; grid.SelectionMode = DataGridViewSelectionMode.FullRowSelect;
        grid.EnableHeadersVisualStyles = false; grid.ColumnHeadersHeight = 40; grid.ColumnHeadersDefaultCellStyle = new() { BackColor = Theme.Panel, ForeColor = Theme.Muted, Padding = new Padding(6) };
        grid.DefaultCellStyle = new() { BackColor = Theme.Panel, ForeColor = Theme.Text, SelectionBackColor = Color.FromArgb(42, 65, 77), SelectionForeColor = Theme.Text, Padding = new Padding(6), WrapMode = DataGridViewTriState.False }; grid.RowTemplate.Height = 38; grid.GridColor = Theme.Background;
        AddColumn("时间", 280); AddColumn("变化", 78); grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "好友", AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill, MinimumWidth = 140 }); AddColumn("好友 ID", 195); AddColumn("账号 ID", 195); AddColumn("来源", 140);
        IdCopyButton.Add(grid, 3);
        layout.Controls.Add(grid);
        var footer = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(0, 9, 0, 0) }; footer.Controls.Add(auto); footer.Controls.Add(summary); layout.Controls.Add(footer);
        layout.Controls.Add(new Label { Text = "最新记录在最上方 · 每天显示最近 5000 条，完整日志保存在本地 · 可选择日期查看历史", Dock = DockStyle.Fill, ForeColor = Theme.Muted, Font = new Font(Font.FontFamily, 9), TextAlign = ContentAlignment.MiddleLeft }); Controls.Add(layout);
        search.TextChanged += (_, _) => Render(); kind.SelectedIndexChanged += (_, _) => Render(); day.ValueChanged += async (_, _) => await Reload(true);
        VisibleChanged += async (_, _) => { if (Visible) await Reload(true); };
        timer.Tick += async (_, _) => { if (Visible && auto.Checked) await Reload(false); }; timer.Start();
    }
    void AddColumn(string text, int width) => grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = text, Width = width });
    public async Task Reload(bool force)
    {
        if (IsDisposed) return;
        if (loading) { if (force) requested = true; return; }
        if (demo)
        {
            var prefix = day.Value.ToString("yyyy-MM-dd");
            data = new(new() { new(prefix + " 20:42:08.123 +08:00", "上线", "Mochi", "usr_mochi", "当前账号", "实时收到"), new(prefix + " 20:39:21.456 +08:00", "下线", "月亮汽水", "usr_moon", "当前账号", "实时收到"), new(prefix + " 20:35:04.007 +08:00", "上线", "星野", "usr_hoshino", "当前账号", "实时收到") }, 3, 0); Render(); return;
        }
        loading = true; var selectedDay = DateOnly.FromDateTime(day.Value);
        try
        {
            var file = new FileInfo(Path.Combine(directory, selectedDay.ToString("yyyy-MM-dd") + ".log"));
            var current = file.Exists ? $"{selectedDay}:{file.Length}:{file.LastWriteTimeUtc.Ticks}" : selectedDay + ":missing";
            if (!force && current == signature) return;
            var read = await Task.Run(() => LogReader.Read(directory, selectedDay));
            if (IsDisposed || DateOnly.FromDateTime(day.Value) != selectedDay) return;
            data = read; signature = read.Error == null ? current : null; Render();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Security.SecurityException)
        { data = new([], 0, 0, "日志暂时无法读取，请稍后点击刷新。"); signature = null; if (!IsDisposed) Render(); }
        finally
        {
            loading = false;
            if (requested && !IsDisposed) { requested = false; await Reload(true); }
        }
    }
    void Render()
    {
        var query = search.Text.Trim(); var action = kind.SelectedIndex switch { 1 => "上线", 2 => "下线", _ => "" };
        grid.Rows.Clear();
        foreach (var entry in data.Entries.Where(e => (action.Length == 0 || e.Action == action) && (query.Length == 0 || e.Name.Contains(query, StringComparison.CurrentCultureIgnoreCase) || e.FriendId.Contains(query, StringComparison.OrdinalIgnoreCase) || e.AccountId.Contains(query, StringComparison.OrdinalIgnoreCase))))
        {
            var row = grid.Rows[grid.Rows.Add(DateTimeOffset.TryParse(entry.Time, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var when) ? when.ToString("yyyy-MM-dd HH:mm:ss zzz") : entry.Time, entry.Action, entry.Name.Replace("\r", " ").Replace("\n", " ").Replace("\t", " "), "复制 ID", entry.FriendId, entry.AccountId, entry.Source)];
            row.Tag = entry.FriendId;
            row.Cells[0].ToolTipText = entry.Time;
            row.Cells[1].Style.ForeColor = entry.Action == "上线" ? Theme.Accent : Theme.Muted;
            row.Cells[2].ToolTipText = entry.Name;
        }
        summary.Text = data.Error ?? (data.Total == 0 ? "当天暂无上下线记录" : $"显示 {grid.Rows.Count} 条 / 当天共 {data.Total} 条" + (data.Skipped > 0 ? $" · 跳过 {data.Skipped} 条无效记录" : ""));
    }
    public void VerifyPreviewFilters()
    {
        if (!demo) throw new InvalidOperationException("Only preview data can be tested.");
        search.Text = "Mochi";
        if (grid.Rows.Count != 1) throw new InvalidOperationException("Log search failed.");
        string? copied = null;
        if (!IdCopyButton.Copy(grid.Rows[0], id => copied = id) || copied != "usr_mochi") throw new InvalidOperationException("Filtered log friend ID copy failed.");
        kind.SelectedIndex = 2;
        if (grid.Rows.Count != 0) throw new InvalidOperationException("Combined log filters failed.");
        search.Clear();
        if (grid.Rows.Count != 1) throw new InvalidOperationException("Offline log filter failed.");
        kind.SelectedIndex = 1;
        if (grid.Rows.Count != 2) throw new InvalidOperationException("Online log filter failed.");
        kind.SelectedIndex = 0;
        var oldDay = day.Value; day.Value = oldDay.AddDays(-1);
        if (!grid.Rows[0].Cells[0].Value!.ToString()!.StartsWith(day.Value.ToString("yyyy-MM-dd"))) throw new InvalidOperationException("Date selector failed.");
        day.Value = oldDay;
    }
    protected override void Dispose(bool disposing) { if (disposing) timer.Dispose(); base.Dispose(disposing); }
}
