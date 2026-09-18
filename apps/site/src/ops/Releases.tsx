import {
  Comparison,
  RecordKind,
  type Release,
  ReleasePage,
  sourceComparison,
} from "@origin89/equipment-schema/releases";
import { useEffect, useState } from "react";
import { Icon } from "../icons.tsx";
import { read } from "./api.ts";
import {
  Button,
  Empty,
  EYEBROW,
  Loading,
  NOTE,
  Notice,
  Panel,
  SECTION_HEADING,
  Table,
  Tag,
  TextButton,
  TextLink,
} from "./ui.tsx";
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
      <Panel>
        <div className={SECTION_HEADING}>
          <div>
            <p className={EYEBROW}>PUBLISHED DATA / VERSION HISTORY</p>
            <h2>Every publication has a fingerprint.</h2>
          </div>
          <TextButton
            type="button"
            disabled={history.loading || history.expired}
            onClick={() =>
              void load((signal) =>
                read("/releases", signal).then((value) => ReleasePage.parse(value)),
              )
            }
          >
            <Icon name="refresh" /> Refresh releases
          </TextButton>
        </div>
        <p className={NOTE}>
          Every publication is recorded, including rollbacks. Identical content shares a content
          hash. History begins with the first publication after this feature is deployed.
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
          <div className="my-6 max-h-[480px] overflow-auto [&_article]:grid [&_article]:grid-cols-[minmax(200px,1fr)_1fr_auto] [&_article]:items-center [&_article]:gap-5 [&_article]:border-t [&_article]:border-line [&_article]:px-4 [&_article]:py-5 [&_article]:max-[800px]:grid-cols-1 [&_article]:max-[800px]:gap-4 [&_article]:max-[800px]:px-0 [&_article.selected]:bg-surface-raised [&_article.selected]:shadow-[inset_2px_0_var(--color-signal)] [&_article>button]:max-[800px]:justify-self-start [&_h3]:mt-2.5 [&_h3]:mb-1.5 [&_h3]:text-[20px] [&_time]:font-data [&_time]:text-[12px] [&_time]:leading-[normal] [&_time]:text-faint">
            {releases.map((release, i) => (
              <article key={release.id} className={destination === release.id ? "selected" : ""}>
                <div>
                  <Tag>{i === 0 ? "LATEST PUBLICATION" : "DATASET PUBLICATION"}</Tag>
                  <h3>
                    <code title={release.id}>{release.id.slice(0, 12)}</code>
                  </h3>
                  <time dateTime={release.at}>{when(release.at)}</time>
                </div>
                <div className="flex flex-wrap items-center gap-x-[18px] gap-y-2 text-[12px] text-faint [&_a]:inline-flex [&_a]:items-center [&_a]:gap-1 [&_a]:text-link [&_svg]:size-[13px]">
                  <span>{Object.keys(release.files).length} files</span>
                  <code title={release.content}>Content {release.content.slice(0, 12)}</code>
                  <a href={`${repo}/commit/${release.sha}`} target="_blank" rel="noopener">
                    Commit {release.sha.slice(0, 7)} <Icon name="arrowUpRight" />
                  </a>
                  <a href={`${repo}/actions/runs/${release.job}`} target="_blank" rel="noopener">
                    Publication job <Icon name="arrowUpRight" />
                  </a>
                </div>
                <Button
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
                </Button>
              </article>
            ))}
          </div>
        )}
        {history.value?.cursor && (
          <Button
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
          </Button>
        )}
      </Panel>
      {(releases.length >= 2 || selectedMissing) && (
        <Panel>
          <div className={SECTION_HEADING}>
            <div>
              <p className={EYEBROW}>UNDERSTAND WHAT CHANGED</p>
              <h2 id="ops-compare" className="scroll-mt-24">
                Compare two versions.
              </h2>
            </div>
          </div>
          <form
            className="my-6 flex flex-wrap items-end gap-3.5 [&>label]:grid [&>label]:gap-2 [&>label]:text-[13px] [&>label]:text-muted [&>label]:max-[800px]:flex-[1_1_140px] [&_select]:bevel-sm [&_select]:max-w-full [&_select]:min-h-[42px] [&_select]:border [&_select]:border-line-strong [&_select]:bg-surface-raised [&_select]:px-3 [&_select]:py-2.5 [&_select]:font-[inherit] [&_select]:text-fg [&_input]:bevel-sm [&_input]:max-w-full [&_input]:min-h-[42px] [&_input]:border [&_input]:border-line-strong [&_input]:bg-surface-raised [&_input]:px-3 [&_input]:py-2.5 [&_input]:font-[inherit] [&_input]:text-fg [@media(pointer:coarse)]:[&_select]:min-h-11 [@media(pointer:coarse)]:[&_input]:min-h-11 [&_button]:max-[800px]:w-full mt-6"
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
            <label className="min-w-[180px] flex-1">
              Record ID
              <input
                type="search"
                maxLength={100}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter record IDs…"
              />
            </label>
            <Button primary type="submit" disabled={!source || !destination || history.expired}>
              Compare versions <Icon name="arrowRight" />
            </Button>
          </form>
          <p className={NOTE}>
            Choose versions and apply the comparison. Missing fields stay distinct from null;
            changed values retain their original provenance.
          </p>
          {comparison && <Compare key={comparison} query={comparison} />}
        </Panel>
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
    <div className="mt-6">
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
          <TextButton
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
          </TextButton>
        </Notice>
      )}
      {result.loading ? (
        <Loading label="Comparing immutable record snapshots…" />
      ) : (
        value && (
          <>
            <div className={SECTION_HEADING}>
              <p className="mt-2.5 text-[13px] leading-[1.65] text-muted">
                <code>{value.from.id.slice(0, 12)}</code> → <code>{value.to.id.slice(0, 12)}</code>{" "}
                · {value.kind}
              </p>
              <TextLink
                href={sourceComparison(value.from.sha, value.to.sha)}
                target="_blank"
                rel="noopener"
              >
                Source comparison <Icon name="arrowUpRight" />
              </TextLink>
            </div>
            <div className="my-[22px] grid grid-cols-3 gap-px border border-line bg-line [&>div]:grid [&>div]:gap-2 [&>div]:bg-surface [&>div]:p-5 [&>div]:max-[800px]:p-4 [&_strong]:text-[32px] [&_strong]:font-semibold [&_strong]:tracking-[-0.035em] [&_strong]:tabular-nums [&_span]:font-data [&_span]:text-[12px] [&_span]:leading-[normal] [&_span]:tracking-[0.05em] [&_span]:text-faint [&_span]:uppercase">
              {(["added", "removed", "changed"] as const).map((kind) => (
                <div key={kind} className={kind}>
                  <strong>{count(value.counts[kind])}</strong>
                  <span>{kind}</span>
                </div>
              ))}
            </div>
            <p className={NOTE}>
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
              <div className="[&_details]:border-t [&_details]:border-t-line [&_details]:py-3.5 [&_summary]:flex [&_summary]:cursor-pointer [&_summary]:items-center [&_summary]:gap-3 [&_summary]:text-[13px] [&_summary_code]:flex-1 [&_summary_code]:font-data [&_summary_code]:wrap-anywhere [&_summary]:after:font-data [&_summary]:after:text-[18px] [&_summary]:after:leading-[normal] [&_summary]:after:text-faint [&_summary]:after:content-['+'] [&_details[open]_summary]:after:content-['\2212']">
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
                    <p className={NOTE}>Changed paths: {item.fields.join(", ")}</p>
                    <div className="my-4 grid grid-cols-2 gap-4 max-[800px]:grid-cols-1 [&>div]:min-w-0 [&_h4]:my-2.5 [&_h4]:text-[13px] [&_h4]:font-medium [&_h4]:text-muted [&_pre]:bevel-[10px] [&_pre]:max-h-[420px] [&_pre]:overflow-auto [&_pre]:border [&_pre]:border-line [&_pre]:bg-surface [&_pre]:p-3.5 [&_pre]:font-data [&_pre]:text-[12px] [&_pre]:leading-[1.6]">
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
            <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line pt-[18px] [&>div]:flex [&>div]:flex-wrap [&>div]:items-center [&>div]:gap-3.5">
              <span className={NOTE}>Page {Math.floor(value.offset / 10) + 1}</span>
              <div>
                <Button
                  type="button"
                  disabled={value.offset === 0 || result.expired || !!result.error}
                  onClick={() => setOffset(Math.max(0, value.offset - 10))}
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  disabled={value.next === undefined || result.expired || !!result.error}
                  onClick={() => setOffset(value.next ?? offset)}
                >
                  Next
                </Button>
              </div>
            </div>
            <details className="mt-[26px] [&>summary]:cursor-pointer [&>summary]:px-0 [&>summary]:py-3.5 [&>summary]:text-sm">
              <summary>{value.files.length} changed files across the dataset</summary>
              <Table>
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
              </Table>
            </details>
          </>
        )
      )}
    </div>
  );
}
