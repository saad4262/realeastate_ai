'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Temporary diagnosis aid for the Vercel-only "u is not a function" crash.
 *
 * Off unless NEXT_PUBLIC_DEBUG_BOUNDARY=1 is set at BUILD time — then it is a
 * plain pass-through and changes nothing. When on, an error inside it is drawn
 * on the page with React's component stack, so a screenshot says which
 * component failed. Remove together with the DEBUG_NO_MINIFY hook in
 * next.config.ts once the crash is found.
 */
class Catcher extends Component<{ label: string; children: ReactNode }, { text: string | null }> {
  state: { text: string | null } = { text: null };

  static getDerivedStateFromError(error: Error) {
    return { text: `${error.name}: ${error.message}` };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({
      text: `${error.name}: ${error.message}\n\nCOMPONENT STACK:${info.componentStack}\n\nJS STACK:\n${error.stack ?? ''}`,
    });
  }

  render() {
    if (this.state.text === null) return this.props.children;
    return (
      <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11, padding: 12, margin: 8, background: '#fff', color: '#b00020', border: '2px solid #b00020' }}>
        {`[debug boundary: ${this.props.label}]\n${this.state.text}`}
      </pre>
    );
  }
}

export function DebugBoundary({ label, children }: { label: string; children: ReactNode }) {
  return process.env.NEXT_PUBLIC_DEBUG_BOUNDARY === '1' ? <Catcher label={label}>{children}</Catcher> : <>{children}</>;
}
