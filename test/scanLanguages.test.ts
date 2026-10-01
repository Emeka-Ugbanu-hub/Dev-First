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
import type { FileFacts } from '../src/scan/duplication';
import { classifyFileDomain } from '../src/architecture/model';
import { analyzeArchitectureRelations, computeRelations } from '../src/architecture/relations';

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

function facts(file: string, overrides: Partial<FileFacts> = {}): FileFacts {
  return {
    file,
    imports: [],
    exports: [],
    handlers: [],
    constants: [],
    moduleCaches: [],
    listeners: [],
    storageKeys: [],
    functions: [],
    types: [],
    httpClients: [],
    httpCalls: [],
    scopedHttpClients: [],
    mutableState: [],
    stateWrites: [],
    sql: [],
    secrets: [],
    ...overrides,
  };
}

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

describe('language-aware domains', () => {
  it('assigns server languages to Backend and leaves other unmatched languages unclassified', () => {
    expect(classifyFileDomain(facts('file:///w/src/main.rs'))).toBe('backend');
    expect(classifyFileDomain(facts('file:///w/src/Program.cs'))).toBe('backend');
    expect(classifyFileDomain(facts('file:///w/src/engine.cpp'))).toBe('unclassified');
    expect(classifyFileDomain(facts('file:///w/src/app.rb'))).toBe('unclassified');
    expect(classifyFileDomain(facts('file:///w/src-tauri/crates/core/src/lib.rs'))).toBe(
      'backend',
    );
    expect(classifyFileDomain(facts('file:///w/scripts/deploy.sh'))).toBe('infrastructure');
    expect(classifyFileDomain(facts('file:///w/scripts/setup.ps1'))).toBe('infrastructure');
    expect(classifyFileDomain(facts('file:///w/src/styles/app.css'))).toBe('frontend');
    expect(classifyFileDomain(facts('file:///w/config/app.ini'))).toBe('configuration');
  });
});

describe('Rust modules and Tauri command evidence', () => {
  it('links frontend invocation only to a registered Rust command and records source evidence', async () => {
    const frontendSource = [
      "import { invoke } from '@tauri-apps/api/core';",
      'export async function greet() {',
      "  return invoke<string>('greet', { name: 'x' });",
      '}',
      '',
    ].join('\n');
    const rustSource = [
      '#[tauri::command]',
      'pub fn greet(name: String) -> String { name }',
      '',
    ].join('\n');
    const registrationSource = [
      'mod commands;',
      'tauri::generate_handler![commands::greet];',
      '',
    ].join('\n');
    const frontend: FileFacts = {
      file: 'file:///w/src/components/GreetButton.tsx',
      ...(await extract(frontendSource, 'typescript')),
    };
    const backend: FileFacts = {
      file: 'file:///w/src-tauri/src/commands.rs',
      ...(await extract(rustSource, 'rust')),
    };
    const registration: FileFacts = {
      file: 'file:///w/src-tauri/src/lib.rs',
      ...(await extract(registrationSource, 'rust')),
    };
    expect(frontend.httpCalls).toContainEqual(
      expect.objectContaining({ method: 'IPC', path: 'greet' }),
    );
    expect(backend.handlers).toContainEqual(
      expect.objectContaining({ name: 'greet', method: 'IPC' }),
    );
    const nodeMap = new Map([
      [frontend.file, 'frontend:greet'],
      [backend.file, 'backend:greet'],
      [registration.file, 'backend:greet'],
    ]);
    expect(registration.rustModules).toContainEqual({ name: 'commands', line: 0 });
    expect(registration.tauriCommandRegistrations).toContainEqual({ name: 'greet', line: 1 });
    const relations = computeRelations([frontend, backend, registration], nodeMap);
    const ipc = relations.find(
      (relation) => relation.fromId === 'frontend:greet' && relation.toId === 'backend:greet',
    );
    expect(ipc?.label).toBe('invokes command');
    expect(ipc?.evidence.find((entry) => entry.role === 'use site')).toMatchObject({
      fromFile: frontend.file,
      toFile: backend.file,
      line: 2,
      kind: 'tauri-command',
      role: 'use site',
      symbol: 'greet',
    });
    expect(new Set(ipc?.evidence.map((entry) => entry.role))).toEqual(new Set(['use site', 'registration', 'handler']));
  });

  it('resolves crate imports and module declarations only to indexed Rust files', async () => {
    const lib: FileFacts = {
      file: 'file:///w/src/lib.rs',
      ...(await extract('mod db; use crate::db::read;', 'rust')),
    };
    const db: FileFacts = { file: 'file:///w/src/db.rs', ...(await extract('pub fn read() {}', 'rust')) };
    const external: FileFacts = { file: 'file:///w/src/not_db.rs', ...(await extract('pub fn x() {}', 'rust')) };
    const nodeMap = new Map([[lib.file, 'lib'], [db.file, 'db'], [external.file, 'external']]);
    const relations = computeRelations([lib, db, external], nodeMap);
    expect(relations.filter((relation) => relation.fromId === 'lib' && relation.toId === 'db'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ label: 'imports' }),
        expect.objectContaining({ label: 'declares module' }),
      ]));
    expect(relations.some((relation) => relation.toId === 'external')).toBe(false);
  });

  it('resolves an explicit Rust super import back to the crate root', async () => {
    const root: FileFacts = { file: 'file:///w/src/lib.rs', ...(await extract('mod github;', 'rust')) };
    const github: FileFacts = { file: 'file:///w/src/github.rs', ...(await extract('use super::*;', 'rust')) };
    const relations = computeRelations([root, github], new Map([[root.file, 'root'], [github.file, 'github']]));
    expect(relations).toContainEqual(expect.objectContaining({ fromId: 'github', toId: 'root', label: 'imports' }));
  });

  it('does not connect a Tauri handler until a crate registration is indexed', async () => {
    const frontend: FileFacts = {
      file: 'file:///w/src/caller.ts',
      ...(await extract("invoke('greet');", 'typescript')),
    };
    const root: FileFacts = { file: 'file:///w/src-tauri/src/lib.rs', ...(await extract('', 'rust')) };
    const command: FileFacts = {
      file: 'file:///w/src-tauri/src/commands.rs',
      ...(await extract('#[tauri::command] pub fn greet() {}', 'rust')),
    };
    const result = analyzeArchitectureRelations([frontend, root, command], new Map([
      [frontend.file, 'frontend'], [root.file, 'shell'], [command.file, 'shell'],
    ]));
    expect(result.relations.some((relation) => relation.label === 'invokes command')).toBe(false);
    expect(result.unresolvedTauriCommands).toBe(1);
  });
});
