using System.Diagnostics;
using System.Net;
using System.Net.WebSockets;
using System.Text.Json;
using Microsoft.Win32;

namespace VrcNotify;

static class BrowserLogin
{
    public static async Task<(VrcApi Api, JsonElement User)> SignIn(CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromMinutes(10));
        await using var browser = await LoginBrowser.Open(false, deadline.Token);
        await browser.Navigate("https://vrchat.com/home/login", deadline.Token);
        string previous = "";
        var nextCheck = DateTime.UtcNow;
        while (true)
        {
            var session = await browser.Session(deadline.Token);
            if (session.Length > 0 && (session != previous || DateTime.UtcNow >= nextCheck))
            {
                previous = session;
                nextCheck = DateTime.UtcNow.AddSeconds(5);
                VrcApi? candidate = new(session);
                try
                {
                    var user = await candidate.Request("auth/user", deadline.Token);
                    if (!AuthChallenge.Required(user) && PresenceTracker.Str(user, "id").StartsWith("usr_", StringComparison.Ordinal))
                    { var api = candidate; candidate = null; return (api, user); }
                }
                catch (ApiException ex) when (ex.Status == HttpStatusCode.Unauthorized) { }
                finally { candidate?.Dispose(); }
            }
            await Task.Delay(1000, deadline.Token);
        }
    }
    // Only official API-domain authentication cookies are transferable to the API client.
    public static string ExtractSession(JsonElement result)
    {
        if (!result.TryGetProperty("cookies", out var cookies) || cookies.ValueKind != JsonValueKind.Array) return "";
        var selected = new Dictionary<string, string>();
        foreach (var cookie in cookies.EnumerateArray())
        {
            var domain = PresenceTracker.Str(cookie, "domain").TrimStart('.').ToLowerInvariant();
            var name = PresenceTracker.Str(cookie, "name"); var value = PresenceTracker.Str(cookie, "value");
            if (domain is not ("api.vrchat.cloud" or "vrchat.cloud" or "api.vrchat.com" or "vrchat.com")) continue;
            if (name is not ("auth" or "twoFactorAuth") || value.Length == 0 || value.Any(c => c <= ' ' || c is ';' or ',')) continue;
            if (cookie.TryGetProperty("expires", out var expires) && expires.TryGetDouble(out var seconds) && seconds > 0 && seconds <= DateTimeOffset.UtcNow.ToUnixTimeSeconds()) continue;
            // Prefer the current API domain if both legacy and current domains are present.
            if (!selected.ContainsKey(name) || domain.EndsWith("vrchat.cloud", StringComparison.Ordinal)) selected[name] = value;
        }
        return selected.ContainsKey("auth") ? string.Join("; ", selected.OrderBy(p => p.Key).Select(p => $"{p.Key}={p.Value}")) : "";
    }
    public static void SmokeTest(string output)
    {
        try { Smoke().GetAwaiter().GetResult(); File.WriteAllText(output, "PASS: isolated headless browser, CDP cookie filtering and profile cleanup"); }
        catch (Exception ex) { File.WriteAllText(output, "FAIL: isolated browser smoke test\n" + ex.GetType().Name + "\n" + ex.StackTrace); Environment.ExitCode = 1; }
    }
    static async Task Smoke()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(45));
        string directory;
        await using (var browser = await LoginBrowser.Open(true, timeout.Token))
        {
            directory = browser.Profile;
            await browser.SetTestCookie("auth", "synthetic-auth", "https://api.vrchat.cloud/", timeout.Token);
            await browser.SetTestCookie("twoFactorAuth", "synthetic-second", "https://api.vrchat.cloud/", timeout.Token);
            await browser.SetTestCookie("unrelated", "ignored", "https://api.vrchat.cloud/", timeout.Token);
            await browser.SetTestCookie("auth", "unrelated-site", "https://example.invalid/", timeout.Token);
            var session = await browser.Session(timeout.Token);
            if (session != "auth=synthetic-auth; twoFactorAuth=synthetic-second") throw new InvalidOperationException();
        }
        if (Directory.Exists(directory)) throw new IOException();
    }
}

// A fresh profile and an incognito CDP context never touch the user's existing browser profile.
sealed class LoginBrowser : IAsyncDisposable
{
    readonly ClientWebSocket socket = new();
    readonly string root = Path.Combine(Path.GetTempPath(), "VRCFriendsMonitor-Login");
    Process? process;
    string targetSession = "";
    int nextId;
    public string Profile { get; }
    LoginBrowser() { Profile = Path.Combine(root, Guid.NewGuid().ToString("N")); }
    static string Executable()
    {
        foreach (var name in new[] { "msedge.exe", "chrome.exe" })
        {
            foreach (var hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
            {
                using var key = hive.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\" + name);
                if (key?.GetValue(null) is string path && File.Exists(path.Trim('"'))) return path.Trim('"');
            }
            var suffix = name == "msedge.exe" ? @"Microsoft\Edge\Application\msedge.exe" : @"Google\Chrome\Application\chrome.exe";
            foreach (var folder in new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) })
            { var path = Path.Combine(folder, suffix); if (File.Exists(path)) return path; }
        }
        throw new InvalidOperationException("浏览器登录需要安装 Microsoft Edge 或 Google Chrome。");
    }
    public static async Task<LoginBrowser> Open(bool headless, CancellationToken ct)
    {
        var browser = new LoginBrowser();
        try
        {
            Directory.CreateDirectory(browser.Profile);
            var start = new ProcessStartInfo(Executable()) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = headless };
            foreach (var arg in new[] { "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--user-data-dir=" + browser.Profile, "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-background-networking", "--disable-extensions" }) start.ArgumentList.Add(arg);
            if (headless) start.ArgumentList.Add("--headless=new");
            start.ArgumentList.Add("about:blank");
            browser.process = Process.Start(start) ?? throw new InvalidOperationException("无法启动登录浏览器。");
            browser.process.OutputDataReceived += (_, _) => { }; browser.process.ErrorDataReceived += (_, _) => { };
            browser.process.BeginOutputReadLine(); browser.process.BeginErrorReadLine();
            using var startup = CancellationTokenSource.CreateLinkedTokenSource(ct); startup.CancelAfter(TimeSpan.FromSeconds(25));
            var activePort = Path.Combine(browser.Profile, "DevToolsActivePort");
            string[] lines = [];
            while (lines.Length < 2)
            {
                startup.Token.ThrowIfCancellationRequested();
                try { if (File.Exists(activePort)) lines = await File.ReadAllLinesAsync(activePort, startup.Token); } catch (IOException) { }
                if (lines.Length < 2) await Task.Delay(100, startup.Token);
            }
            if (!int.TryParse(lines[0], out var port) || port < 1 || port > 65535 || !lines[1].StartsWith("/devtools/browser/", StringComparison.Ordinal) || lines[1].Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('/' or '-'))) throw new IOException("登录浏览器连接无效。");
            await browser.socket.ConnectAsync(new Uri($"ws://127.0.0.1:{port}{lines[1]}"), startup.Token);
            var initial = await browser.Command("Target.getTargets", new { }, startup.Token);
            var context = await browser.Command("Target.createBrowserContext", new { disposeOnDetach = true }, startup.Token);
            var target = await browser.Command("Target.createTarget", new { url = "about:blank", browserContextId = context.GetProperty("browserContextId").GetString(), newWindow = true }, startup.Token);
            var attached = await browser.Command("Target.attachToTarget", new { targetId = target.GetProperty("targetId").GetString(), flatten = true }, startup.Token);
            browser.targetSession = attached.GetProperty("sessionId").GetString()!;
            foreach (var oldTarget in initial.GetProperty("targetInfos").EnumerateArray())
                if (PresenceTracker.Str(oldTarget, "type") == "page") await browser.Command("Target.closeTarget", new { targetId = oldTarget.GetProperty("targetId").GetString() }, startup.Token);
            return browser;
        }
        catch { await browser.DisposeAsync(); throw; }
    }
    public async Task Navigate(string url, CancellationToken ct) => await Command("Page.navigate", new { url }, ct, targetSession);
    public async Task<string> Session(CancellationToken ct) => BrowserLogin.ExtractSession(await Command("Network.getCookies", new { urls = new[] { "https://api.vrchat.cloud/api/1/auth/user", "https://vrchat.com/", "https://api.vrchat.com/api/1/auth/user" } }, ct, targetSession));
    public async Task SetTestCookie(string name, string value, string url, CancellationToken ct)
    {
        var result = await Command("Network.setCookie", new { name, value, url, secure = true, httpOnly = true }, ct, targetSession);
        if (!result.GetProperty("success").GetBoolean()) throw new InvalidOperationException();
    }
    async Task<JsonElement> Command(string method, object parameters, CancellationToken ct, string? sessionId = null)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(TimeSpan.FromSeconds(10));
        var id = ++nextId;
        var command = new Dictionary<string, object> { ["id"] = id, ["method"] = method, ["params"] = parameters };
        if (sessionId != null) command["sessionId"] = sessionId;
        await socket.SendAsync(JsonSerializer.SerializeToUtf8Bytes(command).AsMemory(), WebSocketMessageType.Text, true, timeout.Token);
        var buffer = new byte[8192];
        while (true)
        {
            using var stream = new MemoryStream();
            ValueWebSocketReceiveResult received;
            do
            {
                received = await socket.ReceiveAsync(buffer.AsMemory(), timeout.Token);
                if (received.MessageType == WebSocketMessageType.Close) throw new IOException("登录浏览器已关闭。");
                stream.Write(buffer, 0, received.Count);
                if (stream.Length > 4 * 1024 * 1024) throw new IOException("登录浏览器响应过大。");
            } while (!received.EndOfMessage);
            using var doc = JsonDocument.Parse(stream.ToArray()); var message = doc.RootElement;
            if (!message.TryGetProperty("id", out var responseId) || responseId.GetInt32() != id) continue;
            if (message.TryGetProperty("error", out _)) throw new InvalidOperationException("登录浏览器操作失败，请更新浏览器后重试。");
            return message.GetProperty("result").Clone();
        }
    }
    public async ValueTask DisposeAsync()
    {
        if (socket.State == WebSocketState.Open)
        {
            try { using var close = new CancellationTokenSource(TimeSpan.FromSeconds(2)); await Command("Browser.close", new { }, close.Token); } catch { }
        }
        socket.Dispose();
        if (process != null)
        {
            try
            {
                using var exit = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                try { await process.WaitForExitAsync(exit.Token); }
                catch (OperationCanceledException)
                {
                    if (!process.HasExited) process.Kill(true);
                    using var killed = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                    try { await process.WaitForExitAsync(killed.Token); } catch (OperationCanceledException) { }
                }
            }
            catch (InvalidOperationException) { }
            catch (System.ComponentModel.Win32Exception) { }
            finally { process.Dispose(); process = null; }
        }
        var fullPath = Path.GetFullPath(Profile);
        if (!fullPath.StartsWith(Path.GetFullPath(root) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return;
        for (int i = 0; i < 50; i++)
        {
            try { if (Directory.Exists(fullPath)) Directory.Delete(fullPath, true); break; }
            catch (IOException) { await Task.Delay(200); }
            catch (UnauthorizedAccessException) { await Task.Delay(200); }
        }
    }
}
