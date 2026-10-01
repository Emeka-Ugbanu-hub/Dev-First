import { useEffect, useState } from 'react';
import type { HostMessage, LearnMoreLink } from '../../../src/shared/protocol';
import { domainOf } from '../lib/domains';
import { post } from '../vscode';

export function LearnMoreModal({ title, onClose }: { title: string; onClose: () => void }) {
  const [state, setState] = useState<{
    loading: boolean;
    chosen: LearnMoreLink[];
    alternatives: LearnMoreLink[];
    error?: string;
  }>({ loading: true, chosen: [], alternatives: [] });

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostMessage>) => {
      if (event.data.type === 'learnMoreResult') {
        setState({
          loading: false,
          chosen: event.data.chosen,
          alternatives: event.data.alternatives,
          error: event.data.error,
        });
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('message', onMessage);
    window.addEventListener('keydown', onKey);
    post({ type: 'learnMore' });
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const empty = !state.loading && state.chosen.length === 0 && state.alternatives.length === 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="learn-more-modal anim-scale-in" onClick={(event) => event.stopPropagation()}>
        <div className="learn-more-header">
          <span className="codicon codicon-book" />
          <span className="learn-more-title">Learn more — {title}</span>
          <span className="spacer" />
          <button className="icon-btn" title="Close" onClick={onClose}>
            <span className="codicon codicon-close" />
          </button>
        </div>
        <div className="learn-more-body">
          {state.loading && [0, 1, 2].map((index) => <div className="skeleton-row" key={index} />)}
          {!state.loading && state.chosen.length > 0 && (
            <>
              <div className="settings-group-title">THE APPROACH WE CHOSE</div>
              {state.chosen.map((link) => (
                <LinkRow key={link.url} link={link} />
              ))}
            </>
          )}
          {!state.loading && state.alternatives.length > 0 && (
            <>
              <div className="settings-group-title">ALTERNATIVES CONSIDERED</div>
              {state.alternatives.map((link) => (
                <LinkRow key={link.url} link={link} />
              ))}
            </>
          )}
          {empty && <div className="model-empty">{state.error ?? 'No verified resources found.'}</div>}
        </div>
        <div className="learn-more-footer">
          <button
            className="btn-secondary"
            onClick={() => {
              post({ type: 'sendMessage', text: `Find learning resources about ${title} — docs, articles, videos.` });
              onClose();
            }}
          >
            <span className="codicon codicon-globe" /> Search the web
          </button>
        </div>
      </div>
    </div>
  );
}

function LinkRow({ link }: { link: LearnMoreLink }) {
  return (
    <button className="link-row" title={link.url} onClick={() => post({ type: 'openExternal', url: link.url })}>
      <span className="link-title">{link.title}</span>
      {link.why && <span className="link-why">{link.why}</span>}
      <span className="link-domain">{domainOf(link.url)}</span>
    </button>
  );
}
