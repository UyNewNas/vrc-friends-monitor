using System.Net;
using System.Text;

namespace VrcNotify;

static class LoginFlowTest
{
    public static void Run(string output)
    {
        var results = new List<string>();
        try
        {
            Scenario("200 authenticator challenge opens owned dialog", HttpStatusCode.OK, "{\"requiresTwoFactorAuth\":[\"totp\"]}", "totp", false, null);
            Scenario("401 email challenge opens owned dialog", HttpStatusCode.Unauthorized, "{\"requiresTwoFactorAuth\":[\"emailOtp\"]}", "emailotp", false, null);
            Scenario("failed code retries in a new dialog then accepts recovery", HttpStatusCode.OK, "{\"requiresTwoFactorAuth\":[\"totp\"]}", "totp", true, null);
            Scenario("wrapped case-insensitive challenge opens dialog", HttpStatusCode.OK, "{\"data\":{\"RequiresTwoFactorAuth\":\"emailOtp\"}}", "emailotp", false, null);
            Scenario("invalid credentials stop before 2FA and explain stage", HttpStatusCode.Unauthorized, "{\"error\":{\"message\":\"Invalid Username/Email or Password\"}}", null, false, "尚未进入两步验证");
            Scenario("new-location verification explains email link", HttpStatusCode.Unauthorized, "{\"error\":{\"message\":\"It looks like you're logging in from somewhere new! Check your email for a message from VRChat.\"}}", null, false, "邮箱中的验证链接");
            Scenario("expired verification session stops retry", HttpStatusCode.OK, "{\"requiresTwoFactorAuth\":[\"totp\"]}", "totp", false, "验证会话已失效", true);
            File.WriteAllLines(output, results);
        }
        catch (Exception ex) { results.Add("FAIL: " + ex.Message); File.WriteAllLines(output, results); Environment.ExitCode = 1; }

        void Scenario(string name, HttpStatusCode status, string challenge, string? method, bool retry, string? expectedError, bool expired = false)
        {
            int loginCalls = 0, verifyCalls = 0, prompts = 0, saved = 0;
            Exception? failure = null;
            using var form = new LoginDialog(() => new VrcApi("auth=synthetic-partial", new Handler(async request =>
            {
                await Task.Delay(30);
                var path = request.RequestUri!.AbsolutePath;
                if (path.EndsWith("/auth/user"))
                {
                    if (loginCalls++ == 0) return Response(status, challenge);
                    return Response(HttpStatusCode.OK, "{\"id\":\"usr_synthetic\",\"displayName\":\"Synthetic\"}");
                }
                verifyCalls++;
                if (expired) return Response(HttpStatusCode.Unauthorized, "{\"error\":{\"message\":\"Missing Credentials\"}}");
                var expected = retry && verifyCalls == 2 ? "otp" : method;
                if (!path.EndsWith($"/{expected}/verify") || request.Method != HttpMethod.Post) throw new InvalidOperationException("Incorrect verification endpoint");
                var body = await request.Content!.ReadAsStringAsync();
                if (!body.Contains("synthetic-code")) throw new InvalidOperationException("Code did not reach verification request");
                return Response(HttpStatusCode.OK, retry && verifyCalls == 1 ? "{\"verified\":false}" : "{\"verified\":true}");
            })), _ => saved++) { Opacity = 0, ShowInTaskbar = false, SilentTest = true };
            var started = DateTime.UtcNow;
            using var timer = new System.Windows.Forms.Timer { Interval = 30 };
            timer.Tick += (_, _) =>
            {
                var code = Application.OpenForms.OfType<CodeDialog>().SingleOrDefault();
                if (DateTime.UtcNow - started > TimeSpan.FromSeconds(10))
                { failure = new TimeoutException(name); if (code != null) code.DialogResult = DialogResult.Cancel; form.Close(); return; }
                if (code == null || !code.Visible) return;
                if (code.Owner != form) { failure = new InvalidOperationException("Verification dialog owner missing"); code.DialogResult = DialogResult.Cancel; return; }
                prompts++;
                code.TestSubmit(retry && prompts == 2 ? "otp" : method!, "synthetic-code");
            };
            form.Shown += async (_, _) =>
            {
                try
                {
                    await form.TestAccountLogin();
                    if (expectedError != null)
                    {
                        if (form.User != null || saved != 0 || !form.Feedback.Contains(expectedError) || prompts != (expired ? 1 : 0)) throw new InvalidOperationException("Incorrect failure stage or partial session saved");
                    }
                    else if (form.User?.Id != "usr_synthetic" || saved != 1 || prompts != (retry ? 2 : 1) || verifyCalls != prompts) throw new InvalidOperationException("Login did not complete through the verification dialog");
                }
                catch (Exception ex) { failure = ex; }
                finally { form.Api?.Dispose(); if (!form.IsDisposed) form.Close(); }
            };
            timer.Start(); Application.Run(form); timer.Stop();
            if (failure != null) throw failure;
            results.Add("PASS: " + name);
        }
    }
    static HttpResponseMessage Response(HttpStatusCode status, string json) => new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
    sealed class Handler(Func<HttpRequestMessage, Task<HttpResponseMessage>> respond) : HttpMessageHandler
    { protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) => respond(request); }
}
