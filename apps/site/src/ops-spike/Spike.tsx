import { Dialog } from "@base-ui-components/react/dialog";
import { Select } from "@base-ui-components/react/select";
import { Tabs } from "@base-ui-components/react/tabs";
import avatar from "@origin89/brand/art/avatar-round.webp";
import logo from "@origin89/brand/logos/origin89-horizontal-white.svg";
import { useState } from "react";
import { Icon } from "../icons.tsx";

/** The same rows the real Overview renders, held locally so the prototype needs no session. */
const RUNS = [
  {
    maker: "outback-power",
    state: "running",
    next: "Reading 19 of 24 documents",
    pct: 79,
    kind: "nominal",
  },
  {
    maker: "victron-energy",
    state: "awaiting approval",
    next: "42 documents offered",
    pct: 0,
    kind: "warning",
  },
  {
    maker: "magnum-energy",
    state: "stopped",
    next: "Workflow ended without a decision",
    pct: 34,
    kind: "alarm",
  },
  {
    maker: "samlex-america",
    state: "readings ready",
    next: "66 figures extracted",
    pct: 100,
    kind: "info",
  },
] as const;

const NAV = [
  ["Overview", "equipment"],
  ["Manufacturers", "protocols"],
  ["Sellers", "specifications"],
  ["Records & corrections", "evidence"],
  ["Published files", "download"],
  ["Activity feed", "activity"],
] as const;

const TONE = {
  nominal: "text-nominal",
  warning: "text-warning border-dashed",
  alarm: "text-alarm border-2",
  info: "text-info",
} as const;

const SORTS = { attention: "Attention first", name: "Name A–Z", recent: "Most recent" };

export function Spike() {
  const [sort, setSort] = useState<string | null>("attention");
  const [filter, setFilter] = useState("all");
  const [open, setOpen] = useState<(typeof RUNS)[number] | undefined>();

  return (
    <div className="grid min-h-screen grid-cols-[252px_minmax(0,1fr)] max-[980px]:block">
      <aside className="sticky top-0 flex h-dvh flex-col border-r border-line bg-surface px-4 pt-7 pb-5 max-[980px]:static max-[980px]:h-auto max-[980px]:border-r-0 max-[980px]:border-b">
        <a href="/" className="block px-2.5 pb-8" aria-label="Origin89 Data home">
          <img src={logo} width="182" alt="Origin89" />
          <span className="mt-3.5 block font-data text-xs tracking-[0.1em] text-faint uppercase">
            Data workspace
          </span>
        </a>
        <p className="mx-2.5 mb-3 font-data text-xs tracking-wider text-faint uppercase">
          Collection &amp; curation
        </p>
        <nav className="grid gap-0.5" aria-label="Workspace navigation">
          {NAV.map(([label, icon], i) => (
            <a
              key={label}
              href="#"
              aria-current={i === 0 ? "page" : undefined}
              className="bevel-sm flex min-h-11 items-center gap-3 px-2.5 text-sm text-muted transition-colors hover:bg-surface-raised hover:text-fg aria-[current=page]:bg-surface-raised aria-[current=page]:text-fg aria-[current=page]:shadow-[inset_2px_0_var(--color-signal)]"
            >
              <Icon name={icon} />
              <span>{label}</span>
            </a>
          ))}
        </nav>
        <div className="mt-auto grid gap-1 px-2.5 pt-6">
          <div className="mb-3 flex items-start gap-3 border-t border-line pt-5">
            <img src={avatar} width="38" height="38" alt="Buddy" className="rounded-full" />
            <p className="text-[13px] leading-normal">
              Keep the source close.
              <span className="mt-1 block text-xs text-faint">
                Every correction starts with a document.
              </span>
            </p>
          </div>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-10 flex min-h-[72px] items-center justify-between gap-5 border-b border-line bg-page px-8 py-3.5">
          <div className="flex items-center gap-3 text-[13px]">
            <span className="text-faint">Origin89 Data</span>
            <span className="text-faint">/</span>
            <strong className="font-semibold">Overview</strong>
          </div>
          <div className="flex items-center gap-3 text-[13px]">
            <span className="flex items-center gap-2 text-muted">
              <span className="bevel-sm grid size-[30px] place-items-center border border-line-strong bg-surface-raised font-data text-xs">
                DA
              </span>
              david
            </span>
            <button type="button" className="min-h-11 text-[13px] text-muted hover:text-fg">
              Sign out
            </button>
          </div>
        </header>

        <main className="mx-auto max-w-[1560px] px-8 pt-8 pb-6">
          <div className="mb-6 flex items-end justify-between gap-6">
            <div>
              <p className="mb-3 font-data text-xs tracking-wider text-faint uppercase">
                Equipment knowledge / operations
              </p>
              <h1 className="text-[clamp(28px,2.4vw,40px)] leading-[1.05] font-bold tracking-[-0.035em]">
                A clear view of the work ahead.
              </h1>
              <p className="mt-3 text-sm text-muted">
                Review the queue, follow collection, and keep the dataset moving.
              </p>
            </div>
            <button
              type="button"
              className="plate flex min-h-11 items-center gap-2 px-4 text-[13px] font-medium whitespace-nowrap text-on-fill"
            >
              <Icon name="refresh" /> Refresh workspace
            </button>
          </div>

          <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-y border-line py-3 font-data text-xs text-faint">
            <span className="flex items-center gap-2.5">
              <span className="size-1.5 rounded-full bg-muted" />
              Snapshot taken 2 minutes ago
            </span>
            <span className="flex items-center gap-5">
              <span>Refresh on demand</span>
              <button type="button" className="flex min-h-11 items-center gap-2 hover:text-fg">
                <Icon name="copy" /> Copy view link
              </button>
            </span>
          </div>

          <div className="mb-6 grid grid-cols-4 gap-3 max-[640px]:grid-cols-2">
            {[
              ["Awaiting approval", "1", "Document plans to review"],
              ["In progress", "1", "Collection workflows running"],
              ["Needs attention", "1", "Stopped or unknown workflows"],
              ["Readings available", "1", "Makers with extracted figures"],
            ].map(([label, value, note]) => (
              <button
                key={label}
                type="button"
                className="bevel border border-line bg-surface p-[18px] text-left transition-colors hover:border-line-strong hover:bg-surface-raised"
              >
                <span className="flex items-center justify-between gap-2 text-[13px] text-muted">
                  {label} <Icon name="arrowUpRight" />
                </span>
                <strong className="my-3 block text-[40px] leading-[1.1] font-semibold tracking-[-0.04em] tabular-nums">
                  {value}
                </strong>
                <small className="text-xs text-faint">{note}</small>
              </button>
            ))}
          </div>

          <section className="bevel border border-line bg-surface p-6">
            <div className="mb-5 flex items-center justify-between gap-4">
              <div>
                <p className="mb-2.5 font-data text-xs tracking-wider text-faint uppercase">
                  Your collection queue
                </p>
                <h2 className="text-xl leading-tight font-semibold tracking-[-0.025em]">
                  Everything that needs a next step.
                </h2>
              </div>
              <SortSelect value={sort} onChange={setSort} />
            </div>

            <div className="mb-5 flex flex-wrap gap-2">
              {["all", "awaiting", "attention", "running"].map((name) => (
                <button
                  key={name}
                  type="button"
                  aria-pressed={filter === name}
                  onClick={() => setFilter(name)}
                  className="bevel-sm min-h-11 border border-transparent px-2.5 text-xs text-muted capitalize hover:text-fg aria-pressed:border-line-strong aria-pressed:bg-surface-raised aria-pressed:text-fg"
                >
                  {name}
                </button>
              ))}
            </div>

            <div className="-mx-6 overflow-x-auto">
              <table className="w-full min-w-[750px] text-left text-[13px]">
                <thead>
                  <tr>
                    {["Maker", "State", "Next step", "Progress", ""].map((h) => (
                      <th
                        key={h}
                        className="border-b border-line bg-surface-raised px-5 py-3 font-data text-xs font-normal tracking-wide whitespace-nowrap text-faint uppercase"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {RUNS.map((run) => (
                    <tr key={run.maker} className="group hover:bg-surface-raised">
                      <td className="border-t border-line px-5 py-4 font-medium text-fg">
                        <span className="flex items-center gap-3">
                          <span className="bevel-sm grid size-[34px] place-items-center border border-line-strong bg-surface-raised font-data text-xs text-muted">
                            {run.maker.slice(0, 2).toUpperCase()}
                          </span>
                          {run.maker}
                        </span>
                      </td>
                      <td className="border-t border-line px-5 py-4">
                        <span
                          className={`inline-flex items-center gap-1.5 border px-2 py-0.5 font-data text-xs whitespace-nowrap ${TONE[run.kind]}`}
                        >
                          {run.state}
                        </span>
                      </td>
                      <td className="border-t border-line px-5 py-4 text-muted">{run.next}</td>
                      <td className="border-t border-line px-5 py-4">
                        <span className="font-data text-xs text-faint tabular-nums">
                          {run.pct}%
                        </span>
                        <span className="mt-2 block h-[3px] w-[125px] bg-line">
                          <span
                            className="block h-full bg-signal"
                            style={{ width: `${run.pct}%` }}
                          />
                        </span>
                      </td>
                      <td className="border-t border-line px-5 py-4">
                        <button
                          type="button"
                          onClick={() => setOpen(run)}
                          className="bevel-sm grid size-11 place-items-center border border-line-strong text-muted hover:bg-surface-raised hover:text-fg"
                          aria-label={`Inspect ${run.maker}`}
                        >
                          <Icon name="arrowRight" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <footer className="flex justify-between gap-5 pt-8 font-data text-xs text-faint">
            <span>Origin89 / Data workspace</span>
            <span>Private to the working group · Sources stay attached</span>
          </footer>
        </main>
      </div>

      <RunDrawer run={open} onClose={() => setOpen(undefined)} />
    </div>
  );
}

/** Base UI's select, in place of a bare native one: it is a listbox with typeahead and its own
 *  keyboard model, and it can be styled, which a native option list cannot. */
function SortSelect({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  return (
    <Select.Root value={value} onValueChange={onChange} items={SORTS}>
      <Select.Trigger className="bevel-sm flex min-h-11 items-center gap-2 border border-line-strong bg-surface-raised px-3 text-[13px]">
        <Select.Value />
        <Select.Icon>
          <Icon name="arrowRight" className="rotate-90" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner sideOffset={6}>
          <Select.Popup className="bevel border border-line-strong bg-surface-raised p-1 text-[13px] shadow-xl">
            {Object.entries(SORTS).map(([key, label]) => (
              <Select.Item
                key={key}
                value={key}
                className="bevel-sm flex min-h-11 cursor-default items-center gap-2 px-3 data-[highlighted]:bg-surface data-[highlighted]:text-fg"
              >
                <Select.ItemIndicator>
                  <Icon name="evidence" />
                </Select.ItemIndicator>
                <Select.ItemText>{label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

/** The drawer, as a real dialog. Focus trapping, restore, scroll lock, Escape and the labelled
 *  title come with it; the hand-written one carries a manual backdrop click handler and an
 *  accessibility lint suppression instead. */
function RunDrawer({ run, onClose }: { run?: (typeof RUNS)[number]; onClose: () => void }) {
  return (
    <Dialog.Root open={Boolean(run)} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-page/70 backdrop-blur-[2px]" />
        <Dialog.Popup className="fixed inset-y-0 right-0 flex h-dvh w-[min(680px,100%)] flex-col border-l border-line-strong bg-page">
          <header className="flex items-center justify-between gap-5 border-b border-line px-7 py-6">
            <div>
              <p className="font-data text-xs tracking-wider text-faint uppercase">
                Maker / collection run
              </p>
              <Dialog.Title className="mt-1 text-[28px] font-bold tracking-[-0.035em]">
                {run?.maker ?? ""}
              </Dialog.Title>
            </div>
            <Dialog.Close
              className="bevel-sm grid size-11 place-items-center border border-line-strong text-muted hover:bg-surface-raised hover:text-fg"
              aria-label="Close"
            >
              <Icon name="close" />
            </Dialog.Close>
          </header>
          <Tabs.Root defaultValue="plan" className="min-h-0 flex-1 overflow-auto px-7 pb-10">
            <Tabs.List className="mt-6 flex gap-5 border-b border-line">
              {["plan", "documents", "artifacts"].map((tab) => (
                <Tabs.Tab
                  key={tab}
                  value={tab}
                  className="min-h-11 border-b-2 border-transparent py-2.5 text-[13px] text-muted capitalize hover:text-fg data-[selected]:border-signal data-[selected]:text-fg"
                >
                  {tab}
                </Tabs.Tab>
              ))}
            </Tabs.List>
            <Tabs.Panel value="plan" className="pt-6">
              <dl className="grid grid-cols-2 gap-x-6">
                {[
                  ["Offered", "42"],
                  ["Fetched", "31"],
                  ["Converted", "24"],
                  ["Read", "19"],
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3 border-b border-line py-3.5">
                    <dt className="text-[13px] text-muted">{k}</dt>
                    <dd className="font-data text-[15px] tabular-nums">{v}</dd>
                  </div>
                ))}
              </dl>
            </Tabs.Panel>
            <Tabs.Panel value="documents" className="pt-6 text-[13px] text-muted">
              Every document this run offered, with the page each figure was read from.
            </Tabs.Panel>
            <Tabs.Panel value="artifacts" className="pt-6 text-[13px] text-muted">
              Published files, with row counts and content hashes.
            </Tabs.Panel>
          </Tabs.Root>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
