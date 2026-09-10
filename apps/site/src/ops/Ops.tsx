import { useEffect, useState } from "react";
import {
  type Loaded,
  type MakerState,
  type Pipeline,
  pipeline,
  type RunStatus,
  type SellerState,
  type SupervisionReport,
  supervision,
  whoami,
} from "./api.ts";

/**
 * What the spider is doing, for members of the working group.
 *
 * Read-only. Approving a download and starting a crawl stay with `just` for now; the routes they
 * call take this page's session as well, so buttons can come later without a new way in.
 */
export function Ops() {
  const [login, setLogin] = useState<Loaded<string>>({ state: "loading" });
  const [report, setReport] = useState<Loaded<SupervisionReport | null>>({ state: "loading" });
  const [runs, setRuns] = useState<Loaded<Pipeline>>({ state: "idle" });

  useEffect(() => {
    void settle(whoami(), setLogin);
    void settle(supervision(), setReport);
  }, []);

  return (
    <>
      <header className="ops-header">
        <a className="ops-identity" href="/" aria-label="Origin89 Data home">
          {/* The blue mark's wordmark is near black, for paper. The white one is for the dark ground. */}
          <picture>
            <source
              srcSet="/assets/logos/origin89-horizontal-white.svg"
              media="(prefers-color-scheme: dark)"
            />
            <img
              src="/assets/logos/origin89-horizontal-blue.svg"
              width="130"
              height="22"
              alt="Origin89"
            />
          </picture>
          <span className="ops-word">data</span>
          <span className="ops-word ops-section">runs</span>
        </a>
        <div className="ops-who">
          {login.state === "ready" ? (
            <>
              <span>
                Signed in as <strong>{login.value}</strong>
              </span>
              <form method="post" action="/auth/logout">
                <button type="submit" className="ops-button quiet">
                  Sign out
                </button>
              </form>
            </>
          ) : login.state === "failed" ? (
            <a className="ops-button" href="/auth/login?next=%2Fops">
              Sign in again
            </a>
          ) : null}
        </div>
      </header>

      <main className="ops-main">
        <Supervisor report={report} />

        <section className="ops-panel" aria-labelledby="runs-title">
          <div className="ops-panel-head">
            <h2 id="runs-title">Current runs</h2>
            <button
              type="button"
              className="ops-button"
              disabled={runs.state === "loading"}
              onClick={() => {
                setRuns({ state: "loading" });
                void settle(pipeline(), setRuns);
              }}
            >
              {runs.state === "ready" ? "Load again" : "Load"}
            </button>
          </div>
          <p className="ops-note">
            Reads every seller's and maker's current run out of the archive, and asks the Workflows
            service about each. It takes a few seconds, so it waits to be asked.
            {runs.state === "ready" ? ` Loaded ${time(runs.value.at)}.` : null}
          </p>
          {runs.state === "loading" ? <p className="ops-note">Loading…</p> : null}
          {runs.state === "failed" ? <p className="ops-error">{runs.error}</p> : null}
          {runs.state === "ready" ? (
            <>
              <Makers makers={runs.value.makers} runs={runs.value.runs} />
              <Sellers sellers={runs.value.sellers} runs={runs.value.runs} />
            </>
          ) : null}
        </section>
      </main>
    </>
  );
}

/** Put a promise's outcome into a panel's state, whichever way it goes. */
async function settle<T>(promise: Promise<T>, set: (loaded: Loaded<T>) => void): Promise<void> {
  try {
    set({ state: "ready", value: await promise });
  } catch (error) {
    set({ state: "failed", error: error instanceof Error ? error.message : String(error) });
  }
}

const time = (at: Date) => `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** A figure the archive has, or a dash where it has none. Never a zero standing in for unknown. */
const known = (value: number | string | undefined) =>
  value === undefined ? <span className="ops-absent">—</span> : value;

function Supervisor({ report }: { report: Loaded<SupervisionReport | null> }) {
  return (
    <section className="ops-panel" aria-labelledby="supervisor-title">
      <div className="ops-panel-head">
        <h2 id="supervisor-title">Supervisor</h2>
        {report.state === "ready" && report.value ? (
          <span className="ops-note">last pass {time(new Date(report.value.at))}</span>
        ) : null}
      </div>
      {report.state === "loading" ? <p className="ops-note">Loading…</p> : null}
      {report.state === "failed" ? <p className="ops-error">{report.error}</p> : null}
      {report.state === "ready" && !report.value ? (
        <p className="ops-note">The supervisor has not reported yet.</p>
      ) : null}
      {report.state === "ready" && report.value ? (
        <div className="ops-columns">
          <Listing title="Concerns" empty="Nothing looks wrong." alarm>
            {report.value.concerns.map((concern) => (
              <li key={concern}>{concern}</li>
            ))}
          </Listing>
          <Listing title="Started" empty="Nothing was ready to start.">
            {report.value.started.map((started) => (
              <li key={`${started.what}:${started.entity}`}>
                <strong>{started.what}</strong> {started.entity}
                <small>{started.detail}</small>
              </li>
            ))}
          </Listing>
          <Listing title="Blocked" empty="Nothing is waiting.">
            {report.value.blocked.map((blocked) => (
              <li key={blocked.entity}>
                <strong>{blocked.entity}</strong>
                <small>{blocked.waitingOn}</small>
              </li>
            ))}
          </Listing>
        </div>
      ) : null}
    </section>
  );
}

function Listing({
  title,
  empty,
  alarm = false,
  children,
}: {
  title: string;
  empty: string;
  alarm?: boolean;
  children: React.ReactNode[];
}) {
  return (
    <div className="ops-listing">
      <h3>
        {title}{" "}
        <span className={alarm && children.length ? "ops-count alarm" : "ops-count"}>
          {children.length}
        </span>
      </h3>
      {children.length ? <ul>{children}</ul> : <p className="ops-note">{empty}</p>}
    </div>
  );
}

/** The mark beside a workflow's state. Drawn, because a text glyph falls back to whatever font has it. */
const MARKS = {
  alarm: <path d="M3.5 3.5l5 5M8.5 3.5l-5 5" />,
  nominal: <path d="M2.5 6.5l2.5 2.5 4.5-5" />,
  info: <circle cx="6" cy="6" r="2.5" fill="currentColor" stroke="none" />,
  faint: <path d="M4.3 4.6a1.8 1.8 0 1 1 2.5 1.6c-.5.2-.8.6-.8 1.1v.3M6 9.6v.1" />,
} as const;

/** A workflow's state in words, with a mark that does not depend on colour alone. */
function Workflow({ run }: { run: RunStatus | undefined }) {
  if (!run) return <span className="ops-absent">no instance recorded</span>;
  const tone: keyof typeof MARKS =
    run.status === "errored" || run.status === "terminated"
      ? "alarm"
      : run.status === "complete"
        ? "nominal"
        : run.status === "unknown"
          ? "faint"
          : "info";
  return (
    <span className={`ops-status ${tone}`} title={run.instance}>
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {MARKS[tone]}
      </svg>{" "}
      {run.status}
      {run.error ? <small>{run.error}</small> : null}
    </span>
  );
}

function Makers({ makers, runs }: { makers: MakerState[]; runs: Map<string, RunStatus> }) {
  return (
    <div className="table-scroll">
      <table>
        <caption>Makers, {makers.length}</caption>
        <thead>
          <tr>
            <th scope="col">Maker</th>
            <th scope="col">Run</th>
            <th scope="col">Waiting on</th>
            <th scope="col">Approved by</th>
            <th scope="col">Offered · fetched · converted · read</th>
            <th scope="col">Workflow</th>
          </tr>
        </thead>
        <tbody>
          {makers.map((maker) => (
            <tr key={maker.maker}>
              <th scope="row">{maker.maker}</th>
              <td className="ops-figures">{known(maker.date)}</td>
              <td>{maker.waitingOn}</td>
              <td>{known(maker.approvedBy)}</td>
              <td className="ops-figures">
                {known(maker.offered)} · {known(maker.fetched)} · {known(maker.converted)} ·{" "}
                {known(maker.read)}
              </td>
              <td>
                <Workflow run={runs.get(`maker:${maker.maker}`)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Sellers({ sellers, runs }: { sellers: SellerState[]; runs: Map<string, RunStatus> }) {
  return (
    <div className="table-scroll">
      <table>
        <caption>Sellers, {sellers.length}</caption>
        <thead>
          <tr>
            <th scope="col">Seller</th>
            <th scope="col">Run</th>
            <th scope="col">Sightings</th>
            <th scope="col">Classified</th>
            <th scope="col">Workflow</th>
          </tr>
        </thead>
        <tbody>
          {sellers.map((seller) => (
            <tr key={seller.seller}>
              <th scope="row">{seller.seller}</th>
              <td className="ops-figures">{known(seller.date)}</td>
              <td className="ops-figures">{known(seller.sightings)}</td>
              <td className="ops-figures">
                {seller.classified ? (
                  <span
                    className={seller.classified.written < seller.classified.parts ? "warning" : ""}
                  >
                    {seller.classified.written} of {seller.classified.parts} parts
                  </span>
                ) : (
                  known(undefined)
                )}
              </td>
              <td>
                <Workflow run={runs.get(`seller:${seller.seller}`)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
