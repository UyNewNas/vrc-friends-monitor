using System.Globalization;
using System.Text;

namespace VrcNotify;

// Records observed game presence changes independently from notification preferences.
sealed class PresenceLog(string? directory = null, Func<DateTimeOffset>? clock = null)
{
    public string DirectoryPath { get; } = directory ?? Path.Combine(Storage.DirectoryPath, "logs");
    readonly Func<DateTimeOffset> now = clock ?? (() => DateTimeOffset.Now);
    public bool Record(string accountId, Change? change, bool syncing = false)
    {
        if (change == null) return true;
        try
        {
            var time = now();
            Directory.CreateDirectory(DirectoryPath);
            var path = Path.Combine(DirectoryPath, time.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) + ".log");
            var line = $"{time.ToString("yyyy-MM-dd HH:mm:ss.fff zzz", CultureInfo.InvariantCulture)}\t{(change.Online ? "上线" : "下线")}\t{Escape(change.Friend.Name)}\t好友ID={Escape(change.Friend.Id)}\t账号ID={Escape(accountId)}\t{(syncing ? "同步期间收到" : "实时收到")}{Environment.NewLine}";
            File.AppendAllText(path, line, new UTF8Encoding(false));
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Security.SecurityException)
        {
            // Disk errors must never stop monitoring or trigger an unsolicited popup.
            return false;
        }
    }
    static string Escape(string value) => value.Replace("\\", "\\\\").Replace("\r", "\\r").Replace("\n", "\\n").Replace("\t", "\\t");
}
