# ProcDeck's Windows helper. server.js starts it once and keeps it running,
# because each new PowerShell process costs about a second to start.
#
# Protocol: one request per line on stdin, one JSON line back on stdout.
#   list             every process (from WMI) with its owner
#   cwd <pid> ...    working folder of each PID that we can read
#   env <pid> ...    environment block of each PID that we can read
#
# WMI gives no working folder or environment, so the C# class reads them from
# the process environment block (PEB). That works for your own 64-bit processes,
# which covers node, python and the other dev tools ProcDeck cares about.

$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies System.Management -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Management;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

public static class ProcDeck {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicInfo {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadProcessMemory(IntPtr handle, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr handle, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int returned);
    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(IntPtr handle, int infoClass, ref BasicInfo info, int length, out int returned);
    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(IntPtr handle, int infoClass, out IntPtr info, int length, out int returned);

    const uint QUERY_LIMITED = 0x1000;
    const uint VM_READ = 0x10;
    const uint TOKEN_QUERY = 0x8;

    // SID to account name lookups can hit the domain controller, so do each one once.
    static readonly Dictionary<string, string> accounts = new Dictionary<string, string>();

    public static string Handle(string line) {
        string[] parts = line.Trim().Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) return "null";
        if (parts[0] == "list") return List();
        if (parts[0] == "cwd" || parts[0] == "env") {
            bool env = parts[0] == "env";
            StringBuilder sb = new StringBuilder("{");
            bool first = true;
            for (int i = 1; i < parts.Length; i++) {
                int pid;
                if (!int.TryParse(parts[i], out pid)) continue;
                string value = ReadPeb(pid, env);
                if (value == null) continue;
                if (!first) sb.Append(',');
                first = false;
                Str(sb, pid.ToString());
                sb.Append(':');
                Str(sb, value);
            }
            return sb.Append('}').ToString();
        }
        return "{\"error\":\"unknown command\"}";
    }

    static string List() {
        StringBuilder sb = new StringBuilder("[");
        bool first = true;
        string query = "SELECT ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath,CreationDate,WorkingSetSize,KernelModeTime,UserModeTime,SessionId FROM Win32_Process";
        using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(query))
        using (ManagementObjectCollection results = searcher.Get()) {
            foreach (ManagementObject o in results) {
                using (o) {
                    int pid = Convert.ToInt32(o["ProcessId"]);
                    long start = 0;
                    string created = o["CreationDate"] as string;
                    if (created != null) {
                        try {
                            DateTime t = ManagementDateTimeConverter.ToDateTime(created).ToUniversalTime();
                            start = (long)(t - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                        } catch (Exception) { }
                    }
                    if (!first) sb.Append(',');
                    first = false;
                    sb.Append("{\"pid\":").Append(pid);
                    sb.Append(",\"ppid\":").Append(Convert.ToInt64(o["ParentProcessId"] ?? 0));
                    sb.Append(",\"session\":").Append(Convert.ToInt64(o["SessionId"] ?? 0));
                    sb.Append(",\"start\":").Append(start);
                    sb.Append(",\"ws\":").Append(Convert.ToInt64(o["WorkingSetSize"] ?? 0));
                    sb.Append(",\"cpu\":").Append(Convert.ToInt64(o["KernelModeTime"] ?? 0) + Convert.ToInt64(o["UserModeTime"] ?? 0));
                    sb.Append(",\"name\":"); Str(sb, o["Name"] as string);
                    sb.Append(",\"cmd\":"); Str(sb, o["CommandLine"] as string);
                    sb.Append(",\"exe\":"); Str(sb, o["ExecutablePath"] as string);
                    sb.Append(",\"owner\":"); Str(sb, pid > 4 ? Owner(pid) : null);
                    sb.Append('}');
                }
            }
        }
        return sb.Append(']').ToString();
    }

    static string Owner(int pid) {
        IntPtr handle = OpenProcess(QUERY_LIMITED, false, pid);
        if (handle == IntPtr.Zero) return null;
        IntPtr token = IntPtr.Zero;
        try {
            if (!OpenProcessToken(handle, TOKEN_QUERY, out token)) return null;
            int length;
            GetTokenInformation(token, 1, IntPtr.Zero, 0, out length); // 1 = TokenUser
            if (length <= 0) return null;
            IntPtr buffer = Marshal.AllocHGlobal(length);
            try {
                if (!GetTokenInformation(token, 1, buffer, length, out length)) return null;
                SecurityIdentifier sid = new SecurityIdentifier(Marshal.ReadIntPtr(buffer));
                string name;
                if (!accounts.TryGetValue(sid.Value, out name)) {
                    try { name = sid.Translate(typeof(NTAccount)).Value; } catch (Exception) { name = sid.Value; }
                    accounts[sid.Value] = name;
                }
                return name;
            } finally {
                Marshal.FreeHGlobal(buffer);
            }
        } finally {
            if (token != IntPtr.Zero) CloseHandle(token);
            CloseHandle(handle);
        }
    }

    static byte[] Read(IntPtr handle, long address, int size) {
        byte[] buffer = new byte[size];
        IntPtr read;
        if (!ReadProcessMemory(handle, new IntPtr(address), buffer, new IntPtr(size), out read)) return null;
        return read.ToInt64() == size ? buffer : null;
    }

    // Offsets are for 64-bit processes. 32-bit (WOW64) processes keep a second,
    // 32-bit PEB with other offsets, so they are skipped.
    static string ReadPeb(int pid, bool env) {
        if (IntPtr.Size != 8) return null;
        IntPtr handle = OpenProcess(QUERY_LIMITED | VM_READ, false, pid);
        if (handle == IntPtr.Zero) return null;
        try {
            int returned;
            IntPtr wow64;
            if (NtQueryInformationProcess(handle, 26, out wow64, IntPtr.Size, out returned) != 0 || wow64 != IntPtr.Zero) return null;
            BasicInfo info = new BasicInfo();
            if (NtQueryInformationProcess(handle, 0, ref info, Marshal.SizeOf(info), out returned) != 0) return null;
            byte[] peb = Read(handle, info.PebBaseAddress.ToInt64() + 0x20, 8); // PEB.ProcessParameters
            if (peb == null) return null;
            long parameters = BitConverter.ToInt64(peb, 0);
            byte[] p = Read(handle, parameters, 0x400);
            if (p == null) return null;
            if (!env) {
                // CurrentDirectory.DosPath is a UNICODE_STRING: length, then buffer pointer.
                int length = BitConverter.ToUInt16(p, 0x38);
                if (length == 0) return null;
                byte[] text = Read(handle, BitConverter.ToInt64(p, 0x40), length);
                if (text == null) return null;
                string cwd = Encoding.Unicode.GetString(text);
                return cwd.Length > 3 ? cwd.TrimEnd('\\') : cwd;
            }
            long block = BitConverter.ToInt64(p, 0x80);
            long size = BitConverter.ToInt64(p, 0x3F0); // EnvironmentSize
            if (size <= 0 || size > 4 * 1024 * 1024) return null;
            byte[] data = Read(handle, block, (int)size);
            return data == null ? null : Encoding.Unicode.GetString(data).TrimEnd('\0');
        } finally {
            CloseHandle(handle);
        }
    }

    static void Str(StringBuilder sb, string s) {
        if (s == null) { sb.Append("null"); return; }
        sb.Append('"');
        foreach (char c in s) {
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else if (c < 0x20 || char.IsSurrogate(c)) sb.AppendFormat("\\u{0:x4}", (int)c);
            else sb.Append(c);
        }
        sb.Append('"');
    }
}
'@

[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try {
    $reply = [ProcDeck]::Handle($line)
  } catch {
    $reply = '{"error":' + (ConvertTo-Json -Compress -InputObject $_.Exception.Message) + '}'
  }
  [Console]::Out.WriteLine($reply)
  [Console]::Out.Flush()
}
