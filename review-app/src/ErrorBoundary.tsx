import React from 'react';

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[reframe review-app] uncaught render error:', error, info);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;

    const err = this.state.error;
    return (
      <div
        role="alert"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          padding: '2rem',
          fontFamily: 'system-ui, sans-serif',
          color: '#1e293b',
          background: '#f8fafc',
        }}
      >
        <p style={{ fontSize: '3rem', margin: 0 }}>💥</p>
        <h1 style={{ margin: '0.5rem 0', fontSize: '1.5rem' }}>
          The review app crashed
        </h1>
        <p style={{ color: '#64748b', maxWidth: 560, textAlign: 'center' }}>
          An unhandled error broke the UI. Your approvals on disk are
          unaffected — reload to retry.
        </p>
        <pre
          style={{
            maxWidth: 720,
            width: '100%',
            background: '#0f172a',
            color: '#fca5a5',
            padding: '1rem',
            borderRadius: 8,
            fontSize: '0.8rem',
            overflow: 'auto',
            marginTop: '1rem',
          }}
        >
          {err.name}: {err.message}
          {err.stack ? `\n\n${err.stack}` : ''}
        </pre>
        <button
          onClick={this.handleReload}
          style={{
            marginTop: '1.25rem',
            padding: '0.6rem 1.4rem',
            background: '#2563eb',
            color: 'white',
            border: 'none',
            borderRadius: 8,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
