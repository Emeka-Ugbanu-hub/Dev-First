import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  CommandInfo,
  HostMessage,
  ModelMetadata,
  Phase,
  SessionSummary,
  ToolActivity,
  UiState,
} from '../../src/shared/protocol';
import { post } from './vscode';
import { Header } from './components/Header';
import { ChatView } from './components/ChatView';
import { ChatRenderBoundary } from './components/ChatRenderBoundary';
import { PlanCard } from './components/PlanCard';
import { TerminalApprovalCard } from './components/TerminalApprovalCard';
import { DiffReviewBar } from './components/DiffReviewBar';
import { InputBox } from './components/InputBox';
import { QuestionCard } from './components/QuestionCard';
import { ConnectResult, OnboardingCard } from './components/OnboardingCard';
import { ModelPicker } from './components/ModelPicker';
import { SettingsPanel } from './components/settings/SettingsPanel';
import { LearnMoreModal } from './components/LearnMoreModal';
import { RevertBanner } from './components/RevertBanner';
import { SuggestionBar } from './components/SuggestionBar';
import { StatusRow } from './components/StatusRow';
import { TranscriptSearch } from './components/TranscriptSearch';
import { PromptRail } from './components/PromptRail';
import { RecoveryCard } from './components/RecoveryCard';
import { appendDelta } from '../../src/shared/stream';
import { buildSearchPattern, collectSearchTexts } from './lib/search';
import { shouldFollow } from './lib/scroll';
import { nearestPromptIndex, needsCorrection, promptJumpTop } from './lib/promptJump';
import { shouldDockPlan } from './lib/planDock';
import { htmlToMarkdown } from './lib/htmlToMarkdown';
import { setKnownFiles } from './lib/fileLinks';
import { useOverlayDismiss } from './lib/overlays';

const PAGE_SIZE = 60;
const MAX_WINDOW = PAGE_SIZE * 2;
const JUMP_CONTEXT = Math.floor(PAGE_SIZE / 2);

const initialState: UiState = {
  phase: 'idle',
  messages: [],
  plan: null,
  todos: [],
  changes: [],
  terminalApproval: null,
  sandboxEnabled: false,
  connection: { preset: '', provider: '', model: '', connected: false, needsKey: false },
  connections: [],
  selection: null,
  contextUsage: { tokens: 0, limit: 0 },
  question: null,
  viewableRuns: [],
  autoApproveTerminal: false,
  supportsVision: true,
  visionSupportKnown: false,
  modelDisplayName: '',
  reasoningEffort: 'off',
  reasoningLevels: [],
  reasoningCurrent: 'off',
  reasoningDefault: '',
  resources: true,
  mcpDisplay: 'markdown',
  soundOnFinish: false,
  sessionTitle: 'New session',
  provider: '',
  model: '',
  pasteFileLines: 120,
};

export default function App() {
  const [state, setState] = useState<UiState>(initialState);
  const [models, setModels] = useState<string[]>([]);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, string[]>>({});
  const [modelDetailsByProvider, setModelDetailsByProvider] = useState<Record<string, ModelMetadata[]>>({});
  const [modelsError, setModelsError] = useState<string | undefined>(undefined);
  const [modelsUpdatedAtByProvider, setModelsUpdatedAtByProvider] = useState<Record<string, number>>({});
  const [modelsLiveFailedByProvider, setModelsLiveFailedByProvider] = useState<Record<string, boolean>>({});
  const [connectResult, setConnectResult] = useState<ConnectResult | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [modelPickerRight, setModelPickerRight] = useState<number | undefined>(undefined);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCase, setSearchCase] = useState(false);
  const [searchRegex, setSearchRegex] = useState(false);
  const [matchIndex, setMatchIndex] = useState(0);
  const [visibleRange, setVisibleRange] = useState<{ start: number; end: number } | null>(null);
  const [inlinePlanAnchor, setInlinePlanAnchor] = useState<string | null>(null);
  const [activePromptId, setActivePromptId] = useState<string | undefined>(undefined);
  const scrollAdjust = useRef<{ id: string; top: number } | null>(null);
  const pendingPromptJump = useRef<string | null>(null);
  const jumpLockRef = useRef(0);
  const boundaryLoadCooldown = useRef(0);
  const previousPhase = useRef<Phase>('idle');
  const [dismissedSelectionKey, setDismissedSelectionKey] = useState<string | null>(null);
  const [quote, setQuote] = useState<string | null>(null);
  const [quoteCandidate, setQuoteCandidate] = useState<{ text: string; x: number; y: number } | null>(null);
  const quoteRef = useRef<HTMLButtonElement>(null);
  useOverlayDismiss(quoteCandidate !== null, () => setQuoteCandidate(null), quoteRef);
  const [rejectConflicts, setRejectConflicts] = useState<string[]>([]);
  const [canRedo, setCanRedo] = useState(false);
  const [revertFiles, setRevertFiles] = useState<Array<{ path: string; additions: number; deletions: number }>>([]);
  const [suggestion, setSuggestion] = useState<{ text: string; command: string } | null>(null);
  const [images, setImages] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const streamingId = useRef<string | null>(null);
  const sessionQueuedIds = useRef(new Set<string>());
  const pendingStreamDeltas = useRef(new Map<string, { text: string; reasoning: string }>());
  const streamFrame = useRef<number | null>(null);
  const [enhanced, setEnhanced] = useState<{ text: string; nonce: number } | null>(null);
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const [dismissedRecovery, setDismissedRecovery] = useState<string | null>(null);
  const [learnMoreOpen, setLearnMoreOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsValues, setSettingsValues] = useState<Record<string, unknown>>({});
  const [settingsVersion, setSettingsVersion] = useState('');
  const [forceOnboarding, setForceOnboarding] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [status, setStatus] = useState<{ id: string; text: string; tone: 'progress' | 'error' } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const pendingUserScroll = useRef<number | null>(null);
  const activePresetRef = useRef('');
  const modelsByProviderRef = useRef<Record<string, string[]>>({});
  const transcriptMessages = useMemo(() => state.messages.filter((message) => !message.queued), [state.messages]);
  const queuedMessages = useMemo(() => state.messages.filter((message) => message.queued), [state.messages]);
  const recoveredQueueIds = useMemo(
    () =>
      (state.queued ?? [])
        .filter((record) => record.status === 'queued' && !sessionQueuedIds.current.has(record.id))
        .map((record) => record.id),
    [state.queued],
  );
  const recoveryKey = state.recovery ? `${state.recovery.run.id}:${state.recovery.run.updatedAt}` : null;
  const continueInterrupted = useCallback(
    () => setPrefill({ text: 'Continue from where you stopped.', nonce: Date.now() }),
    [],
  );
  const visibleStart = visibleRange?.start ?? Math.max(0, transcriptMessages.length - PAGE_SIZE);
  const visibleEnd = visibleRange?.end ?? transcriptMessages.length;
  const visibleMessages = useMemo(
    () => transcriptMessages.slice(visibleStart, visibleEnd),
    [transcriptMessages, visibleStart, visibleEnd],
  );
  const hiddenCount = visibleStart;
  useEffect(() => {
    const flushStreamDeltas = () => {
      streamFrame.current = null;
      const pending = pendingStreamDeltas.current;
      if (pending.size === 0) return;
      const deltas = [...pending.entries()];
      pending.clear();
      setState((previous) => {
        let next = previous;
        for (const [id, delta] of deltas) {
          if (delta.text) next = applyHostMessage(next, { type: 'assistantDelta', id, text: delta.text });
          if (delta.reasoning) next = applyHostMessage(next, { type: 'reasoningDelta', id, text: delta.reasoning });
        }
        return next;
      });
    };
    const onMessage = (event: MessageEvent<HostMessage>) => {
      const message = event.data;
      if (message.type === 'assistantDelta' || message.type === 'reasoningDelta') {
        const delta = pendingStreamDeltas.current.get(message.id) ?? { text: '', reasoning: '' };
        if (message.type === 'assistantDelta') delta.text += message.text;
        else delta.reasoning += message.text;
        pendingStreamDeltas.current.set(message.id, delta);
        if (streamFrame.current === null) streamFrame.current = requestAnimationFrame(flushStreamDeltas);
        return;
      }
      if (message.type === 'assistantDone' && pendingStreamDeltas.current.size > 0) {
        if (streamFrame.current !== null) cancelAnimationFrame(streamFrame.current);
        flushStreamDeltas();
      }
      if (message.type === 'models') {
        if (message.preset) {
          modelsByProviderRef.current = { ...modelsByProviderRef.current, [message.preset]: message.models };
          setModelsByProvider(modelsByProviderRef.current);
          setModelDetailsByProvider((current) => ({ ...current, [message.preset!]: Object.values(message.details ?? {}) }));
          if (message.updatedAt) {
            setModelsUpdatedAtByProvider((current) => ({ ...current, [message.preset!]: message.updatedAt! }));
          }
          setModelsLiveFailedByProvider((current) => ({ ...current, [message.preset!]: Boolean(message.liveFailed) }));
          if (message.preset === activePresetRef.current) {
            setModels(message.models);
            setModelsError(message.error);
          }
          return;
        }
        setModels(message.models);
        setModelsError(message.error);
        return;
      }
      if (message.type === 'connectResult') {
        setConnectResult({ ok: message.ok, error: message.error });
        if (message.ok) {
          const preset = message.preset ?? activePresetRef.current;
          modelsByProviderRef.current = { ...modelsByProviderRef.current, [preset]: message.models ?? [] };
          setModelsByProvider(modelsByProviderRef.current);
          setModelDetailsByProvider((current) => ({ ...current, [preset]: Object.values(message.details ?? {}) }));
          if (message.updatedAt) {
            setModelsUpdatedAtByProvider((current) => ({ ...current, [preset]: message.updatedAt! }));
          }
          setModelsLiveFailedByProvider((current) => ({ ...current, [preset]: false }));
          if (preset === activePresetRef.current) {
            setModels(message.models ?? []);
            setModelsError(undefined);
          }
        }
        return;
      }
      if (message.type === 'state') {
        const next = message.state;
        activePresetRef.current = next.connection.preset;
        const list = modelsByProviderRef.current[next.connection.preset];
        setModels(list ?? []);
        setModelsError(undefined);
        setState(next);
        return;
      }
      if (message.type === 'commands') {
        setCommands(message.commands);
        return;
      }
      if (message.type === 'prefill') {
        setPrefill({ text: message.text, nonce: Date.now() });
        return;
      }
      if (message.type === 'files') {
        setFiles(message.files);
        setKnownFiles(message.files);
        return;
      }
      if (message.type === 'sessions') {
        setSessions(message.sessions);
        setActiveSessionId(message.activeId);
        return;
      }
      if (message.type === 'rejectConflict') {
        setRejectConflicts((previous) =>
          previous.includes(message.path) ? previous : [...previous, message.path],
        );
        return;
      }
      if (message.type === 'redoState') {
        setCanRedo(message.canRedo);
        setRevertFiles(message.files ?? []);
        return;
      }
      if (message.type === 'suggestion') {
        setSuggestion({ text: message.text, command: message.command });
        return;
      }
      if (message.type === 'settings') {
        setSettingsValues(message.values);
        setSettingsVersion(message.version);
        return;
      }
      if (message.type === 'enhancedPrompt') {
        setEnhanced({ text: message.text, nonce: Date.now() });
        return;
      }
      if (message.type === 'openSettings') {
        setSettingsOpen(true);
        post({ type: 'requestSettings' });
        return;
      }
      if (message.type === 'status') {
        if (message.done) {
          setStatus((previous) => (previous?.id === message.id ? null : previous));
        } else {
          setStatus({ id: message.id, text: message.text, tone: message.tone ?? 'progress' });
        }
        return;
      }
      if (message.type === 'addMessage' && message.message.queued) {
        sessionQueuedIds.current.add(message.message.id);
      }
      setState((previous) => applyHostMessage(previous, message));
    };
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    post({ type: 'listCommands' });
    post({ type: 'listFiles' });
    return () => {
      window.removeEventListener('message', onMessage);
      if (streamFrame.current !== null) cancelAnimationFrame(streamFrame.current);
      streamFrame.current = null;
      pendingStreamDeltas.current.clear();
    };
  }, []);

  useEffect(() => {
    const onLearnMore = () => setLearnMoreOpen(true);
    window.addEventListener('df-learn-more', onLearnMore);
    return () => window.removeEventListener('df-learn-more', onLearnMore);
  }, []);

  useEffect(() => {
    const previous = previousPhase.current;
    previousPhase.current = state.phase;
    const finished =
      (previous === 'executing' || previous === 'planning') && (state.phase === 'idle' || state.phase === 'review');
    if (finished && state.soundOnFinish) {
      try {
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.frequency.value = 660;
        gain.gain.value = 0.05;
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start();
        oscillator.stop(context.currentTime + 0.15);
      } catch {
        // audio unavailable
      }
    }
  }, [state.phase, state.soundOnFinish]);

  useEffect(() => {
    if (state.terminalApproval || state.question) {
      setAnnouncement('Waiting for your approval');
      return;
    }
    if (state.phase === 'planning') {
      setAnnouncement('Planning');
      return;
    }
    if (state.phase === 'executing') {
      setAnnouncement('Working');
      return;
    }
    if (state.plan?.status === 'draft') {
      setAnnouncement('Waiting for your approval');
    }
  }, [state.phase, state.terminalApproval, state.question, state.plan]);

  useEffect(() => {
    const streaming = state.messages.find((message) => message.streaming);
    if (streaming) {
      streamingId.current = streaming.id;
      return;
    }
    const previousId = streamingId.current;
    if (!previousId) {
      return;
    }
    streamingId.current = null;
    if (state.messages.some((message) => message.id === previousId)) {
      setAnnouncement('Response ready');
    }
  }, [state.messages]);

  useEffect(() => {
    const isTyping = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable);
    const onKeyDown = (event: KeyboardEvent) => {
      if (state.terminalApproval && !isTyping(event.target)) {
        if (event.key === 'Enter') {
          event.preventDefault();
          post({ type: 'terminalApproval', id: state.terminalApproval.id, decision: 'allow' });
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          post({ type: 'terminalApproval', id: state.terminalApproval.id, decision: 'deny' });
          return;
        }
      }
      if (state.question && event.key === 'Escape' && !isTyping(event.target)) {
        post({ type: 'questionAnswer', id: state.question.id, answer: '' });
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        if (state.plan && state.plan.status === 'draft' && state.phase !== 'planning' && state.phase !== 'executing') {
          event.preventDefault();
          post({ type: 'approvePlan' });
        }
        return;
      }
      if (event.key === 'Escape' && (state.phase === 'planning' || state.phase === 'executing')) {
        post({ type: 'stop' });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [state.plan, state.phase, state.terminalApproval, state.question]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    if (scrollAdjust.current !== null) {
      const anchor = scrollAdjust.current;
      const message = Array.from(element.querySelectorAll<HTMLElement>('[data-message-id]'))
        .find((candidate) => candidate.dataset.messageId === anchor.id);
      if (message) {
        element.scrollTop += message.getBoundingClientRect().top - anchor.top;
      }
      scrollAdjust.current = null;
      return;
    }
    if (followRef.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [state.messages, state.plan, state.terminalApproval, state.changes, visibleRange]);

  const planDocked = shouldDockPlan(state.phase, state.plan);

  const captureScrollAnchor = () => {
    const container = scrollRef.current;
    if (!container) return;
    const containerTop = container.getBoundingClientRect().top;
    const firstVisible = Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]'))
      .find((message) => message.getBoundingClientRect().bottom > containerTop + 1);
    if (firstVisible) {
      scrollAdjust.current = {
        id: firstVisible.dataset.messageId ?? '',
        top: firstVisible.getBoundingClientRect().top,
      };
    }
  };

  useEffect(() => {
    if (!state.plan || planDocked) {
      setInlinePlanAnchor(null);
      return;
    }
    setInlinePlanAnchor((current) => current ?? state.messages[state.messages.length - 1]?.id ?? null);
  }, [state.plan, planDocked, state.messages]);

  useEffect(() => {
    const index = pendingUserScroll.current;
    if (index === null || !scrollRef.current) {
      return;
    }
    const userElements = Array.from(
      scrollRef.current.querySelectorAll<HTMLElement>('[data-message-role="user"]'),
    );
    if (userElements.length < index) {
      return;
    }
    pendingUserScroll.current = null;
    followRef.current = true;
    userElements[index - 1].scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [state.messages]);

  useLayoutEffect(() => {
    const id = pendingPromptJump.current;
    if (id) scrollToPromptMessage(id);
  }, [visibleMessages]);

  useEffect(() => {
    setVisibleRange(null);
    pendingPromptJump.current = null;
    setActivePromptId(undefined);
    setSearchOpen(false);
    setSearchQuery('');
    setInlinePlanAnchor(null);
  }, [activeSessionId]);

  const searchTargets = useMemo(() => {
    const pattern = buildSearchPattern(searchQuery, searchCase, searchRegex);
    if (!pattern) {
      return [];
    }
    const results: Array<{ id: string; text: string }> = [];
    for (const target of collectSearchTexts(state.messages)) {
      pattern.lastIndex = 0;
      if (pattern.test(target.text)) {
        results.push(target);
      }
    }
    return results;
  }, [state.messages, searchQuery, searchCase, searchRegex]);

  useEffect(() => {
    setMatchIndex(0);
  }, [searchQuery, searchCase, searchRegex]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || typeof (CSS as any).highlights === 'undefined') {
      return;
    }
    const pattern = buildSearchPattern(searchQuery, searchCase, searchRegex);
    if (!pattern) {
      (CSS as any).highlights.delete('df-search');
      (CSS as any).highlights.delete('df-search-current');
      return;
    }
    const ranges: Range[] = [];
    const currentRanges: Range[] = [];
    const activeId = searchTargets[matchIndex]?.id;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.textContent ?? '';
      if (!text) {
        continue;
      }
      const element = (node.parentElement?.closest('[data-message-id]') as HTMLElement | null) ?? null;
      const messageId = element?.dataset.messageId;
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text))) {
        if (match[0].length === 0) {
          break;
        }
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        ranges.push(range);
        if (messageId && messageId === activeId) {
          currentRanges.push(range);
        }
      }
    }
    const HighlightCtor = (window as any).Highlight;
    if (HighlightCtor) {
      (CSS as any).highlights.set('df-search', new HighlightCtor(...ranges));
      (CSS as any).highlights.set('df-search-current', new HighlightCtor(...currentRanges));
    }
    return () => {
      (CSS as any).highlights.delete('df-search');
      (CSS as any).highlights.delete('df-search-current');
    };
  }, [searchTargets, matchIndex, searchQuery, searchCase, searchRegex, state.messages]);

  useEffect(() => {
    if (searchTargets.length === 0) {
      return;
    }
    const target = searchTargets[Math.min(matchIndex, searchTargets.length - 1)];
    const element = scrollRef.current?.querySelector(`[data-message-id="${target.id}"]`);
    element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [matchIndex, searchTargets]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    const onScroll = () => {
      const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
      followRef.current = shouldFollow(distanceFromBottom);
      setShowScrollTop(distanceFromBottom > 120);
      if (Date.now() < jumpLockRef.current) {
        return;
      }
      const userElements = Array.from(element.querySelectorAll('[data-message-role="user"]')) as HTMLElement[];
      if (userElements.length === 0) {
        return;
      }
      const containerTop = element.getBoundingClientRect().top;
      let active = userElements[0];
      if (distanceFromBottom <= 40) {
        active = userElements[userElements.length - 1];
      } else {
        const centers = userElements.map((candidate) => {
          const rect = candidate.getBoundingClientRect();
          return rect.top + rect.height / 2;
        });
        const index = nearestPromptIndex(containerTop, element.clientHeight, centers);
        if (index >= 0) {
          active = userElements[index];
        }
      }
      setActivePromptId(active.dataset.messageId);

      if (Date.now() >= boundaryLoadCooldown.current && element.scrollTop < 100 && visibleStart > 0) {
        boundaryLoadCooldown.current = Date.now() + 150;
        captureScrollAnchor();
        setVisibleRange((range) => {
          const start = Math.max(0, (range?.start ?? Math.max(0, transcriptMessages.length - PAGE_SIZE)) - PAGE_SIZE);
          const end = Math.min(range?.end ?? transcriptMessages.length, start + MAX_WINDOW);
          return { start, end };
        });
      } else if (
        Date.now() >= boundaryLoadCooldown.current &&
        distanceFromBottom <= 80 &&
        visibleRange !== null &&
        visibleEnd < transcriptMessages.length
      ) {
        boundaryLoadCooldown.current = Date.now() + 150;
        setVisibleRange((range) => range ? {
          start: Math.max(range.start, Math.min(transcriptMessages.length, range.end + PAGE_SIZE) - MAX_WINDOW),
          end: Math.min(transcriptMessages.length, range.end + PAGE_SIZE),
        } : range);
      }
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => element.removeEventListener('scroll', onScroll);
  }, [state.messages, transcriptMessages, visibleRange, visibleStart, visibleEnd]);

  const scrollToPromptMessage = (id: string): boolean => {
    const container = scrollRef.current;
    const message = Array.from(container?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])
      .find((element) => element.dataset.messageId === id);
    if (!container || !message) return false;
    pendingPromptJump.current = null;
    followRef.current = false;
    jumpLockRef.current = Date.now() + 700;
    const desiredTop = () =>
      promptJumpTop(
        message.getBoundingClientRect().top,
        container.getBoundingClientRect().top,
        container.scrollTop,
        container.clientHeight,
        message.getBoundingClientRect().height,
      );
    container.scrollTo({ top: desiredTop(), behavior: 'auto' });
    message.classList.remove('message-flash');
    window.requestAnimationFrame(() => {
      message.classList.add('message-flash');
      window.setTimeout(() => message.classList.remove('message-flash'), 1200);
    });
    for (const delay of [0, 250, 600]) {
      window.setTimeout(() => {
        if (!container.isConnected) return;
        const desired = desiredTop();
        if (needsCorrection(container.scrollTop, desired)) {
          container.scrollTo({ top: desired, behavior: 'auto' });
        }
      }, delay);
    }
    return true;
  };

  const jumpToMessage = (id: string) => {
    const targetIndex = transcriptMessages.findIndex((message) => message.id === id);
    if (!scrollRef.current || targetIndex < 0) return;
    followRef.current = false;
    setActivePromptId(id);
    if (scrollToPromptMessage(id)) return;
    pendingPromptJump.current = id;
    const start = Math.max(0, targetIndex - JUMP_CONTEXT);
    const end = Math.min(transcriptMessages.length, Math.max(start + PAGE_SIZE, targetIndex + JUMP_CONTEXT + 1));
    setVisibleRange({ start, end });
  };

  const loadEarlier = () => {
    captureScrollAnchor();
    const start = visibleRange?.start ?? Math.max(0, transcriptMessages.length - PAGE_SIZE);
    const nextStart = Math.max(0, start - PAGE_SIZE);
    setVisibleRange({ start: nextStart, end: Math.min(visibleEnd, nextStart + MAX_WINDOW) });
  };

  const selection = state.selection;
  const selectionKey = selection ? `${selection.path}:${selection.startLine}:${selection.endLine}` : null;
  const visibleSelection = selectionKey && selectionKey !== dismissedSelectionKey ? selection : null;
  const showOnboarding = (!state.connection.connected && !onboardingDismissed) || connectResult?.ok === true || forceOnboarding;

  return (
    <div
      className="app"
      onDragOver={(event) => {
        if (event.dataTransfer?.types?.includes('Files')) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) {
          setDragging(false);
        }
      }}
      onDrop={() => setDragging(false)}
    >
      {dragging && (
        <div className="drop-overlay">
          <span className="codicon codicon-cloud-upload" />
          <span>Drop images to attach</span>
        </div>
      )}
      <Header
        phase={state.phase}
        sessions={sessions}
        activeSessionId={activeSessionId}
        contextUsage={state.contextUsage}
        onSearchClick={() => setSearchOpen((value) => !value)}
        onSettingsClick={() => {
          setSettingsOpen(true);
          post({ type: 'requestSettings' });
        }}
        searchActive={searchOpen}
      />
      {learnMoreOpen && state.resources && (
        <LearnMoreModal title={state.plan?.title ?? 'this task'} onClose={() => setLearnMoreOpen(false)} />
      )}
      {settingsOpen && (
        <SettingsPanel
          values={settingsValues}
          version={settingsVersion}
          connections={state.connections}
          onClose={() => {
            setSettingsOpen(false);
            setTimeout(() => document.querySelector<HTMLTextAreaElement>('.input-textarea')?.focus(), 0);
          }}
          onAddProvider={() => {
            setSettingsOpen(false);
            setForceOnboarding(true);
          }}
          onDisconnectProvider={(preset) => post({ type: 'disconnectProvider', preset })}
          onNewSession={() => {
            setSettingsOpen(false);
            post({ type: 'newSession' });
          }}
        />
      )}
      {searchOpen && (
        <TranscriptSearch
          query={searchQuery}
          caseSensitive={searchCase}
          useRegex={searchRegex}
          count={searchTargets.length}
          current={matchIndex}
          onQueryChange={setSearchQuery}
          onCaseChange={setSearchCase}
          onRegexChange={setSearchRegex}
          onPrev={() =>
            setMatchIndex((index) => (searchTargets.length === 0 ? 0 : (index - 1 + searchTargets.length) % searchTargets.length))
          }
          onNext={() =>
            setMatchIndex((index) => (searchTargets.length === 0 ? 0 : (index + 1) % searchTargets.length))
          }
          onClose={() => {
            setSearchOpen(false);
            setSearchQuery('');
            setTimeout(() => document.querySelector<HTMLTextAreaElement>('.input-textarea')?.focus(), 0);
          }}
        />
      )}
      {pickerOpen && (
        <ModelPicker
          connection={state.connection}
          connections={state.connections}
          models={models}
            modelsByProvider={modelsByProvider}
            modelDetailsByProvider={modelDetailsByProvider}
          modelsError={modelsError}
          modelsUpdatedAtByProvider={modelsUpdatedAtByProvider}
          modelsLiveFailedByProvider={modelsLiveFailedByProvider}
          anchorRight={modelPickerRight}
          onAddProvider={() => {
            setPickerOpen(false);
            setForceOnboarding(true);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
      {quoteCandidate && (
        <button
          className="quote-float"
          ref={quoteRef}
          style={{ left: Math.min(quoteCandidate.x, window.innerWidth - 90), top: Math.max(8, quoteCandidate.y - 36) }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setQuote(quoteCandidate.text);
            setQuoteCandidate(null);
          }}
        >
          <span className="codicon codicon-quote" /> Quote
        </button>
      )}
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
      <div className="transcript-wrap">
        <PromptRail messages={transcriptMessages} activeId={activePromptId} onJump={jumpToMessage} />
        <div
          className="scroll-area"
          ref={scrollRef}
          role="region"
          aria-label="Conversation"
          onCopy={(event) => {
            const selection = window.getSelection();
            if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
              return;
            }
            const container = scrollRef.current;
            if (!container || !container.contains(selection.anchorNode)) {
              return;
            }
            const wrapper = document.createElement('div');
            wrapper.appendChild(selection.getRangeAt(0).cloneContents());
            const markdown = htmlToMarkdown(wrapper.innerHTML);
            if (markdown.trim()) {
              event.preventDefault();
              event.clipboardData?.setData('text/plain', markdown);
            }
          }}
          onMouseUp={(event) => {
            const selection = window.getSelection()?.toString().trim() ?? '';
            if (selection.length > 3) {
              setQuoteCandidate({ text: selection.slice(0, 2000), x: event.clientX, y: event.clientY });
            } else {
              setQuoteCandidate(null);
            }
          }}
        >
          {hiddenCount > 0 && (
            <button className="load-earlier" onClick={loadEarlier}>
              <span className="codicon codicon-arrow-up" /> Load earlier ({hiddenCount} more)
            </button>
          )}
          {state.recovery && dismissedRecovery !== recoveryKey && (
            <RecoveryCard run={state.recovery.run} onDismiss={() => setDismissedRecovery(recoveryKey)} />
          )}
          <ChatRenderBoundary key={activeSessionId}>
            <ChatView
              messages={visibleMessages}
              mcpDisplay={state.mcpDisplay}
              onExample={(text) => post({ type: 'sendMessage', text })}
              plan={planDocked ? null : state.plan}
              todos={state.todos}
              phase={state.phase}
              planAnchor={inlinePlanAnchor}
              onApprove={() => post({ type: 'approvePlan' })}
              viewableRuns={state.viewableRuns}
              queuedRecords={state.queued}
              recoveredQueueIds={recoveredQueueIds}
              onContinueInterrupted={continueInterrupted}
            />
          </ChatRenderBoundary>
          {status && <StatusRow text={status.text} tone={status.tone} />}
        {state.terminalApproval && (
          <TerminalApprovalCard request={state.terminalApproval} sandboxEnabled={state.sandboxEnabled} />
        )}
          {state.question && <QuestionCard request={state.question} />}
          {state.plan && planDocked && (
            <PlanCard plan={state.plan} phase={state.phase} todos={state.todos} onApprove={() => post({ type: 'approvePlan' })} />
          )}
        </div>
        {showScrollTop && (
          <button
            className="scroll-top"
            title="Scroll to latest"
            onClick={() => {
              followRef.current = true;
              const element = scrollRef.current;
              element?.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
            }}
          >
            <span className="codicon codicon-arrow-down" />
          </button>
        )}
      </div>
      {state.changes.length > 0 && (
        <DiffReviewBar
          changes={state.changes}
          currentRunId={state.currentRunId}
          conflicts={rejectConflicts.filter((path) =>
            state.changes.some((change) => change.path === path),
          )}
        />
      )}
      {showOnboarding ? (
        <OnboardingCard
          connection={state.connection}
          connectResult={connectResult}
          onConnect={(preset, apiKey, baseUrl) => post({ type: 'connect', preset, apiKey, baseUrl })}
          onSetModel={(model) => post({ type: 'setModel', model })}
          onDone={() => {
            setConnectResult(null);
            setForceOnboarding(false);
            setOnboardingDismissed(false);
          }}
          onDismiss={() => {
            setConnectResult(null);
            setForceOnboarding(false);
            setOnboardingDismissed(true);
          }}
        />
      ) : (
        <>
          <RevertBanner canRedo={canRedo} files={revertFiles} />
          {suggestion && <SuggestionBar suggestion={suggestion} onDismiss={() => setSuggestion(null)} />}
          <InputBox
            phase={state.phase}
            hasPlan={Boolean(state.plan)}
            connected={state.connection.connected}
            selection={visibleSelection}
            commands={commands}
            files={files}
            quote={quote}
            images={images}
            sessions={sessions}
            autoApproveTerminal={state.autoApproveTerminal}
            supportsVision={state.supportsVision}
            visionSupportKnown={state.visionSupportKnown}
            reasoningEffort={state.reasoningCurrent || state.reasoningEffort}
            modelName={state.modelDisplayName || state.connection.model}
            modelId={state.connection.model}
            modelPreset={state.connection.preset}
            reasoningLevels={state.reasoningLevels ?? []}
            queuedMessages={queuedMessages}
            queuedRecords={state.queued}
            recoveredQueueIds={recoveredQueueIds}
            enhanced={enhanced}
            prefill={prefill}
            pasteFileLines={state.pasteFileLines}
            onImagesChange={setImages}
            onOpenModelPicker={(anchor) => {
              if (anchor) {
                const rect = anchor.getBoundingClientRect();
                const panelWidth = Math.min(360, window.innerWidth - 24);
                const left = Math.max(8, Math.min(window.innerWidth - panelWidth - 8, rect.right - panelWidth));
                setModelPickerRight(window.innerWidth - left - panelWidth);
              }
              setPickerOpen(true);
            }}
            onToggleAutoApprove={() =>
              post({ type: 'updateSetting', key: 'autoApproveTerminal', value: !state.autoApproveTerminal })
            }
            onSend={(text, sentImages, sentPastes) => {
              post({
                type: 'sendMessage',
                text,
                selection: visibleSelection ?? undefined,
                quote: quote ?? undefined,
                images: sentImages,
                pastes: sentPastes,
              });
              setQuote(null);
              followRef.current = true;
              const visibleUserCount = transcriptMessages
                .slice(-PAGE_SIZE)
                .filter((message) => message.role === 'user').length;
              setVisibleRange(null);
              pendingUserScroll.current = visibleUserCount + 1;
            }}
            onEditQueued={(message) => {
              post({ type: 'cancelQueued', id: message.id });
              setPrefill({ text: message.text, nonce: Date.now() });
              setImages(message.images ?? []);
              setQuote(message.quote ?? null);
            }}
            onCancelQueued={(id) => post({ type: 'cancelQueued', id })}
            onStop={() => post({ type: 'stop' })}
            onDismissSelection={() => setDismissedSelectionKey(selectionKey)}
            onDismissQuote={() => setQuote(null)}
            onEnhance={(text) => post({ type: 'enhancePrompt', text })}
          />
        </>
      )}
    </div>
  );
}

function applyHostMessage(previous: UiState, message: HostMessage): UiState {
  switch (message.type) {
    case 'state':
      return message.state;
    case 'phase':
      return { ...previous, phase: message.phase };
    case 'connection':
      return { ...previous, connection: message.connection };
    case 'selection':
      return { ...previous, selection: message.selection };
    case 'usage':
      return {
        ...previous,
        contextUsage: { tokens: message.tokens, limit: message.limit, reserved: message.reserved },
      };
    case 'addMessage':
      return { ...previous, messages: [...previous.messages, message.message] };
    case 'assistantDelta':
      return {
        ...previous,
        messages: previous.messages.map((item) =>
          item.id === message.id ? { ...item, text: appendDelta(item.text, message.text) } : item,
        ),
      };
    case 'assistantDone':
      return {
        ...previous,
        messages: previous.messages.map((item) =>
          item.id === message.id ? { ...item, streaming: false } : item,
        ),
      };
    case 'plan':
      return { ...previous, plan: message.plan };
    case 'todos':
      return { ...previous, todos: message.todos };
    case 'checkpoint':
      return {
        ...previous,
        messages: previous.messages.map((item) =>
          item.id === message.messageId ? { ...item, checkpointId: message.checkpointId } : item,
        ),
      };
    case 'activity':
      return {
        ...previous,
        messages: previous.messages.map((item) =>
          item.id === message.messageId
            ? { ...item, activities: upsertActivity(item.activities ?? [], message.activity) }
            : item,
        ),
      };
    case 'changes':
      return { ...previous, changes: message.changes, currentRunId: message.currentRunId };
    case 'terminalApproval':
      return { ...previous, terminalApproval: message.request };
    case 'question':
      return { ...previous, question: message.request };
    case 'reasoningDelta':
      return {
        ...previous,
        messages: previous.messages.map((item) =>
          item.id === message.id ? { ...item, reasoning: appendDelta(item.reasoning ?? '', message.text) } : item,
        ),
      };
    case 'removeMessage':
      return { ...previous, messages: previous.messages.filter((item) => item.id !== message.id) };
    case 'unqueueMessage':
      return {
        ...previous,
        messages: previous.messages.map((item) =>
          item.id === message.id ? { ...item, queued: false } : item,
        ),
      };
    case 'error':
      return {
        ...previous,
        messages: [
          ...previous.messages,
          { id: `err-${Date.now()}`, role: 'notice' as const, text: message.message },
        ],
      };
    default:
      return previous;
  }
}

function upsertActivity(activities: ToolActivity[], activity: ToolActivity): ToolActivity[] {
  const index = activities.findIndex((item) => item.id === activity.id);
  if (index === -1) {
    return [...activities, activity];
  }
  const next = [...activities];
  next[index] = activity;
  return next;
}
