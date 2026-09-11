import {
  Comparison,
  RecordKind,
  type Release,
  ReleasePage,
} from "@origin89/equipment-schema/releases";
import { useEffect, useState } from "react";
import { Icon } from "../icons.tsx";
import { read } from "./api.ts";
import { Empty, Loading, Notice } from "./ui.tsx";
import { useResource } from "./useResource.ts";
import { bytes, count, when } from "./workspace.ts";

const repo = "https://github.com/origin89hq/offgrid-equipment";
export function Releases({ selected, refresh }: { selected?: string; refresh: number }) {
  const history = useResource<ReturnType<typeof ReleasePage.parse>>();
  const load = history.load;
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(selected ?? "");
  const [kind, setKind] = useState("models");
  const [query, setQuery] = useState("");
  const [change, setChange] = useState("all");
  const [comparison, setComparison] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: A workspace refresh explicitly reloads history.
  useEffect(() => {
    void load((signal) => read("/releases", signal).then((value) => ReleasePage.parse(value)));
  }, [load, refresh]);
  const releases = history.value?.releases ?? [];
  const destination = to || releases[0]?.id || "";
  const source = from || releases.find((release) => release.id !== destination)?.id || "";
  const selectedMissing = destination && !releases.some((release) => release.id === destination);
  return (
    <>
      <section className="ops-panel">
        <div className="ops-section-heading">
          <div>
            <p className="ops-eyebrow">PUBLISHED DATA / VERSION HISTORY</p>
            <h2>Every publication has a fingerprint.</h2>
          </div>
          <button
            className="ops-quiet"
            type="button"
            disabled={history.loading || history.expired}
            onClick={() =>
              void load((signal) =>
                read("/releases", signal).then((value) => ReleasePage.parse(value)),
              )
            }
          >
            <Icon name="refresh" /> Refresh releases
          </button>
        </div>
        <p className="ops-note">
          Versions identify dataset content. Publishing identical content keeps the same version.
          History begins with the first publication after this feature is deployed.
        </p>
        {history.error && (
          <Notice alarm>
            {history.value ? "Showing the last successful history. " : ""}
            {history.error}
            {history.expired && (
              <>
                {" "}
                <a href="/auth/login?next=%2Fops">Sign in again</a>
              </>
            )}
          </Notice>
        )}
        {history.loading && !history.value ? (
          <Loading label="Reading published versions…" />
        ) : !releases.length && history.value ? (
          <Empty title="No recorded releases yet">
            The next dataset publication will appear here with its source commit and record
            snapshots.
          </Empty>
        ) : (
          <div className="ops-release-list">
            {releases.map((release, i) => (
              <article key={release.id} className={destination === release.id ? "selected" : ""}>
                <div>
                  <span className="ops-tag">
                    {i === 0 ? "MOST RECENT CONTENT" : "DATASET VERSION"}
                  </span>
                  <h3>
                    <code title={release.id}>{release.id.slice(0, 12)}</code>
                  </h3>
                  <time dateTime={release.at}>{when(release.at)}</time>
                </div>
                <div className="ops-history-meta">
                  <span>{Object.keys(release.files).length} files</span>
                  <a href={`${repo}/commit/${release.sha}`} target="_blank" rel="noopener">
                    Commit {release.sha.slice(0, 7)} <Icon name="arrowUpRight" />
                  </a>
                  <a href={`${repo}/actions/runs/${release.job}`} target="_blank" rel="noopener">
                    Publication job <Icon name="arrowUpRight" />
                  </a>
                </div>
                <button
                  className="ops-button"
                  type="button"
                  onClick={() => {
                    setTo(release.id);
                    setFrom(
                      releases[i + 1]?.id ??
                        releases.find((other) => other.id !== release.id)?.id ??
                        "",
                    );
                    setComparison("");
                    document
                      .getElementById("ops-compare")
                      ?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                >
                  Compare this version
                </button>
              </article>
            ))}
          </div>
        )}
        {history.value?.cursor && (
          <button
            className="ops-button"
            type="button"
            disabled={history.loading || history.expired}
            onClick={() =>
              void load(async (signal) => {
                const next = ReleasePage.parse(
                  await read(
                    `/releases?cursor=${encodeURIComponent(history.value?.cursor ?? "")}`,
                    signal,
                  ),
                );
                const previous = history.value?.releases ?? [];
                return {
                  ...next,
                  releases: [
                    ...previous,
                    ...next.releases.filter(
                      (release) => !previous.some((p) => p.id === release.id),
                    ),
                  ],
                };
              })
            }
          >
            Load older versions
          </button>
        )}
      </section>
      {(releases.length >= 2 || selectedMissing) && (
        <section className="ops-panel">
          <div className="ops-section-heading">
            <div>
              <p className="ops-eyebrow">UNDERSTAND WHAT CHANGED</p>
              <h2 id="ops-compare">Compare two versions.</h2>
            </div>
          </div>
          <form
            className="ops-history-filters ops-compare-controls"
            onSubmit={(event) => {
              event.preventDefault();
              setComparison(
                new URLSearchParams({
                  from: source,
                  to: destination,
                  kind,
                  q: query,
                  change,
                }).toString(),
              );
            }}
          >
            <label htmlFor="release-from">
              From
              <VersionSelect
                id="release-from"
                releases={releases}
                value={source}
                onChange={setFrom}
              />
            </label>
            <label htmlFor="release-to">
              To
              <VersionSelect
                id="release-to"
                releases={releases}
                value={destination}
                onChange={setTo}
              />
            </label>
            <label>
              Record type
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                {RecordKind.options.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Changes
              <select value={change} onChange={(e) => setChange(e.target.value)}>
                <option value="all">All changes</option>
                <option value="added">Added</option>
                <option value="removed">Removed</option>
                <option value="changed">Changed</option>
              </select>
            </label>
            <label className="ops-history-search">
              Record ID
              <input
                type="search"
                maxLength={100}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter record IDs…"
              />
            </label>
            <button
              className="ops-button primary"
              type="submit"
              disabled={!source || !destination || history.expired}
            >
              Compare versions <Icon name="arrowRight" />
            </button>
          </form>
          <p className="ops-note">
            Choose versions and apply the comparison. Missing fields stay distinct from null;
            changed values retain their original provenance.
          </p>
          {comparison && <Compare key={comparison} query={comparison} />}
        </section>
      )}
    </>
  );
}
function VersionSelect({
  id,
  releases,
  value,
  onChange,
}: {
  id: string;
  releases: Release[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
      {!releases.some((release) => release.id === value) && (
        <option value={value}>{value ? value.slice(0, 12) : "Choose a version"}</option>
      )}
      {releases.map((release) => (
        <option key={release.id} value={release.id}>
          {release.id.slice(0, 12)} · {when(release.at)}
        </option>
      ))}
    </select>
  );
}
function Compare({ query }: { query: string }) {
  const result = useResource<Comparison & { offset: number }>();
  const load = result.load;
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    void load((signal) =>
      read(`/release-compare?${query}&offset=${offset}&limit=10`, signal).then((value) => ({
        ...Comparison.parse(value),
        offset,
      })),
    );
  }, [load, query, offset]);
  const value = result.value;
  return (
    <div className="ops-comparison">
      {result.error && (
        <Notice alarm>
          {value ? "Comparison refresh failed; the prior page is shown. " : ""}
          {result.error}
          {result.expired && (
            <>
              {" "}
              <a href="/auth/login?next=%2Fops">Sign in again</a>
            </>
          )}
          <button
            className="ops-quiet"
            type="button"
            disabled={result.loading || result.expired}
            onClick={() =>
              void load((signal) =>
                read(`/release-compare?${query}&offset=${offset}&limit=10`, signal).then(
                  (value) => ({ ...Comparison.parse(value), offset }),
                ),
              )
            }
          >
            Try again
          </button>
        </Notice>
      )}
      {result.loading ? (
        <Loading label="Comparing immutable record snapshots…" />
      ) : (
        value && (
          <>
            <div className="ops-section-heading">
              <p className="ops-note">
                <code>{value.from.id.slice(0, 12)}</code> → <code>{value.to.id.slice(0, 12)}</code>{" "}
                · {value.kind}
              </p>
              <a
                className="ops-quiet"
                href={`${repo}/compare/${value.from.sha}...${value.to.sha}`}
                target="_blank"
                rel="noopener"
              >
                Source comparison <Icon name="arrowUpRight" />
              </a>
            </div>
            <div className="ops-diff-stats">
              {(["added", "removed", "changed"] as const).map((kind) => (
                <div key={kind} className={kind}>
                  <strong>{count(value.counts[kind])}</strong>
                  <span>{kind}</span>
                </div>
              ))}
            </div>
            <p className="ops-note">
              {count(value.matched)} matching record changes · {count(value.total)} total in{" "}
              {value.kind}
            </p>
            {!value.changes.length ? (
              <Empty
                title={value.total ? "No matching record changes" : "These records are identical"}
              >
                Try another record type or adjust the filters. File changes are listed below.
              </Empty>
            ) : (
              <div className="ops-record-diffs">
                {value.changes.map((item) => (
                  <details key={item.id}>
                    <summary>
                      <span className={`ops-change ${item.change}`}>
                        {item.change === "added" ? "+" : item.change === "removed" ? "−" : "~"}{" "}
                        {item.change}
                      </span>
                      <code>{item.id}</code>
                      <span>
                        {item.fields.length} {item.fields.length === 1 ? "field" : "fields"}
                      </span>
                    </summary>
                    <p className="ops-note">Changed paths: {item.fields.join(", ")}</p>
                    <div className="ops-diff-values">
                      <div>
                        <h4>Before</h4>
                        <pre>
                          {item.before ? JSON.stringify(item.before, null, 2) : "Record absent"}
                        </pre>
                      </div>
                      <div>
                        <h4>After</h4>
                        <pre>
                          {item.after ? JSON.stringify(item.after, null, 2) : "Record absent"}
                        </pre>
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            )}
            <div className="ops-history-footer">
              <span className="ops-note">Page {Math.floor(value.offset / 10) + 1}</span>
              <div>
                <button
                  className="ops-button"
                  type="button"
                  disabled={value.offset === 0 || result.expired || !!result.error}
                  onClick={() => setOffset(Math.max(0, value.offset - 10))}
                >
                  Previous
                </button>
                <button
                  className="ops-button"
                  type="button"
                  disabled={value.next === undefined || result.expired || !!result.error}
                  onClick={() => setOffset(value.next ?? offset)}
                >
                  Next
                </button>
              </div>
            </div>
            <details className="ops-file-diff">
              <summary>{value.files.length} changed files across the dataset</summary>
              <div className="ops-table-scroll">
                <table className="ops-table">
                  <thead>
                    <tr>
                      <th scope="col">File</th>
                      <th scope="col">Change</th>
                      <th scope="col">Rows before → after</th>
                      <th scope="col">Size before → after</th>
                    </tr>
                  </thead>
                  <tbody>
                    {value.files.map((file) => (
                      <tr key={file.name}>
                        <th scope="row">{file.name}</th>
                        <td>{file.change}</td>
                        <td>
                          {count(file.before?.rows)} → {count(file.after?.rows)}
                        </td>
                        <td>
                          {bytes(file.before?.bytes)} → {bytes(file.after?.bytes)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )
      )}
    </div>
  );
}
