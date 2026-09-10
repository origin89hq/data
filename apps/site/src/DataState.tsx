import type { ReactNode } from "react";

export function DataLoading({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div className="data-loading">
      <div className="data-status" role="status">
        <span className="loading-indicator" aria-hidden="true" />
        <span>{label}</span>
      </div>
      {children && <div aria-hidden="true">{children}</div>}
    </div>
  );
}

export function DataProblem({ label, retry }: { label: string; retry: () => void }) {
  return (
    <div className="data-problem" role="alert">
      <p>{label} Check your connection and try again.</p>
      <button type="button" className="button small" onClick={retry}>
        Try again
      </button>
    </div>
  );
}

export function Skeleton({ width = "100%" }: { width?: string }) {
  return <span className="data-skeleton" style={{ width }} aria-hidden="true" />;
}
