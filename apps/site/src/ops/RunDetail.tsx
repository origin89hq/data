import { Tabs } from "@base-ui-components/react/tabs";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons.tsx";
import {
  approve,
  archive,
  archiveUrl,
  type DocumentPlan,
  decisionRecorded,
  message,
  plan,
  runPrefix,
  runSettingsError,
  startRun,
} from "./api.ts";
import {
  Button,
  Drawer,
  Empty,
  IconButton,
  Loading,
  Notice,
  Search,
  Status,
  TableFoot,
} from "./ui.tsx";
import { useResource } from "./useResource.ts";
import { bytes, count, displayName, needsApproval, type RunRow } from "./workspace.ts";

export function RunDetail({
  row,
  login,
  onClose,
  onApproved,
  onChanged,
}: {
  row: RunRow;
  login: string;
  onClose: () => void;
  onApproved: () => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<"summary" | "documents" | "archive" | "actions">("summary");
  const documents = useResource<DocumentPlan>();
  const files = useResource<string[]>();
  const [query, setQuery] = useState("");
  const [documentPage, setDocumentPage] = useState(0);
  const [filePage, setFilePage] = useState(0);
  const [limit, setLimit] = useState("20");
  const [acknowledged, setAcknowledged] = useState(false);
  const [submission, setSubmission] = useState<{
    state: "pending" | "sent" | "uncertain";
    text: string;
  }>();
  const run = row.run;
  const selected = documents.value;
  useEffect(() => {
    if (selected) {
      setLimit(String(Math.min(20, selected.documents.length)));
      setAcknowledged(false);
      setDocumentPage(0);
    }
  }, [selected]);
  const matchingDocuments =
    selected?.documents.filter((doc) =>
      [doc.url, doc.host].some((value) => value.toLowerCase().includes(query.trim().toLowerCase())),
    ) ?? [];
  const reviewing = Boolean(row.maker && run && needsApproval(row.maker, run));
  const view = (next: typeof tab) => {
    setTab(next);
    if (next === "documents" && run && !documents.value && !documents.loading)
      void documents.load((signal) => plan(run, signal));
    if (next === "archive" && run && !files.value && !files.loading)
      void files.load((signal) => archive(run, signal));
  };
  // Closing the drawer stops the wait for the workflow; the next refresh shows what it recorded.
  const waiting = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => waiting.current?.abort(), []);
  const submit = async () => {
    if (!run || !selected || documents.loading || documents.error || !acknowledged || submission)
      return;
    setSubmission({ state: "pending", text: "Sending approval…" });
    try {
      await approve(run, Number(limit), selected.documents.length);
    } catch (error) {
      setSubmission({ state: "uncertain", text: message(error) });
      return;
    }
    const sent = `Approval for up to ${limit} documents sent to ${run.instance}.`;
    setSubmission({ state: "sent", text: `${sent} Waiting for the workflow to record it…` });
    const controller = new AbortController();
    waiting.current = controller;
    const recorded = await decisionRecorded(run, controller.signal).catch(() => false);
    if (controller.signal.aborted) return;
    setSubmission({
      state: "sent",
      text: recorded
        ? `${sent} The workflow recorded it.`
        : `${sent} The workflow has not recorded it yet; refresh the workspace in a moment.`,
    });
    if (recorded) onApproved();
    else onChanged();
  };
  const facts = row.maker
    ? ([
        ["Offered", row.maker.offered],
        ["Downloaded", row.maker.fetched],
        ["Sent for conversion", row.maker.sent],
        ["Converted", row.maker.converted],
        ["Text readings", row.maker.read],
        ["Page readings", row.maker.seen],
        ["Specification pages", row.maker.specPages],
      ] as const)
    : ([
        ["Sightings", row.seller?.sightings],
        ["Classification parts", row.seller?.classified?.parts],
        ["Parts written", row.seller?.classified?.written],
      ] as const);
  return (
    <Drawer
      title={displayName(row.entity)}
      eyebrow={`${row.kind === "maker" ? "MANUFACTURER" : "SELLER"} / CURRENT RUN`}
      onClose={onClose}
    >
      <div className="ops-detail-summary">
        <Status value={run?.status} />
        <span className="ops-mono">{row.date ?? "Date not reported"}</span>
      </div>
      {/* A real tablist. The selected state is read from aria-selected rather than Base UI's
          data-active, which is internal to the library and is a release candidate. These were <nav> buttons carrying aria-pressed, which is toggle-button
          semantics: no tab roles, no panel association, and no way to move between them with the
          arrow keys. */}
      <Tabs.Root value={tab} onValueChange={(next) => view(next as typeof tab)}>
        <Tabs.List
          className="mt-6 flex gap-5 border-b border-line max-[640px]:gap-4"
          aria-label="Run detail views"
        >
          {(
            [
              "summary",
              ...(row.kind === "maker" ? ["documents"] : []),
              "archive",
              "actions",
            ] as const
          ).map((item) => (
            <Tabs.Tab
              key={item}
              value={item}
              className="min-h-11 border-b-2 border-transparent py-2.5 text-[13px] text-muted hover:text-fg aria-[selected=true]:border-signal aria-[selected=true]:text-fg"
            >
              {item === "summary"
                ? "Overview"
                : item === "documents"
                  ? "Documents"
                  : item === "archive"
                    ? "Run files"
                    : "Actions"}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        <Tabs.Panel value="summary" className="pt-6">
          <>
            <div className="ops-next">
              <p className="ops-eyebrow">NEXT STEP</p>
              <h3>{row.next}</h3>
              {reviewing && submission?.state !== "sent" && (
                <Button type="button" primary onClick={() => view("documents")}>
                  Review download plan <Icon name="arrowRight" />
                </Button>
              )}
            </div>
            <dl className="ops-facts">
              {facts.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{count(value)}</dd>
                </div>
              ))}
            </dl>
            <p className="ops-note">A dash means the archive has not reported a count.</p>
            <dl className="ops-meta">
              <div>
                <dt>Entity</dt>
                <dd>{row.entity}</dd>
              </div>
              <div>
                <dt>Run ID</dt>
                <dd>{run?.run ?? "Not reported"}</dd>
              </div>
              <div>
                <dt>Workflow instance</dt>
                <dd>{run?.instance ?? "Not recorded"}</dd>
              </div>
              {row.maker && (
                <div>
                  <dt>Approved by</dt>
                  <dd>{row.maker.approvedBy ?? "No approval recorded"}</dd>
                </div>
              )}
            </dl>
            {run?.error && <Notice alarm>{run.error}</Notice>}
            <a className="ops-text-link" href="/#explore" target="_blank" rel="noopener">
              Explore published equipment <Icon name="arrowUpRight" />
            </a>
          </>
        </Tabs.Panel>
        <Tabs.Panel value="documents" className="pt-6">
          {!run ? (
            <Empty title="No workflow instance recorded">
              Refresh the workspace before reviewing a download plan.
            </Empty>
          ) : (
            <>
              {documents.loading && <Loading label="Reading this run’s document plan…" />}
              {documents.error && (
                <Notice alarm>
                  {documents.error}
                  <Button
                    type="button"
                    onClick={() => void documents.load((signal) => plan(run, signal))}
                  >
                    Read plan again
                  </Button>
                </Notice>
              )}
              {selected && (
                <>
                  <div className="ops-plan-summary">
                    <div>
                      <strong>{count(selected.documents.length)}</strong>
                      <span>documents offered</span>
                    </div>
                    <div>
                      <strong>
                        {bytes(selected.documents.reduce((sum, doc) => sum + (doc.bytes ?? 0), 0))}
                      </strong>
                      <span>
                        known size ·{" "}
                        {selected.documents.filter((doc) => doc.bytes === undefined).length} unknown
                      </span>
                    </div>
                  </div>
                  <Search>
                    <Icon name="search" />
                    <input
                      aria-label="Search documents"
                      placeholder="Find a document or host…"
                      value={query}
                      onChange={(event) => {
                        setQuery(event.target.value);
                        setDocumentPage(0);
                      }}
                    />
                  </Search>
                  <div className="ops-document-list">
                    {matchingDocuments
                      .slice(documentPage * 50, (documentPage + 1) * 50)
                      .map((doc) => (
                        <a href={doc.url} target="_blank" rel="noopener" key={doc.url}>
                          <span className="ops-file-icon">
                            {new URL(doc.url).pathname
                              .split(".")
                              .pop()
                              ?.slice(0, 4)
                              .toUpperCase() || "FILE"}
                          </span>
                          <span>
                            <strong>{decodeName(doc.url)}</strong>
                            <small>
                              {doc.host} · {bytes(doc.bytes)}
                              {doc.cited ? " · cited by a record" : ""}
                            </small>
                          </span>
                          <Icon name="arrowUpRight" />
                        </a>
                      ))}
                  </div>
                  <Pages
                    page={documentPage}
                    total={matchingDocuments.length}
                    onPage={setDocumentPage}
                    label="documents"
                  />
                  {reviewing && !documents.error && submission?.state !== "sent" && (
                    <div className="ops-approval">
                      <p className="ops-eyebrow">REVIEW BEFORE DOWNLOADING</p>
                      <h3>Give this run the go-ahead.</h3>
                      <p>
                        A limit takes the documents the records already cite first, then the rest in
                        the plan’s order. This approval applies only to the workflow shown above and
                        is attributed to <strong>{login}</strong>.
                      </p>
                      <label>
                        Maximum documents
                        <input
                          type="number"
                          min="1"
                          max={selected.documents.length}
                          value={limit}
                          disabled={!!submission}
                          onChange={(event) => {
                            setLimit(event.target.value);
                            setAcknowledged(false);
                          }}
                        />
                      </label>
                      <label className="ops-check">
                        <input
                          type="checkbox"
                          checked={acknowledged}
                          disabled={!!submission}
                          onChange={(event) => setAcknowledged(event.target.checked)}
                        />
                        <span>
                          I reviewed this plan and approve downloading up to {limit || "—"}{" "}
                          documents.
                        </span>
                      </label>
                      <Button
                        type="button"
                        primary
                        disabled={
                          documents.loading ||
                          !acknowledged ||
                          !!submission ||
                          !Number.isSafeInteger(Number(limit)) ||
                          Number(limit) < 1 ||
                          Number(limit) > selected.documents.length
                        }
                        onClick={() => void submit()}
                      >
                        Approve downloads <Icon name="arrowRight" />
                      </Button>
                    </div>
                  )}
                  {submission && (
                    <Notice alarm={submission.state === "uncertain"}>{submission.text}</Notice>
                  )}
                  {!reviewing && !submission && (
                    <p className="ops-note">
                      This snapshot does not show a workflow awaiting download approval.
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </Tabs.Panel>
        <Tabs.Panel value="archive" className="pt-6">
          {!run ? (
            <Empty title="No run files to locate">
              The current snapshot has no workflow instance for this entity.
            </Empty>
          ) : (
            <>
              <p className="ops-note">
                Files belonging to run <code>{run.run}</code>. Open text artifacts to inspect their
                contents.
              </p>
              {files.loading && <Loading label="Listing run files…" />}
              {files.error && (
                <Notice alarm>
                  {files.error}
                  <Button
                    type="button"
                    onClick={() => void files.load((signal) => archive(run, signal))}
                  >
                    Try again
                  </Button>
                </Notice>
              )}
              {files.value?.length === 0 && (
                <Empty title="No files yet">This run has not written any artifacts.</Empty>
              )}
              <div className="ops-artifacts">
                {files.value?.slice(filePage * 50, (filePage + 1) * 50).map((file) => (
                  <div key={file}>
                    <code>{file.slice(runPrefix(run).length + 1)}</code>
                    {/\.(json|jsonl|md|txt)$/.test(file) ? (
                      <a
                        href={archiveUrl(file)}
                        target="_blank"
                        rel="noopener"
                        aria-label={`Open ${file}`}
                      >
                        <Icon name="arrowUpRight" />
                      </a>
                    ) : (
                      <span className="ops-note">Binary artifact</span>
                    )}
                  </div>
                ))}
              </div>
              <Pages
                page={filePage}
                total={files.value?.length ?? 0}
                onPage={setFilePage}
                label="files"
              />
            </>
          )}
        </Tabs.Panel>
        <Tabs.Panel value="actions" className="pt-6">
          <NewRun row={row} onChanged={onChanged} />
        </Tabs.Panel>
      </Tabs.Root>
    </Drawer>
  );
}
function decodeName(url: string) {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() || url);
  } catch {
    return url;
  }
}
function NewRun({ row, onChanged }: { row: RunRow; onChanged: () => void }) {
  const [domains, setDomains] = useState("");
  const [limit, setLimit] = useState("120");
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<{ state: "pending" | "sent" | "uncertain"; text: string }>();
  const submit = async () => {
    if (!confirm || result) return;
    setResult({ state: "pending", text: "Starting the run…" });
    try {
      const result = await startRun(
        row.kind,
        row.entity,
        domains
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        Number(limit),
        row.run,
      );
      setResult({
        state: "sent",
        text: result.reconciled
          ? `Run ${result.id} was already created and is now confirmed. Refresh to inspect it.`
          : `Run ${result.id} started. Refresh to follow its progress.`,
      });
      onChanged();
    } catch (error) {
      setResult({ state: "uncertain", text: message(error) });
    }
  };
  const settingsError = runSettingsError(
    row.kind,
    row.entity,
    domains
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean),
    Number(limit),
  );
  const inProgress =
    row.run &&
    ["queued", "running", "waiting", "paused", "waitingForPause"].includes(row.run.status);
  return (
    <div className="ops-action-form">
      <p className="ops-eyebrow">COLLECTION CONTROL</p>
      <h3>Start a fresh {row.kind === "maker" ? "discovery" : "collection"} run</h3>
      <p>
        A new run becomes current for {displayName(row.entity)}. Existing archive files stay
        available.
      </p>
      {inProgress && (
        <Notice>
          A workflow is already {row.run?.status}. Let it finish before starting another run.
        </Notice>
      )}
      {row.kind === "maker" && (
        <label>
          Manufacturer-owned domains
          <input
            placeholder="example.com, docs.example.com"
            value={domains}
            onChange={(event) => {
              setDomains(event.target.value);
              setConfirm(false);
            }}
            disabled={!!result}
          />
          <small>Use only domains belonging to this manufacturer.</small>
        </label>
      )}
      <label>
        {row.kind === "maker" ? "Discovery page limit" : "Page crawl limit"}
        <input
          type="number"
          min="1"
          max="500"
          value={limit}
          onChange={(event) => {
            setLimit(event.target.value);
            setConfirm(false);
          }}
          disabled={!!result}
        />
      </label>
      <p className="ops-note">
        {row.kind === "maker"
          ? "Discovery reads public pages. Document downloads still require a separate approval."
          : "A seller run can use paid model calls. This limit applies to page crawls; feed crawls read the seller’s configured feed."}
      </p>
      {settingsError && (domains.trim() || row.kind === "seller" || !limit) && (
        <Notice alarm>{settingsError}</Notice>
      )}
      <label className="ops-check">
        <input
          type="checkbox"
          checked={confirm}
          onChange={(event) => setConfirm(event.target.checked)}
          disabled={!!result}
        />
        <span>I want to start this run with these settings.</span>
      </label>
      <Button
        type="button"
        primary
        disabled={
          !confirm ||
          !!result ||
          !!inProgress ||
          !!settingsError ||
          Number(limit) < 1 ||
          Number(limit) > 500 ||
          !Number.isInteger(Number(limit)) ||
          (row.kind === "maker" && !domains.trim())
        }
        onClick={() => void submit()}
      >
        Start new run <Icon name="arrowRight" />
      </Button>
      {result && <Notice alarm={result.state === "uncertain"}>{result.text}</Notice>}
    </div>
  );
}

function Pages({
  page,
  total,
  onPage,
  label,
}: {
  page: number;
  total: number;
  onPage: (page: number) => void;
  label: string;
}) {
  return (
    <TableFoot>
      <span>
        {total ? `${page * 50 + 1}–${Math.min((page + 1) * 50, total)} of ${total}` : "0 matching"}{" "}
        {label}
      </span>
      {total > 50 && (
        <div>
          <IconButton
            type="button"
            aria-label={`Previous ${label}`}
            disabled={page === 0}
            onClick={() => onPage(page - 1)}
          >
            <Icon name="arrowLeft" />
          </IconButton>
          <IconButton
            type="button"
            aria-label={`Next ${label}`}
            disabled={(page + 1) * 50 >= total}
            onClick={() => onPage(page + 1)}
          >
            <Icon name="arrowRight" />
          </IconButton>
        </div>
      )}
    </TableFoot>
  );
}
