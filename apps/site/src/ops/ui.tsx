import { Dialog } from "@base-ui-components/react/dialog";
import {
  type StatusTone,
  Empty as Surface,
  Loading as SurfaceLoading,
  Notice as SurfaceNotice,
  Panel as SurfacePanel,
  Status as SurfaceStatus,
  Tag as SurfaceTag,
} from "@origin89/ui-react";
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

/* Shared text surfaces. They stay strings rather than components so each caller keeps its own
 * element: the note describes a paragraph, a span, a code span or a small, depending on what it
 * sits beside. */
export const EYEBROW =
  "mb-3 font-data text-[12px] leading-[normal] font-normal tracking-[0.06em] text-faint uppercase";
export const NOTE = "text-[13px] leading-[1.65] text-muted";
export const NOTE_SMALL = "mt-1 block text-[12px] leading-[1.65] text-faint";
export const MONO = "font-data text-[12px] tabular-nums";
/* The blue link. TextLink above is the quiet control; this one reads as a link and takes the
 * link token, which is the lightened blue that carries running text. */
export const LINK =
  "my-2.5 inline-flex items-center gap-2 text-[13px] text-link hover:text-fg [@media(pointer:coarse)]:min-h-11";
export const SECTION_HEADING =
  "mb-5 flex items-center justify-between gap-4 max-[640px]:flex-wrap max-[640px]:items-start [&_h2]:text-[20px] [&_h2]:leading-[1.25] [&_h2]:font-semibold [&_h2]:tracking-[-0.025em]";
export const SIGNIN =
  "mx-auto max-w-[600px] px-[30px] py-[12vh] [&_h1]:mt-10 [&_h1]:text-[40px] [&_p]:mt-4 [&_p]:mb-6 [&_p]:text-muted";

/* Tables. The head, body and hover treatments are descendant rules by nature, so they ride on the
 * wrapper as variants rather than being repeated on every th and td a view writes. */
export function Table({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`-mx-6 overflow-x-auto max-[640px]:-mx-4 ${className}`}>
      <table className="w-full min-w-[750px] border-collapse text-left text-[13px] [&_thead_th]:border-b [&_thead_th]:border-line [&_thead_th]:bg-surface-raised [&_thead_th]:px-5 [&_thead_th]:py-3 [&_thead_th]:font-data [&_thead_th]:text-[12px] [&_thead_th]:leading-[normal] [&_thead_th]:font-normal [&_thead_th]:tracking-[0.04em] [&_thead_th]:whitespace-nowrap [&_thead_th]:text-faint [&_thead_th]:uppercase [&_tbody_td]:border-t [&_tbody_td]:border-line [&_tbody_td]:px-5 [&_tbody_td]:py-4 [&_tbody_td]:align-middle [&_tbody_td]:font-normal [&_tbody_td]:text-muted [&_tbody_th]:border-t [&_tbody_th]:border-line [&_tbody_th]:px-5 [&_tbody_th]:py-4 [&_tbody_th]:align-middle [&_tbody_th]:font-normal [&_tbody_th]:text-muted [&_tbody_tr:hover_td]:bg-surface-raised [&_tbody_tr:hover_td]:text-fg [&_tbody_tr:hover_th]:bg-surface-raised [&_tbody_tr:hover_th]:text-fg [&_details]:mt-1.5 [&_details]:text-[12px] [&_details]:text-faint [&_details_code]:mt-1.5 [&_details_code]:block [&_details_code]:max-w-[230px] [&_details_code]:font-data [&_details_code]:whitespace-normal [&_details_code]:wrap-anywhere">
        {children}
      </table>
    </div>
  );
}

export function TableFoot({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-4 text-[12px] text-faint [&>div]:flex [&>div]:items-center [&>div]:gap-3">
      {children}
    </div>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return (
    <div className="mb-4 flex items-center gap-3 max-[640px]:flex-wrap [&>label]:max-[640px]:basis-full [&_select]:bevel-sm [&_select]:min-h-10 [&_select]:border [&_select]:border-line-strong [&_select]:bg-surface-raised [&_select]:px-3 [&_select]:py-0 [&_select]:text-[13px] [&_select]:text-fg [@media(pointer:coarse)]:[&_select]:min-h-11 [&_select]:max-[640px]:w-full">
      {children}
    </div>
  );
}

/* A search field. The label is the target, so the input stretches to fill it rather than leaving a
 * dead band a finger can miss. */
export function Search({ children }: { children: ReactNode }) {
  return (
    // Wrapping the field is the point: the whole box is the target, which is what the touch pass
    // in #210 established for this control.
    // biome-ignore lint/a11y/noLabelWithoutControl: the input is the child every caller passes in, so the rule cannot see it from here
    <label className="bevel-sm flex min-h-10 flex-1 items-center gap-2.5 border border-line-strong bg-surface-raised px-3 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus [@media(pointer:coarse)]:min-h-11 [&>svg]:text-muted [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-0 [&_input]:py-2.5 [&_input]:text-[13px] [&_input]:text-fg [&_input]:outline-none [@media(pointer:coarse)]:[&_input]:self-stretch [&_kbd]:border [&_kbd]:border-line-strong [&_kbd]:px-1.5 [&_kbd]:py-0.5 [&_kbd]:font-data [&_kbd]:text-[12px] [&_kbd]:leading-[normal] [&_kbd]:text-faint">
      {children}
    </label>
  );
}

export function Filters({ children, ...rest }: ComponentProps<"section">) {
  return (
    <section
      {...rest}
      className="mb-5 flex flex-wrap gap-2 [&>button]:bevel-sm [&>button]:min-h-8 [&>button]:border [&>button]:border-transparent [&>button]:px-2.5 [&>button]:text-[12px] [&>button]:text-muted [&>button:hover]:text-fg [&>button[aria-pressed=true]]:border-line-strong [&>button[aria-pressed=true]]:bg-surface-raised [&>button[aria-pressed=true]]:text-fg [@media(pointer:coarse)]:[&>button]:min-h-11 [&_span]:ml-2 [&_span]:font-data [&_span]:text-[12px] [&_span]:leading-[normal] [&_span]:text-faint"
    >
      {children}
    </section>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return <SurfaceTag>{children}</SurfaceTag>;
}

/* A reading's state is never carried by colour alone: each tone pairs its hue with a glyph and a
 * border treatment, so the row still separates in monochrome or under protanopia. */
/* What counts as an alarm is this workspace's judgement, not the chip's: the package knows tones,
 * and the run vocabulary that maps onto them stays here. */
function toneFor(value?: string): StatusTone {
  if (value === "errored" || value === "terminated") return "alarm";
  if (value === "complete") return "nominal";
  if (value === "waiting" || value === "paused") return "warning";
  if (!value || value === "unknown") return "faint";
  return "info";
}

export function Status({ value }: { value?: string }) {
  return <SurfaceStatus tone={toneFor(value)}>{value ?? "Not reported"}</SurfaceStatus>;
}

export function Loading({ label = "Loading workspace…" }: { label?: string }) {
  return <SurfaceLoading label={label} />;
}

export function Notice({ children, alarm = false }: { children: ReactNode; alarm?: boolean }) {
  return <SurfaceNotice tone={alarm ? "alarm" : "info"}>{children}</SurfaceNotice>;
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
        <Dialog.Popup className="fixed inset-y-0 right-0 z-50 flex h-dvh w-[min(680px,100%)] flex-col border-l border-line-strong bg-page text-sm text-fg [&_h3]:mt-2 [&_h3]:mb-4 [&_h3]:text-[20px] [&_h3]:leading-[1.3] [&_h3]:font-semibold [&_.ui-icon]:size-[18px]">
          <header className="flex items-center justify-between gap-5 border-b border-line px-7 py-6 max-[640px]:px-5">
            <div className="min-w-0">
              <p className={`${EYEBROW} wrap-anywhere`}>{eyebrow}</p>
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
    <Surface title={title} mark={<Icon name="equipment" className="size-7" />}>
      {children}
    </Surface>
  );
}

/* A panel. Its heading is SECTION_HEADING, which a caller puts on the div wrapping the h2 it
 * passes in. */
export function Panel({ children }: { children: ReactNode }) {
  return <SurfacePanel>{children}</SurfacePanel>;
}
