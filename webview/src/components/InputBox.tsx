import { useEffect, useRef, useState } from 'react';
import type { CommandInfo, Phase, QueuedPromptRecord, SelectionContext, SessionSummary, UiMessage } from '../../../src/shared/protocol';
import { slashQuery } from '../lib/commands';
import { mentionQuery } from '../lib/mentions';
import { PasteChip, createPasteChip, expandPastes, removeMarker, shouldCollapsePaste, shouldSavePasteFile } from '../lib/paste';
import { queueStatusLabel } from '../lib/queueStatus';
import { randomId } from '../lib/random';
import { isEscapeKey, useOverlayDismiss } from '../lib/overlays';
import { SlashMenu } from './SlashMenu';
import { MentionMenu } from './MentionMenu';
import { ThinkingSelector } from './ThinkingSelector';
import { post } from '../vscode';

export function InputBox({
  phase,
  hasPlan,
  connected,
  selection,
  commands,
  files,
  quote,
  images,
  sessions,
  autoApproveTerminal,
  supportsVision,
  visionSupportKnown,
  reasoningEffort,
  modelName,
  modelId,
  modelPreset,
  reasoningLevels,
  queuedMessages,
  queuedRecords,
  recoveredQueueIds,
  enhanced,
  prefill,
  pasteFileLines,
  onImagesChange,
  onToggleAutoApprove,
  onOpenModelPicker,
  onSend,
  onEditQueued,
  onCancelQueued,
  onStop,
  onDismissSelection,
  onDismissQuote,
  onEnhance,
}: {
  phase: Phase;
  hasPlan: boolean;
  connected: boolean;
  selection: SelectionContext | null;
  commands: CommandInfo[];
  files: string[];
  quote: string | null;
  images: string[];
  sessions: SessionSummary[];
  autoApproveTerminal: boolean;
  supportsVision: boolean;
  visionSupportKnown: boolean;
  reasoningEffort: string;
  modelName: string;
  modelId: string;
  modelPreset: string;
  reasoningLevels: string[];
  queuedMessages: UiMessage[];
  queuedRecords?: QueuedPromptRecord[];
  recoveredQueueIds?: string[];
  enhanced: { text: string; nonce: number } | null;
  prefill: { text: string; nonce: number } | null;
  pasteFileLines: number;
  onImagesChange: (images: string[]) => void;
  onToggleAutoApprove: () => void;
  onOpenModelPicker: (anchor?: HTMLElement) => void;
  onSend: (text: string, images?: string[], pastes?: { id: string; text: string }[]) => void;
  onEditQueued: (message: UiMessage) => void;
  onCancelQueued: (id: string) => void;
  onStop: () => void;
  onDismissSelection: () => void;
  onDismissQuote: () => void;
  onEnhance: (text: string) => void;
}) {
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem('devFirst.draft') ?? '';
    } catch {
      return '';
    }
  });
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [pastes, setPastes] = useState<PasteChip[]>([]);
  const [enhancing, setEnhancing] = useState(false);
  const [reasoningHint, setReasoningHint] = useState<string | null>(null);
  const [menuHidden, setMenuHidden] = useState(false);
  const undoRef = useRef<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const menuOpen = !menuHidden && (slashQuery(text) !== null || mentionQuery(text) !== null);
  useOverlayDismiss(menuOpen, () => setMenuHidden(true), areaRef);

  useEffect(() => {
    if (prefill && prefill.text) {
      setText(prefill.text);
      textareaRef.current?.focus();
    }
  }, [prefill]);
  const busy = phase === 'planning' || phase === 'executing';
  const hasSendableContent = Boolean(text.trim() || images.length > 0);
  // Keep the composer editable while a run is active so follow-up prompts can queue.
  const disabled = !connected;

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) {
      return;
    }
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [text]);

  useEffect(() => {
    try {
      localStorage.setItem('devFirst.draft', text);
    } catch {
      // storage unavailable
    }
  }, [text]);

  useEffect(() => {
    if (enhanced) {
      undoRef.current = text;
      setText(enhanced.text);
      setEnhancing(false);
      textareaRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enhanced?.nonce]);

  useEffect(() => {
    setMenuHidden(false);
  }, [text]);

  const addImageFiles = (files: FileList | null) => {
    if (!files) {
      return;
    }
    for (const file of Array.from(files).slice(0, 4)) {
      if (!file.type.startsWith('image/')) {
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result ?? '');
        if (result) {
          onImagesChange([...images, result].slice(0, 4));
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const submit = () => {
    const value = expandPastes(text, pastes).trim();
    if ((!value && images.length === 0) || disabled) {
      return;
    }
    const savedPastes = pastes
      .filter((chip) => chip.saveToFile)
      .map((chip) => ({ id: chip.id, text: chip.text }));
    try {
      const history = JSON.parse(localStorage.getItem('devFirst.promptHistory') ?? '[]') as string[];
      const next = [value, ...history.filter((item) => item !== value)].slice(0, 50);
      localStorage.setItem('devFirst.promptHistory', JSON.stringify(next));
    } catch {
      // storage unavailable
    }
    setHistoryIndex(-1);
    onSend(value, images.length > 0 ? images : undefined, savedPastes.length > 0 ? savedPastes : undefined);
    setText('');
    setPastes([]);
    onImagesChange([]);
    undoRef.current = null;
  };

  const recallHistory = (direction: 1 | -1) => {
    let history: string[] = [];
    try {
      history = JSON.parse(localStorage.getItem('devFirst.promptHistory') ?? '[]') as string[];
    } catch {
      return;
    }
    if (history.length === 0) {
      return;
    }
    const nextIndex = Math.min(history.length - 1, Math.max(-1, historyIndex + direction));
    setHistoryIndex(nextIndex);
    setText(nextIndex === -1 ? '' : history[nextIndex]);
  };

  const placeholder = !connected
    ? 'Connect a provider to start…'
    : busy
      ? phase === 'planning'
        ? 'Planning… type to queue a message'
        : 'Executing… type to steer the task'
      : hasPlan
        ? 'Ask why, alternatives — or refine the plan…  (⏎ send · ⇧⏎ newline)'
        : 'Ask a question or describe what to build…  (⏎ send · ⇧⏎ newline)';

  return (
    <div className="input-area" ref={areaRef}>
      {queuedMessages.length > 0 && (
        <div className="queued-prompts" aria-label="Queued prompts">
          {queuedMessages.map((message) => {
            const record = queuedRecords?.find((candidate) => candidate.id === message.id);
            const status = record?.status ?? 'queued';
            const label = queueStatusLabel(status);
            const recovered = (recoveredQueueIds?.includes(message.id) ?? false) && status === 'queued';
            return (
              <div className="queued-prompt" key={message.id}>
                <span className="codicon codicon-reply queued-prompt-mark" aria-hidden="true" />
                <span className="queued-prompt-text" title={message.text}>{message.text}</span>
                {label !== null && (
                  <span className={`queue-status-chip queue-status-${status}`}>
                    <span className="codicon codicon-clock" /> {label}
                  </span>
                )}
                <div className="queued-prompt-actions">
                  <button
                    className="queued-prompt-action"
                    title="Edit this queued prompt"
                    aria-label="Edit this queued prompt"
                    onClick={() => onEditQueued(message)}
                  >
                    <span className="codicon codicon-edit" /> Edit
                  </button>
                  <button
                    className="queued-prompt-action"
                    title="Discard this queued prompt"
                    aria-label="Discard this queued prompt"
                    onClick={() => onCancelQueued(message.id)}
                  >
                    <span className="codicon codicon-trash" /> Discard
                  </button>
                </div>
                {recovered && (
                  <div className="queue-recovered-hint queued-prompt-recovered">
                    Recovered — won't run automatically.
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {quote && (
        <div className="selection-chip quote-chip-input" title={quote}>
          <span className="codicon codicon-quote" />
          <span className="selection-text">{quote.slice(0, 120)}</span>
          <button className="chip-close" title="Remove quote" aria-label="Remove quote" onClick={onDismissQuote}>
            <span className="codicon codicon-close" />
          </button>
        </div>
      )}
      {selection && (
        <div className="selection-chip" title={selection.text.slice(0, 600)}>
          <span className="codicon codicon-selection" />
          <span className="selection-text">
            {selection.path}:{selection.startLine}–{selection.endLine}
          </span>
          <button
            className="chip-close"
            title="Don't attach this selection"
            aria-label="Don't attach this selection"
            onClick={onDismissSelection}
          >
            <span className="codicon codicon-close" />
          </button>
        </div>
      )}
      {pastes.map((chip) => (
        <div className="selection-chip paste-chip" key={chip.id} title={chip.text.slice(0, 600)}>
          <span className="codicon codicon-file" />
          <button
            className="paste-expand"
            title="Expand pasted text into the input"
            onClick={() => {
              setText((current) => current.replace(chip.marker, chip.text));
              setPastes((current) => current.filter((entry) => entry.id !== chip.id));
            }}
          >
            {chip.marker}
          </button>
          <button
            className="chip-close"
            title="Remove pasted text"
            aria-label="Remove pasted text"
            onClick={() => {
              setText((current) => removeMarker(current, chip.marker));
              setPastes((current) => current.filter((entry) => entry.id !== chip.id));
            }}
          >
            <span className="codicon codicon-close" />
          </button>
        </div>
      ))}
      {reasoningHint && (
        <div className="input-hint">
          <span className="codicon codicon-lightbulb" /> Reasoning: {reasoningHint}
        </div>
      )}
      {images.length > 0 && !supportsVision && (
        <div className="input-hint input-warning">
          <span className="codicon codicon-warning" /> This model can't see images.
              <button className="input-warning-action" onClick={(event) => onOpenModelPicker(event.currentTarget)}>
            Change model
          </button>
        </div>
      )}
      {images.length > 0 && (
        <div className="image-strip">
          {images.map((image, index) => (
            <div className="image-thumb" key={index}>
              <img src={image} alt={`attachment ${index + 1}`} />
              <button
                className="image-remove"
                title="Remove image"
                aria-label="Remove image"
                onClick={() => onImagesChange(images.filter((_, itemIndex) => itemIndex !== index))}
              >
                <span className="codicon codicon-close" />
              </button>
            </div>
          ))}
        </div>
      )}
      {(() => {
        if (menuHidden) {
          return null;
        }
        const commandQuery = slashQuery(text);
        if (commandQuery !== null && commands.length > 0) {
          return (
            <SlashMenu
              commands={commands}
              query={commandQuery}
              onPick={(name) => {
                setText(`/${name} `);
                textareaRef.current?.focus();
              }}
            />
          );
        }
        if (commandQuery !== null) {
          return (
            <div className="input-hint">
              <span className="codicon codicon-terminal-cmd" /> Commands come from .dev-first/commands/*.md
            </div>
          );
        }
        const fileQuery = mentionQuery(text);
        if (fileQuery !== null && (files.length > 0 || sessions.length > 0)) {
          return (
            <MentionMenu
              files={files}
              sessions={sessions}
              query={fileQuery}
              onPick={(value) => {
                setText(text.replace(/@[\w./-]*$/, `@${value} `));
                textareaRef.current?.focus();
              }}
            />
          );
        }
        return null;
      })()}
      <div className="input-box">
        <textarea
          ref={textareaRef}
          className="input-textarea"
          rows={2}
          placeholder={placeholder}
          value={text}
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
          onPaste={(event) => {
            const files = event.clipboardData?.files;
            if (files && files.length > 0) {
              event.preventDefault();
              addImageFiles(files);
              return;
            }
            const pasted = event.clipboardData?.getData('text') ?? '';
            if (shouldCollapsePaste(pasted)) {
              event.preventDefault();
              const chip = createPasteChip(randomId('paste'), pasted, shouldSavePasteFile(pasted, pasteFileLines));
              setPastes((current) => [...current, chip]);
              setText((current) => `${current}${current && !current.endsWith(' ') ? ' ' : ''}${chip.marker}`);
            }
          }}
          onDrop={(event) => {
            if (event.dataTransfer?.files?.length) {
              event.preventDefault();
              addImageFiles(event.dataTransfer.files);
            }
          }}
          onKeyDown={(event) => {
            if (isEscapeKey(event.key) && menuOpen) {
              event.preventDefault();
              event.stopPropagation();
              setMenuHidden(true);
              return;
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
              return;
            }
            if (event.key === 'Tab' && event.shiftKey) {
              event.preventDefault();
              if (reasoningLevels.length === 0) {
                return;
              }
              const next =
                reasoningLevels[(reasoningLevels.indexOf(reasoningEffort) + 1) % reasoningLevels.length];
              post({ type: 'setReasoningEffort', preset: modelPreset, model: modelId, value: next });
              setReasoningHint(next);
              setTimeout(() => setReasoningHint(null), 1600);
              return;
            }
            if (event.key === 'Backspace') {
              const caret = event.currentTarget.selectionStart ?? 0;
              const chip = pastes.find((entry) => text.slice(0, caret).endsWith(entry.marker));
              if (chip) {
                event.preventDefault();
                setText((current) => removeMarker(current, chip.marker));
                setPastes((current) => current.filter((entry) => entry.id !== chip.id));
                return;
              }
            }
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && undoRef.current !== null) {
              event.preventDefault();
              setText(undoRef.current);
              undoRef.current = null;
              return;
            }
            const atStart = event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0;
            const atEnd =
              event.currentTarget.selectionStart === text.length && event.currentTarget.selectionEnd === text.length;
            if (event.key === 'ArrowUp' && (atStart || atEnd)) {
              event.preventDefault();
              recallHistory(1);
            }
            if (event.key === 'ArrowDown' && (atStart || atEnd)) {
              event.preventDefault();
              recallHistory(-1);
            }
          }}
        />
        <div className="input-toolbar">
          <div className="input-toolbar-left">
            {(supportsVision || !visionSupportKnown) && <button className="composer-button composer-icon" title={visionSupportKnown ? 'Attach image' : 'Attach image (support unverified for this model)'} aria-label={visionSupportKnown ? 'Attach image' : 'Attach image; model support unverified'} onClick={() => {
              const picker = document.createElement('input');
              picker.type = 'file';
              picker.accept = 'image/*';
              picker.multiple = true;
              picker.onchange = () => addImageFiles(picker.files);
              picker.click();
            }}>
              <span className="codicon codicon-add" />
            </button>}
            <button
              className={`composer-button composer-approval ${autoApproveTerminal ? 'active' : ''}`}
              title={autoApproveTerminal ? 'Auto-approve commands is on. Click to require approval.' : 'Ask for approval. Click to enable auto-approval.'}
              aria-label={autoApproveTerminal ? 'Auto-approve terminal commands on' : 'Ask for approval'}
              onClick={onToggleAutoApprove}
            >
              <span className="codicon codicon-shield" />
              <span>{autoApproveTerminal ? 'Auto-approve' : 'Ask for approval'}</span>
            </button>
          </div>
          <div className="input-toolbar-right">
            <button
              className="composer-button composer-model"
              title="Change model"
              onClick={(event) => onOpenModelPicker(event.currentTarget)}
            >
              <span className="composer-model-name">{modelName || 'Model'}</span>
              <span className="codicon codicon-chevron-down" />
            </button>
            <ThinkingSelector levels={reasoningLevels} current={reasoningEffort} preset={modelPreset} model={modelId} />
            <button
              className="composer-button composer-icon composer-enhance"
              title="Enhance prompt with AI"
              aria-label="Enhance prompt with AI"
              disabled={disabled || enhancing || !text.trim()}
              onClick={() => {
                setEnhancing(true);
                onEnhance(expandPastes(text, pastes));
              }}
            >
              <span className={`codicon codicon-${enhancing ? 'loading codicon-modifier-spin' : 'wand'}`} />
            </button>
            {busy && !hasSendableContent ? (
              <button className="btn-stop" onClick={onStop} title="Stop current run" aria-label="Stop current run">
                <span className="codicon codicon-debug-stop" />
              </button>
            ) : (
              <button
                className="btn-send"
                onClick={submit}
                disabled={!hasSendableContent || !connected}
                title={busy ? (phase === 'planning' ? 'Queue message' : 'Steer current task') : 'Send'}
                aria-label={busy ? (phase === 'planning' ? 'Queue message' : 'Steer current task') : 'Send'}
              >
                <span className="codicon codicon-arrow-up" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
