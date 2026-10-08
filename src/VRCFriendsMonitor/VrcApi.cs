using System.Net;
using System.Net.Http.Headers;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

namespace VrcNotify;

class ApiException(HttpStatusCode status, string message) : Exception(message) { public HttpStatusCode Status { get; } = status; }
sealed class VrcApi : IDisposable
{
    static readonly string UserAgent = $"VRCFriendsMonitor/{typeof(VrcApi).Assembly.GetName().Version?.ToString(3) ?? "1.0.0"} (https://github.com/UyNewNas/vrc-friends-monitor)";
    static readonly Uri Origin = new("https://api.vrchat.cloud");
    readonly CookieContainer cookies = new();
    readonly HttpClient http;
    public VrcApi(string? saved = null, HttpMessageHandler? testHandler = null)
    {
        if (saved != null) foreach (var pair in saved.Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            var p = pair.Trim().Split('=', 2);
            if (p.Length == 2 && p[0] is "auth" or "twoFactorAuth") cookies.Add(Origin, new Cookie(p[0], p[1], "/"));
        }
        http = new(testHandler ?? new HttpClientHandler { CookieContainer = cookies, AllowAutoRedirect = false }) { BaseAddress = new("https://api.vrchat.cloud/api/1/"), Timeout = TimeSpan.FromSeconds(30) };
        http.DefaultRequestHeaders.UserAgent.ParseAdd(UserAgent);
    }
    public string Session => string.Join("; ", cookies.GetCookies(Origin).Cast<Cookie>().Where(c => c.Name is "auth" or "twoFactorAuth").Select(c => $"{c.Name}={c.Value}"));
    public async Task<JsonElement> Request(string path, CancellationToken ct = default, HttpMethod? method = null, object? body = null, string? basic = null)
    {
        ct.ThrowIfCancellationRequested();
        using var request = new HttpRequestMessage(method ?? HttpMethod.Get, path);
        if (basic != null) request.Headers.Authorization = new AuthenticationHeaderValue("Basic", basic);
        if (body != null) request.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        using var response = await http.SendAsync(request, ct).ConfigureAwait(false);
        var text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        JsonElement result = default;
        try { using var doc = JsonDocument.Parse(text); result = doc.RootElement.Clone(); }
        catch (JsonException) when (!response.IsSuccessStatusCode) { }
        // A structured challenge can accompany a 401; preserve the partial session for verification.
        if (path == "auth/user" && response.StatusCode == HttpStatusCode.Unauthorized && AuthChallenge.Required(result)) return result;
        if (!response.IsSuccessStatusCode)
        {
            string message = response.StatusCode switch
            {
                HttpStatusCode.Unauthorized => "登录已失效，或账号密码 / 验证码不正确，请重新登录。",
                HttpStatusCode.Forbidden => "服务器拒绝访问，请检查账号或稍后重试。",
                HttpStatusCode.TooManyRequests => "请求过于频繁，请等待几分钟后重试。",
                _ => $"VRChat 服务暂不可用（{(int)response.StatusCode}）。"
            };
            throw new ApiException(response.StatusCode, message);
        }
        return result;
    }
    public Task<JsonElement> Login(string username, string password, CancellationToken ct = default) => Request("auth/user", ct, basic: Convert.ToBase64String(Encoding.UTF8.GetBytes(Uri.EscapeDataString(username) + ":" + Uri.EscapeDataString(password))));
    public async Task Verify(string type, string code, CancellationToken ct = default)
    {
        if (type is not ("totp" or "emailotp" or "otp")) throw new InvalidOperationException("不支持此验证方式。");
        var result = await Request($"auth/twofactorauth/{type}/verify", ct, method: HttpMethod.Post, body: new { code });
        if (!result.TryGetProperty("verified", out var verified) || verified.ValueKind != JsonValueKind.True) throw new InvalidOperationException("验证码未通过，请重新输入。");
    }
    public async Task<List<Friend>> Friends(CancellationToken ct)
    {
        var result = new Dictionary<string, Friend>();
        foreach (bool offline in new[] { false, true })
        {
            for (int offset = 0; ; offset += 100)
            {
                var page = await Request($"auth/user/friends?offline={offline.ToString().ToLowerInvariant()}&n=100&offset={offset}", ct);
                if (page.ValueKind != JsonValueKind.Array) throw new IOException("好友列表格式异常。");
                foreach (var user in page.EnumerateArray())
                {
                    var id = PresenceTracker.Str(user, "id");
                    if (id.Length > 0) result[id] = new Friend(id, PresenceTracker.Str(user, "displayName"), PresenceTracker.ParseState(user, offline));
                }
                if (page.GetArrayLength() < 100) break;
                await Task.Delay(300, ct);
            }
        }
        return result.Values.ToList();
    }
    public async Task Monitor(Action<List<Friend>> baseline, Action<string, bool> message, Action<string> status, CancellationToken ct)
    {
        int failures = 0;
        while (!ct.IsCancellationRequested)
        {
            using var connection = CancellationTokenSource.CreateLinkedTokenSource(ct);
            Task? reader = null;
            try
            {
                status(failures == 0 ? "正在连接实时通知…" : "正在重新连接…");
                var current = await Request("auth/user", ct);
                if (!current.TryGetProperty("id", out _)) throw new ApiException(HttpStatusCode.Unauthorized, "登录已失效，请重新登录。");
                Storage.SaveSession(Session);
                using var socket = new ClientWebSocket();
                socket.Options.SetRequestHeader("User-Agent", UserAgent);
                socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
                socket.Options.KeepAliveTimeout = TimeSpan.FromSeconds(20);
                var auth = cookies.GetCookies(Origin)["auth"]?.Value ?? throw new ApiException(HttpStatusCode.Unauthorized, "请重新登录。");
                using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct))
                { timeout.CancelAfter(TimeSpan.FromSeconds(30)); await socket.ConnectAsync(new Uri("wss://pipeline.vrchat.cloud/?authToken=" + Uri.EscapeDataString(auth)), timeout.Token); }
                var queue = Channel.CreateBounded<string>(new BoundedChannelOptions(4096) { FullMode = BoundedChannelFullMode.Wait, SingleReader = true, SingleWriter = true });
                reader = Receive(socket, queue.Writer, connection.Token);
                baseline(await Friends(connection.Token));
                // Events buffered while building the snapshot establish the baseline silently.
                while (queue.Reader.TryRead(out var buffered)) message(buffered, true);
                status("实时监控中 · 关闭窗口后仍会在托盘运行");
                failures = 0;
                await foreach (var raw in queue.Reader.ReadAllAsync(connection.Token)) message(raw, false);
                throw new IOException("实时连接已断开。");
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (ApiException ex) when (ex.Status is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            { status(ex.Message); return; }
            catch (Exception ex)
            {
                failures++;
                var seconds = Math.Min(120, 5 * (1 << Math.Min(failures - 1, 5)));
                if (ex is ApiException limited && limited.Status == HttpStatusCode.TooManyRequests) seconds = 120;
                status((ex is ApiException ? ex.Message : "网络连接中断。") + $" {seconds} 秒后重连；好友状态暂时未知。");
                connection.Cancel();
                if (reader != null) try { await reader; } catch { }
                try { await Task.Delay(TimeSpan.FromSeconds(seconds), ct); } catch (OperationCanceledException) { break; }
            }
            finally { connection.Cancel(); if (reader != null) try { await reader; } catch { } }
        }
    }
    static async Task Receive(ClientWebSocket socket, ChannelWriter<string> writer, CancellationToken ct)
    {
        try
        {
            var buffer = new byte[8192];
            while (!ct.IsCancellationRequested)
            {
                using var stream = new MemoryStream();
                WebSocketReceiveResult result;
                do
                {
                    result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
                    if (result.MessageType == WebSocketMessageType.Close) throw new IOException("连接关闭。");
                    stream.Write(buffer, 0, result.Count);
                    if (stream.Length > 2 * 1024 * 1024) throw new IOException("实时消息过大。");
                } while (!result.EndOfMessage);
                if (result.MessageType == WebSocketMessageType.Text) await writer.WriteAsync(Encoding.UTF8.GetString(stream.ToArray()), ct);
            }
            writer.TryComplete();
        }
        catch (Exception ex) { writer.TryComplete(ex); }
    }
    public void Dispose() => http.Dispose();
}
