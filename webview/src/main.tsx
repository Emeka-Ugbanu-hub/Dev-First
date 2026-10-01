import { createRoot } from 'react-dom/client';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import '@vscode/codicons/dist/codicon.css';
import App from './App';
import './styles.css';

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Dev-First failed while rendering the chat view.', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="app-fatal-error" role="alert">
          <strong>Dev-First couldn’t display this chat.</strong>
          <span>{this.state.error.message || 'An unexpected rendering error occurred.'}</span>
          <button type="button" onClick={() => window.location.reload()}>Reload Dev-First</button>
        </div>
      );
    }
    return this.props.children;
  }
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<AppErrorBoundary><App /></AppErrorBoundary>);

  const reportRuntimeFault = (error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    console.error('Dev-First webview runtime error.', error);
    let notice = document.getElementById('df-runtime-fault');
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'df-runtime-fault';
      notice.className = 'app-fatal-error';
      notice.setAttribute('role', 'alert');
      document.body.appendChild(notice);
    }
    notice.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = 'Dev-First encountered a webview error.';
    const message = document.createElement('span');
    message.textContent = detail;
    notice.append(title, message);
  };
  window.addEventListener('error', (event) => reportRuntimeFault(event.error ?? event.message));
  window.addEventListener('unhandledrejection', (event) => reportRuntimeFault(event.reason));
}
