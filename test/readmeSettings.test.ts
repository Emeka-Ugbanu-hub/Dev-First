import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import * as path from 'path';
import { SETTING_KEYS } from '../src/shared/settingsSchema';

const root = path.join(__dirname, '..');
const readme = readFileSync(path.join(root, 'README.md'), 'utf-8');
const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf-8');
const packageJsonText = readFileSync(path.join(root, 'package.json'), 'utf-8');

const REMOVED_SCAN_SETTINGS = [
  'scanEnabled',
  'scanAst',
  'scanHotspots',
  'scanDuplication',
  'scanDuplicationThreshold',
  'scanCrossFile',
  'scanConventions',
  'scanMaxFileKb',
  'scanNewOnly',
  'scanDisabledCategories',
  'scanAi',
  'scanAiCrossFile',
  'scanAiCrossFileMaxPairs',
];

function settingsSection(markdown: string): string {
  const match = /^## Settings\s*$([\s\S]*?)(?=^## )/m.exec(markdown);
  return match ? match[1] : '';
}

function mentionedKeys(markdown: string): string[] {
  return [...markdown.matchAll(/`devFirst\.([A-Za-z0-9]+)`/g)].map((match) => match[1]);
}

describe('README settings documentation', () => {
  const section = settingsSection(readme);

  it('has a Settings section', () => {
    expect(section.length).toBeGreaterThan(0);
  });

  it('only mentions settings that exist in SETTING_KEYS', () => {
    const keys = [...new Set(mentionedKeys(section))];
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(SETTING_KEYS.has(key), `README documents devFirst.${key}, which is not in SETTING_KEYS`).toBe(true);
    }
  });

  it('documents every setting in the schema', () => {
    const documented = new Set(mentionedKeys(section));
    for (const key of SETTING_KEYS) {
      expect(documented.has(key), `README Settings is missing devFirst.${key}`).toBe(true);
    }
  });

  it('never mentions removed scanner settings', () => {
    for (const key of REMOVED_SCAN_SETTINGS) {
      const pattern = new RegExp(`\\b${key}\\b`);
      expect(SETTING_KEYS.has(key), `removed key ${key} is still in SETTING_KEYS`).toBe(false);
      expect(pattern.test(readme), `README mentions removed setting ${key}`).toBe(false);
      expect(pattern.test(changelog), `CHANGELOG mentions removed setting ${key}`).toBe(false);
      expect(pattern.test(packageJsonText), `package.json mentions removed setting ${key}`).toBe(false);
    }
  });
});
