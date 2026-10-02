import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Create a shortcut only to a test-owned local path. Never open or execute it.
export async function createWindowsShortcut(shortcutPath, targetPath) {
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; $shell=New-Object -ComObject WScript.Shell; $link=$shell.CreateShortcut($env:RECOVERY_FIXTURE_LINK); $link.TargetPath=$env:RECOVERY_FIXTURE_TARGET; $link.Save()"], {
    windowsHide: true, timeout: 15000, maxBuffer: 65536,
    env: { ...process.env, RECOVERY_FIXTURE_LINK: shortcutPath, RECOVERY_FIXTURE_TARGET: targetPath },
  });
}
