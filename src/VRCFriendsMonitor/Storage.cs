using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace VrcNotify;

class Settings
{
    public bool Sound { get; set; } = false;
    public int Seconds { get; set; } = 6;
    public Dictionary<string, Dictionary<string, Rule>> Accounts { get; set; } = new();
}
static class Storage
{
    public static string DirectoryPath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VRChatFriendNotifier");
    static string SettingsPath => Path.Combine(DirectoryPath, "settings.json");
    static string SessionPath => Path.Combine(DirectoryPath, "session.bin");
    public static Settings Load()
    {
        try { return JsonSerializer.Deserialize<Settings>(File.ReadAllText(SettingsPath)) ?? new(); }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException) { return new(); }
    }
    public static void Save(Settings settings) => AtomicWrite(SettingsPath, JsonSerializer.SerializeToUtf8Bytes(settings, new JsonSerializerOptions { WriteIndented = true }));
    internal static void AtomicWrite(string path, byte[] bytes)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                stream.Write(bytes);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporary, path, true);
        }
        finally { File.Delete(temporary); }
    }
    public static void SaveSession(string cookies)
    {
        var clear = Encoding.UTF8.GetBytes(cookies);
        try { AtomicWrite(SessionPath, Protect(clear, false)); }
        finally { CryptographicOperations.ZeroMemory(clear); }
    }
    public static string? LoadSession()
    {
        byte[]? clear = null;
        try
        {
            if (!File.Exists(SessionPath)) return null;
            clear = Protect(File.ReadAllBytes(SessionPath), true);
            return Encoding.UTF8.GetString(clear);
        }
        catch { return null; }
        finally { if (clear != null) CryptographicOperations.ZeroMemory(clear); }
    }
    public static void DeleteSession() { if (File.Exists(SessionPath)) File.Delete(SessionPath); }
    [StructLayout(LayoutKind.Sequential)] struct Blob { public int Length; public IntPtr Data; }
    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CryptProtectData(ref Blob input, string? description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, out Blob output);
    [DllImport("crypt32.dll", SetLastError = true)]
    static extern bool CryptUnprotectData(ref Blob input, IntPtr description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, out Blob output);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr ptr);
    public static byte[] Protect(byte[] data, bool decrypt)
    {
        var input = new Blob { Length = data.Length, Data = Marshal.AllocHGlobal(data.Length) };
        Blob output = default;
        try
        {
            Marshal.Copy(data, 0, input.Data, data.Length);
            bool ok = decrypt ? CryptUnprotectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, out output)
                : CryptProtectData(ref input, "VRC Friend Notifier", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, out output);
            if (!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            var result = new byte[output.Length]; Marshal.Copy(output.Data, result, 0, result.Length); return result;
        }
        finally
        {
            ClearUnmanaged(input);
            Marshal.FreeHGlobal(input.Data);
            if (output.Data != IntPtr.Zero) { ClearUnmanaged(output); LocalFree(output.Data); }
        }
    }
    static void ClearUnmanaged(Blob blob)
    {
        for (int i = 0; i < blob.Length; i++) Marshal.WriteByte(blob.Data, i, 0);
    }
}
