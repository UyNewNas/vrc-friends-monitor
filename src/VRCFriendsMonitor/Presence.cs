using System.Text.Json;

namespace VrcNotify;

enum Presence { Offline, Web, Game }
record Friend(string Id, string Name, Presence State);
record Change(Friend Friend, bool Online);
class Rule { public bool Online { get; set; } public bool Offline { get; set; } }

class PresenceTracker
{
    public Dictionary<string, Friend> Friends { get; } = new();
    public static string Str(JsonElement obj, string key) => obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
    public static Presence ParseState(JsonElement user, bool offline = false)
    {
        if (offline) return Presence.Offline;
        var state = Str(user, "state");
        if (state == "online") return Presence.Game;
        if (state == "active") return Presence.Web;
        if (state == "offline") return Presence.Offline;
        var loc = Str(user, "location");
        return loc is "offline" or "" ? Presence.Offline : loc == "online" ? Presence.Web : Presence.Game;
    }
    public void Baseline(IEnumerable<Friend> friends)
    {
        Friends.Clear();
        foreach (var friend in friends) Friends[friend.Id] = friend;
    }
    public Change? Apply(string message)
    {
        using var doc = JsonDocument.Parse(message);
        var root = doc.RootElement;
        if (root.TryGetProperty("err", out _)) throw new IOException("实时连接被服务器拒绝，请重新登录或检查网络。");
        var type = Str(root, "type");
        if (!type.StartsWith("friend-", StringComparison.Ordinal) || !root.TryGetProperty("content", out var body)) return null;
        using var inner = body.ValueKind == JsonValueKind.String ? JsonDocument.Parse(body.GetString()!) : null;
        if (inner != null) body = inner.RootElement;
        var id = Str(body, "userId");
        if (id.Length == 0) id = Str(body, "userid");
        if (id.Length == 0) return null;
        if (type == "friend-delete") { Friends.Remove(id); return null; }
        Friends.TryGetValue(id, out var old);
        var name = body.TryGetProperty("user", out var user) ? Str(user, "displayName") : "";
        if (name.Length == 0) name = old?.Name ?? id;
        var state = type switch
        {
            "friend-online" => Presence.Game,
            "friend-offline" => Presence.Offline,
            "friend-active" => Presence.Web,
            "friend-add" => ParseState(user),
            _ => old?.State ?? Presence.Offline
        };
        var friend = new Friend(id, name, state);
        Friends[id] = friend;
        // Website presence is not an in-game login. Game -> website is a game logout.
        if (type is "friend-add" or "friend-update" or "friend-location") return null;
        if ((old?.State == Presence.Game) == (state == Presence.Game)) return null;
        return new Change(friend, state == Presence.Game);
    }
}
