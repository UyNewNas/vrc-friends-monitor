using System.Globalization;
using System.Text;

namespace VrcNotify;

record LogEntry(string Time, string Action, string Name, string FriendId, string AccountId, string Source);
record LogReadResult(List<LogEntry> Entries, int Total, int Skipped, string? Error = null);
static class LogReader
{
    public static LogReadResult Read(string directory, DateOnly day, int limit = 5000)
    {
        var entries = new Queue<LogEntry>(); int total = 0, skipped = 0;
        try
        {
            var path = Path.Combine(directory, day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) + ".log");
            using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var reader = new StreamReader(file, Encoding.UTF8);
            while (reader.ReadLine() is { } line)
            {
                var fields = line.Split('\t');
                if (fields.Length != 6 || fields[1] is not ("上线" or "下线") || !fields[3].StartsWith("好友ID=", StringComparison.Ordinal) || !fields[4].StartsWith("账号ID=", StringComparison.Ordinal)) { skipped++; continue; }
                entries.Enqueue(new(fields[0], fields[1], Unescape(fields[2]), Unescape(fields[3][5..]), Unescape(fields[4][5..]), fields[5]));
                total++;
                while (entries.Count > Math.Max(1, limit)) entries.Dequeue();
            }
            return new(entries.Reverse().ToList(), total, skipped);
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException) { return new([], 0, 0); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Security.SecurityException) { return new([], 0, 0, "日志暂时无法读取，请稍后点击刷新。"); }
    }
    static string Unescape(string value)
    {
        var result = new StringBuilder();
        for (int i = 0; i < value.Length; i++)
        {
            if (value[i] == '\\' && i + 1 < value.Length)
            {
                var next = value[++i];
                result.Append(next switch { 'n' => '\n', 'r' => '\r', 't' => '\t', '\\' => '\\', _ => '\\' });
                if (next is not ('n' or 'r' or 't' or '\\')) result.Append(next);
            }
            else result.Append(value[i]);
        }
        return result.ToString();
    }
}
