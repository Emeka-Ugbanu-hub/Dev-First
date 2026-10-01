export interface ArchitectureChild {
  id: string;
  kind: string;
  label: string;
  description: string;
  subtext?: string;
  usedBy: string[];
  dependsOn: string[];
  implementedBy: number;
  fileCount: number;
  file?: string;
}

export type ArchitectureActivation =
  | { type: 'openFile'; path: string }
  | { type: 'drillDown'; id: string };

export function conceptChildren(children: ArchitectureChild[]): ArchitectureChild[] {
  return children.filter((child) => child.kind !== 'file');
}

export function fileChildren(children: ArchitectureChild[]): ArchitectureChild[] {
  return children.filter((child) => child.kind === 'file');
}

export function shouldRenderDiagram(children: ArchitectureChild[]): boolean {
  return children.length > 0 && children.some((child) => child.kind !== 'file');
}

export function activationFor(child: ArchitectureChild): ArchitectureActivation {
  if (child.kind === 'file' && child.file) {
    return { type: 'openFile', path: child.file };
  }
  return { type: 'drillDown', id: child.id };
}
