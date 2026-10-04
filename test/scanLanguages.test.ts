import { afterAll, describe, expect, it, vi } from 'vitest';
import * as path from 'path';

vi.mock('vscode', () => ({
  ProgressLocation: { Notification: 15 },
  window: {
    withProgress: async (_options: unknown, task: () => Promise<unknown>) => task(),
  },
}));

import { TreeSitterService } from '../src/scan/treeSitter';
import { profileFor } from '../src/scan/languages/profiles';
import { descendantsOf, functionsOf } from '../src/scan/rules/analyzerUtils';
import {
  LANGUAGE_BY_EXTENSION,
  extractFileFacts,
} from '../src/scan/duplication';

const service = new TreeSitterService({ extensionUri: { fsPath: path.join(__dirname, '..') } });

afterAll(() => service.dispose());

const GRAMMAR_SAMPLES: Record<string, string> = {
  rust: 'fn main() { let value = 1; }',
  ruby: 'puts "hi"',
  bash: 'echo hi',
  powershell: 'Write-Host "hi"',
  csharp: 'class Demo { }',
  cpp: 'int main() { return 0; }',
  css: 'body { color: red; }',
  ini: '[section]\nkey = value\n',
};

const PROFILE_SAMPLES: Record<string, string> = {
  rust: 'fn check(value: i32) { if value > 0 { for i in 0..value { report(i); } } }',
  csharp:
    'class Checker { void Check(int value) { if (value > 0) { for (int i = 0; i < value; i++) { } } } }',
  cpp: 'void check(int value) { if (value > 0) { for (int i = 0; i < value; i++) { } } }',
  ruby: 'def check(value)\n  if value\n    while value > 0\n      value -= 1\n    end\n  end\nend\n',
  bash: 'check() {\n  if [ "$1" ]; then\n    while true; do break; done\n  fi\n}\n',
  powershell: 'function Check { if ($value) { foreach ($i in $list) { Write-Host $i } } }',
};

async function extract(source: string, languageId: string) {
  const tree = await service.parse(source, languageId);
  expect(tree).toBeDefined();
  const profile = profileFor(languageId);
  expect(profile).toBeDefined();
  return extractFileFacts(tree!, source, profile!);
}

describe('tree-sitter grammar map', () => {
  it('parses every newly registered language', async () => {
    for (const [languageId, source] of Object.entries(GRAMMAR_SAMPLES)) {
      const tree = await service.parse(source, languageId);
      expect(tree, `expected a grammar for ${languageId}`).toBeDefined();
    }
  });

  it('keeps the original grammars wired', async () => {
    const tree = await service.parse('const value = 1;\n', 'typescript');
    expect(tree).toBeDefined();
  });
});

describe('LANGUAGE_BY_EXTENSION', () => {
  it('maps the new extensions without clashing with older ones', () => {
    expect(LANGUAGE_BY_EXTENSION['.rs']).toBe('rust');
    expect(LANGUAGE_BY_EXTENSION['.rb']).toBe('ruby');
    expect(LANGUAGE_BY_EXTENSION['.sh']).toBe('bash');
    expect(LANGUAGE_BY_EXTENSION['.bash']).toBe('bash');
    expect(LANGUAGE_BY_EXTENSION['.ps1']).toBe('powershell');
    expect(LANGUAGE_BY_EXTENSION['.cs']).toBe('csharp');
    expect(LANGUAGE_BY_EXTENSION['.c']).toBe('cpp');
    expect(LANGUAGE_BY_EXTENSION['.h']).toBe('cpp');
    expect(LANGUAGE_BY_EXTENSION['.cpp']).toBe('cpp');
    expect(LANGUAGE_BY_EXTENSION['.cc']).toBe('cpp');
    expect(LANGUAGE_BY_EXTENSION['.cxx']).toBe('cpp');
    expect(LANGUAGE_BY_EXTENSION['.hpp']).toBe('cpp');
    expect(LANGUAGE_BY_EXTENSION['.hh']).toBe('cpp');
    expect(LANGUAGE_BY_EXTENSION['.css']).toBe('css');
    expect(LANGUAGE_BY_EXTENSION['.ini']).toBe('ini');
  });

  it('leaves existing mappings untouched', () => {
    expect(LANGUAGE_BY_EXTENSION['.ts']).toBe('typescript');
    expect(LANGUAGE_BY_EXTENSION['.tsx']).toBe('typescriptreact');
    expect(LANGUAGE_BY_EXTENSION['.py']).toBe('python');
    expect(LANGUAGE_BY_EXTENSION['.java']).toBe('java');
    expect(LANGUAGE_BY_EXTENSION['.go']).toBe('go');
    expect(LANGUAGE_BY_EXTENSION['.php']).toBe('php');
  });
});

describe('language profiles', () => {
  it('exposes if, loop, and function kinds for every new profile', async () => {
    for (const [languageId, source] of Object.entries(PROFILE_SAMPLES)) {
      const profile = profileFor(languageId);
      expect(profile, `expected a profile for ${languageId}`).toBeDefined();
      const tree = await service.parse(source, languageId);
      expect(tree).toBeDefined();
      expect(
        descendantsOf(tree!.rootNode, [profile!.ifNode]).length,
        `${languageId} if node`,
      ).toBeGreaterThan(0);
      const loops = descendantsOf(tree!.rootNode, profile!.loopNodes);
      expect(loops.length, `${languageId} loop nodes`).toBeGreaterThan(0);
      expect(functionsOf(tree!, profile!).length, `${languageId} functions`).toBeGreaterThan(0);
    }
  });
});

describe('multi-language fact extraction', () => {
  it('extracts rust imports, types, functions, and tauri commands', async () => {
    const source = [
      'use std::collections::HashMap;',
      'use serde::{Deserialize, Serialize};',
      'mod utils;',
      '',
      'pub struct Point { x: i32 }',
      'pub enum Color { Red }',
      'pub trait Draw { fn draw(&self); }',
      'impl Draw for Point { fn draw(&self) {} }',
      '',
      '#[tauri::command]',
      'pub fn greet(name: String) -> String { format!("hi {name}") }',
      '',
    ].join('\n');
    const result = await extract(source, 'rust');
    const specifiers = result.imports.map((record) => record.specifier);
    expect(specifiers).toContain('std::collections::HashMap');
    expect(specifiers).toContain('serde::Deserialize');
    expect(specifiers).toContain('serde::Serialize');
    expect(result.rustModules).toContainEqual({ name: 'utils', line: 2 });
    expect(result.types.map((type) => type.name)).toEqual(
      expect.arrayContaining(['Point', 'Color', 'Draw']),
    );
    expect(result.functions.map((fn) => fn.name)).toContain('greet');
    expect(result.handlers).toContainEqual(
      expect.objectContaining({ name: 'greet', method: 'IPC' }),
    );
  });

  it('extracts csharp usings, types, methods, and route attributes', async () => {
    const source = [
      'using System;',
      'using System.Collections.Generic;',
      'public class WeatherController {',
      '  [HttpGet("weather/{id}")]',
      '  public int Get(int id) { return 1; }',
      '}',
      '',
    ].join('\n');
    const result = await extract(source, 'csharp');
    expect(result.imports.map((record) => record.specifier)).toEqual(
      expect.arrayContaining(['System', 'System.Collections.Generic']),
    );
    expect(result.types.map((type) => type.name)).toContain('WeatherController');
    expect(result.functions.map((fn) => fn.name)).toContain('Get');
    expect(result.handlers).toContainEqual(
      expect.objectContaining({ name: 'Get', method: 'GET' }),
    );
  });

  it('extracts cpp includes, types, and functions', async () => {
    const source = [
      '#include <string>',
      '#include "local.h"',
      'class Greeter { public: int hello() { return 1; } };',
      'struct Point { int x; };',
      'int main() { return 0; }',
      '',
    ].join('\n');
    const result = await extract(source, 'cpp');
    expect(result.imports.map((record) => record.specifier)).toEqual(
      expect.arrayContaining(['string', 'local.h']),
    );
    expect(result.types.map((type) => type.name)).toEqual(
      expect.arrayContaining(['Greeter', 'Point']),
    );
    expect(result.functions.map((fn) => fn.name)).toContain('main');
  });

  it('extracts ruby requires, classes, and methods', async () => {
    const source = [
      "require 'json'",
      "require_relative './helper'",
      'module Demo',
      '  class Greeter',
      '    def hello(name)',
      '      puts name',
      '    end',
      '  end',
      'end',
      '',
    ].join('\n');
    const result = await extract(source, 'ruby');
    expect(result.imports.map((record) => record.specifier)).toEqual(
      expect.arrayContaining(['json', './helper']),
    );
    expect(result.types.map((type) => type.name)).toEqual(
      expect.arrayContaining(['Demo', 'Greeter']),
    );
    expect(result.functions.map((fn) => fn.name)).toContain('hello');
  });

  it('extracts bash source commands and functions', async () => {
    const source = ['source ./lib.sh', '. ./other.sh', 'greet() { echo hi; }', ''].join('\n');
    const result = await extract(source, 'bash');
    expect(result.imports.map((record) => record.specifier)).toEqual(
      expect.arrayContaining(['./lib.sh', './other.sh']),
    );
    expect(result.functions.map((fn) => fn.name)).toContain('greet');
  });

  it('extracts powershell imports and functions', async () => {
    const source = ['Import-Module ActiveDirectory', 'function Get-Thing { Write-Host "hi" }', ''].join(
      '\n',
    );
    const result = await extract(source, 'powershell');
    expect(result.imports.map((record) => record.specifier)).toContain('ActiveDirectory');
    expect(result.functions.map((fn) => fn.name)).toContain('Get-Thing');
  });
});

describe('framework handler extraction', () => {
  it('reads Spring, Express, and Nest route declarations', async () => {
    const spring = await extract('@GetMapping("/users/{id}")\npublic User getUser() { return null; }', 'java');
    expect(spring.handlers).toContainEqual(
      expect.objectContaining({ method: 'GET', pathShape: '/users/:p' }),
    );
    const express = await extract("router.post('/items', createItem);", 'typescript');
    expect(express.handlers).toContainEqual(
      expect.objectContaining({ method: 'POST', pathShape: '/items' }),
    );
    const nest = await extract("@Get(':id')\nasync findOne() {}", 'typescript');
    expect(nest.handlers).toContainEqual(
      expect.objectContaining({ method: 'GET', pathShape: '/:p' }),
    );
  });

  it('extracts Rust exports and Go types', async () => {
    const rust = await extract('pub fn greet() {}\npub struct User {}', 'rust');
    expect(rust.exports.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(['greet', 'User']),
    );
    const go = await extract('type User struct { Name string }\ntype Reader interface {}', 'go');
    expect(go.types.map((entry) => entry.name)).toEqual(expect.arrayContaining(['User', 'Reader']));
  });
});
