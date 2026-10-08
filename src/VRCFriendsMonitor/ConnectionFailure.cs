using System.Net.Sockets;
using System.Net.WebSockets;

namespace VrcNotify;

static class ConnectionFailure
{
    // Never include exception messages: WebSocket errors can contain the authentication URL.
    public static string Code(Exception error)
    {
        if (error is ApiException api) return "HTTP " + (int)api.Status;
        if (error is OperationCanceledException) return "TimeoutOrCancelled";
        for (Exception? current = error; current != null; current = current.InnerException)
        {
            if (current is SocketException socket) return "Socket." + socket.SocketErrorCode;
            if (current is HttpRequestException http) return "HTTP." + http.HttpRequestError + (http.StatusCode.HasValue ? "." + (int)http.StatusCode.Value : "");
        }
        if (error is WebSocketException ws) return "WebSocket." + ws.WebSocketErrorCode;
        if (error.InnerException != null) return error.GetType().Name + "/" + error.InnerException.GetType().Name;
        return error.GetType().Name;
    }
    public static string Describe(string stage, Exception error, int httpStatus = 0)
    {
        var label = stage switch { "Session" => "登录会话检查", "ConnectSocket" => "实时连接", "SyncFriends" => "好友列表加载", "Live" => "实时消息处理", _ => "监控" };
        if (error is ApiException api) return label + "失败：" + api.Message;
        var code = Code(error);
        if (code.Contains("HostNotFound") || code.Contains("NameResolutionError")) return label + "失败：服务域名解析失败。";
        if (error is OperationCanceledException) return label + "超时。";
        if (httpStatus >= 400) return label + $"被服务器拒绝（HTTP {httpStatus}）。";
        return label + $"失败（{code}）。";
    }
    public static void Report(string stage, Exception? error = null, int httpStatus = 0)
    {
        try
        {
            Directory.CreateDirectory(Storage.DirectoryPath);
            File.WriteAllText(Path.Combine(Storage.DirectoryPath, "connection-status.json"), System.Text.Json.JsonSerializer.Serialize(new { time = DateTimeOffset.Now, stage, code = error == null ? "OK" : Code(error), httpStatus }));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }
}
