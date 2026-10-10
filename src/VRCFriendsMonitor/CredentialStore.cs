using System.Security.Cryptography;
using System.Text.Json;

namespace VrcNotify;

sealed class SavedCredentials(string username, string password)
{
    public string Username { get; } = username;
    public string Password { get; } = password;
    public override string ToString() => nameof(SavedCredentials);
}

interface ICredentialStore
{
    SavedCredentials? Load();
    void Save(SavedCredentials credentials);
    void Delete();
}

sealed class CredentialStore : ICredentialStore
{
    readonly string directory;
    readonly string path;

    public CredentialStore(string? directoryPath = null)
    {
        directory = directoryPath ?? Storage.DirectoryPath;
        path = Path.Combine(directory, "credentials.bin");
    }

    public SavedCredentials? Load()
    {
        byte[] encrypted;
        try { encrypted = File.ReadAllBytes(path); }
        catch (FileNotFoundException) { return null; }
        catch (DirectoryNotFoundException) { return null; }

        var clear = Storage.Protect(encrypted, true);
        try
        {
            var credentials = JsonSerializer.Deserialize<SavedCredentials>(clear);
            if (credentials == null || string.IsNullOrWhiteSpace(credentials.Username) || string.IsNullOrEmpty(credentials.Password))
                throw new InvalidDataException("Saved credentials are invalid.");
            return credentials;
        }
        finally { CryptographicOperations.ZeroMemory(clear); }
    }

    public void Save(SavedCredentials credentials)
    {
        ArgumentNullException.ThrowIfNull(credentials);
        if (string.IsNullOrWhiteSpace(credentials.Username) || string.IsNullOrEmpty(credentials.Password))
            throw new ArgumentException("An account name and password are required.", nameof(credentials));

        var clear = JsonSerializer.SerializeToUtf8Bytes(credentials);
        try { Storage.AtomicWrite(path, Storage.Protect(clear, false)); }
        finally { CryptographicOperations.ZeroMemory(clear); }
    }

    public void Delete()
    {
        try
        {
            File.Delete(path);
            File.Delete(path + ".tmp");
            foreach (var temporary in Directory.EnumerateFiles(directory, "credentials.bin.*.tmp"))
                File.Delete(temporary);
        }
        catch (DirectoryNotFoundException) { }
    }
}
