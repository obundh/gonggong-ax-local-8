# Windows volume reader

`VolumeReader.cs` is the narrow privileged boundary for raw Windows volume reads. It has no write, format, mount, shell, or arbitrary-path command. It accepts only an enumerated drive (`C:`) or volume GUID (`\\?\Volume{...}\`), opens it with `GENERIC_READ`, and shares read/write/delete so it does not lock normal Windows activity.

Build from a 64-bit Windows PowerShell prompt:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-native.ps1
```

The output is `native\bin\RecoveryChat.VolumeReader.exe`. The normal mode reads newline-delimited JSON on stdin and writes one correlated JSON response per line on stdout. Commands are limited to `hello`, `open`, `read`, `assert`, and `close`. `read` requires sector-aligned offsets and lengths, is bounded to 1 MiB, and must stay within the opened volume length.

`engine/windows-device.mjs` inventories volumes without raw reads. `openWindowsVolume(device)` accepts only a device identity returned by the current process's latest `listWindowsDevices()` result and rechecks the volume-to-physical-disk mapping before opening and before every read. Its provider accepts reads up to 1 MiB at arbitrary byte offsets; it expands them into one or more aligned native reads and returns only the requested bytes. An access-denied open returns `NEEDS_ADMIN`.

After an explicit user action, `openWindowsVolume(device, { elevate: true })` starts the same helper through Windows UAC. The GUI remains unelevated. Elevated mode creates a random one-client named pipe, restricts its ACL to the current user's SID, verifies the connected client's SID under impersonation, and exits on disconnect or a 30-second startup timeout. Cancelling the UAC prompt returns `ELEVATION_CANCELLED`.

The helper identity includes the volume serial, physical extent disk numbers, length, sector size, and storage descriptor values. Re-query mismatches return `DEVICE_CHANGED`; callers must stop the job and refresh inventory.
