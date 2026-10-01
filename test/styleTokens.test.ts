import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import * as path from 'path';

const css = readFileSync(path.join(__dirname, '..', 'webview', 'src', 'styles.css'), 'utf-8');

const ALLOWED_FONT_SIZES = new Set([10, 11, 12, 13, 15]);
const ALLOWED_RADII = new Set([4, 6, 8, 12]);

function collect(property: string, skipSelector?: string): number[] {
  const values: number[] = [];
  for (const rule of css.split('}')) {
    if (skipSelector && rule.includes(skipSelector)) {
      continue;
    }
    const regex = new RegExp(`${property}:\\s*(\\d+)px`, 'g');
    let match: RegExpExecArray | null;
    while ((match = regex.exec(rule)) !== null) {
      values.push(Number(match[1]));
    }
  }
  return values;
}

describe('style tokens', () => {
  it('uses only scale font sizes for text (icons excluded)', () => {
    const sizes = collect('font-size', '.codicon');
    expect(sizes.length).toBeGreaterThan(50);
    for (const size of sizes) {
      expect(ALLOWED_FONT_SIZES.has(size), `off-scale font-size: ${size}px`).toBe(true);
    }
  });

  it('uses only scale border radii', () => {
    const radii = collect('border-radius');
    for (const radius of radii) {
      expect(ALLOWED_RADII.has(radius), `off-scale border-radius: ${radius}px`).toBe(true);
    }
  });

  it('handles reduced motion', () => {
    expect(css).toContain('prefers-reduced-motion');
  });
});
