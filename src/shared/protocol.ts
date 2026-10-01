export type Phase = 'idle' | 'planning' | 'executing' | 'review';

export interface PlanContextEntry {
  path: string;
  role: string;
  /** One-based source range that supports the plan's explanation, when known. */
  startLine?: number;
  endLine?: number;
}

export interface Plan {
  version: number;
  status: 'draft' | 'approved' | 'completed';
  intent?: 'plan' | 'explanation';
  title?: string;
  what?: string;
  how?: string;
  flow?: string;
  why?: string;
  tradeoff?: string;
  leaveAsIs?: string;
  concept?: string;
  convention?: string;
  risks?: string[];
  whyNot?: string;
  context?: PlanContextEntry[];
  steps?: string[];
  skippedSteps?: number[];
  filePath?: string;
  trivial?: boolean;
}

export interface LearnMoreLink {
  title: string;
  url: string;
  why?: string;
}

export interface ToolActivity {
  id: string;
  label: string;
  status: 'running' | 'done' | 'error';
  icon?: string;
  detail?: string;
  detailKind?: 'terminal' | 'text';
  exitCode?: number;
  filePath?: string;
}

export interface TodoItem {
  text: string;
  status: 'pending' | 'in_progress' | 'done' | 'cancelled';
  checkpointId?: string;
}

export interface UiMessage {
  id: string;
  role: 'user' | 'assistant' | 'notice';
  text: string;
  kind?: 'error' | 'completion' | 'compaction';
  compaction?: {
    tokensBefore: number;
    tokensAfter: number;
    messagesBefore: number;
    messagesAfter: number;
  };
  streaming?: boolean;
  takeaways?: string[];
  failureConcept?: string;
  activities?: ToolActivity[];
  checkpointId?: string;
  attachment?: MessageAttachment;
  images?: string[];
  pastes?: PastedContent[];
  reasoning?: string;
  quote?: string;
  queued?: boolean;
  action?: 'openSettings';
  planSnapshot?: { title: string; steps?: string[] };
  changedFiles?: ChangedFile[];
  runId?: string;
}

export interface ChangedFile {
  path: string;
  status: 'modified' | 'added' | 'deleted';
  additions: number;
  deletions: number;
}

export interface ContextUsage {
  tokens: number;
  limit: number;
  reserved?: number;
}

export interface CommandInfo {
  name: string;
  description?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface ChangeHunk {
  id: string;
  startLine: number;
  endLine: number;
  type: 'insert' | 'delete' | 'replace';
}

export interface ChangeSummary {
  path: string;
  additions: number;
  deletions: number;
  isNew: boolean;
  isDeleted: boolean;
  runId?: string;
  runLabel?: string;
  summary?: string;
  hunks?: ChangeHunk[];
}

export interface TerminalApprovalRequest {
  id: string;
  command: string;
  cwd: string;
}

export type TerminalApprovalDecision = 'allow' | 'allow-unsandboxed' | 'deny';

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionItem {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

export interface QuestionRequest {
  id: string;
  question: string;
  header?: string;
  options: QuestionOption[];
  multiple?: boolean;
  questions?: QuestionItem[];
}

export interface ConnectionState {
  preset: string;
  provider: string;
  model: string;
  connected: boolean;
  needsKey: boolean;
  error?: string;
}

export interface ModelMetadata {
  id: string;
  name?: string;
  supportsVision?: boolean;
  reasoningLevels?: string[];
  reasoningDefault?: string;
}

export interface ProviderConnection {
  preset: string;
  label: string;
  model: string;
  active: boolean;
}

export interface SelectionContext {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface MessageAttachment {
  path: string;
  startLine: number;
  endLine: number;
}

export interface PastedContent {
  id: string;
  text: string;
}

export interface UiState {
  phase: Phase;
  messages: UiMessage[];
  plan: Plan | null;
  todos: TodoItem[];
  changes: ChangeSummary[];
  terminalApproval: TerminalApprovalRequest | null;
  question: QuestionRequest | null;
  sandboxEnabled: boolean;
  connection: ConnectionState;
  connections: ProviderConnection[];
  selection: SelectionContext | null;
  contextUsage: ContextUsage;
  currentRunId?: string;
  viewableRuns: string[];
  autoApproveTerminal: boolean;
  supportsVision: boolean;
  visionSupportKnown: boolean;
  modelDisplayName: string;
  reasoningDefault: string;
  reasoningEffort: string;
  reasoningLevels: string[];
  reasoningCurrent: string;
  resources: boolean;
  mcpDisplay: 'plain' | 'markdown';
  soundOnFinish: boolean;
  sessionTitle: string;
  provider: string;
  model: string;
  pasteFileLines: number;
}

export type WebviewMessage =
  | { type: 'ready' }
  | {
      type: 'sendMessage';
      text: string;
      selection?: SelectionContext;
      quote?: string;
      images?: string[];
      pastes?: PastedContent[];
    }
  | { type: 'connect'; preset: string; apiKey?: string; baseUrl?: string }
  | { type: 'fetchModels'; preset: string; apiKey?: string; baseUrl?: string }
  | { type: 'disconnectProvider'; preset: string }
  | { type: 'setProvider'; preset: string; model: string }
  | { type: 'setModel'; model: string }
  | { type: 'compactNow' }
  | { type: 'updatePlan'; markdown: string }
  | { type: 'toggleStep'; index: number }
  | { type: 'openPlan' }
  | { type: 'explainSection'; key: string }
  | { type: 'redoRevert' }
  | { type: 'enhancePrompt'; text: string }
  | { type: 'openFile'; path: string }
  | { type: 'learnMore' }
  | { type: 'questionAnswer'; id: string; answer: string }
  | { type: 'editMessage'; id: string; text: string; restoreWorkspace: boolean }
  | { type: 'cancelQueued'; id: string }
  | { type: 'approvePlan' }
  | { type: 'discardPlan' }
  | { type: 'stop' }
  | { type: 'newSession' }
  | { type: 'switchSession'; id: string }
  | { type: 'deleteSession'; id: string }
  | { type: 'renameSession'; id: string; title: string }
  | { type: 'acceptChange'; path: string }
  | { type: 'rejectChange'; path: string }
  | { type: 'acceptAll' }
  | { type: 'rejectAll' }
  | { type: 'openChange'; path: string; changeId?: string }
  | { type: 'openFileDiff'; path: string; runId: string }
  | { type: 'explainChange'; path: string }
  | { type: 'acceptRun'; runId: string }
  | { type: 'rejectRun'; runId: string }
  | { type: 'resolveRejectConflict'; path: string; action: 'revert-file' | 'keep' }
  | { type: 'reviewChanges' }
  | { type: 'summarizeReview' }
  | { type: 'reviewAcrossFiles' }
  | { type: 'listFiles' }
  | { type: 'terminalApproval'; id: string; decision: TerminalApprovalDecision }
  | { type: 'revertToCheckpoint'; checkpointId: string }
  | { type: 'listCommands' }
  | { type: 'openExternal'; url: string }
  | { type: 'requestSettings' }
  | { type: 'updateSetting'; key: string; value: unknown }
  | { type: 'setReasoningEffort'; preset: string; model: string; value: string }
  | { type: 'openVSCodeSettings' }
  | { type: 'openSettings' };

export type HostMessage =
  | { type: 'state'; state: UiState }
  | { type: 'phase'; phase: Phase }
  | { type: 'addMessage'; message: UiMessage }
  | { type: 'assistantDelta'; id: string; text: string }
  | { type: 'assistantDone'; id: string }
  | { type: 'status'; id: string; text: string; tone?: 'progress' | 'error'; done?: boolean }
  | { type: 'plan'; plan: Plan | null }
  | { type: 'todos'; todos: TodoItem[] }
  | { type: 'checkpoint'; messageId: string; checkpointId: string }
  | { type: 'activity'; messageId: string; activity: ToolActivity }
  | { type: 'changes'; changes: ChangeSummary[]; currentRunId?: string }
  | { type: 'rejectConflict'; path: string }
  | {
      type: 'redoState';
      canRedo: boolean;
      files?: Array<{ path: string; additions: number; deletions: number }>;
    }
  | { type: 'suggestion'; text: string; command: string }
  | { type: 'settings'; values: Record<string, unknown>; version: string }
  | { type: 'enhancedPrompt'; text: string; error?: string }
  | { type: 'learnMoreResult'; chosen: LearnMoreLink[]; alternatives: LearnMoreLink[]; error?: string }
  | { type: 'prefill'; text: string }
  | { type: 'terminalApproval'; request: TerminalApprovalRequest | null }
  | { type: 'question'; request: QuestionRequest | null }
  | { type: 'reasoningDelta'; id: string; text: string }
  | { type: 'removeMessage'; id: string }
  | { type: 'unqueueMessage'; id: string }
  | { type: 'connection'; connection: ConnectionState }
  | { type: 'connectResult'; ok: boolean; error?: string; models?: string[]; details?: Record<string, ModelMetadata>; preset?: string; updatedAt?: number }
  | { type: 'models'; models: string[]; details?: Record<string, ModelMetadata>; error?: string; preset?: string; updatedAt?: number; liveFailed?: boolean }
  | { type: 'selection'; selection: SelectionContext | null }
  | { type: 'usage'; tokens: number; limit: number; reserved?: number }
  | { type: 'commands'; commands: CommandInfo[] }
  | { type: 'files'; files: string[] }
  | { type: 'sessions'; sessions: SessionSummary[]; activeId: string }
  | { type: 'openSettings' }
  | { type: 'error'; message: string };
