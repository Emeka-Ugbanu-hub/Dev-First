import { describe, expect, it } from 'vitest';
import { browserCandidates } from '../src/browser/ChromeLauncher';

describe('browserCandidates', () => {
  it('lists Chrome and Edge paths on macOS', () => {
    const candidates = browserCandidates('darwin');
    expect(candidates.some((path) => path.includes('Google Chrome.app'))).toBe(true);
    expect(candidates.some((path) => path.includes('Microsoft Edge.app'))).toBe(true);
    expect(candidates.every((path) => path.startsWith('/'))).toBe(true);
  });

  it('lists PATH commands on linux', () => {
    const candidates = browserCandidates('linux');
    expect(candidates).toContain('google-chrome');
    expect(candidates).toContain('chromium');
  });

  it('lists Program Files paths on windows', () => {
    const candidates = browserCandidates('win32');
    expect(candidates.some((path) => path.toLowerCase().includes('chrome.exe'))).toBe(true);
    expect(candidates.some((path) => path.toLowerCase().includes('msedge.exe'))).toBe(true);
  });
});
