import { spawn, spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface BrowserLaunchResult {
  launched: boolean;
  reason: string;
}

export function browserCandidates(platform: string = process.platform): string[] {
  const home = os.homedir();
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ];
  }
  if (platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const localAppData = process.env['LOCALAPPDATA'] ?? path.join(home, 'AppData', 'Local');
    return [
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
  }
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
}

export async function isDebugPortAlive(port: number, timeoutMs = 1000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function ensureDebugBrowser(port: number, profileDir: string): Promise<BrowserLaunchResult> {
  if (await isDebugPortAlive(port)) {
    return { launched: false, reason: 'already-running' };
  }

  const executable = await resolveExecutable(browserCandidates());
  if (!executable) {
    return { launched: false, reason: 'no-browser' };
  }

  await fs.mkdir(profileDir, { recursive: true });
  const child = spawn(
    executable,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-features=Translate',
      'about:blank',
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();

  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (await isDebugPortAlive(port, 500)) {
      return { launched: true, reason: executable };
    }
    await delay(400);
  }
  return { launched: false, reason: 'timeout' };
}

async function resolveExecutable(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (candidate.includes(path.sep)) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
    const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [candidate], {
      stdio: 'ignore',
    });
    if (result.status === 0) {
      return candidate;
    }
  }
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
