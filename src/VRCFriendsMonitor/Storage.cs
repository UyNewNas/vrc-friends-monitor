using System.Runtime.InteropServices;
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
    static void AtomicWrite(string path, byte[] bytes)
    {
        Directory.CreateDirectory(DirectoryPath);
        File.WriteAllBytes(path + ".tmp", bytes);
        File.Move(path + ".tmp", path, true);
    }
    public static void SaveSession(string cookies) => AtomicWrite(SessionPath, Protect(Encoding.UTF8.GetBytes(cookies), false));
    public static string? LoadSession()
    {
        try { return File.Exists(SessionPath) ? Encoding.UTF8.GetString(Protect(File.ReadAllBytes(SessionPath), true)) : null; }
        catch { return null; }
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
        finally { Marshal.FreeHGlobal(input.Data); if (output.Data != IntPtr.Zero) LocalFree(output.Data); }
    }
}
