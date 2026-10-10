using System.Net;
using System.Text;
using System.Text.Json;

namespace VrcNotify;

static class LoginFlowTest
{
    const string Username = "synthetic-user", Password = "synthetic-password";
    const string UserJson = "{\"id\":\"usr_synthetic\",\"displayName\":\"Synthetic\"}";
    public static void Run(string output)
    {
        var results = new List<string>();
        try
        {
            Preference("empty store starts unchecked and password remains masked", null, (form, store) =>
                Require(form.FilledUsername == "" && form.FilledPassword == "" && !form.RemembersCredentials && form.PasswordMasked && store.SaveCalls == 0));
            Preference("saved account prefills username and masked password", OldCredentials(), (form, store) =>
                Require(form.FilledUsername == "synthetic-old" && form.FilledPassword == "synthetic-old-password" && form.RemembersCredentials && form.PasswordMasked && store.SaveCalls == 0));
            Preference("changing the saved username clears the autofilled password", OldCredentials(), (form, store) =>
            {
                form.TestSetUsername("synthetic-other");
                Require(form.FilledUsername == "synthetic-other" && form.FilledPassword == "" && store.Value?.Username == "synthetic-old" && store.SaveCalls == 0);
            });
            Preference("unchecking forgets the saved account immediately and keeps current input", OldCredentials(), (form, store) =>
            {
                form.TestSetRemember(false);
                Require(store.Value == null && store.DeleteCalls == 1 && !form.RemembersCredentials && form.FilledUsername == "synthetic-old" && form.FilledPassword == "synthetic-old-password");
                using var reopened = Dialog(store);
                Require(reopened.FilledUsername == "" && reopened.FilledPassword == "" && !reopened.RemembersCredentials);
            });
            Preference("forget action clears the saved account and both inputs", OldCredentials(), (form, store) =>
            {
                form.TestForgetCredentials();
                Require(store.Value == null && store.DeleteCalls == 1 && form.FilledUsername == "" && form.FilledPassword == "" && !form.RemembersCredentials);
            });
            foreach (bool forget in new[] { false, true })
                Preference(forget ? "failed forget keeps the saved account and explains failure" : "failed delete preserves the user's unchecked preference", OldCredentials(), (form, store) =>
                {
                    store.FailDelete = true;
                    if (forget) form.TestForgetCredentials(); else form.TestSetRemember(false);
                    Require(store.Value?.Username == "synthetic-old" && form.RemembersCredentials == forget && form.Feedback.Contains("无法删除") && !form.Feedback.Contains("synthetic-private"));
                });
            var unreadable = new FakeCredentialStore { FailLoad = true };
            using (var form = Dialog(unreadable))
            {
                Require(form.FilledUsername == "" && form.FilledPassword == "" && !form.RemembersCredentials && form.Feedback.Contains("无法读取") && !form.Feedback.Contains("synthetic-private"));
                results.Add("PASS: unreadable credentials leave a usable empty login dialog");
            }

            Challenge("200 authenticator challenge opens owned dialog", HttpStatusCode.OK, "{\"requiresTwoFactorAuth\":[\"totp\"]}", "totp");
            Challenge("401 email challenge opens owned dialog", HttpStatusCode.Unauthorized, "{\"requiresTwoFactorAuth\":[\"emailOtp\"]}", "emailotp");
            Challenge("failed code retries in a new dialog then accepts recovery", HttpStatusCode.OK, "{\"requiresTwoFactorAuth\":[\"totp\"]}", "totp", retry: true);
            Challenge("wrapped case-insensitive challenge opens dialog", HttpStatusCode.OK, "{\"data\":{\"RequiresTwoFactorAuth\":\"emailOtp\"}}", "emailotp");
            Challenge("invalid credentials stop before 2FA without overwriting saved credentials", HttpStatusCode.Unauthorized, "{\"error\":{\"message\":\"Invalid Username/Email or Password\"}}", null, expectedError: "尚未进入两步验证");
            Challenge("new-location verification keeps saved credentials and explains email link", HttpStatusCode.Unauthorized, "{\"error\":{\"message\":\"It looks like you're logging in from somewhere new! Check your email for a message from VRChat.\"}}", null, expectedError: "邮箱中的验证链接");
            Challenge("expired verification session stops retry without saving", HttpStatusCode.OK, "{\"requiresTwoFactorAuth\":[\"totp\"]}", "totp", expectedError: "验证会话已失效", expired: true);
            Challenge("cancelled 2FA preserves the previous saved account and saves no session", HttpStatusCode.OK, "{\"requiresTwoFactorAuth\":[\"totp\"]}", "totp", cancel: true);
            Challenge("unsupported 2FA cannot save partial credentials", HttpStatusCode.OK, "{\"requiresTwoFactorAuth\":[]}", null, expectedError: "暂不支持");
            Challenge("rate limited login leaves saved credentials unchanged", HttpStatusCode.TooManyRequests, "{}", null, expectedError: "请求过于频繁");

            PasswordSuccess("unchecked login saves only its validated session", false);
            PasswordSuccess("successful login replaces saved credentials and preserves password whitespace", true);
            PersistenceFailure(false);
            PersistenceFailure(true);
            UnreadableCredentialsLogin(false);
            UnreadableCredentialsLogin(true);
            FailedUncheckLogin();
            BrowserScenario(false);
            BrowserScenario(true);
            File.WriteAllLines(output, results); Environment.ExitCode = 0;
        }
        catch (Exception ex) { results.Add("FAIL: " + ex.Message); File.WriteAllLines(output, results); Environment.ExitCode = 1; }

        void Preference(string name, SavedCredentials? initial, Action<LoginDialog, FakeCredentialStore> check)
        {
            var store = new FakeCredentialStore { Value = initial };
            using var form = Dialog(store);
            try { check(form, store); } catch (Exception ex) { throw new InvalidOperationException(name, ex); }
            results.Add("PASS: " + name);
        }
        void Challenge(string name, HttpStatusCode status, string challenge, string? method, bool retry = false, string? expectedError = null, bool expired = false, bool cancel = false)
        {
            int loginCalls = 0, verifyCalls = 0, prompts = 0, saved = 0;
            bool authenticated = false;
            var store = new FakeCredentialStore { Value = OldCredentials(), BeforeSave = _ => Require(authenticated) };
            using var form = Dialog(store, () => new VrcApi("auth=synthetic-partial", new Handler(async request =>
            {
                await Task.Delay(30);
                var path = request.RequestUri!.AbsolutePath;
                if (path.EndsWith("/auth/user"))
                {
                    if (loginCalls++ == 0) return Response(status, challenge);
                    authenticated = true;
                    return Response(HttpStatusCode.OK, UserJson);
                }
                verifyCalls++;
                Require(saved == 0 && store.SaveCalls == 0);
                if (expired) return Response(HttpStatusCode.Unauthorized, "{\"error\":{\"message\":\"Missing Credentials\"}}");
                var expected = retry && verifyCalls == 2 ? "otp" : method;
                Require(path.EndsWith($"/{expected}/verify") && request.Method == HttpMethod.Post);
                Require((await request.Content!.ReadAsStringAsync()).Contains("synthetic-code"));
                return Response(HttpStatusCode.OK, retry && verifyCalls == 1 ? "{\"verified\":false}" : "{\"verified\":true}");
            })), _ => { Require(authenticated); saved++; });
            RunDialog(name, form, async () =>
            {
                await form.TestAccountLogin(rememberCredentials: true);
                if (expectedError != null || cancel)
                    Require(form.User == null && saved == 0 && store.SaveCalls == 0 && store.Value?.Username == "synthetic-old" && form.Feedback.Contains(expectedError ?? "取消") && prompts == (expired || cancel ? 1 : 0));
                else
                    Require(form.User?.Id == "usr_synthetic" && saved == 1 && store.SaveCalls == 1 && store.Value?.Username == Username && store.Value.Password == Password && prompts == (retry ? 2 : 1) && verifyCalls == prompts);
            }, code =>
            {
                Require(saved == 0 && store.SaveCalls == 0);
                prompts++;
                if (cancel) code.DialogResult = DialogResult.Cancel;
                else code.TestSubmit(retry && prompts == 2 ? "otp" : method!, "synthetic-code");
            });
            results.Add("PASS: " + name);
        }
        void PasswordSuccess(string name, bool remember)
        {
            const string loginName = "  synthetic+测试@example.invalid  ", loginPassword = "  synthetic-p:ass 密码  ";
            int requests = 0, saved = 0;
            var store = new FakeCredentialStore { Value = remember ? OldCredentials() : null };
            Func<VrcApi> create = () => new VrcApi("auth=synthetic-auth", new Handler(request =>
            {
                Require(request.RequestUri!.AbsolutePath.EndsWith("/auth/user"));
                Require(request.Headers.Authorization?.Scheme == "Basic");
                var supplied = Encoding.UTF8.GetString(Convert.FromBase64String(request.Headers.Authorization!.Parameter!));
                Require(supplied == Uri.EscapeDataString(loginName.Trim()) + ":" + Uri.EscapeDataString(loginPassword));
                requests++;
                return Task.FromResult(Response(HttpStatusCode.OK, UserJson));
            }));
            using (var form = Dialog(store, create, _ => saved++))
                RunDialog(name, form, async () =>
                {
                    await form.TestAccountLogin(loginName, loginPassword, remember);
                    Require(form.User?.Id == "usr_synthetic" && saved == 1 && requests == 1 && store.SaveCalls == (remember ? 1 : 0));
                    if (remember) Require(store.Value?.Username == loginName.Trim() && store.Value.Password == loginPassword);
                    else Require(store.Value == null);
                });
            if (remember)
            {
                using var reopened = Dialog(store, create, _ => saved++);
                Require(reopened.FilledUsername == loginName.Trim() && reopened.FilledPassword == loginPassword && reopened.RemembersCredentials && reopened.PasswordMasked);
                RunDialog(name + " after reopening", reopened, async () =>
                {
                    await reopened.TestFilledAccountLogin();
                    Require(reopened.User?.Id == "usr_synthetic" && saved == 2 && requests == 2 && store.Value?.Password == loginPassword);
                });
            }
            results.Add("PASS: " + name);
        }
        void PersistenceFailure(bool sessionFailure)
        {
            string name = sessionFailure ? "session save failure keeps authenticated login and remembers credentials" : "credential save failure keeps authenticated login and the old saved account";
            var store = new FakeCredentialStore { Value = OldCredentials(), FailSave = !sessionFailure };
            int saved = 0;
            using var form = Dialog(store, () => new VrcApi("auth=synthetic-auth", new Handler(_ => Task.FromResult(Response(HttpStatusCode.OK, UserJson)))), _ =>
            {
                saved++;
                if (sessionFailure) throw new IOException("synthetic-private-session-error");
            });
            RunDialog(name, form, async () =>
            {
                await form.TestAccountLogin(rememberCredentials: true);
                var warning = form.PersistenceWarning ?? "";
                Require(form.User?.Id == "usr_synthetic" && form.Api != null && saved == 1 && warning.Contains(sessionFailure ? "会话" : "账号密码") && !warning.Contains("synthetic-private"));
                Require(store.Value?.Username == (sessionFailure ? Username : "synthetic-old"));
            });
            results.Add("PASS: " + name);
        }
        void UnreadableCredentialsLogin(bool deleteFailure)
        {
            string name = deleteFailure ? "unreadable credential cleanup failure warns without blocking login" : "unchecked successful login removes unreadable old credentials";
            var store = new FakeCredentialStore { Value = OldCredentials(), FailLoad = true, FailDelete = deleteFailure };
            int saved = 0;
            using var form = Dialog(store, () => new VrcApi("auth=synthetic-auth", new Handler(_ => Task.FromResult(Response(HttpStatusCode.OK, UserJson)))), _ => saved++);
            RunDialog(name, form, async () =>
            {
                await form.TestAccountLogin();
                Require(form.User?.Id == "usr_synthetic" && form.Api != null && saved == 1 && store.DeleteCalls == 1 && store.SaveCalls == 0);
                if (deleteFailure)
                {
                    var warning = form.PersistenceWarning ?? "";
                    Require(store.Value?.Username == "synthetic-old" && warning.Contains("无法删除") && warning.Contains("账号密码") && !warning.Contains("synthetic-private"));
                }
                else Require(store.Value == null && form.PersistenceWarning == null);
            });
            results.Add("PASS: " + name);
        }
        void FailedUncheckLogin()
        {
            const string name = "failed unchecked deletion retries cleanup without saving credentials after login";
            var store = new FakeCredentialStore { Value = OldCredentials(), FailDelete = true };
            int saved = 0;
            using var form = Dialog(store, () => new VrcApi("auth=synthetic-auth", new Handler(_ => Task.FromResult(Response(HttpStatusCode.OK, UserJson)))), _ => saved++);
            form.TestSetRemember(false);
            Require(!form.RemembersCredentials);
            RunDialog(name, form, async () =>
            {
                await form.TestFilledAccountLogin();
                var warning = form.PersistenceWarning ?? "";
                Require(form.User?.Id == "usr_synthetic" && saved == 1 && store.SaveCalls == 0 && store.DeleteCalls == 2 && store.Value?.Username == "synthetic-old" && warning.Contains("无法删除") && warning.Contains("账号密码"));
            });
            results.Add("PASS: " + name);
        }
        void BrowserScenario(bool cancel)
        {
            string name = cancel ? "interrupted browser login leaves saved credentials and session untouched" : "browser login never saves the account password from the form";
            var store = new FakeCredentialStore { Value = OldCredentials() };
            int saved = 0, browserCalls = 0;
            using var form = Dialog(store, saveSession: _ => saved++, browserSignIn: async ct =>
            {
                browserCalls++;
                await Task.Delay(30, ct);
                if (cancel) throw new OperationCanceledException();
                using var user = JsonDocument.Parse(UserJson);
                return (new VrcApi("auth=synthetic-browser", new Handler(_ => throw new InvalidOperationException("Unexpected API request"))), user.RootElement.Clone());
            });
            RunDialog(name, form, async () =>
            {
                await form.TestBrowserLogin();
                Require(browserCalls == 1 && store.SaveCalls == 0 && store.Value?.Username == "synthetic-old" && saved == (cancel ? 0 : 1));
                Require(cancel ? form.User == null : form.User?.Id == "usr_synthetic");
            });
            results.Add("PASS: " + name);
        }
    }
    static LoginDialog Dialog(FakeCredentialStore store, Func<VrcApi>? createApi = null, Action<string>? saveSession = null, Func<CancellationToken, Task<(VrcApi Api, JsonElement User)>>? browserSignIn = null) =>
        new(createApi ?? (() => throw new InvalidOperationException("Unexpected account login")), saveSession ?? (_ => throw new InvalidOperationException("Unexpected session write")), store,
            browserSignIn ?? (_ => Task.FromException<(VrcApi Api, JsonElement User)>(new InvalidOperationException("Unexpected browser login"))))
        { Opacity = 0, ShowInTaskbar = false, SilentTest = true };
    static void RunDialog(string name, LoginDialog form, Func<Task> check, Action<CodeDialog>? submit = null)
    {
        Exception? failure = null;
        bool completed = false;
        var started = DateTime.UtcNow;
        using var timer = new System.Windows.Forms.Timer { Interval = 30 };
        timer.Tick += (_, _) =>
        {
            var code = Application.OpenForms.OfType<CodeDialog>().SingleOrDefault();
            try
            {
                if (DateTime.UtcNow - started > TimeSpan.FromSeconds(10)) throw new TimeoutException(name);
                if (code == null || !code.Visible) return;
                Require(code.Owner == form && submit != null);
                submit!(code);
            }
            catch (Exception ex)
            {
                failure ??= ex;
                if (code != null) code.DialogResult = DialogResult.Cancel;
                if (!form.IsDisposed) form.Close();
            }
        };
        form.Shown += async (_, _) =>
        {
            try { await check(); }
            catch (Exception ex) { failure ??= ex; }
            finally { completed = true; form.Api?.Dispose(); if (!form.IsDisposed) form.Close(); }
        };
        timer.Start(); Application.Run(form); timer.Stop();
        if (failure != null || !completed) throw new InvalidOperationException(name, failure);
    }
    static void Require(bool pass)
    { if (!pass) throw new InvalidOperationException("Login expectation failed; synthetic test data only."); }
    static SavedCredentials OldCredentials() => new("synthetic-old", "synthetic-old-password");
    static HttpResponseMessage Response(HttpStatusCode status, string json) => new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
    sealed class Handler(Func<HttpRequestMessage, Task<HttpResponseMessage>> respond) : HttpMessageHandler
    { protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) => respond(request); }
    sealed class FakeCredentialStore : ICredentialStore
    {
        public SavedCredentials? Value;
        public bool FailLoad, FailSave, FailDelete;
        public int SaveCalls, DeleteCalls;
        public Action<SavedCredentials>? BeforeSave;
        public SavedCredentials? Load() => FailLoad ? throw new IOException("synthetic-private-load-error") : Value;
        public void Save(SavedCredentials credentials)
        {
            SaveCalls++;
            BeforeSave?.Invoke(credentials);
            if (FailSave) throw new IOException("synthetic-private-save-error");
            Value = credentials;
        }
        public void Delete()
        {
            DeleteCalls++;
            if (FailDelete) throw new IOException("synthetic-private-delete-error");
            Value = null;
        }
    }
}
