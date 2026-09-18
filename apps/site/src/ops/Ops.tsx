import avatar from "@origin89/brand/art/avatar-round.webp";
import favicon from "@origin89/brand/icons/favicon.svg";
import logo from "@origin89/brand/logos/origin89-horizontal-white.svg";
import { getRouteApi, Link } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../icons.tsx";
import { Activity } from "./Activity.tsx";
import {
  type DatasetFile,
  type Pipeline,
  pipeline,
  published,
  type SupervisionReport,
  supervision,
  whoami,
} from "./api.ts";
import { Releases } from "./Releases.tsx";
import { RunDetail } from "./RunDetail.tsx";
import type { OpsSearch } from "./router.ts";
import {
  Button,
  ButtonLink,
  Empty,
  Filters,
  IconButton,
  IconLink,
  Loading,
  Notice,
  Panel,
  Search,
  Status,
  Table,
  TableFoot,
  Tag,
  TextButton,
  Toolbar,
} from "./ui.tsx";
import { useResource } from "./useResource.ts";
import {
  bytes,
  count,
  csv,
  displayName,
  download,
  type Filter,
  type RunRow,
  runRows,
  selectRows,
  type View,
  when,
} from "./workspace.ts";

const Records = lazy(() => import("./Records.tsx"));
const NAV = [
  { id: "overview", label: "Overview", icon: "equipment" },
  { id: "makers", label: "Manufacturers", icon: "protocols" },
  { id: "sellers", label: "Sellers", icon: "specifications" },
  { id: "records", label: "Records & corrections", icon: "evidence" },
  { id: "files", label: "Published files", icon: "download" },
  { id: "activity", label: "Activity feed", icon: "activity" },
  { id: "releases", label: "Releases & changes", icon: "evidence" },
  { id: "supervisor", label: "Supervisor", icon: "activity" },
] as const;
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All runs" },
  { id: "review", label: "Awaiting approval" },
  { id: "attention", label: "Needs attention" },
  { id: "active", label: "In progress" },
  { id: "readings", label: "Readings available" },
];
const TITLES: Record<View, [string, string]> = {
  overview: [
    "A clear view of the work ahead.",
    "Review the queue, follow collection, and keep the dataset moving.",
  ],
  makers: ["Manufacturer runs", "From discovery to sourced equipment figures."],
  sellers: ["Seller runs", "Follow collection and classification across the equipment market."],
  records: [
    "Records & corrections",
    "Trace a claim to its source and prepare a reviewable correction.",
  ],
  files: ["Published database", "The files your users and integrations can read today."],
  activity: ["A history you can follow.", "Collection, approvals, and publications in one place."],
  releases: [
    "Know what changed.",
    "Compare published versions, inspect records, and follow every change back to its source.",
  ],
  supervisor: ["Supervisor activity", "What the latest pass started, and what still needs a hand."],
};

export function Ops() {
  const route = getRouteApi("/ops/$view");
  const { view } = route.useParams();
  const state = route.useSearch();
  const routeNavigate = route.useNavigate();
  const filter = state.filter ?? "all";
  const query = state.q ?? "";
  const sort = state.sort ?? "attention";
  const page = state.page ?? 0;
  const updateSearch = (patch: Partial<OpsSearch>, replace = false) => {
    void routeNavigate({ search: (previous) => ({ ...previous, ...patch }), replace });
  };
  const setFilter = (filter: Filter) => updateSearch({ filter, page: undefined });
  const setQuery = (q: string) => updateSearch({ q, page: undefined }, true);
  const setSort = (sort: NonNullable<OpsSearch["sort"]>) => updateSearch({ sort, page: undefined });
  const setPage = (page: number) => updateSearch({ page });
  // The drawer follows each snapshot by key. Holding the row it opened with left it showing a
  // plan as waiting for approval after a refresh had the approval recorded.
  const [selectedKey, setSelectedKey] = useState<string>();
  const setSelected = (row?: RunRow) => setSelectedKey(row?.key);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const releaseSelection = state.release;
  const [toast, setToast] = useState("");
  const [dirty, setDirty] = useState(false);
  const login = useResource<string>();
  const report = useResource<SupervisionReport | null>();
  const runs = useResource<Pipeline>();
  const files = useResource<DatasetFile[]>();
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void login.load(whoami);
  }, [login.load]);
  useEffect(() => {
    if (login.value) {
      void report.load(supervision);
      void files.load(published);
    }
  }, [login.value, report.load, files.load]);
  const selectedView = useRef(view);
  useEffect(() => {
    if (selectedView.current !== view) {
      setSelectedKey(undefined);
      selectedView.current = view;
    }
  }, [view]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.key === "/" &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLTextAreaElement) &&
        !document.querySelector("dialog[open]")
      ) {
        event.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  const rows = useMemo(() => (runs.value ? runRows(runs.value) : []), [runs.value]);
  const selected = rows.find((row) => row.key === selectedKey);
  const shown = useMemo(
    () => selectRows(rows, view, filter, query, sort),
    [rows, view, filter, query, sort],
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(shown.length / 12) - 1));
  const expired = login.expired || runs.expired || report.expired || files.expired;
  const loading = runs.loading || report.loading || files.loading;
  const navigate = (next: View, nextFilter: Filter = "all", extra: Partial<OpsSearch> = {}) => {
    void routeNavigate({
      to: "/ops/$view",
      params: { view: next },
      search: { filter: nextFilter, ...extra },
    });
  };
  const refresh = () => {
    if (!login.value || expired) return;
    setHistoryRefresh((value) => value + 1);
    setDirty(false);
    void runs.load(pipeline);
    void report.load(supervision);
    void files.load(published);
  };
  const share = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setToast("View link copied.");
    } catch {
      setToast("Couldn’t copy the link. Copy it from the address bar.");
    }
  };
  if (!login.value)
    return (
      <div className="ops-signin">
        <link rel="icon" href={favicon} />
        <img src={logo} alt="Origin89" width="190" />
        {login.error ? (
          <>
            <h1>Sign in to your data workspace.</h1>
            <p>{login.error}</p>
            {!login.expired && (
              <Button className="mr-3" type="button" onClick={() => void login.load(whoami)}>
                Try again
              </Button>
            )}
            <ButtonLink
              primary
              href={`/auth/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`}
            >
              Sign in with GitHub <Icon name="arrowRight" />
            </ButtonLink>
          </>
        ) : (
          <Loading label="Checking your session…" />
        )}
      </div>
    );
  return (
    <div className="ops-app grid min-h-screen grid-cols-[252px_minmax(0,1fr)] text-sm max-[1250px]:grid-cols-[212px_minmax(0,1fr)] max-[980px]:block">
      <link rel="icon" href={favicon} />
      <a className="skip" href="#ops-main">
        Skip to workspace
      </a>
      <aside className="sticky top-0 flex h-dvh flex-col border-r border-line bg-surface px-4 pt-7 pb-5 max-[1250px]:px-3 max-[980px]:static max-[980px]:h-auto max-[980px]:border-r-0 max-[980px]:border-b max-[980px]:px-5.5 max-[980px]:pt-4.5 max-[980px]:pb-0 max-[640px]:px-4">
        <a
          className="block px-2.5 pb-8 max-[980px]:flex max-[980px]:items-center max-[980px]:gap-5 max-[980px]:px-0 max-[980px]:pb-4.5"
          href="/"
          aria-label="Origin89 Data home"
        >
          <img src={logo} width="182" alt="Origin89" className="max-[1250px]:w-[170px]" />
          <span className="mt-3.5 block font-data text-xs tracking-[0.1em] text-faint uppercase max-[980px]:mt-0">
            Data workspace
          </span>
        </a>
        <p className="mx-2.5 mb-3 font-data text-xs tracking-wider text-faint uppercase max-[980px]:hidden">
          Collection &amp; curation
        </p>
        <nav
          className="ops-nav grid gap-0.5 max-[980px]:flex max-[980px]:gap-2 max-[980px]:overflow-x-auto max-[980px]:pb-2.5"
          aria-label="Workspace navigation"
        >
          {NAV.map((item) => (
            <Link
              key={item.id}
              to="/ops/$view"
              params={{ view: item.id }}
              search={{}}
              activeOptions={{ includeSearch: false }}
              aria-current={view === item.id ? "page" : undefined}
              className="group bevel-sm flex min-h-11 items-center gap-3 px-2.5 text-sm text-muted transition-colors hover:bg-surface-raised hover:text-fg aria-[current=page]:bg-surface-raised aria-[current=page]:text-fg aria-[current=page]:shadow-[inset_2px_0_var(--color-signal)] max-[980px]:flex-none max-[980px]:whitespace-nowrap max-[640px]:text-xs"
            >
              <Icon name={item.icon} className="group-aria-[current=page]:text-signal" />
              <span>{item.label}</span>
              {item.id === "makers" && runs.value ? (
                <small className="ml-auto font-data text-xs text-faint tabular-nums max-[980px]:hidden">
                  {runs.value.makers.length}
                </small>
              ) : item.id === "sellers" && runs.value ? (
                <small className="ml-auto font-data text-xs text-faint tabular-nums max-[980px]:hidden">
                  {runs.value.sellers.length}
                </small>
              ) : null}
            </Link>
          ))}
        </nav>
        <div className="mt-auto grid gap-1 px-2.5 pt-6 max-[980px]:hidden">
          <div className="mb-3 flex items-start gap-3 border-t border-line pt-5">
            <img src={avatar} width="38" height="38" alt="Buddy" className="rounded-full" />
            <p className="text-[13px] leading-normal">
              Keep the source close.
              <span className="mt-1 block text-xs text-faint">
                Every correction starts with a document.
              </span>
            </p>
          </div>
          <a
            className="flex min-h-10 items-center justify-between text-[13px] text-muted hover:text-fg"
            href="/"
            target="_blank"
            rel="noopener"
          >
            Visit the public dataset <Icon name="arrowUpRight" />
          </a>
          <a
            className="flex min-h-10 items-center justify-between text-[13px] text-muted hover:text-fg"
            href="https://github.com/origin89hq/offgrid-equipment"
            target="_blank"
            rel="noopener"
          >
            Repository <Icon name="arrowUpRight" />
          </a>
        </div>
      </aside>
      <div className="min-w-0">
        <header className="sticky top-0 z-10 flex min-h-[72px] items-center justify-between gap-5 border-b border-line bg-page px-8 py-3.5 max-[1250px]:px-6 max-[980px]:min-h-[60px] max-[640px]:px-4">
          <div className="flex items-center gap-3 text-[13px] max-[640px]:hidden">
            <span className="text-faint max-[1250px]:hidden">Origin89 Data</span>
            <span className="text-faint max-[1250px]:hidden">/</span>
            <strong className="font-semibold">{NAV.find((item) => item.id === view)?.label}</strong>
          </div>
          <div className="flex items-center gap-3 text-[13px] max-[640px]:w-full max-[640px]:justify-between">
            <span className="flex items-center gap-2 text-muted">
              <span className="bevel-sm grid size-[30px] place-items-center border border-line-strong bg-surface-raised font-data text-xs">
                {login.value.slice(0, 2).toUpperCase()}
              </span>
              {login.value}
            </span>
            <form method="post" action="/auth/logout" className="m-0">
              <TextButton type="submit">Sign out</TextButton>
            </form>
          </div>
        </header>
        <main
          id="ops-main"
          className="mx-auto max-w-[1560px] px-8 pt-8 pb-6 max-[1250px]:p-7 max-[980px]:px-5.5 max-[640px]:px-4 max-[640px]:pt-6"
        >
          <div className="mb-6 flex items-end justify-between gap-6 max-[640px]:flex-col max-[640px]:items-start max-[640px]:gap-4.5">
            <div>
              <p className="ops-eyebrow">EQUIPMENT KNOWLEDGE / OPERATIONS</p>
              <h1 className="text-[clamp(28px,2.4vw,40px)] leading-[1.05] font-bold tracking-[-0.035em] max-[640px]:text-[28px]">
                {TITLES[view][0]}
              </h1>
              <p className="mt-3 text-sm text-muted">{TITLES[view][1]}</p>
            </div>
            <Button type="button" primary disabled={loading || expired} onClick={refresh}>
              <Icon name="refresh" />
              {runs.loading
                ? "Refreshing…"
                : runs.value || view === "activity" || view === "releases"
                  ? "Refresh workspace"
                  : "Load current runs"}
            </Button>
          </div>
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-y border-line py-3 font-data text-xs text-faint max-[640px]:flex-col max-[640px]:items-start max-[640px]:gap-2">
            <span className="flex items-center gap-2.5">
              <span
                className={`size-1.5 flex-none ${dirty ? "rounded-[1px] bg-warning" : "rounded-full bg-muted"}`}
              />
              {runs.value
                ? `${runs.error ? "Last successful snapshot" : "Snapshot"} · ${when(runs.value.at)}`
                : "Current runs haven’t been loaded yet"}
            </span>
            <span className="flex items-center gap-5">
              Refresh on demand{" "}
              <TextButton type="button" onClick={() => void share()}>
                <Icon name="copy" />
                Copy view link
              </TextButton>
            </span>
          </div>
          {toast && (
            <Notice>
              {toast}
              <TextButton type="button" onClick={() => setToast("")}>
                Dismiss
              </TextButton>
            </Notice>
          )}
          {expired && (
            <Notice alarm>
              Your session expired.{" "}
              <a
                href={`/auth/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`}
              >
                Sign in again
              </a>{" "}
              before continuing.
            </Notice>
          )}
          {dirty && (
            <Notice>A collection request was sent. Refresh the workspace to see its result.</Notice>
          )}
          {runs.error && (
            <Notice alarm>
              {runs.value ? "Refresh failed. The previous snapshot is still shown. " : ""}
              {runs.error}
            </Notice>
          )}
          {runs.value?.workflowError && (
            <Notice alarm>
              Run data loaded, but workflow statuses are unavailable. {runs.value.workflowError}
            </Notice>
          )}
          {view === "overview" && (
            <>
              <Metrics
                rows={runs.value ? rows : undefined}
                statusesUnavailable={!!runs.value?.workflowError}
                onFilter={(category) => {
                  setFilter(category);
                }}
              />
              <div className="ops-overview-grid">
                <div className="ops-summary-card">
                  <div className="ops-section-heading">
                    <h2>Next up</h2>
                    <Tag>HUMAN IN THE LOOP</Tag>
                  </div>
                  <p>
                    Review a document plan before its downloads begin. Investigate stopped workflows
                    from the same queue.
                  </p>
                  <div className="ops-quick-views">
                    <button
                      type="button"
                      onClick={() => {
                        setFilter("review");
                      }}
                    >
                      <Icon name="evidence" />
                      <span>
                        Review download plans
                        <small>
                          {runs.value
                            ? `${rows.filter((row) => row.category === "review").length} waiting for a decision`
                            : "Load runs to see the review queue"}
                        </small>
                      </span>
                      <Icon name="arrowRight" />
                    </button>
                    <button type="button" onClick={() => navigate("records")}>
                      <Icon name="specifications" />
                      <span>
                        Prepare a record correction
                        <small>Check the source and export a patch</small>
                      </span>
                      <Icon name="arrowRight" />
                    </button>
                  </div>
                </div>
                <div className="ops-summary-card field">
                  <div className="ops-section-heading">
                    <h2>Latest supervisor pass</h2>
                    <TextButton type="button" onClick={() => navigate("supervisor")}>
                      View activity <Icon name="arrowRight" />
                    </TextButton>
                  </div>
                  {report.error ? (
                    <Notice alarm>{report.error}</Notice>
                  ) : report.loading && !report.value ? (
                    <Loading label="Reading the latest pass…" />
                  ) : report.value ? (
                    <>
                      <p className="ops-note">{when(report.value.at)}</p>
                      <div className="ops-pass-stats">
                        <div>
                          <strong>{report.value.started.length}</strong>
                          <span>started</span>
                        </div>
                        <div>
                          <strong>{report.value.blocked.length}</strong>
                          <span>blocked</span>
                        </div>
                        <div>
                          <strong>{report.value.concerns.length}</strong>
                          <span>concerns</span>
                        </div>
                      </div>
                      <p>{report.value.concerns[0] ?? "No concerns were reported in this pass."}</p>
                    </>
                  ) : (
                    <p>No supervisor report has been published.</p>
                  )}
                </div>
              </div>
            </>
          )}
          {(view === "overview" || view === "activity") && (
            <Activity
              compact={view === "overview"}
              refresh={historyRefresh}
              onAll={() => navigate("activity")}
              onRelease={(id) => {
                navigate("releases", "all", { release: id });
              }}
            />
          )}
          {view === "releases" && <Releases selected={releaseSelection} refresh={historyRefresh} />}
          {(view === "overview" || view === "makers" || view === "sellers") && (
            <Panel>
              <div className="ops-section-heading">
                <div>
                  <p className="ops-eyebrow">
                    {view === "overview" ? "YOUR COLLECTION QUEUE" : "CURRENT RUNS"}
                  </p>
                  <h2>
                    {view === "overview"
                      ? "Everything that needs a next step."
                      : view === "makers"
                        ? "Manufacturer collection"
                        : "Seller collection"}
                  </h2>
                </div>
                <Button
                  type="button"
                  disabled={!runs.value || !shown.length}
                  onClick={() => download("origin89-runs.csv", csv(shown), "text/csv")}
                >
                  <Icon name="download" />
                  Export view
                </Button>
              </div>
              <Toolbar>
                <Search>
                  <Icon name="search" />
                  <input
                    ref={search}
                    type="search"
                    aria-label="Search runs"
                    placeholder="Search names, workflow IDs, or next steps…"
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                    }}
                  />
                  <kbd>/</kbd>
                </Search>
                <select
                  aria-label="Sort runs"
                  value={sort}
                  onChange={(event) => {
                    setSort(event.target.value as typeof sort);
                  }}
                >
                  <option value="attention">Attention first</option>
                  <option value="name">Name A–Z</option>
                  <option value="recent">Most recent</option>
                </select>
              </Toolbar>
              <Filters aria-label="Filter runs">
                {FILTERS.filter(
                  (item) => view !== "sellers" || !["review", "readings"].includes(item.id),
                ).map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    aria-pressed={filter === item.id}
                    onClick={() => {
                      setFilter(item.id);
                    }}
                  >
                    {item.label}
                    {runs.value && (
                      <span>
                        {runs.value.workflowError && ["active", "attention"].includes(item.id)
                          ? "—"
                          : selectRows(rows, view, item.id, "", sort).length}
                      </span>
                    )}
                  </button>
                ))}
              </Filters>
              {runs.loading && !runs.value ? (
                <Loading label="Loading the current collection runs…" />
              ) : !runs.value ? (
                <Empty title="Your collection, in one place">
                  Load current runs to see approval requests, progress, and workflow errors.
                </Empty>
              ) : shown.length === 0 ? (
                <Empty title="No runs match this view">
                  Try another search or clear the filters.
                </Empty>
              ) : (
                <RunTable
                  rows={shown.slice(currentPage * 12, (currentPage + 1) * 12)}
                  onSelect={setSelected}
                />
              )}
              {runs.value && (
                <TableFoot>
                  <span>
                    {shown.length
                      ? `${currentPage * 12 + 1}–${Math.min((currentPage + 1) * 12, shown.length)} of ${shown.length}`
                      : "0 matching"}{" "}
                    runs
                  </span>
                  <div>
                    <IconButton
                      type="button"
                      aria-label="Previous runs page"
                      disabled={currentPage === 0}
                      onClick={() => setPage(currentPage - 1)}
                    >
                      <Icon name="arrowLeft" />
                    </IconButton>
                    <span>
                      {currentPage + 1} / {Math.max(1, Math.ceil(shown.length / 12))}
                    </span>
                    <IconButton
                      type="button"
                      aria-label="Next runs page"
                      disabled={(currentPage + 1) * 12 >= shown.length}
                      onClick={() => setPage(currentPage + 1)}
                    >
                      <Icon name="arrowRight" />
                    </IconButton>
                  </div>
                </TableFoot>
              )}
            </Panel>
          )}
          {view === "records" && (
            <Suspense fallback={<Loading label="Opening the record workspace…" />}>
              <Records />
            </Suspense>
          )}
          {view === "files" && (
            <Published
              files={files.value}
              loading={files.loading}
              error={files.error}
              query={query}
              onSearch={setQuery}
            />
          )}
          {view === "supervisor" && (
            <Supervisor
              report={report.value}
              error={report.error}
              loading={report.loading}
              onEntity={(entity) => {
                const row = rows.find((row) => row.entity === entity);
                if (row) setSelected(row);
                else {
                  navigate("overview", "all", { q: entity });
                }
              }}
            />
          )}
          <footer className="flex justify-between gap-5 pt-8 font-data text-xs text-faint max-[640px]:flex-col max-[640px]:gap-2">
            <span>Origin89 / Data workspace</span>
            <span>Private to the working group · Sources stay attached</span>
          </footer>
        </main>
      </div>
      {selected && !expired && (
        <RunDetail
          // A different current run is a different review: its plan and approval start afresh.
          key={`${selected.key}:${selected.run?.instance ?? ""}`}
          row={selected}
          login={login.value}
          onClose={() => setSelected(undefined)}
          onApproved={refresh}
          onChanged={() => setDirty(true)}
        />
      )}
    </div>
  );
}
function Metrics({
  rows,
  statusesUnavailable,
  onFilter,
}: {
  rows?: RunRow[];
  statusesUnavailable: boolean;
  onFilter: (filter: Filter) => void;
}) {
  const items: [Filter, string, string][] = [
    ["review", "Awaiting approval", "Document plans to review"],
    ["active", "In progress", "Collection workflows running"],
    ["attention", "Needs attention", "Stopped or unknown workflows"],
    ["readings", "Readings available", "Makers with extracted figures"],
  ];
  return (
    <div className="ops-metrics">
      {items.map(([filter, label, note]) => (
        <button type="button" key={filter} onClick={() => onFilter(filter)}>
          <span>
            {label}
            <Icon name="arrowUpRight" />
          </span>
          <strong>
            {rows && !(statusesUnavailable && ["active", "attention"].includes(filter))
              ? rows.filter((row) => row.category === filter).length
              : "—"}
          </strong>
          <small>
            {statusesUnavailable && ["active", "attention"].includes(filter)
              ? "Workflow status unavailable"
              : note}
          </small>
        </button>
      ))}
    </div>
  );
}
function RunTable({ rows, onSelect }: { rows: RunRow[]; onSelect: (row: RunRow) => void }) {
  return (
    <Table>
      <thead>
        <tr>
          <th scope="col">Source</th>
          <th scope="col">Workflow</th>
          <th scope="col">Collection progress</th>
          <th scope="col">Next step</th>
          <th scope="col">
            <span className="sr-only">Inspect</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <th scope="row">
              <button type="button" className="ops-source-button" onClick={() => onSelect(row)}>
                <span className="ops-source-initial">{row.entity.slice(0, 2).toUpperCase()}</span>
                <span>
                  {displayName(row.entity)}
                  <small>
                    {row.kind === "maker" ? "Manufacturer" : "Seller"} · {row.date ?? "No date"}
                  </small>
                </span>
              </button>
            </th>
            <td>
              <Status value={row.run?.status} />
            </td>
            <td>
              <Progress row={row} />
            </td>
            <td>
              <span className={`ops-next-text ${row.category === "review" ? "warning" : ""}`}>
                {row.next}
              </span>
              {row.maker?.approvedBy && (
                <small className="ops-note">Approved by {row.maker.approvedBy}</small>
              )}
            </td>
            <td>
              <IconButton
                type="button"
                aria-label={`Inspect ${row.entity}`}
                onClick={() => onSelect(row)}
              >
                <Icon name="arrowRight" />
              </IconButton>
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
function Progress({ row }: { row: RunRow }) {
  const done = row.maker ? row.maker.converted : row.seller?.classified?.written;
  const total = row.maker ? row.maker.sent : row.seller?.classified?.parts;
  const label = row.maker ? "converted" : "classified parts";
  return (
    <div className="ops-progress">
      <span>
        {done === undefined || total === undefined
          ? row.maker
            ? `${count(row.maker.offered)} documents offered`
            : `${count(row.seller?.sightings)} sightings`
          : `${count(done)} / ${count(total)} ${label}`}
      </span>
      {done !== undefined && total !== undefined && total > 0 && (
        <div aria-hidden="true">
          <span
            style={{
              width:
                done !== undefined && total !== undefined && total > 0
                  ? `${Math.min(100, (done / total) * 100)}%`
                  : "0%",
            }}
          />
        </div>
      )}
    </div>
  );
}
function Published({
  files,
  loading,
  error,
  query,
  onSearch,
}: {
  files?: DatasetFile[];
  loading: boolean;
  error?: string;
  query: string;
  onSearch: (value: string) => void;
}) {
  const [format, setFormat] = useState("all");
  const [copied, setCopied] = useState("");
  const shown =
    files?.filter(
      (file) =>
        file.name.includes(query.toLowerCase()) &&
        (format === "all" || file.name.endsWith(`.${format}`)),
    ) ?? [];
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("Content hash copied.");
    } catch {
      setCopied("Couldn’t copy. The full hash is shown below.");
    }
  };
  return (
    <Panel>
      <div className="ops-section-heading">
        <div>
          <p className="ops-eyebrow">PUBLIC RELEASE</p>
          <h2>Ready for your next tool.</h2>
        </div>
        <Button
          type="button"
          disabled={!files}
          onClick={() =>
            download("origin89-file-index.json", JSON.stringify(shown, null, 2), "application/json")
          }
        >
          Export file index <Icon name="download" />
        </Button>
      </div>
      <Toolbar>
        <Search>
          <Icon name="search" />
          <input
            aria-label="Search published files"
            placeholder="Find a table…"
            value={query}
            onChange={(event) => onSearch(event.target.value)}
          />
        </Search>
        <select
          aria-label="File format"
          value={format}
          onChange={(event) => setFormat(event.target.value)}
        >
          <option value="all">All formats</option>
          <option value="parquet">Parquet</option>
          <option value="csv">CSV</option>
          <option value="json">JSON</option>
        </select>
      </Toolbar>
      {error && <Notice alarm>{error}</Notice>}
      {copied && <Notice>{copied}</Notice>}
      {loading && !files ? (
        <Loading label="Reading the published file index…" />
      ) : shown.length === 0 ? (
        <Empty title="No files match">Try another table name or format.</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Rows</th>
              <th scope="col">Size</th>
              <th scope="col">Content hash</th>
              <th scope="col">Download</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((file) => (
              <tr key={file.name}>
                <th scope="row">
                  <span className="ops-file-type">{file.name.split(".").pop()}</span>
                  {file.name}
                </th>
                <td className="ops-mono">{count(file.rows)}</td>
                <td>{bytes(file.bytes)}</td>
                <td>
                  <button
                    type="button"
                    className="ops-hash"
                    title={file.sha256}
                    onClick={() => void copy(file.sha256)}
                  >
                    {file.sha256.slice(0, 12)}… <Icon name="copy" />
                  </button>
                  <details>
                    <summary>Full SHA-256</summary>
                    <code>{file.sha256}</code>
                  </details>
                </td>
                <td>
                  <IconLink href={`/v1/${file.name}`} download aria-label={`Download ${file.name}`}>
                    <Icon name="download" />
                  </IconLink>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}
function Supervisor({
  report,
  error,
  loading,
  onEntity,
}: {
  report?: SupervisionReport | null;
  error?: string;
  loading: boolean;
  onEntity: (entity: string) => void;
}) {
  return (
    <Panel>
      <div className="ops-section-heading">
        <h2>Latest pass</h2>
        {report && <span className="ops-note">{when(report.at)}</span>}
      </div>
      {error && <Notice alarm>{error}</Notice>}
      {loading && !report ? (
        <Loading label="Reading the supervisor report…" />
      ) : !report ? (
        <Empty title="No report yet">
          The supervisor’s latest pass will appear here when it has run.
        </Empty>
      ) : (
        <div className="ops-activity-columns">
          <div>
            <h3>
              Concerns <span>{report.concerns.length}</span>
            </h3>
            {report.concerns.length ? (
              report.concerns.map((text) => (
                <div className="ops-activity alarm" key={text}>
                  <span>!</span>
                  <p>{text}</p>
                </div>
              ))
            ) : (
              <p className="ops-note">No concerns reported.</p>
            )}
          </div>
          <div>
            <h3>
              Started <span>{report.started.length}</span>
            </h3>
            {report.started.length ? (
              report.started.map((item) => (
                <div className="ops-activity" key={`${item.what}:${item.entity}:${item.detail}`}>
                  <span>↗</span>
                  <div>
                    <TextButton
                      className="mb-1 font-medium text-fg"
                      type="button"
                      onClick={() => onEntity(item.entity)}
                    >
                      {displayName(item.entity)}
                    </TextButton>
                    <p>{item.what}</p>
                    <small>{item.detail}</small>
                  </div>
                </div>
              ))
            ) : (
              <p className="ops-note">No work was started in this pass.</p>
            )}
          </div>
          <div>
            <h3>
              Blocked <span>{report.blocked.length}</span>
            </h3>
            {report.blocked.length ? (
              report.blocked.map((item) => (
                <div className="ops-activity" key={`${item.entity}:${item.waitingOn}`}>
                  <span>—</span>
                  <div>
                    <TextButton
                      className="mb-1 font-medium text-fg"
                      type="button"
                      onClick={() => onEntity(item.entity)}
                    >
                      {displayName(item.entity)}
                    </TextButton>
                    <p>{item.waitingOn}</p>
                  </div>
                </div>
              ))
            ) : (
              <p className="ops-note">No blocked work reported.</p>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}
