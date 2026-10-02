using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;
using System.Web.Script.Serialization;

internal static class VolumeReader
{
    private const uint GenericRead = 0x80000000;
    private const uint ShareRead = 1;
    private const uint ShareWrite = 2;
    private const uint ShareDelete = 4;
    private const uint OpenExisting = 3;
    private const uint IoctlDiskGetDriveGeometry = 0x00070000;
    private const uint IoctlDiskGetLengthInfo = 0x0007405c;
    private const uint IoctlVolumeGetVolumeDiskExtents = 0x00560000;
    private const uint IoctlStorageQueryProperty = 0x002d1400;
    private const uint FsctlAllowExtendedDasdIo = 0x00090083;
    private const uint FsctlReadUsnJournal = 0x000900bb;
    private const uint FsctlQueryUsnJournal = 0x000900f4;
    private const uint UsnReasonFileDelete = 0x00000200;
    private const uint UsnReasonRenameOldName = 0x00001000;
    private const uint UsnReasonRenameNewName = 0x00002000;
    private const uint JournalReasonMask = UsnReasonFileDelete | UsnReasonRenameOldName | UsnReasonRenameNewName;
    private const int ErrorAccessDenied = 5;
    private const int ErrorInvalidFunction = 1;
    private const int ErrorMoreData = 234;
    private const int ErrorInvalidParameter = 87;
    private const int ErrorJournalDeleteInProgress = 1178;
    private const int ErrorJournalNotActive = 1179;
    private const int ErrorJournalEntryDeleted = 1181;
    private const int MaxRead = 1024 * 1024;
    private const int MinJournalRead = 8;
    private static readonly Regex GuidVolume = new Regex(@"^\\\\\?\\Volume\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}\\?$", RegexOptions.CultureInvariant);
    private static readonly Regex DriveVolume = new Regex(@"^(?:\\\\\.\\)?[a-zA-Z]:$", RegexOptions.CultureInvariant);
    private static readonly Regex PipeName = new Regex(@"^RecoveryChat\.[0-9a-f]{32}$", RegexOptions.CultureInvariant);
    private static readonly Regex SidText = new Regex(@"^S-1-(?:\d+-){1,14}\d+$", RegexOptions.CultureInvariant);
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 };
    private static SafeFileHandle handle;
    private static Snapshot opened;
    private static string openedPath;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeviceIoControl(SafeFileHandle device, uint control, byte[] input, int inputLength, byte[] output, int outputLength, out int returned, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetFilePointerEx(SafeFileHandle file, long distance, out long newPosition, uint moveMethod);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadFile(SafeFileHandle file, byte[] buffer, int count, out int read, IntPtr overlapped);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetVolumeInformation(string root, StringBuilder volumeName, int volumeNameSize, out uint serial, out uint maxComponent, out uint flags, StringBuilder fileSystem, int fileSystemSize);

    private sealed class ProtocolException : Exception
    {
        internal readonly string Code;
        internal ProtocolException(string code, string message) : base(message) { Code = code; }
    }

    private sealed class Snapshot
    {
        internal long Size;
        internal int SectorSize;
        internal uint Serial;
        internal string FileSystem;
        internal string[] DiskIds;
        internal string Storage;
        internal string Identity;
    }

    private static void Main(string[] args)
    {
        try
        {
            if (args.Length == 0)
            {
                Console.InputEncoding = Encoding.UTF8;
                Console.OutputEncoding = new UTF8Encoding(false);
                RunProtocol(Console.In, Console.Out);
                return;
            }
            if (args.Length != 4 || args[0] != "--pipe" || args[2] != "--owner" || !PipeName.IsMatch(args[1]) || !SidText.IsMatch(args[3]))
                throw new ProtocolException("INVALID_ARGUMENT", "Only the secured named-pipe server arguments are supported.");
            RunPipe(args[1], args[3]);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            Environment.ExitCode = 1;
        }
        finally { CloseVolume(); }
    }

    private static void RunPipe(string pipeName, string ownerSid)
    {
        SecurityIdentifier owner = new SecurityIdentifier(ownerSid);
        PipeSecurity security = new PipeSecurity();
        security.SetAccessRuleProtection(true, false);
        security.SetOwner(owner);
        security.AddAccessRule(new PipeAccessRule(owner, PipeAccessRights.FullControl, AccessControlType.Allow));
        using (NamedPipeServerStream pipe = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1,
            PipeTransmissionMode.Byte, PipeOptions.WriteThrough | PipeOptions.Asynchronous, 65536, 65536, security,
            HandleInheritability.None, (PipeAccessRights)0))
        {
            IAsyncResult waiting = pipe.BeginWaitForConnection(null, null);
            if (!waiting.AsyncWaitHandle.WaitOne(TimeSpan.FromSeconds(30))) throw new ProtocolException("PIPE_TIMEOUT", "No authorized client connected in time.");
            pipe.EndWaitForConnection(waiting);
            using (StreamReader reader = new StreamReader(pipe, new UTF8Encoding(false), false, 65536, true))
            using (StreamWriter writer = new StreamWriter(pipe, new UTF8Encoding(false), 65536, true) { AutoFlush = true })
                RunProtocol(reader, writer, delegate
                {
                    string clientSid = null;
                    pipe.RunAsClient(delegate
                    {
                        using (WindowsIdentity client = WindowsIdentity.GetCurrent(true))
                        {
                            if (client != null && client.User != null) clientSid = client.User.Value;
                        }
                    });
                    if (!String.Equals(clientSid, ownerSid, StringComparison.OrdinalIgnoreCase)) throw new ProtocolException("PIPE_CLIENT_DENIED", "The named-pipe client SID does not match the requested owner.");
                });
        }
    }

    private static void RunProtocol(TextReader reader, TextWriter writer, Action authorizeClient = null)
    {
        string line;
        while ((line = reader.ReadLine()) != null)
        {
            // Windows can identify the pipe client after a read. Authorize before dispatching any command.
            if (authorizeClient != null)
            {
                authorizeClient();
                authorizeClient = null;
            }
            string id = null;
            bool close = false;
            IDictionary<string, object> response = new Dictionary<string, object>();
            try
            {
                Dictionary<string, object> request = Json.Deserialize<Dictionary<string, object>>(line);
                id = RequireString(request, "id");
                string command = RequireString(request, "command");
                object result;
                if (command == "hello") result = new Dictionary<string, object> { { "protocol", 1 }, { "role", "readonly-volume-reader" }, { "sessionReuse", true } };
                else if (command == "open") result = Open(request);
                else if (command == "read") result = Read(request);
                else if (command == "queryJournal") result = QueryJournal();
                else if (command == "readJournal") result = ReadJournal(request);
                else if (command == "assert") result = AssertUnchanged();
                else if (command == "release") { CloseVolume(); result = new Dictionary<string, object> { { "released", true } }; }
                else if (command == "close") { CloseVolume(); result = new Dictionary<string, object> { { "closed", true } }; close = true; }
                else throw new ProtocolException("UNKNOWN_COMMAND", "The requested helper command is not supported.");
                response["id"] = id; response["ok"] = true; response["result"] = result;
            }
            catch (Exception error)
            {
                ProtocolException protocol = error as ProtocolException;
                response["id"] = id;
                response["ok"] = false;
                response["error"] = new Dictionary<string, object> {
                    { "code", protocol == null ? "HELPER_FAILED" : protocol.Code }, { "message", error.Message }
                };
            }
            writer.WriteLine(Json.Serialize(response));
            writer.Flush();
            if (close) break;
        }
    }

    private static object Open(Dictionary<string, object> request)
    {
        if (handle != null && !handle.IsClosed) throw new ProtocolException("ALREADY_OPEN", "A volume is already open.");
        string requested = RequireString(request, "path");
        if (!GuidVolume.IsMatch(requested) && !DriveVolume.IsMatch(requested)) throw new ProtocolException("INVALID_DEVICE", "Only a drive letter or Windows volume GUID is accepted.");
        openedPath = NormalizeDevicePath(requested);
        handle = CreateFile(openedPath, GenericRead, ShareRead | ShareWrite | ShareDelete, IntPtr.Zero, OpenExisting, 0, IntPtr.Zero);
        if (handle.IsInvalid)
        {
            int code = Marshal.GetLastWin32Error();
            handle.Dispose(); handle = null;
            throw new ProtocolException(code == ErrorAccessDenied ? "NEEDS_ADMIN" : "OPEN_FAILED", new Win32Exception(code).Message);
        }
        try
        {
            opened = QuerySnapshot(openedPath);
            string[] expected = OptionalStrings(request, "expectedDiskIds");
            if (expected != null && !EqualStrings(Sort(expected), opened.DiskIds)) throw new ProtocolException("DEVICE_CHANGED", "The volume's physical-disk mapping does not match the enumerated selection.");
            // A volume's filesystem capacity can exclude the partition's final
            // sectors. Enable reads of that tail on this GENERIC_READ handle;
            // Read() still enforces the exact queried volume length and alignment.
            int returned;
            if (!DeviceIoControl(handle, FsctlAllowExtendedDasdIo, null, 0, null, 0, out returned, IntPtr.Zero))
            {
                int code = Marshal.GetLastWin32Error();
                throw new ProtocolException(code == ErrorAccessDenied ? "NEEDS_ADMIN" : "EXTENDED_READ_UNAVAILABLE", new Win32Exception(code).Message);
            }
            return SnapshotResult(opened);
        }
        catch { CloseVolume(); throw; }
    }

    private static object Read(Dictionary<string, object> request)
    {
        EnsureOpen();
        long offset = RequireInt64(request, "offset");
        int length = checked((int)RequireInt64(request, "length"));
        if (offset < 0 || length <= 0 || length > MaxRead || offset % opened.SectorSize != 0 || length % opened.SectorSize != 0 || offset > opened.Size - length)
            throw new ProtocolException("INVALID_READ", "Reads must be sector aligned, no larger than 1 MiB, and inside the opened volume.");
        AssertSnapshot();
        long position;
        if (!SetFilePointerEx(handle, offset, out position, 0) || position != offset) throw Win32Protocol("READ_FAILED");
        byte[] data = new byte[length];
        int count;
        if (!ReadFile(handle, data, length, out count, IntPtr.Zero))
        {
            int error = Marshal.GetLastWin32Error();
            throw new ProtocolException(error == ErrorAccessDenied ? "NEEDS_ADMIN" : "READ_FAILED", new Win32Exception(error).Message);
        }
        if (count != length) throw new ProtocolException("SHORT_READ", "Windows returned fewer bytes than requested.");
        return new Dictionary<string, object> { { "data", Convert.ToBase64String(data) }, { "bytesRead", count } };
    }

    private static object QueryJournal()
    {
        EnsureNtfsJournal();
        AssertSnapshot();
        byte[] data = JournalIoctl(FsctlQueryUsnJournal, null, 80, "JOURNAL_QUERY_FAILED");
        if (data.Length < 56) throw new ProtocolException("JOURNAL_QUERY_FAILED", "Windows returned a truncated USN journal description.");
        return new Dictionary<string, object> {
            { "journalId", BitConverter.ToUInt64(data, 0).ToString(System.Globalization.CultureInfo.InvariantCulture) },
            { "firstUsn", BitConverter.ToInt64(data, 8).ToString(System.Globalization.CultureInfo.InvariantCulture) },
            { "nextUsn", BitConverter.ToInt64(data, 16).ToString(System.Globalization.CultureInfo.InvariantCulture) },
            { "lowestValidUsn", BitConverter.ToInt64(data, 24).ToString(System.Globalization.CultureInfo.InvariantCulture) },
            { "maxUsn", BitConverter.ToInt64(data, 32).ToString(System.Globalization.CultureInfo.InvariantCulture) },
            { "maximumSize", BitConverter.ToUInt64(data, 40).ToString(System.Globalization.CultureInfo.InvariantCulture) },
            { "allocationDelta", BitConverter.ToUInt64(data, 48).ToString(System.Globalization.CultureInfo.InvariantCulture) }
        };
    }

    private static object ReadJournal(Dictionary<string, object> request)
    {
        EnsureNtfsJournal();
        long startUsn = RequireNonnegativeInt64String(request, "startUsn");
        ulong journalId = RequireUInt64String(request, "journalId");
        int maxBytes = checked((int)RequireInt64(request, "maxBytes"));
        if (maxBytes < MinJournalRead || maxBytes > MaxRead)
            throw new ProtocolException("INVALID_REQUEST", "The USN journal response limit must be between 8 bytes and 1 MiB.");
        AssertSnapshot();

        // READ_USN_JOURNAL_DATA_V0. The reason mask is intentionally fixed;
        // callers cannot turn this helper into an arbitrary journal endpoint.
        byte[] input = new byte[40];
        Buffer.BlockCopy(BitConverter.GetBytes(startUsn), 0, input, 0, 8);
        Buffer.BlockCopy(BitConverter.GetBytes(JournalReasonMask), 0, input, 8, 4);
        Buffer.BlockCopy(BitConverter.GetBytes((uint)0), 0, input, 12, 4); // ReturnOnlyOnClose
        Buffer.BlockCopy(BitConverter.GetBytes((ulong)0), 0, input, 16, 8); // Timeout
        Buffer.BlockCopy(BitConverter.GetBytes((ulong)0), 0, input, 24, 8); // BytesToWaitFor
        Buffer.BlockCopy(BitConverter.GetBytes(journalId), 0, input, 32, 8);

        byte[] output = JournalIoctl(FsctlReadUsnJournal, input, maxBytes, "JOURNAL_READ_FAILED");
        if (output.Length < MinJournalRead) throw new ProtocolException("JOURNAL_READ_FAILED", "Windows returned a truncated USN journal read.");
        long nextUsn = BitConverter.ToInt64(output, 0);
        if (nextUsn < 0) throw new ProtocolException("JOURNAL_READ_FAILED", "Windows returned an invalid next USN.");
        return new Dictionary<string, object> {
            { "data", Convert.ToBase64String(output) }, { "bytesRead", output.Length },
            { "nextUsn", nextUsn.ToString(System.Globalization.CultureInfo.InvariantCulture) },
            { "reasonMask", JournalReasonMask }
        };
    }

    private static object AssertUnchanged()
    {
        EnsureOpen(); AssertSnapshot();
        return new Dictionary<string, object> { { "unchanged", true }, { "identity", opened.Identity } };
    }

    private static void AssertSnapshot()
    {
        Snapshot current = QuerySnapshot(openedPath);
        if (!String.Equals(current.Identity, opened.Identity, StringComparison.Ordinal) || !EqualStrings(current.DiskIds, opened.DiskIds))
            throw new ProtocolException("DEVICE_CHANGED", "The opened volume identity or physical-disk mapping changed.");
    }

    private static Snapshot QuerySnapshot(string devicePath)
    {
        byte[] length = Ioctl(IoctlDiskGetLengthInfo, null, 8, "LENGTH_QUERY_FAILED");
        byte[] geometry = Ioctl(IoctlDiskGetDriveGeometry, null, 32, "GEOMETRY_QUERY_FAILED");
        long size = BitConverter.ToInt64(length, 0);
        int sectorSize = BitConverter.ToInt32(geometry, 20);
        if (size <= 0 || sectorSize < 128 || sectorSize > 65536 || (sectorSize & (sectorSize - 1)) != 0)
            throw new ProtocolException("INVALID_GEOMETRY", "Windows returned invalid volume geometry.");
        string[] disks = QueryExtents();
        uint serial = 0, maxName, flags;
        StringBuilder label = new StringBuilder(261), fileSystem = new StringBuilder(261);
        string root = VolumeRoot(devicePath);
        if (!GetVolumeInformation(root, label, label.Capacity, out serial, out maxName, out flags, fileSystem, fileSystem.Capacity))
            throw Win32Protocol("IDENTITY_QUERY_FAILED");
        string storage = QueryStorageDescriptor();
        string material = serial.ToString("X8") + "|" + size + "|" + sectorSize + "|" + String.Join(",", disks) + "|" + fileSystem + "|" + storage;
        return new Snapshot { Size = size, SectorSize = sectorSize, Serial = serial, FileSystem = fileSystem.ToString(), DiskIds = disks, Storage = storage, Identity = Sha256(material) };
    }

    private static byte[] Ioctl(uint code, byte[] input, int initialSize, string errorCode)
    {
        int size = initialSize;
        while (size <= MaxRead)
        {
            byte[] output = new byte[size]; int returned;
            if (DeviceIoControl(handle, code, input, input == null ? 0 : input.Length, output, output.Length, out returned, IntPtr.Zero))
            {
                if (returned < 0 || returned > output.Length) throw new ProtocolException(errorCode, "Windows returned an invalid control response length.");
                Array.Resize(ref output, returned); return output;
            }
            int error = Marshal.GetLastWin32Error();
            if (error != ErrorMoreData) throw new ProtocolException(error == ErrorAccessDenied ? "NEEDS_ADMIN" : errorCode, new Win32Exception(error).Message);
            size *= 2;
        }
        throw new ProtocolException(errorCode, "The Windows control response exceeded the helper limit.");
    }

    private static byte[] JournalIoctl(uint code, byte[] input, int outputSize, string errorCode)
    {
        byte[] output = new byte[outputSize]; int returned;
        if (!DeviceIoControl(handle, code, input, input == null ? 0 : input.Length, output, output.Length, out returned, IntPtr.Zero))
        {
            int error = Marshal.GetLastWin32Error();
            if (error == ErrorAccessDenied) throw new ProtocolException("NEEDS_ADMIN", new Win32Exception(error).Message);
            if (error == ErrorJournalDeleteInProgress) throw new ProtocolException("JOURNAL_DELETE_IN_PROGRESS", new Win32Exception(error).Message);
            if (error == ErrorJournalNotActive || error == ErrorInvalidFunction) throw new ProtocolException("JOURNAL_NOT_ACTIVE", new Win32Exception(error).Message);
            if (error == ErrorJournalEntryDeleted) throw new ProtocolException("JOURNAL_ENTRY_DELETED", new Win32Exception(error).Message);
            if (error == ErrorInvalidParameter && code == FsctlReadUsnJournal) throw new ProtocolException("JOURNAL_INVALID_PARAMETER", new Win32Exception(error).Message);
            throw new ProtocolException(errorCode, new Win32Exception(error).Message);
        }
        if (returned < 0 || returned > output.Length) throw new ProtocolException(errorCode, "Windows returned an invalid USN response length.");
        Array.Resize(ref output, returned);
        return output;
    }

    private static string[] QueryExtents()
    {
        byte[] data = Ioctl(IoctlVolumeGetVolumeDiskExtents, null, 4096, "EXTENTS_QUERY_FAILED");
        if (data.Length < 8) throw new ProtocolException("EXTENTS_QUERY_FAILED", "The volume extent response was too short.");
        uint count = BitConverter.ToUInt32(data, 0);
        const int first = 8, stride = 24;
        if (count > 4096 || first + (long)count * stride > data.Length) throw new ProtocolException("EXTENTS_QUERY_FAILED", "The volume extent response was invalid.");
        List<string> ids = new List<string>();
        for (int index = 0; index < count; index++) ids.Add(BitConverter.ToUInt32(data, first + index * stride).ToString());
        string[] result = ids.ToArray(); Array.Sort(result, StringComparer.Ordinal); return Unique(result);
    }

    private static string QueryStorageDescriptor()
    {
        byte[] query = new byte[8];
        byte[] data;
        try { data = Ioctl(IoctlStorageQueryProperty, query, 4096, "STORAGE_QUERY_FAILED"); }
        catch (ProtocolException error) { if (error.Code == "NEEDS_ADMIN") throw; return "unavailable"; }
        if (data.Length < 32) return "unavailable";
        return DescriptorString(data, 12) + "|" + DescriptorString(data, 16) + "|" + DescriptorString(data, 20) + "|" + DescriptorString(data, 24) + "|" + data[28];
    }

    private static string DescriptorString(byte[] data, int offsetField)
    {
        uint offset = BitConverter.ToUInt32(data, offsetField);
        if (offset == 0 || offset >= data.Length) return String.Empty;
        int end = (int)offset;
        while (end < data.Length && data[end] != 0) end++;
        return Encoding.ASCII.GetString(data, (int)offset, end - (int)offset).Trim();
    }

    private static object SnapshotResult(Snapshot snapshot)
    {
        return new Dictionary<string, object> {
            { "size", snapshot.Size }, { "sectorSize", snapshot.SectorSize }, { "identity", snapshot.Identity },
            { "diskIds", snapshot.DiskIds }, { "fileSystem", snapshot.FileSystem }, { "readonly", true }, { "maxRead", MaxRead }
        };
    }

    private static void CloseVolume()
    {
        if (handle != null) { handle.Dispose(); handle = null; }
        opened = null; openedPath = null;
    }

    private static void EnsureOpen() { if (handle == null || handle.IsClosed || opened == null) throw new ProtocolException("NOT_OPEN", "No volume is open."); }
    private static void EnsureNtfsJournal()
    {
        EnsureOpen();
        if (!String.Equals(opened.FileSystem, "NTFS", StringComparison.OrdinalIgnoreCase))
            throw new ProtocolException("JOURNAL_UNSUPPORTED", "USN journal reads require an opened NTFS volume.");
    }
    private static string NormalizeDevicePath(string value)
    {
        if (GuidVolume.IsMatch(value)) return value.TrimEnd('\\');
        string drive = value.Substring(value.Length - 2).ToUpperInvariant();
        return @"\\.\" + drive;
    }
    private static string VolumeRoot(string devicePath)
    {
        if (devicePath.StartsWith(@"\\?\Volume{", StringComparison.OrdinalIgnoreCase)) return devicePath + @"\";
        return devicePath.Substring(devicePath.Length - 2) + @"\";
    }
    private static ProtocolException Win32Protocol(string code) { int error = Marshal.GetLastWin32Error(); return new ProtocolException(error == ErrorAccessDenied ? "NEEDS_ADMIN" : code, new Win32Exception(error).Message); }
    private static string RequireString(Dictionary<string, object> request, string key)
    {
        object value; if (!request.TryGetValue(key, out value) || value == null || String.IsNullOrWhiteSpace(Convert.ToString(value))) throw new ProtocolException("INVALID_REQUEST", "A required string field is missing.");
        return Convert.ToString(value);
    }
    private static long RequireInt64(Dictionary<string, object> request, string key)
    {
        object value; long result;
        if (!request.TryGetValue(key, out value) || value == null || !Int64.TryParse(Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture), out result)) throw new ProtocolException("INVALID_REQUEST", "A required integer field is invalid.");
        return result;
    }
    private static long RequireNonnegativeInt64String(Dictionary<string, object> request, string key)
    {
        string value = RequireString(request, key); long result;
        if (!Regex.IsMatch(value, @"^(?:0|[1-9][0-9]*)$", RegexOptions.CultureInvariant)
            || !Int64.TryParse(value, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out result))
            throw new ProtocolException("INVALID_REQUEST", "A USN field must be a canonical nonnegative decimal string.");
        return result;
    }
    private static ulong RequireUInt64String(Dictionary<string, object> request, string key)
    {
        string value = RequireString(request, key); ulong result;
        if (!Regex.IsMatch(value, @"^(?:0|[1-9][0-9]*)$", RegexOptions.CultureInvariant)
            || !UInt64.TryParse(value, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out result))
            throw new ProtocolException("INVALID_REQUEST", "A journal identifier must be a canonical unsigned decimal string.");
        return result;
    }
    private static string[] OptionalStrings(Dictionary<string, object> request, string key)
    {
        object value; if (!request.TryGetValue(key, out value) || value == null) return null;
        ArrayList list = value as ArrayList;
        if (list == null) { object[] array = value as object[]; if (array == null) throw new ProtocolException("INVALID_REQUEST", "A string-array field is invalid."); list = new ArrayList(array); }
        string[] result = new string[list.Count]; for (int i = 0; i < result.Length; i++) result[i] = Convert.ToString(list[i]);
        return Sort(result);
    }
    private static string[] Sort(string[] values) { string[] copy = (string[])values.Clone(); Array.Sort(copy, StringComparer.Ordinal); return Unique(copy); }
    private static string[] Unique(string[] values)
    {
        List<string> output = new List<string>();
        foreach (string value in values) if (output.Count == 0 || !String.Equals(output[output.Count - 1], value, StringComparison.Ordinal)) output.Add(value);
        return output.ToArray();
    }
    private static bool EqualStrings(string[] left, string[] right)
    {
        if (left == null || right == null || left.Length != right.Length) return false;
        for (int i = 0; i < left.Length; i++) if (!String.Equals(left[i], right[i], StringComparison.Ordinal)) return false;
        return true;
    }
    private static string Sha256(string value)
    {
        using (SHA256 hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-", String.Empty).ToLowerInvariant();
    }
}
