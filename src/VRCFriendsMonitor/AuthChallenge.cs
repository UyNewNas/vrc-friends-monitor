using System.Text.Json;

namespace VrcNotify;

static class AuthChallenge
{
    static JsonElement Factors(JsonElement user)
    {
        if (user.ValueKind != JsonValueKind.Object) return default;
        if (user.TryGetProperty("requiresTwoFactorAuth", out var factors)) return factors;
        return user.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.Object
            && error.TryGetProperty("requiresTwoFactorAuth", out factors) ? factors : default;
    }
    public static bool Required(JsonElement user) => Factors(user).ValueKind != JsonValueKind.Undefined;
    public static string[] Methods(JsonElement user)
    {
        var factors = Factors(user);
        if (factors.ValueKind != JsonValueKind.Array) return [];
        var methods = factors.EnumerateArray().Where(v => v.ValueKind == JsonValueKind.String)
            .Select(v => v.GetString()!.ToLowerInvariant()).Where(v => v is "totp" or "emailotp" or "otp").Distinct().ToList();
        if (methods.Contains("totp") && !methods.Contains("otp")) methods.Add("otp");
        return methods.ToArray();
    }
}
