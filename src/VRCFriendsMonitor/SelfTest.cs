using System.Text;
using System.Text.Json;

namespace VrcNotify;

static class SelfTest
{
    public static void Run(string output)
    {
        var results = new List<string>();
        void Check(bool pass, string name) { if (!pass) throw new InvalidOperationException("FAIL: " + name); results.Add("PASS: " + name); }
        string Event(string type, string id = "u", bool encoded = true) => JsonSerializer.Serialize(new { type, content = (object)(encoded ? JsonSerializer.Serialize(new { userId = id, user = new { displayName = "好友 A" } }) : new { userId = id, user = new { displayName = "好友 A" } }) });
        try
        {
            var tracker = new PresenceTracker(); tracker.Baseline(new[] { new Friend("u", "好友 A", Presence.Offline) });
            Check(tracker.Apply(Event("friend-active")) == null && tracker.Friends["u"].State == Presence.Web, "website active is not game login");
            Check(tracker.Apply(Event("friend-online")) is { Online: true }, "double encoded in-game login");
            Check(tracker.Apply(Event("friend-online")) == null, "duplicate login suppressed");
            Check(tracker.Apply(Event("friend-location")) == null, "world change does not notify");
            Check(tracker.Apply(Event("friend-update")) == null && tracker.Friends["u"].State == Presence.Game, "profile updates preserve game presence");
            Check(tracker.Apply(Event("friend-active", encoded: false)) is { Online: false }, "game to web counts as game logout");
            Check(tracker.Apply(Event("friend-offline")) == null, "website to offline does not repeat logout");
            Check(tracker.Apply(Event("friend-online", encoded: false)) is { Online: true }, "object content format supported");
            Check(tracker.Apply(Event("friend-offline")) is { Online: false }, "game logout detected");
            Check(tracker.Apply(Event("friend-offline")) == null, "duplicate logout suppressed");
            tracker.Baseline(new[] { new Friend("u", "好友 A", Presence.Game) });
            Check(tracker.Apply(Event("friend-online")) == null, "reconnect baseline suppresses existing online friends");
            Check(tracker.Apply("{\"type\":\"friend-active\",\"content\":\"{\\\"userid\\\":\\\"u\\\"}\"}") is { Online: false }, "lowercase userid accepted");
            Check(tracker.Apply(Event("friend-delete")) == null && tracker.Friends.Count == 0, "deleted friends removed");
            Check(tracker.Apply(Event("friend-add")) == null, "new friendship is not a login notification");
            Check(tracker.Apply("{\"type\":\"notification\",\"content\":\"not_id\"}") == null, "unrelated notifications ignored");
            using var web = JsonDocument.Parse("{\"location\":\"online\"}"); Check(PresenceTracker.ParseState(web.RootElement) == Presence.Web, "REST website presence classified");
            using var priv = JsonDocument.Parse("{\"location\":\"private\"}"); Check(PresenceTracker.ParseState(priv.RootElement) == Presence.Game, "private location classified as game");
            var clear = Encoding.UTF8.GetBytes("auth=test-session; twoFactorAuth=test-2fa"); var encrypted = Storage.Protect(clear, false);
            Check(!clear.SequenceEqual(encrypted) && clear.SequenceEqual(Storage.Protect(encrypted, true)), "Windows DPAPI encrypted session roundtrip");
            var settings = new Settings(); settings.Accounts["account-A"] = new() { ["u"] = new Rule { Online = true, Offline = false } }; settings.Accounts["account-B"] = new();
            var restored = JsonSerializer.Deserialize<Settings>(JsonSerializer.Serialize(settings))!;
            Check(restored.Accounts["account-A"]["u"].Online && !restored.Accounts["account-A"]["u"].Offline && restored.Accounts["account-B"].Count == 0, "independent switches and account separation persist");
            ApiTests(Check).GetAwaiter().GetResult();
            Check(ConnectionFailure.Code(new IOException("authToken=synthetic-private")) == "IOException", "connection diagnostics exclude exception text and authentication URLs");
            Check(ConnectionFailure.Describe("SyncFriends", new InvalidOperationException()).StartsWith("好友列表加载失败"), "UI or data failures identify the friend-list stage instead of reporting an outage");
            Check(ConnectionFailure.Describe("ConnectSocket", new System.Net.WebSockets.WebSocketException(), 403).Contains("HTTP 403"), "WebSocket handshake rejection displays only its safe HTTP status");
            LogTests(Check, output);
            File.WriteAllLines(output, results); Environment.ExitCode = 0;
        }
        catch (Exception ex) { results.Add(ex.ToString()); File.WriteAllLines(output, results); Environment.ExitCode = 1; }
    }
    static void LogTests(Action<bool, string> check, string output)
    {
        var directory = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(output))!, "log-test-artifacts", Guid.NewGuid().ToString("N"));
        var time = new DateTimeOffset(2026, 10, 7, 23, 59, 58, TimeSpan.FromHours(8));
        var logger = new PresenceLog(directory, () => time);
        var tracker = new PresenceTracker(); tracker.Baseline(new[] { new Friend("usr_a", "好友 A", Presence.Offline) });
        var online = tracker.Apply("{\"type\":\"friend-online\",\"content\":{\"userId\":\"usr_a\",\"user\":{\"displayName\":\"好友 A\"}}}");
        check(logger.Record("account_a", online), "unselected friend login logged without notification rules");
        var day1 = Path.Combine(directory, "2026-10-07.log");
        check(logger.Record("account_a", tracker.Apply("{\"type\":\"friend-online\",\"content\":{\"userId\":\"usr_a\"}}")) && File.ReadAllLines(day1).Length == 1, "duplicate presence events do not create duplicate log entries");
        check(new PresenceLog(directory, () => time).Record("account_a", new Change(new Friend("usr_a", "好友 A", Presence.Offline), false)), "log appends across program restarts");
        var entries = File.ReadAllLines(day1);
        check(entries.Length == 2 && entries[0].Contains("2026-10-07 23:59:58.000 +08:00\t上线\t好友 A\t好友ID=usr_a\t账号ID=account_a") && entries[1].Contains("\t下线\t"), "log stores full timestamp offset, friend name, IDs and both transitions");
        time = time.AddSeconds(5);
        check(logger.Record("account_b", new Change(new Friend("usr_b", "名\n称\t\\", Presence.Game), true), true), "buffered changes log silently while syncing");
        var day2 = File.ReadAllLines(Path.Combine(directory, "2026-10-08.log"));
        check(day2.Length == 1 && day2[0].Contains("名\\n称\\t\\\\") && day2[0].Contains("账号ID=account_b") && day2[0].EndsWith("同步期间收到"), "daily rollover and escaped names keep one entry per change");
        var readDay1 = LogReader.Read(directory, new DateOnly(2026, 10, 7));
        check(readDay1.Total == 2 && readDay1.Entries[0].Action == "下线" && readDay1.Entries[0].FriendId == "usr_a" && readDay1.Entries[0].AccountId == "account_a", "viewer reads existing logs with newest events first and intact IDs");
        var readDay2 = LogReader.Read(directory, new DateOnly(2026, 10, 8));
        check(readDay2.Entries.Single().Name == "名\n称\t\\" && readDay2.Entries.Single().Source == "同步期间收到", "viewer restores escaped names and source labels");
        check(LogReader.Read(directory, new DateOnly(2026, 10, 7), 1).Entries.Single().Action == "下线", "viewer caps display while retaining newest entries");
        File.AppendAllText(day1, "incomplete record" + Environment.NewLine);
        var partial = LogReader.Read(directory, new DateOnly(2026, 10, 7));
        check(partial.Total == 2 && partial.Skipped == 1 && partial.Error == null, "viewer safely ignores malformed or incomplete records");
        var missing = LogReader.Read(directory, new DateOnly(2026, 10, 9));
        check(missing.Total == 0 && missing.Error == null, "viewer shows missing dates as empty history");
        var blocker = Path.Combine(directory, "not-a-directory"); File.WriteAllText(blocker, "test");
        check(!new PresenceLog(blocker, () => time).Record("account_a", online), "unwritable logs fail quietly without crashing monitoring");
    }
    static async Task ApiTests(Action<bool, string> check)
    {
        var calls = new List<string>();
        var handler = new FakeHandler(async request =>
        {
            var path = request.RequestUri!.PathAndQuery; calls.Add(path);
            if (path.EndsWith("auth/user"))
            {
                var decoded = Encoding.UTF8.GetString(Convert.FromBase64String(request.Headers.Authorization!.Parameter!));
                check(decoded == "test%2Bname:p%3Aa%20ss", "username/password individually URL encoded for Basic auth");
                check(request.Headers.UserAgent.ToString().StartsWith("VRCFriendsMonitor/"), "identified user agent provided");
                return Response("{\"id\":\"account\",\"displayName\":\"Tester\"}");
            }
            if (path.Contains("twofactorauth"))
            {
                check(request.Method == HttpMethod.Post && (await request.Content!.ReadAsStringAsync()).Contains("123456"), "2FA POST code payload");
                return Response("{\"verified\":true}");
            }
            if (path.Contains("offline=false") && path.EndsWith("offset=0"))
                return Response(JsonSerializer.Serialize(Enumerable.Range(0, 100).Select(i => new { id = "u" + i, displayName = "Friend " + i, location = "private" })));
            if (path.Contains("offline=false")) return Response("[{\"id\":\"web\",\"displayName\":\"Web\",\"location\":\"online\"}]");
            return Response("[{\"id\":\"off\",\"displayName\":\"Offline\",\"location\":\"offline\"}]");
        });
        using var api = new VrcApi("auth=test; twoFactorAuth=second; unrelated=ignored", handler);
        await api.Login("test+name", "p:a ss"); await api.Verify("emailotp", "123456");
        var friends = await api.Friends(CancellationToken.None);
        check(friends.Count == 102 && friends.Single(f => f.Id == "web").State == Presence.Web && friends.Single(f => f.Id == "off").State == Presence.Offline, "online and offline friend pages merged and classified");
        check(calls.Any(p => p.Contains("offset=100")) && calls.Any(p => p.Contains("offline=true")), "pagination fetches beyond 100 and requests offline friends");
        check(api.Session.Contains("auth=test") && api.Session.Contains("twoFactorAuth=second") && !api.Session.Contains("unrelated"), "only authentication cookies restored");
        using var expired = new VrcApi(testHandler: new FakeHandler(_ => Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.Unauthorized))));
        try { await expired.Request("auth/user"); check(false, "expired session reported"); }
        catch (ApiException ex) { check(ex.Status == System.Net.HttpStatusCode.Unauthorized && !ex.Message.Contains("test-session"), "expired session reported without secret data"); }
        using var badCode = new VrcApi(testHandler: new FakeHandler(_ => Task.FromResult(Response("{\"verified\":false}"))));
        try { await badCode.Verify("totp", "000000"); check(false, "rejected 2FA blocked"); }
        catch (InvalidOperationException) { check(true, "rejected 2FA blocked"); }
        foreach (var status in new[] { System.Net.HttpStatusCode.OK, System.Net.HttpStatusCode.Unauthorized })
        {
            using var challenged = new VrcApi("auth=partial-session", new FakeHandler(_ => Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent("{\"requiresTwoFactorAuth\":[\"totp\",\"emailOtp\"]}") })));
            var user = await challenged.Login("synthetic", "synthetic");
            check(AuthChallenge.Required(user) && AuthChallenge.Methods(user).SequenceEqual(new[] { "totp", "emailotp", "otp" }) && challenged.Session == "auth=partial-session", $"{(int)status} challenge preserves partial session and provides recovery option");
        }
        using var nested = JsonDocument.Parse("{\"error\":{\"requiresTwoFactorAuth\":[\"EMAILOTP\",\"unknown\"]}}");
        check(AuthChallenge.Required(nested.RootElement) && AuthChallenge.Methods(nested.RootElement).SequenceEqual(new[] { "emailotp" }), "nested challenge and supported methods parsed safely");
        using var unsupported = JsonDocument.Parse("{\"requiresTwoFactorAuth\":[]}");
        check(AuthChallenge.Required(unsupported.RootElement) && AuthChallenge.Methods(unsupported.RootElement).Length == 0, "empty challenge cannot bypass authentication");
        using var ordinary = new VrcApi(testHandler: new FakeHandler(_ => Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.Unauthorized) { Content = new StringContent("{\"error\":{\"message\":\"secret must never appear\"}}") })));
        try { await ordinary.Login("synthetic", "wrong"); check(false, "ordinary 401 blocked"); }
        catch (ApiException ex) { check(!ex.Message.Contains("secret"), "ordinary 401 is not a challenge and server payload is not exposed"); }
        int tries = 0;
        using var retry = new VrcApi("auth=partial-session", new FakeHandler(request =>
        {
            if (request.RequestUri!.AbsolutePath.EndsWith("/otp/verify"))
            { tries++; return Task.FromResult(Response(tries == 1 ? "{\"verified\":false}" : "{\"verified\":true}")); }
            return Task.FromResult(Response("{\"id\":\"usr_synthetic\"}"));
        }));
        try { await retry.Verify("otp", "wrong"); } catch (InvalidOperationException) { }
        await retry.Verify("otp", "synthetic-recovery");
        check(tries == 2 && retry.Session == "auth=partial-session" && PresenceTracker.Str(await retry.Request("auth/user"), "id") == "usr_synthetic", "failed recovery code can retry on same session before completing login");
        using var browserCookies = JsonDocument.Parse("{\"cookies\":[{\"domain\":\".vrchat.cloud\",\"name\":\"auth\",\"value\":\"synthetic\"},{\"domain\":\"api.vrchat.cloud\",\"name\":\"twoFactorAuth\",\"value\":\"second\"},{\"domain\":\"vrchat.cloud.evil.invalid\",\"name\":\"auth\",\"value\":\"wrong\"},{\"domain\":\"api.vrchat.cloud\",\"name\":\"unrelated\",\"value\":\"ignored\"},{\"domain\":\"api.vrchat.cloud\",\"name\":\"auth\",\"value\":\"expired\",\"expires\":1}]}");
        check(BrowserLogin.ExtractSession(browserCookies.RootElement) == "auth=synthetic; twoFactorAuth=second", "browser login excludes unrelated, lookalike and expired cookies");
        using var unsafeCookies = JsonDocument.Parse("{\"cookies\":[{\"domain\":\"api.vrchat.cloud\",\"name\":\"auth\",\"value\":\"a; injected=b\"}]}");
        check(BrowserLogin.ExtractSession(unsafeCookies.RootElement) == "", "cookie delimiter injection rejected");
        using var cancellation = new CancellationTokenSource(); cancellation.Cancel();
        try { await retry.Login("synthetic", "synthetic", cancellation.Token); check(false, "cancelled login blocked"); }
        catch (OperationCanceledException) { check(true, "cancelled login blocked"); }
    }
    static HttpResponseMessage Response(string json) => new(System.Net.HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
    sealed class FakeHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> respond) : HttpMessageHandler
    { protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) => respond(request); }
}
