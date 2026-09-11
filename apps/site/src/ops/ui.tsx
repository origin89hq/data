import { type ReactNode, useEffect, useRef } from "react";
import { Icon } from "../icons.tsx";
export function Status({ value }: { value?: string }) {
  const tone =
    value === "errored" || value === "terminated"
      ? "alarm"
      : value === "complete"
        ? "nominal"
        : value === "waiting" || value === "paused"
          ? "warning"
          : !value || value === "unknown"
            ? "faint"
            : "info";
  return (
    <span className={`ops-status ${tone}`}>
      <span aria-hidden="true">{tone === "nominal" ? "✓" : tone === "alarm" ? "!" : "•"}</span>
      {value ?? "Not reported"}
    </span>
  );
}
export function Loading({ label = "Loading workspace…" }: { label?: string }) {
  return (
    <div className="ops-loading">
      <p role="status">
        <span className="ops-spinner" aria-hidden="true" />
        {label}
      </p>
      <div aria-hidden="true">
        {[0, 1, 2, 3].map((id) => (
          <span className="ops-skeleton" key={id} />
        ))}
      </div>
    </div>
  );
}
export function Notice({ children, alarm = false }: { children: ReactNode; alarm?: boolean }) {
  return (
    <div className={alarm ? "ops-notice alarm" : "ops-notice"} role={alarm ? "alert" : "status"}>
      {children}
    </div>
  );
}
export function Drawer({
  title,
  eyebrow,
  onClose,
  children,
}: {
  title: string;
  eyebrow: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      className="ops-drawer"
      ref={ref}
      aria-labelledby="ops-detail-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <div>
          <p className="ops-eyebrow">{eyebrow}</p>
          <h2 id="ops-detail-title">{title}</h2>
        </div>
        <button
          className="ops-icon-button"
          type="button"
          aria-label="Close details"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="ops-drawer-body">{children}</div>
    </dialog>
  );
}
export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="ops-empty">
      <Icon name="equipment" />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
