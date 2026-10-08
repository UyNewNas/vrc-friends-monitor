using System.Reflection;

namespace VrcNotify;

static class AppVersion
{
    public static string Current { get; } = typeof(AppVersion).Assembly
        .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Split('+')[0]
        ?? typeof(AppVersion).Assembly.GetName().Version?.ToString(3) ?? "unknown";
    public static string Display => "v" + Current;
}
