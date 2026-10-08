using System.Net;
using System.Text.Json;

namespace VrcNotify;

static class AuthFailure
{
    // Classify known server messages, but never display or persist arbitrary response text.
    public static string? Message(string path, HttpStatusCode status, JsonElement result, bool passwordLogin)
    {
        if (path != "auth/user" && !path.StartsWith("auth/twofactorauth/", StringComparison.Ordinal)) return null;
        var message = "";
        if (result.ValueKind == JsonValueKind.Object)
        {
            if (result.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.Object) message = PresenceTracker.Str(error, "message");
            else message = PresenceTracker.Str(result, "message");
        }
        bool Has(string value) => message.Contains(value, StringComparison.OrdinalIgnoreCase);
        if (status is HttpStatusCode.Unauthorized or HttpStatusCode.TooManyRequests && (Has("somewhere new") || Has("too many places") || Has("verification link") || Has("login location")))
            return "VRChat 要求确认新的登录地点。请打开邮箱中的验证链接，再重新登录；此步骤不是输入两步验证码。";
        if (status == HttpStatusCode.Unauthorized && passwordLogin)
        {
            if (Has("Invalid Username") || Has("Invalid Credentials") || Has("Authentication failed"))
                return "账号验证失败（HTTP 401）：请使用注册用户名或邮箱及账号密码，显示名称不能用于登录。尚未进入两步验证。";
            if (Has("Missing Credentials")) return "账号验证失败（HTTP 401）：服务器未接受登录凭据，尚未进入两步验证。可尝试浏览器登录。";
            return "账号登录请求被拒绝（HTTP 401），未收到可识别的两步验证请求。请确认注册用户名或邮箱，或尝试浏览器登录。";
        }
        if (path.StartsWith("auth/twofactorauth/", StringComparison.Ordinal) && status is HttpStatusCode.Unauthorized or HttpStatusCode.BadRequest)
            return Has("Missing Credentials") ? "验证会话已失效，请重新进行账号登录。" : "两步验证码未通过，请检查验证方式并重新输入。";
        return null;
    }
}
