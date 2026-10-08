namespace VrcNotify;

static class IdCopyButton
{
    public static void Add(DataGridView grid, int index)
    {
        grid.Columns.Insert(index, new DataGridViewButtonColumn
        {
            Name = "CopyId", HeaderText = "", Width = 94,
            FlatStyle = FlatStyle.Flat, ReadOnly = true,
            SortMode = DataGridViewColumnSortMode.NotSortable
        });
        grid.CellContentClick += (_, e) =>
        {
            if (e.RowIndex < 0 || e.ColumnIndex != grid.Columns["CopyId"]!.Index) return;
            var row = grid.Rows[e.RowIndex];
            row.Cells["CopyId"].Value = Copy(row) ? "已复制" : "重试";
            row.Cells["CopyId"].ToolTipText = row.Cells["CopyId"].Value as string == "重试" ? "剪贴板暂时不可用，请再点击一次。" : "复制此好友的完整 ID";
        };
    }
    public static bool Copy(DataGridViewRow row, Action<string>? write = null)
    {
        if (row.Tag is not string id || string.IsNullOrWhiteSpace(id)) return false;
        try { (write ?? Clipboard.SetText)(id); return true; }
        catch (System.Runtime.InteropServices.ExternalException) { return false; }
    }
}
