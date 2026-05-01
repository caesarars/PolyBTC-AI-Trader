import { Component, ErrorInfo, ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ info });
    console.error("[ErrorBoundary]", error, info);
  }

  reset = () => this.setState({ error: null, info: null });

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="min-h-screen bg-black text-white p-6 flex items-start justify-center">
        <div className="max-w-3xl w-full glass-card border border-red-700/40 p-6">
          <div className="flex items-center gap-2 mb-4 text-red-400">
            <AlertTriangle className="w-5 h-5" />
            <h2 className="text-lg font-bold">{this.props.fallbackTitle || "Component crashed"}</h2>
          </div>
          <div className="text-sm text-red-300 font-mono mb-3 break-all">
            {this.state.error.name}: {this.state.error.message}
          </div>
          {this.state.error.stack && (
            <pre className="text-[10px] text-zinc-400 bg-zinc-950/60 p-3 rounded overflow-auto max-h-64 mb-3">
              {this.state.error.stack}
            </pre>
          )}
          {this.state.info?.componentStack && (
            <pre className="text-[10px] text-zinc-500 bg-zinc-950/40 p-3 rounded overflow-auto max-h-48 mb-3">
              {this.state.info.componentStack}
            </pre>
          )}
          <button
            type="button"
            onClick={this.reset}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-700 text-xs hover:bg-zinc-800"
          >
            <RotateCcw className="w-3 h-3" /> Try again
          </button>
        </div>
      </div>
    );
  }
}
