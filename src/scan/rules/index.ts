import type { RulePack } from '../ruleTypes';
import { anyPack } from './any';
import { javascriptPack } from './javascript';
import { pythonPack } from './python';
import { javaPack } from './java';
import { goPack } from './go';
import { phpPack } from './php';
import { csharpPack } from './csharp';
import { iacPack } from './iac';
import { webPack } from './web';
import { structuralPack } from './structural';
import { analyzersPack } from './analyzers';
import { flowAnalyzersPack } from './flowAnalyzers';
import { nullFlowPack } from './nullFlow';
import { javaSpecificPack } from './javaSpecific';
import { securitySpecificPack } from './securitySpecific';
import { conventionsPack } from './conventions';
import { secretsMorePack } from './secretsMore';
import { structurePack } from './structure';

export const RULE_PACKS: RulePack[] = [
  anyPack,
  javascriptPack,
  pythonPack,
  javaPack,
  goPack,
  phpPack,
  csharpPack,
  iacPack,
  webPack,
  structuralPack,
  analyzersPack,
  flowAnalyzersPack,
  nullFlowPack,
  javaSpecificPack,
  securitySpecificPack,
  conventionsPack,
  secretsMorePack,
  structurePack,
];
