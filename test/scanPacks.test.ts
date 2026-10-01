import { describe, expect, it } from 'vitest';

import { scanText } from '../src/scan/engine';
import { RULE_PACKS } from '../src/scan/rules';
import { isRegexRule } from '../src/scan/ruleTypes';
import type { ScanFinding } from '../src/scan/ruleTypes';

const options = { includeHotspots: true };
const categories = ['bug', 'vulnerability', 'smell', 'hotspot', 'secret'];
const severities = ['error', 'warning', 'info', 'hint'];

function scan(text: string, languageId: string): ScanFinding[] {
  return scanText(text, languageId, RULE_PACKS, options);
}

function ids(text: string, languageId: string): string[] {
  return scan(text, languageId).map((finding) => finding.rule.id);
}

describe('rule pack metadata', () => {
  it('has unique ids and valid metadata across every pack', () => {
    const packIds = new Set<string>();
    const ruleIds = new Set<string>();
    for (const pack of RULE_PACKS) {
      expect(packIds.has(pack.id), `duplicate pack id ${pack.id}`).toBe(false);
      packIds.add(pack.id);
      expect(pack.rules.length).toBeGreaterThan(0);
      for (const rule of pack.rules) {
        expect(ruleIds.has(rule.id), `duplicate rule id ${rule.id}`).toBe(false);
        ruleIds.add(rule.id);
        if (isRegexRule(rule)) {
          expect(() => new RegExp(rule.pattern.source, 'gmu')).not.toThrow();
        }
        expect(categories).toContain(rule.category);
        expect(severities).toContain(rule.severity);
        expect(rule.message.trim().length).toBeGreaterThan(0);
        expect(rule.why.trim().length).toBeGreaterThan(0);
        expect(rule.fix.trim().length).toBeGreaterThan(0);
      }
    }
    expect(ruleIds.size).toBeGreaterThan(50);
  });
});

describe('java pack', () => {
  it('flags printStackTrace and weak MessageDigest', () => {
    const source = [
      'import java.security.MessageDigest;',
      'public class Demo {',
      '  void handle(Exception e) {',
      '    try {',
      '      MessageDigest.getInstance("MD5");',
      '    } catch (Exception inner) {',
      '      e.printStackTrace();',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');
    const found = ids(source, 'java');
    expect(found).toContain('scan-java-print-stack-trace');
    expect(found).toContain('scan-java-weak-message-digest');
  });
});

describe('go pack', () => {
  it('flags InsecureSkipVerify and interpolated exec.Command', () => {
    const source = [
      'package main',
      'import (',
      '  "crypto/tls"',
      '  "os/exec"',
      ')',
      'func main() {',
      '  _ = &tls.Config{InsecureSkipVerify: true}',
      '  exec.Command("sh", "-c", "echo " + input)',
      '}',
      '',
    ].join('\n');
    const found = ids(source, 'go');
    expect(found).toContain('scan-go-insecure-skip-verify');
    expect(found).toContain('scan-go-exec-command');
  });
});

describe('php pack', () => {
  it('flags eval and SQL interpolation', () => {
    const source = [
      '<?php',
      'eval($code);',
      '$result = mysqli_query($conn, "SELECT * FROM users WHERE id = $id");',
      'if ($_GET["id"] == $adminId) { return true; }',
      '',
    ].join('\n');
    const found = ids(source, 'php');
    expect(found).toContain('scan-php-eval-assert');
    expect(found).toContain('scan-php-sql-concatenation');
    expect(found).toContain('scan-php-loose-comparison-input');
  });
});

describe('csharp pack', () => {
  it('flags empty catch and interpolated SqlCommand', () => {
    const source = [
      'using System;',
      'class Demo {',
      '  void Run() {',
      '    try { Work(); } catch (Exception) {}',
      '    var cmd = new SqlCommand("SELECT * FROM users WHERE id = " + id);',
      '  }',
      '}',
      '',
    ].join('\n');
    const found = ids(source, 'csharp');
    expect(found).toContain('scan-csharp-empty-catch');
    expect(found).toContain('scan-csharp-sql-concatenation');
  });
});

describe('iac pack', () => {
  it('flags Dockerfile latest tag and privileged containers', () => {
    const dockerfile = ['FROM node:latest', 'USER root', 'RUN docker run --privileged alpine', ''].join('\n');
    const found = ids(dockerfile, 'dockerfile');
    expect(found).toContain('scan-iac-docker-latest-tag');
    expect(found).toContain('scan-iac-docker-privileged');
    expect(found).toContain('scan-iac-docker-root-user');
  });

  it('flags Kubernetes and cloud settings', () => {
    const manifest = [
      'apiVersion: apps/v1',
      'kind: Deployment',
      'spec:',
      '  template:',
      '    spec:',
      '      hostNetwork: true',
      '      containers:',
      '        - image: nginx:latest',
      '          securityContext:',
      '            privileged: true',
      '            runAsUser: 0',
      '',
    ].join('\n');
    const found = ids(manifest, 'yaml');
    expect(found).toContain('scan-iac-k8s-privileged');
    expect(found).toContain('scan-iac-k8s-host-namespace');
    expect(found).toContain('scan-iac-k8s-latest-image');
    expect(found).toContain('scan-iac-k8s-root-user');
  });
});

describe('web pack', () => {
  it('flags images without alt and reports the missing viewport at line 0', () => {
    const source = ['<html>', '<head></head>', '<body>', '<img src="logo.png">', '</body>', '</html>', ''].join(
      '\n',
    );
    const findings = scan(source, 'html');
    const found = findings.map((finding) => finding.rule.id);
    expect(found).toContain('scan-web-img-no-alt');
    const viewport = findings.find((finding) => finding.rule.id === 'html-missing-viewport');
    expect(viewport).toMatchObject({ line: 0, startChar: 0, endChar: 0 });
  });

  it('accepts a complete html document', () => {
    const source =
      '<html lang="en"><head><title>Hi</title><meta name="viewport" content="width=device-width"></head><body></body></html>';
    const found = ids(source, 'html');
    expect(found).not.toContain('html-missing-viewport');
    expect(found).not.toContain('html-missing-title');
    expect(found).not.toContain('scan-web-html-no-lang');
  });

  it('flags css expressions and xml external entities', () => {
    expect(ids('a { width: expression(alert(1)); }', 'css')).toContain('scan-web-css-expression');
    expect(ids('<!DOCTYPE foo SYSTEM "foo.dtd">', 'xml')).toContain('scan-web-xml-doctype-system');
  });
});
