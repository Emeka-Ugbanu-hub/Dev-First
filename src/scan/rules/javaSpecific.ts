import type { Node, Tree } from '@vscode/tree-sitter-wasm/wasm/web-tree-sitter';
import type { LanguageProfile } from '../languages/profiles';
import type { RulePack, ScanRange } from '../ruleTypes';
import { nodeRange } from '../treeSitter';
import { descendantsOf, descendantsWithin, named } from './analyzerUtils';

const JAVA = ['java'];

function equalsHashCode(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const classNode of descendantsOf(tree.rootNode, ['class_declaration'])) {
    const body = classNode.childForFieldName('body');
    if (!body) {
      continue;
    }
    const methods = named(body, profile).filter((child) => child.type === 'method_declaration');
    const equals = methods.find((method) => methodName(method) === 'equals' && parameterCount(method) === 1);
    const hashCode = methods.find((method) => methodName(method) === 'hashCode' && parameterCount(method) === 0);
    if (equals && !hashCode) {
      out.push(nodeRange(equals));
    }
    if (hashCode && !equals) {
      out.push(nodeRange(hashCode));
    }
  }
  return out;
}

function methodName(method: Node): string | undefined {
  return method.childForFieldName('name')?.text;
}

function parameterCount(method: Node): number {
  const params = method.childForFieldName('parameters');
  if (!params) {
    return 0;
  }
  return params.namedChildren.filter((child) => child !== null).length;
}

function serialVersionUid(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const classNode of descendantsOf(tree.rootNode, ['class_declaration'])) {
    const interfaces = classNode.childForFieldName('interfaces');
    if (!interfaces) {
      continue;
    }
    const serializable = descendantsOf(interfaces, ['type_identifier']).some(
      (type) => type.text === 'Serializable' || type.text.endsWith('.Serializable'),
    );
    if (!serializable) {
      continue;
    }
    const body = classNode.childForFieldName('body');
    if (!body) {
      continue;
    }
    const hasUid = named(body, profile)
      .filter((child) => child.type === 'field_declaration')
      .some((field) => field.childForFieldName('declarator')?.childForFieldName('name')?.text === 'serialVersionUID');
    if (!hasUid) {
      out.push(nodeRange(classNode));
    }
  }
  return out;
}

function sharedDateFormat(tree: Tree): ScanRange[] {
  const out: ScanRange[] = [];
  for (const field of descendantsOf(tree.rootNode, ['field_declaration'])) {
    const modifiers = field.children.find((child) => child?.type === 'modifiers');
    if (!modifiers || !modifiers.text.includes('static')) {
      continue;
    }
    const type = field.childForFieldName('type');
    if (type?.text.includes('SimpleDateFormat')) {
      out.push(nodeRange(field));
    }
  }
  return out;
}

function doubleCheckedLocking(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const outer of descendantsOf(tree.rootNode, ['if_statement'])) {
    const sync = descendantsWithin(outer, ['synchronized_statement'], profile)[0];
    if (!sync) {
      continue;
    }
    const syncBody = sync.childForFieldName('body');
    if (!syncBody) {
      continue;
    }
    const inner = descendantsWithin(syncBody, ['if_statement'], profile)[0];
    if (!inner) {
      continue;
    }
    const outerCondition = outer.childForFieldName('condition');
    const innerCondition = inner.childForFieldName('condition');
    if (!outerCondition || !innerCondition || !sharesIdentifier(outerCondition, innerCondition)) {
      continue;
    }
    const innerBody = inner.childForFieldName('consequence') ?? inner.childForFieldName('body');
    if (!innerBody) {
      continue;
    }
    if (descendantsWithin(innerBody, ['assignment_expression'], profile).length === 0) {
      continue;
    }
    out.push(nodeRange(outer));
  }
  return out;
}

function sharesIdentifier(left: Node, right: Node): boolean {
  const names = new Set(descendantsOf(left, ['identifier']).map((node) => node.text));
  return descendantsOf(right, ['identifier']).some((node) => names.has(node.text));
}

function waitNotify(tree: Tree): ScanRange[] {
  const out: ScanRange[] = [];
  for (const call of descendantsOf(tree.rootNode, ['method_invocation'])) {
    const name = call.childForFieldName('name')?.text;
    if (name !== 'wait' && name !== 'notify' && name !== 'notifyAll') {
      continue;
    }
    const receiver = call.childForFieldName('object');
    if (receiver && receiver.text !== 'this') {
      continue;
    }
    if (!insideSynchronized(call)) {
      out.push(nodeRange(call));
    }
  }
  return out;
}

function insideSynchronized(node: Node): boolean {
  let current = node.parent;
  while (current) {
    if (current.type === 'synchronized_statement') {
      return true;
    }
    if (current.type === 'lambda_expression') {
      return true;
    }
    if (current.type === 'method_declaration' || current.type === 'constructor_declaration') {
      const modifiers = current.children.find((child) => child?.type === 'modifiers');
      return modifiers ? modifiers.text.includes('synchronized') : false;
    }
    if (current.type === 'class_body' || current.type === 'program') {
      return false;
    }
    current = current.parent;
  }
  return false;
}

export const javaSpecificPack: RulePack = {
  id: 'java-specific',
  languages: JAVA,
  rules: [
    {
      kind: 'analyzer',
      id: 'java-equals-hashcode',
      category: 'bug',
      severity: 'warning',
      languages: JAVA,
      run: equalsHashCode,
      message: 'equals() and hashCode() are out of sync.',
      why: 'Overriding one without the other breaks hash-based collections such as HashMap and HashSet.',
      fix: 'Override both equals(Object) and hashCode(), or neither.',
    },
    {
      kind: 'analyzer',
      id: 'java-serialversionuid',
      category: 'smell',
      severity: 'info',
      languages: JAVA,
      run: serialVersionUid,
      message: 'Serializable class has no serialVersionUID.',
      why: 'Without an explicit id, any change to the class breaks compatibility with previously serialized data.',
      fix: 'Declare a private static final long serialVersionUID field.',
    },
    {
      kind: 'analyzer',
      id: 'java-shared-dateformat',
      category: 'bug',
      severity: 'warning',
      languages: JAVA,
      run: sharedDateFormat,
      message: 'SimpleDateFormat is stored in a static field.',
      why: 'SimpleDateFormat is not thread-safe, so shared instances corrupt dates or throw under concurrency.',
      fix: 'Use DateTimeFormatter, or create a new SimpleDateFormat per thread or call.',
    },
    {
      kind: 'analyzer',
      id: 'java-double-checked-locking',
      category: 'bug',
      severity: 'warning',
      languages: JAVA,
      run: doubleCheckedLocking,
      message: 'Double-checked locking pattern detected.',
      why: 'Double-checked locking is easy to get wrong; without a volatile field another thread can observe a partially constructed object.',
      fix: 'Make the field volatile or initialize it in a static holder or enum.',
    },
    {
      kind: 'analyzer',
      id: 'java-wait-notify',
      category: 'bug',
      severity: 'warning',
      languages: JAVA,
      run: waitNotify,
      message: 'wait()/notify() called outside synchronized.',
      why: 'Calling wait, notify, or notifyAll without holding the monitor throws IllegalMonitorStateException.',
      fix: 'Call wait()/notify() only inside a synchronized block or synchronized method on the same object.',
    },
  ],
};
