using System.Text.Json;

namespace VrcNotify;

static class AuthChallenge
{
    static JsonElement Factors(JsonElement user)
    {
        if (user.ValueKind != JsonValueKind.Object) return default;
        foreach (var property in user.EnumerateObject())
            if (property.Name.Equals("requiresTwoFactorAuth", StringComparison.OrdinalIgnoreCase)) return property.Value;
        foreach (var name in new[] { "error", "data" })
            if (user.TryGetProperty(name, out var nested) && nested.ValueKind == JsonValueKind.Object)
                foreach (var property in nested.EnumerateObject())
                    if (property.Name.Equals("requiresTwoFactorAuth", StringComparison.OrdinalIgnoreCase)) return property.Value;
        return default;
    }
    public static bool Required(JsonElement user) => Factors(user).ValueKind != JsonValueKind.Undefined;
    public static string[] Methods(JsonElement user)
    {
        var factors = Factors(user);
        if (factors.ValueKind == JsonValueKind.String)
            factors = JsonSerializer.SerializeToElement(new[] { factors.GetString() });
        if (factors.ValueKind != JsonValueKind.Array) return [];
        var methods = factors.EnumerateArray().Where(v => v.ValueKind == JsonValueKind.String)
            .Select(v => v.GetString()!.ToLowerInvariant()).Where(v => v is "totp" or "emailotp" or "otp").Distinct().ToList();
        if (methods.Contains("totp") && !methods.Contains("otp")) methods.Add("otp");
        return methods.ToArray();
    }
}
