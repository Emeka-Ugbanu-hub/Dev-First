import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import * as path from 'path';

const app = readFileSync(path.join(__dirname, '..', 'webview', 'src', 'App.tsx'), 'utf-8');
const css = readFileSync(path.join(__dirname, '..', 'webview', 'src', 'styles.css'), 'utf-8');

describe('sticky prompt removal', () => {
  it('keeps no sticky prompt state or element', () => {
    expect(app).not.toContain('stickyPrompt');
    expect(app).not.toContain('sticky-user');
    expect(css).not.toContain('sticky-user');
  });

  it('gates auto-scroll through the follow ref', () => {
    expect(app).toContain('followRef');
    expect(app).toContain('shouldFollow');
  });
});
