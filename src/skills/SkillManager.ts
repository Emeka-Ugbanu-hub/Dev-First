import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface SkillInfo {
  name: string;
  description?: string;
  file: string;
  baseDir: string;
  dirSkill: boolean;
}

export function skillDirs(root: string | undefined): string[] {
  const dirs: string[] = [];
  if (root) {
    dirs.push(path.join(root, '.dev-first', 'skills'));
  }
  dirs.push(path.join(os.homedir(), '.dev-first', 'skills'));
  return dirs;
}

export async function listSkills(root: string | undefined): Promise<SkillInfo[]> {
  const skills = new Map<string, SkillInfo>();
  for (const dir of skillDirs(root)) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const file = path.join(dir, entry.name, 'SKILL.md');
        const content = await fs.readFile(file, 'utf-8').catch(() => undefined);
        if (content === undefined || skills.has(entry.name)) {
          continue;
        }
        skills.set(entry.name, {
          name: entry.name,
          description: extractDescription(content),
          file,
          baseDir: path.join(dir, entry.name),
          dirSkill: true,
        });
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) {
        continue;
      }
      const name = entry.name.replace(/\.md$/, '');
      if (skills.has(name)) {
        continue;
      }
      const file = path.join(dir, entry.name);
      const content = await fs.readFile(file, 'utf-8').catch(() => '');
      skills.set(name, {
        name,
        description: extractDescription(content),
        file,
        baseDir: dir,
        dirSkill: false,
      });
    }
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function readSkill(root: string | undefined, name: string): Promise<string | undefined> {
  const skill = (await listSkills(root)).find((candidate) => candidate.name === name);
  if (!skill) {
    return undefined;
  }
  return fs.readFile(skill.file, 'utf-8').catch(() => undefined);
}

export interface LoadedSkill {
  content: string;
  baseDir: string;
  files: string[];
}

export async function loadSkill(root: string | undefined, name: string): Promise<LoadedSkill | undefined> {
  const skill = (await listSkills(root)).find((candidate) => candidate.name === name);
  if (!skill) {
    return undefined;
  }
  const content = await fs.readFile(skill.file, 'utf-8').catch(() => undefined);
  if (content === undefined) {
    return undefined;
  }
  const files = skill.dirSkill ? await listSkillFiles(skill.baseDir) : [];
  return { content, baseDir: skill.baseDir, files };
}

export async function listSkillFiles(baseDir: string, limit = 10): Promise<string[]> {
  const results: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    if (results.length >= limit) {
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= limit) {
        return;
      }
      if (entry.name === 'node_modules' || entry.name === '.git') {
        continue;
      }
      const absolute = path.join(dir, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else if (entry.isFile() && relative !== 'SKILL.md') {
        results.push(relative);
      }
    }
  };
  await walk(baseDir, '');
  return results.slice(0, limit);
}

export function skillSummary(skills: SkillInfo[]): string {
  if (skills.length === 0) {
    return '';
  }
  return skills
    .map((skill) => (skill.description ? `${skill.name} — ${skill.description}` : skill.name))
    .join('\n');
}

export interface CommandInfo {
  name: string;
  description?: string;
}

export async function listCommands(root: string | undefined): Promise<CommandInfo[]> {
  const commands = new Map<string, CommandInfo>();
  const dirs = skillDirs(root).map((dir) => path.join(path.dirname(dir), 'commands'));
  for (const dir of dirs) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) {
        continue;
      }
      const name = entry.name.replace(/\.md$/, '');
      if (commands.has(name)) {
        continue;
      }
      const content = await fs.readFile(path.join(dir, entry.name), 'utf-8').catch(() => '');
      commands.set(name, { name, description: extractDescription(content) });
    }
  }
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function expandSlashCommand(
  root: string | undefined,
  text: string,
): Promise<{ name: string; expanded: string } | undefined> {
  const match = /^\/([a-zA-Z0-9_-]+)\s*([\s\S]*)$/.exec(text.trim());
  if (!match) {
    return undefined;
  }
  const [, name, args] = match;
  const dirs = skillDirs(root).map((dir) => path.join(path.dirname(dir), 'commands'));
  for (const dir of dirs) {
    try {
      const content = await fs.readFile(path.join(dir, `${name}.md`), 'utf-8');
      return { name, expanded: content.replace(/\$ARGUMENTS/g, args.trim()) };
    } catch {
      continue;
    }
  }
  return undefined;
}

function extractDescription(content: string): string | undefined {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(content);
  if (frontmatter) {
    const match = /description:\s*(.+)/.exec(frontmatter[1]);
    if (match) {
      return match[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---')) {
      return trimmed.slice(0, 160);
    }
  }
  return undefined;
}
