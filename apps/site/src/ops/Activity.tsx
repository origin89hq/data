import {
  type ActivityEvent,
  ActivityKind,
  ActivityPage,
} from "@origin89/equipment-schema/activity";
import { useEffect, useState } from "react";
import { Icon } from "../icons.tsx";
import { read } from "./api.ts";
import { Button, Empty, Loading, Notice, Panel, TextButton } from "./ui.tsx";
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
    <Panel>
      <div className="ops-section-heading">
        <div>
          <p className="ops-eyebrow">THE WORK, AS IT HAPPENED</p>
          <h2>{compact ? "Recent activity" : "Activity feed"}</h2>
        </div>
        {compact && (
          <TextButton type="button" onClick={onAll}>
            All activity <Icon name="arrowRight" />
          </TextButton>
        )}
      </div>
      {!compact && (
        <form
          className="flex items-center gap-3 max-[640px]:flex-wrap [&>label]:max-[640px]:basis-full [&_select]:bevel-sm [&_select]:min-h-10 [&_select]:border [&_select]:border-line-strong [&_select]:bg-surface-raised [&_select]:px-3 [&_select]:py-0 [&_select]:text-[13px] [&_select]:text-fg [@media(pointer:coarse)]:[&_select]:min-h-11 [&_select]:max-[640px]:w-full my-6 flex flex-wrap items-end gap-3.5 [&>label]:grid [&>label]:gap-2 [&>label]:text-[13px] [&>label]:text-muted [&>label]:max-[800px]:flex-[1_1_140px] [&_select]:bevel-sm [&_select]:max-w-full [&_select]:min-h-[42px] [&_select]:border [&_select]:border-line-strong [&_select]:bg-surface-raised [&_select]:px-3 [&_select]:py-2.5 [&_select]:font-[inherit] [&_select]:text-fg [&_input]:bevel-sm [&_input]:max-w-full [&_input]:min-h-[42px] [&_input]:border [&_input]:border-line-strong [&_input]:bg-surface-raised [&_input]:px-3 [&_input]:py-2.5 [&_input]:font-[inherit] [&_input]:text-fg [@media(pointer:coarse)]:[&_select]:min-h-11 [@media(pointer:coarse)]:[&_input]:min-h-11 [&_button]:max-[800px]:w-full"
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
          <label className="min-w-[180px] flex-1">
            Search
            <input
              type="search"
              maxLength={100}
              placeholder="Entity, person, or workflow…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <Button type="submit">Apply filters</Button>
        </form>
      )}
      <ActivityList
        key={applied}
        filter={applied}
        compact={compact}
        refresh={refresh}
        onRelease={onRelease}
      />
    </Panel>
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
          <ol className="mt-6 mb-0 list-none p-0 [&>li]:relative [&>li]:flex [&>li]:gap-[18px] [&>li]:pb-7 [&>li]:max-[800px]:gap-3 [&>li:not(:last-child)]:before:absolute [&>li:not(:last-child)]:before:top-8 [&>li:not(:last-child)]:before:bottom-0 [&>li:not(:last-child)]:before:left-[17px] [&>li:not(:last-child)]:before:border-l [&>li:not(:last-child)]:before:border-line [&>li:not(:last-child)]:before:content-['']">
            {value.events.map((event) => (
              <li key={event.id} className={event.kind === "collection_failed" ? "alarm" : ""}>
                <span
                  className="grid h-9 flex-[0_0_36px] place-items-center rounded-full border border-line-strong bg-surface text-signal [&_svg]:size-4 group-[.alarm]/row:border-2 group-[.alarm]/row:border-alarm group-[.alarm]/row:text-alarm"
                  aria-hidden="true"
                >
                  <Icon name={event.kind === "release" ? "download" : "activity"} />
                </span>
                <div className="min-w-0 flex-1 [&>p]:my-2 [&>p]:text-sm [&>p]:leading-[1.6] [&>p]:wrap-anywhere [&>p]:text-muted [&>code]:mt-2.5 [&>code]:block [&>code]:font-data [&>code]:text-[12px] [&>code]:leading-[normal] [&>code]:wrap-anywhere [&>code]:text-faint">
                  <div className="flex flex-wrap justify-between gap-x-5 gap-y-2 [&_strong]:text-[15px] [&_strong]:font-semibold [&_time]:font-data [&_time]:text-[12px] [&_time]:leading-[normal] [&_time]:text-faint">
                    <strong>{labels[event.kind]}</strong>
                    <time dateTime={event.at} title={event.at}>
                      {when(event.at)}
                    </time>
                  </div>
                  <p>{event.summary}</p>
                  <div className="flex flex-wrap items-center gap-x-[18px] gap-y-2 text-[12px] text-faint [&_a]:inline-flex [&_a]:items-center [&_a]:gap-1 [&_a]:text-link [&_svg]:size-[13px]">
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
                      <TextButton type="button" onClick={() => onRelease(event.release as string)}>
                        Compare release <Icon name="arrowRight" />
                      </TextButton>
                    )}
                  </div>
                  {!compact && event.run && <code className="ops-note">{event.run.instance}</code>}
                </div>
              </li>
            ))}
          </ol>
        )
      )}
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line pt-[18px] [&>div]:flex [&>div]:flex-wrap [&>div]:items-center [&>div]:gap-3.5">
        <span className="ops-note">
          {value ? `Recorded history · refreshed ${when(value.at)}` : "Server-recorded history"}
        </span>
        <div>
          {!compact && value?.cursor && (
            <Button
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
            </Button>
          )}
          <TextButton
            type="button"
            disabled={resource.loading || resource.expired}
            onClick={() => void load(first)}
          >
            <Icon name="refresh" /> Refresh activity
          </TextButton>
        </div>
      </div>
    </>
  );
}
