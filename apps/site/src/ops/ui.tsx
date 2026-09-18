import { Dialog } from "@base-ui-components/react/dialog";
import type { ReactNode } from "react";
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
/**
 * The run drawer.
 *
 * The native `<dialog>` this replaces trapped focus and closed on Escape, but left the page
 * behind it scrolling, ignored a click on the backdrop, and returned focus to the document rather
 * than to the row that opened it, so a keyboard restarted from the top of the page each time.
 */
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
  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-page/65" />
        <Dialog.Popup className="ops-drawer fixed inset-y-0 right-0 z-50 flex h-dvh w-[min(680px,100%)] flex-col border-l border-line-strong bg-page text-sm text-fg">
          <header className="flex items-center justify-between gap-5 border-b border-line px-7 py-6 max-[640px]:px-5">
            <div className="min-w-0">
              <p className="ops-eyebrow">{eyebrow}</p>
              <Dialog.Title className="text-[28px] font-bold tracking-[-0.035em] max-[640px]:text-2xl">
                {title}
              </Dialog.Title>
            </div>
            <Dialog.Close className="ops-icon-button" aria-label="Close details">
              <Icon name="close" />
            </Dialog.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-auto px-7 pt-6 pb-12 max-[640px]:px-5">
            {children}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
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
