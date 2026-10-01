import { Component, type ReactNode } from 'react';

interface Props { children: ReactNode; }
interface State { error: Error | null; }

export class ChatRenderBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }): void {
    console.error('Dev-First could not render this saved conversation.', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="chat-render-error" role="alert">
          <strong>This conversation couldn’t be displayed.</strong>
          <span>The saved chat is still intact. Try another chat or start a new one; this error has been logged for diagnosis.</span>
        </div>
      );
    }
    return this.props.children;
  }
}
