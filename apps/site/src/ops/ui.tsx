import { Dialog } from "@base-ui-components/react/dialog";
import type { ComponentProps, ReactNode } from "react";
import { Icon } from "../icons.tsx";

/* The workspace's controls. These were four class names applied at forty call sites; as components
 * the geometry is written once, and they are the shape that would move to @origin89/ui-react. */
const CONTROL =
  "inline-flex appearance-none items-center justify-center gap-2 bevel-sm border px-4 py-0 text-[13px] font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-45 min-h-10 [@media(pointer:coarse)]:min-h-11";
const QUIET = "border-line-strong bg-surface-raised text-fg not-disabled:hover:border-muted";
/* The plate's fill is 2.40:1 on its own ground, so the rim carries the control boundary. */
const FILLED =
  "border-action bg-action text-on-fill shadow-[inset_0_0_0_1px_var(--color-action-rim)] not-disabled:hover:border-action-lit not-disabled:hover:bg-action-lit";

export function Button({
  primary = false,
  className = "",
  ...rest
}: ComponentProps<"button"> & { primary?: boolean }) {
  return <button className={`${CONTROL} ${primary ? FILLED : QUIET} ${className}`} {...rest} />;
}

export function ButtonLink({
  primary = false,
  className = "",
  ...rest
}: ComponentProps<"a"> & { primary?: boolean }) {
  return <a className={`${CONTROL} ${primary ? FILLED : QUIET} ${className}`} {...rest} />;
}

const ICON_CONTROL =
  "bevel-sm grid size-9 appearance-none place-items-center border border-line-strong p-0 text-muted not-disabled:hover:bg-surface-raised not-disabled:hover:text-fg disabled:cursor-not-allowed disabled:opacity-45 [@media(pointer:coarse)]:size-11";

/* An icon-only control carries no text, so the type makes its label mandatory rather than leaving
 * it to review. */
export function IconLink({
  className = "",
  ...rest
}: ComponentProps<"a"> & { "aria-label": string }) {
  return <a className={`${ICON_CONTROL} ${className}`} {...rest} />;
}

export function IconButton({
  className = "",
  ...rest
}: ComponentProps<"button"> & { "aria-label": string }) {
  return <button className={`${ICON_CONTROL} ${className}`} {...rest} />;
}

/* The quiet control: no border, no fill, but still a control, so it keeps a full target on touch. */
const TEXT =
  "inline-flex appearance-none items-center gap-1.5 px-0 py-1 text-left text-[13px] text-muted hover:text-fg [@media(pointer:coarse)]:min-h-11";

export function TextButton({ className = "", ...rest }: ComponentProps<"button">) {
  return <button className={`${TEXT} ${className}`} {...rest} />;
}

export function TextLink({ className = "", ...rest }: ComponentProps<"a">) {
  return <a className={`${TEXT} ${className}`} {...rest} />;
}

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
            <Dialog.Close className={ICON_CONTROL} aria-label="Close details">
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
