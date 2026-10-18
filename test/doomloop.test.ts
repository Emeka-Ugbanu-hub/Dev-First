import { describe, expect, it } from 'vitest';
import {
  DoomLoopDetector,
  LoopProgress,
  canonicalToolSignature,
  touchedFileHash,
} from '../src/agent/doomloop';
import { ToolCall } from '../src/llm/types';

function call(name: string, args: string): ToolCall {
  return { id: `id-${Math.random()}`, name, arguments: args };
}

function progress(fingerprint: string, description = 'edited src/foo.ts'): LoopProgress {
  return { fingerprint, description };
}

describe('DoomLoopDetector', () => {
  it('stays quiet for distinct calls', () => {
    const detector = new DoomLoopDetector();
    expect(detector.record(call('read_file', '{"path":"a"}')).action).toBe('none');
    expect(detector.record(call('read_file', '{"path":"b"}')).action).toBe('none');
    expect(detector.record(call('edit_file', '{"path":"a"}')).action).toBe('none');
  });

  it('warns at the third identical call', () => {
    const detector = new DoomLoopDetector();
    const same = () => call('read_file', '{"path":"a"}');
    expect(detector.record(same()).action).toBe('none');
    expect(detector.record(same()).action).toBe('none');
    const third = detector.record(same());
    expect(third.action).toBe('warn');
    expect(third.count).toBe(3);
  });

  it('warns only once per key', () => {
    const detector = new DoomLoopDetector();
    const same = () => call('read_file', '{"path":"a"}');
    detector.record(same());
    detector.record(same());
    expect(detector.record(same()).action).toBe('warn');
    expect(detector.record(same()).action).toBe('none');
  });

  it('stops at the fifth identical call', () => {
    const detector = new DoomLoopDetector();
    const same = () => call('search_text', '{"query":"x"}');
    for (let i = 0; i < 4; i++) {
      detector.record(same());
    }
    const result = detector.record(same());
    expect(result.action).toBe('stop');
    expect(result.count).toBe(5);
  });

  it('forgets old calls outside the window', () => {
    const detector = new DoomLoopDetector(3, 3, 5);
    const same = () => call('read_file', '{"path":"a"}');
    detector.record(same());
    detector.record(call('other', '{}'));
    detector.record(call('other2', '{}'));
    detector.record(same());
    const result = detector.record(same());
    expect(result.action).toBe('none');
  });

  it('resets', () => {
    const detector = new DoomLoopDetector();
    const same = () => call('read_file', '{"path":"a"}');
    detector.record(same());
    detector.record(same());
    detector.reset();
    expect(detector.record(same()).action).toBe('none');
  });
});

describe('canonicalToolSignature', () => {
  it('collapses key order, path variants, whitespace, and volatile fields', () => {
    const a = call('read_file', '{"path":"./src//a.ts","start_line":1,"end_line":40}');
    const b = call('read_file', '{"end_line":40,"path":"src/a.ts","start_line":1}');
    expect(canonicalToolSignature(a)).toBe(canonicalToolSignature(b));

    const c = call('search_text', '{"query":"  foo   bar  "}');
    const d = call('search_text', '{"query":"foo bar"}');
    expect(canonicalToolSignature(c)).toBe(canonicalToolSignature(d));

    const e = call('read_file', '{"path":"src\\\\nested\\\\a.ts"}');
    const f = call('read_file', '{"path":"./src/nested/a.ts/"}');
    expect(canonicalToolSignature(e)).toBe(canonicalToolSignature(f));

    const one = call('hover', '{"path":"src/a.ts","line":4,"character":2}');
    const two = call('hover', '{"path":"src/a.ts","line":12,"character":9}');
    expect(canonicalToolSignature(one)).toBe(canonicalToolSignature(two));

    const withId = call('background_process', '{"action":"status","id":"proc-1"}');
    const withOtherId = call('background_process', '{"action":"status","id":"proc-2"}');
    expect(canonicalToolSignature(withId)).toBe(canonicalToolSignature(withOtherId));
  });

  it('preserves identity fields', () => {
    expect(canonicalToolSignature(call('find_references', '{"path":"src/a.ts","symbol":"foo"}'))).not.toBe(
      canonicalToolSignature(call('find_references', '{"path":"src/a.ts","symbol":"bar"}')),
    );
    expect(canonicalToolSignature(call('edit_file', '{"path":"src/a.ts","old_text":"a","new_text":"b"}'))).not.toBe(
      canonicalToolSignature(call('edit_file', '{"path":"src/a.ts","old_text":"a","new_text":"c"}')),
    );
  });

  it('collapses apply_patch range headers', () => {
    const first = call(
      'apply_patch',
      JSON.stringify({
        patch: '*** Begin Patch\n*** Update File: src/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n*** End Patch',
      }),
    );
    const second = call(
      'apply_patch',
      JSON.stringify({
        patch: '*** Begin Patch\n*** Update File: src/a.ts\n@@ -8,12 +8,12 @@\n-old\n+new\n*** End Patch',
      }),
    );
    expect(canonicalToolSignature(first)).toBe(canonicalToolSignature(second));
  });

  it('keeps the exact raw fast path for identical calls', () => {
    const detector = new DoomLoopDetector();
    const raw = '{"path":"src/a.ts"}';
    detector.record(call('read_file', raw));
    detector.record(call('read_file', raw));
    expect(detector.record(call('read_file', raw)).action).toBe('warn');
    detector.record(call('read_file', raw));
    const fifth = detector.record(call('read_file', raw));
    expect(fifth.action).toBe('stop');
    expect(fifth.count).toBe(5);
  });
});

describe('touchedFileHash', () => {
  it('uses only files with cached content hashes', () => {
    const edit = call('edit_file', '{"path":"src/a.ts","old_text":"x","new_text":"y"}');
    expect(touchedFileHash(edit, new Map([['src/a.ts', 'hash1']]))).toBe('src/a.ts:hash1');
    expect(touchedFileHash(edit, new Map([['src/other.ts', 'hash1']]))).toBe('');
    expect(touchedFileHash(edit, new Map())).toBe('');
  });

  it('separates two different edits to the same file', () => {
    const first = call('edit_file', '{"path":"src/a.ts","old_text":"const a = 1;","new_text":"const a = 2;"}');
    const second = call('edit_file', '{"path":"src/a.ts","old_text":"const b = 1;","new_text":"const b = 2;"}');
    expect(canonicalToolSignature(first)).not.toBe(canonicalToolSignature(second));
    expect(touchedFileHash(first, new Map([['src/a.ts', 'hash1']]))).not.toBe(
      touchedFileHash(second, new Map([['src/a.ts', 'hash2']])),
    );
  });
});

describe('DoomLoopDetector no-progress detection', () => {
  it('warns at the first repeat and stops after three repeats with no progress', () => {
    const detector = new DoomLoopDetector();
    const variant = (line: number) => call('read_file', `{"path":"src/a.ts","line":${line}}`);
    const same = progress('0|0|0||1');
    expect(detector.record(variant(1), same).action).toBe('none');
    const warned = detector.record(variant(2), same);
    expect(warned.action).toBe('warn');
    expect(warned.message).toContain('LOOP RECOVERY: read_file was repeated with identical arguments');
    expect(detector.record(variant(3), same).action).toBe('none');
    const stopped = detector.record(variant(4), same);
    expect(stopped.action).toBe('stop');
    expect(stopped.message).toBe(
      'Stopped after three repeated attempts with no progress since edited src/foo.ts at call 4.',
    );
  });

  it('resets when the fingerprint changes', () => {
    const detector = new DoomLoopDetector();
    const variant = (line: number) => call('read_file', `{"path":"src/a.ts","line":${line}}`);
    expect(detector.record(variant(1), progress('fp-a')).action).toBe('none');
    expect(detector.record(variant(2), progress('fp-a')).action).toBe('warn');
    expect(detector.record(variant(3), progress('fp-b')).action).toBe('none');
    expect(detector.record(variant(4), progress('fp-b')).action).toBe('warn');
    expect(detector.record(variant(5), progress('fp-b')).action).toBe('none');
    expect(detector.record(variant(6), progress('fp-b')).action).toBe('stop');
  });

  it('resets after noteProgress', () => {
    const detector = new DoomLoopDetector();
    const variant = (line: number) => call('read_file', `{"path":"src/a.ts","line":${line}}`);
    expect(detector.record(variant(1), progress('fp-a')).action).toBe('none');
    expect(detector.record(variant(2), progress('fp-a')).action).toBe('warn');
    detector.noteProgress(progress('fp-b', 'verify_change passed'));
    expect(detector.record(variant(3), progress('fp-b')).action).toBe('none');
    expect(detector.record(variant(4), progress('fp-b')).action).toBe('warn');
  });

  it('does not flag two distinct edits to the same file', () => {
    const detector = new DoomLoopDetector();
    const first = call('edit_file', '{"path":"src/a.ts","old_text":"const a = 1;","new_text":"const a = 2;"}');
    const second = call('edit_file', '{"path":"src/a.ts","old_text":"const b = 1;","new_text":"const b = 2;"}');
    expect(detector.record(first, progress('0|0|0|src/a.ts:hash1|1')).action).toBe('none');
    expect(detector.record(second, progress('0|0|0|src/a.ts:hash2|1')).action).toBe('none');
  });
});

describe('DoomLoopDetector polling tools', () => {
  it('doubles the exact thresholds and skips no-progress detection', () => {
    const detector = new DoomLoopDetector();
    const same = () => call('list_files', '{}');
    for (let index = 0; index < 5; index++) {
      expect(detector.record(same(), progress(`fp-${index}`)).action).toBe('none');
    }
    const warned = detector.record(same(), progress('fp-5'));
    expect(warned.action).toBe('warn');
    expect(warned.count).toBe(6);
    expect(warned.message).toContain('Stop polling');
    for (let index = 0; index < 3; index++) {
      expect(detector.record(same(), progress(`fp-${index + 6}`)).action).toBe('none');
    }
    const stopped = detector.record(same(), progress('fp-9'));
    expect(stopped.action).toBe('stop');
    expect(stopped.count).toBe(10);
  });
});
