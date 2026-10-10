import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import * as path from 'path';
import { SETTINGS_SCHEMA, SETTING_KEYS } from '../src/shared/settingsSchema';

const packageJson = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'),
) as { contributes: { configuration: { properties: Record<string, unknown> } } };

describe('SETTINGS_SCHEMA', () => {
  it('has unique keys', () => {
    const keys = SETTINGS_SCHEMA.map((setting) => setting.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(SETTING_KEYS.size).toBe(keys.length);
  });

  it('only references settings that exist in package.json', () => {
    const properties = packageJson.contributes.configuration.properties;
    for (const setting of SETTINGS_SCHEMA) {
      expect(properties, `missing devFirst.${setting.key}`).toHaveProperty([`devFirst.${setting.key}`]);
    }
  });

  it('gives every setting a label, description, and valid tab', () => {
    for (const setting of SETTINGS_SCHEMA) {
      expect(setting.label.length).toBeGreaterThan(0);
      expect(setting.description.length).toBeGreaterThan(0);
      expect(['provider', 'behavior', 'display', 'about']).toContain(setting.tab);
    }
  });

  it('provides options for enum settings', () => {
    for (const setting of SETTINGS_SCHEMA.filter((entry) => entry.type === 'enum')) {
      expect(setting.options?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('no longer exposes the removed autoRunSimple setting', () => {
    const properties = packageJson.contributes.configuration.properties;
    expect(SETTING_KEYS.has('autoRunSimple')).toBe(false);
    expect(properties).not.toHaveProperty('devFirst.autoRunSimple');
  });

  it('does not expose obsolete scanner controls', () => {
    const properties = packageJson.contributes.configuration.properties;
    expect(properties).not.toHaveProperty('devFirst.scanAiCrossFile');
    expect(properties).not.toHaveProperty('devFirst.scanAiCrossFileMaxPairs');
    expect(SETTING_KEYS.has('scanAiCrossFile')).toBe(false);
    expect(SETTING_KEYS.has('scanAiCrossFileMaxPairs')).toBe(false);
  });

  it('ships the request timeout settings with safe defaults', () => {
    const properties = packageJson.contributes.configuration.properties;
    expect(properties['devFirst.headerTimeout']).toMatchObject({
      type: 'number',
      default: 120,
      minimum: 0,
    });
    expect(properties['devFirst.streamIdleTimeout']).toMatchObject({
      type: 'number',
      default: 120,
      minimum: 0,
    });
    expect(SETTING_KEYS.has('headerTimeout')).toBe(true);
    expect(SETTING_KEYS.has('streamIdleTimeout')).toBe(true);
  });

  it('ships the paste-to-file threshold with a safe default', () => {
    const properties = packageJson.contributes.configuration.properties;
    expect(properties['devFirst.pasteFileLines']).toMatchObject({
      type: 'number',
      default: 120,
      minimum: 20,
    });
    expect(SETTING_KEYS.has('pasteFileLines')).toBe(true);
  });
});
