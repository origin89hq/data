import {
  type ActivityEvent,
  ActivityKind,
  ActivityPage,
} from "@origin89/equipment-schema/activity";
import { useEffect, useState } from "react";
import { Icon } from "../icons.tsx";
import { read } from "./api.ts";
import { Empty, Loading, Notice } from "./ui.tsx";
import { useResource } from "./useResource.ts";
import { displayName, when } from "./workspace.ts";

const labels: Record<ActivityEvent["kind"], string> = {
  collection_started: "Collection started",
  collection_completed: "Collection finished",
  collection_failed: "Collection failed",
  approval_waiting: "Awaiting approval",
  approval_decided: "Approval outcome",
  supervision: "Supervisor pass",
  release: "Dataset published",
};
export function Activity({
  compact = false,
  refresh = 0,
  onAll,
  onRelease,
}: {
  compact?: boolean;
  refresh?: number;
  onAll?: () => void;
  onRelease: (id: string) => void;
}) {
  const [kind, setKind] = useState("");
  const [query, setQuery] = useState("");
  const [days, setDays] = useState("");
  const [applied, setApplied] = useState("");
  return (
    <section className="ops-panel">
      <div className="ops-section-heading">
        <div>
          <p className="ops-eyebrow">THE WORK, AS IT HAPPENED</p>
          <h2>{compact ? "Recent activity" : "Activity feed"}</h2>
        </div>
        {compact && (
          <button className="ops-quiet" type="button" onClick={onAll}>
            All activity <Icon name="arrowRight" />
          </button>
        )}
      </div>
      {!compact && (
        <form
          className="ops-toolbar ops-history-filters"
          onSubmit={(event) => {
            event.preventDefault();
            const params = new URLSearchParams();
            if (kind) params.set("kind", kind);
            if (query.trim()) params.set("q", query.trim());
            if (days)
              params.set("since", new Date(Date.now() - Number(days) * 86400000).toISOString());
            setApplied(params.toString());
          }}
        >
          <label>
            Event type
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">All events</option>
              {ActivityKind.options.map((kind) => (
                <option key={kind} value={kind}>
                  {labels[kind]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Time period
            <select value={days} onChange={(e) => setDays(e.target.value)}>
              <option value="">All time</option>
              <option value="1">Last 24 hours</option>
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
            </select>
          </label>
          <label className="ops-history-search">
            Search
            <input
              type="search"
              maxLength={100}
              placeholder="Entity, person, or workflow…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <button className="ops-button" type="submit">
            Apply filters
          </button>
        </form>
      )}
      <ActivityList
        key={applied}
        filter={applied}
        compact={compact}
        refresh={refresh}
        onRelease={onRelease}
      />
    </section>
  );
}
function ActivityList({
  filter,
  compact,
  refresh,
  onRelease,
}: {
  filter: string;
  compact: boolean;
  refresh: number;
  onRelease: (id: string) => void;
}) {
  const resource = useResource<ReturnType<typeof ActivityPage.parse>>();
  const load = resource.load;
  const first = (signal: AbortSignal) =>
    read(`/activity?limit=${compact ? 5 : 25}&${filter}`, signal).then((value) =>
      ActivityPage.parse(value),
    );
  // Changing filters remounts this list; a failed refresh within a filter preserves its snapshot.
  // biome-ignore lint/correctness/useExhaustiveDependencies: A workspace refresh explicitly reloads this resource.
  useEffect(() => {
    void load((signal) =>
      read(`/activity?limit=${compact ? 5 : 25}&${filter}`, signal).then((value) =>
        ActivityPage.parse(value),
      ),
    );
  }, [load, filter, compact, refresh]);
  const value = resource.value;
  return (
    <>
      {resource.error && (
        <Notice alarm>
          {value ? "Refresh failed. Showing the last successful snapshot. " : ""}
          {resource.error}
          {resource.expired && (
            <>
              {" "}
              <a href="/auth/login?next=%2Fops">Sign in again</a>
            </>
          )}
        </Notice>
      )}
      {resource.loading && !value ? (
        <Loading label="Reading activity history…" />
      ) : value && !value.events.length ? (
        <Empty title={value.cursor ? "No matches in this part of history" : "No activity found"}>
          Events are recorded after history is deployed. Adjust the filters or check again after the
          next run.
        </Empty>
      ) : (
        value && (
          <ol className="ops-timeline">
            {value.events.map((event) => (
              <li key={event.id} className={event.kind === "collection_failed" ? "alarm" : ""}>
                <span className="ops-timeline-dot" aria-hidden="true">
                  <Icon name={event.kind === "release" ? "download" : "activity"} />
                </span>
                <div className="ops-timeline-entry">
                  <div className="ops-history-heading">
                    <strong>{labels[event.kind]}</strong>
                    <time dateTime={event.at} title={event.at}>
                      {when(event.at)}
                    </time>
                  </div>
                  <p>{event.summary}</p>
                  <div className="ops-history-meta">
                    <span>{displayName(event.entity)}</span>
                    <span>by {event.actor}</span>
                    {event.run && (
                      <a
                        href={`/archive?list=true&prefix=${encodeURIComponent(`${event.run.kind === "maker" ? "documents" : "sightings"}/${event.entity}/runs/${event.run.id}/`)}`}
                        target="_blank"
                        rel="noopener"
                        title={event.run.instance}
                      >
                        Run files <Icon name="arrowUpRight" />
                      </a>
                    )}
                    {event.release && (
                      <button
                        className="ops-quiet"
                        type="button"
                        onClick={() => onRelease(event.release as string)}
                      >
                        Compare release <Icon name="arrowRight" />
                      </button>
                    )}
                  </div>
                  {!compact && event.run && <code className="ops-note">{event.run.instance}</code>}
                </div>
              </li>
            ))}
          </ol>
        )
      )}
      <div className="ops-history-footer">
        <span className="ops-note">
          {value ? `Recorded history · refreshed ${when(value.at)}` : "Server-recorded history"}
        </span>
        <div>
          {!compact && value?.cursor && (
            <button
              className="ops-button"
              type="button"
              disabled={resource.loading || resource.expired}
              onClick={() =>
                void load(async (signal) => {
                  const next = ActivityPage.parse(
                    await read(
                      `/activity?limit=25&${filter}&cursor=${encodeURIComponent(value.cursor as string)}`,
                      signal,
                    ),
                  );
                  const seen = new Set(value.events.map((event) => event.id));
                  return {
                    ...next,
                    events: [
                      ...value.events,
                      ...next.events.filter((event) => !seen.has(event.id)),
                    ],
                  };
                })
              }
            >
              {resource.loading ? "Loading…" : "Load older events"}
            </button>
          )}
          <button
            className="ops-quiet"
            type="button"
            disabled={resource.loading || resource.expired}
            onClick={() => void load(first)}
          >
            <Icon name="refresh" /> Refresh activity
          </button>
        </div>
      </div>
    </>
  );
}
