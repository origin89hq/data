import { useBlocker } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { fetchIndex, type Index } from "../api.ts";
import { Explorer } from "../explorer.tsx";
import { Icon } from "../icons.tsx";
import { useDuckDb } from "../useDuckDb.ts";
import {
  type CorrectionTarget,
  recordPath,
  reviewCorrection,
  sourceRecord,
} from "./corrections.ts";
import { draftObject, editField, fields } from "./fields.ts";
import { Button, Drawer, Loading, Notice } from "./ui.tsx";
import { useResource } from "./useResource.ts";
import { download } from "./workspace.ts";
export default function Records() {
  const manifest = useResource<Index>();
  const db = useDuckDb(manifest.value);
  const [tier, setTier] = useState<"records" | "all">("records");
  const [target, setTarget] = useState<CorrectionTarget>();
  useEffect(() => {
    void manifest.load(() => fetchIndex());
  }, [manifest.load]);
  return (
    <>
      <div className="ops-section-heading">
        <div>
          <p className="ops-eyebrow">SOURCE-BACKED CORRECTIONS</p>
          <h2>Find it. Check it. Make it clearer.</h2>
          <p>Inspect a record to prepare a correction against its authored JSON file.</p>
        </div>
        <label className="flex items-center gap-2.5 text-[13px] whitespace-nowrap max-[640px]:whitespace-normal [&_input]:accent-action">
          Include public feeds
          <input
            type="checkbox"
            checked={tier === "all"}
            onChange={(event) => setTier(event.target.checked ? "all" : "records")}
          />
        </label>
      </div>
      {manifest.error ? (
        <Notice alarm>
          {manifest.error}
          <Button type="button" onClick={() => void manifest.load(() => fetchIndex())}>
            Try again
          </Button>
        </Notice>
      ) : (
        <Explorer index={manifest.value} db={db} tier={tier} onCorrect={setTarget} />
      )}
      <div className="bevel mt-5 flex gap-4 border border-line p-5 text-[13px] leading-[1.7] text-muted">
        <Icon name="evidence" />
        <p>
          Corrections are drafts. The editor checks the record’s schema; the repository checks
          references and evidence before publishing. Nothing is marked reviewed automatically.
        </p>
      </div>
      {target && <Correction target={target} onClose={() => setTarget(undefined)} />}
    </>
  );
}
function Correction({ target, onClose }: { target: CorrectionTarget; onClose: () => void }) {
  const source = useResource<string>();
  const [draft, setDraft] = useState<string>();
  const [editor, setEditor] = useState<"fields" | "json">("fields");
  const [exported, setExported] = useState(false);
  useEffect(() => {
    void source.load((signal) => sourceRecord(target, signal));
  }, [target, source.load]);
  const unsaved = draft !== undefined && draft !== source.value && !exported;
  useBlocker({
    disabled: !unsaved,
    enableBeforeUnload: unsaved,
    shouldBlockFn: () => !window.confirm("Discard this unexported correction?"),
  });
  const text = draft ?? source.value ?? "";
  const review = useMemo(
    () => (source.value ? reviewCorrection(target, source.value, text) : undefined),
    [target, source.value, text],
  );
  const path = recordPath(target);
  const object = useMemo(() => draftObject(text), [text]);
  const before = useMemo(() => draftObject(source.value ?? ""), [source.value]);
  const change = (value: string) => {
    setDraft(value);
    setExported(false);
  };
  const close = () => {
    if (
      draft !== undefined &&
      draft !== source.value &&
      !exported &&
      !window.confirm("Discard this unexported correction?")
    )
      return;
    onClose();
  };
  return (
    <Drawer
      title="Prepare a correction"
      eyebrow={`${target.table.toUpperCase()} / ${target.id}`}
      onClose={close}
    >
      <p className="ops-note">
        The original file stays untouched. Export a patch, apply it in your checkout, and submit it
        for review.
      </p>
      <a
        className="ops-text-link"
        href={`https://github.com/origin89hq/offgrid-equipment/blob/main/${path}`}
        target="_blank"
        rel="noopener"
      >
        Open source in GitHub <Icon name="arrowUpRight" />
      </a>
      {source.loading && <Loading label="Reading the authored source file…" />}
      {source.error && (
        <Notice alarm>
          {source.error}
          <Button
            type="button"
            onClick={() => void source.load((signal) => sourceRecord(target, signal))}
          >
            Try again
          </Button>
        </Notice>
      )}
      {source.value && (
        <>
          <nav
            className="my-6 flex items-center gap-5 border-b border-line max-[640px]:gap-4 [&>button]:border-b-2 [&>button]:border-transparent [&>button]:px-0 [&>button]:py-2.5 [&>button]:text-[13px] [&>button]:text-muted [&>button:hover]:text-fg [&>button[aria-pressed=true]]:border-b-signal [&>button[aria-pressed=true]]:text-fg [&>button]:max-[640px]:min-h-11"
            aria-label="Correction editor"
          >
            <button
              type="button"
              aria-pressed={editor === "fields"}
              onClick={() => setEditor("fields")}
            >
              Edit fields
            </button>
            <button
              type="button"
              aria-pressed={editor === "json"}
              onClick={() => setEditor("json")}
            >
              Record JSON
            </button>
          </nav>
          {editor === "fields" ? (
            object ? (
              <>
                <p className="ops-note">
                  Leave optional fields blank when unknown. Use Record JSON for nested lists and
                  other fields. Review and extraction metadata stay unchanged; corrections are
                  approved through repository review.
                </p>
                <div className="my-6 grid grid-cols-2 gap-5 max-[480px]:grid-cols-1 [&>label]:grid [&>label]:gap-2 [&>label]:text-[13px] [&>label>span]:flex [&>label>span]:items-baseline [&>label>span]:gap-2 [&_small]:font-data [&_small]:text-[12px] [&_small]:leading-[normal] [&_small]:text-faint [&_.wide]:col-span-full [&_input]:bevel-sm [&_input]:w-full [&_input]:min-w-0 [&_input]:border [&_input]:border-line-strong [&_input]:bg-surface-raised [&_input]:px-3 [&_input]:py-2.5 [&_input]:text-fg [&_select]:bevel-sm [&_select]:w-full [&_select]:min-w-0 [&_select]:border [&_select]:border-line-strong [&_select]:bg-surface-raised [&_select]:px-3 [&_select]:py-2.5 [&_select]:text-fg [&_textarea]:bevel-sm [&_textarea]:w-full [&_textarea]:min-w-0 [&_textarea]:resize-y [&_textarea]:border [&_textarea]:border-line-strong [&_textarea]:bg-surface-raised [&_textarea]:px-3 [&_textarea]:py-2.5 [&_textarea]:font-data [&_textarea]:text-[13px] [&_textarea]:leading-[1.7] [&_textarea]:text-fg">
                  {fields[target.table].map((field) => (
                    <label
                      key={field.key}
                      htmlFor={`correction-${field.key}`}
                      className={field.multiline ? "wide" : ""}
                    >
                      <span>
                        {field.label}
                        {field.optional && <small>Optional</small>}
                      </span>
                      {field.options ? (
                        <select
                          id={`correction-${field.key}`}
                          value={String(object[field.key] ?? "")}
                          onChange={(event) =>
                            change(editField(target.table, text, field.key, event.target.value))
                          }
                        >
                          <option value="">
                            {field.optional ? "Not recorded" : "Choose a value"}
                          </option>
                          {field.options.map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                      ) : field.multiline ? (
                        <textarea
                          id={`correction-${field.key}`}
                          rows={3}
                          value={String(object[field.key] ?? "")}
                          onChange={(event) =>
                            change(editField(target.table, text, field.key, event.target.value))
                          }
                        />
                      ) : (
                        <input
                          id={`correction-${field.key}`}
                          type={field.numeric ? "number" : "text"}
                          min={field.numeric ? 1 : undefined}
                          step={field.numeric ? 1 : undefined}
                          value={String(object[field.key] ?? "")}
                          onChange={(event) =>
                            change(editField(target.table, text, field.key, event.target.value))
                          }
                        />
                      )}
                    </label>
                  ))}
                </div>
              </>
            ) : (
              <Notice alarm>Fix the Record JSON before using the field editor.</Notice>
            )
          ) : (
            <>
              <label
                className="mt-5 mb-3 grid gap-2 text-[13px] [&_span]:text-[12px] [&_span]:text-faint [&_span]:wrap-anywhere"
                htmlFor="record-editor"
              >
                Record JSON <span className="ops-mono">{path}</span>
              </label>
              <textarea
                id="record-editor"
                className="bevel-[10px] block min-h-[370px] w-full resize-y border border-line-strong bg-surface-raised p-4 font-data text-[13px] leading-[1.7] text-fg [tab-size:2]"
                spellCheck={false}
                value={text}
                onChange={(event) => change(event.target.value)}
              />
            </>
          )}
          {review?.ok ? (
            <div className="py-4 [&_p]:text-[13px] [&_small]:text-[12px] [&_small]:text-faint">
              <span className="inline-flex items-center gap-1.5 border border-current px-2 py-[3px] font-data text-[12px] leading-[normal] whitespace-nowrap text-nominal">
                ✓ Schema checks passed
              </span>
              <p>
                {review.changed.length
                  ? `Changed fields: ${review.changed.join(", ")}`
                  : "No changes yet."}
              </p>
              <small>Cross-record references and the supporting source still need review.</small>
            </div>
          ) : (
            <Notice alarm>
              <strong>Check these fields</strong>
              <ul>
                {review?.errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </Notice>
          )}
          {review?.ok && review.changed.length > 0 && (
            <section
              className="my-6 [&>h3]:mb-3.5 [&>h3]:text-[20px] [&>div]:grid [&>div]:grid-cols-2 [&>div]:gap-x-[18px] [&>div]:gap-y-2 [&>div]:border-t [&>div]:border-t-line [&>div]:py-3.5 [&>div]:max-[480px]:grid-cols-1 [&_strong]:col-span-full [&_strong]:font-data [&_strong]:text-[13px] [&_strong]:leading-[normal] [&_strong]:font-normal [&_span]:font-data [&_span]:text-[12px] [&_span]:leading-[normal] [&_span]:text-faint [&_pre]:mt-1.5 [&_pre]:mb-0 [&_pre]:max-h-[220px] [&_pre]:overflow-auto [&_pre]:font-data [&_pre]:text-[13px] [&_pre]:leading-[1.65] [&_pre]:whitespace-pre-wrap [&_pre]:wrap-anywhere [&>div>div:last-child]:border-l-2 [&>div>div:last-child]:border-l-signal [&>div>div:last-child]:pl-3"
              aria-label="Review changes"
            >
              <h3>Review your changes</h3>
              {review.changed.map((key) => (
                <div key={key}>
                  <strong>{key}</strong>
                  <div>
                    <span>Before</span>
                    <pre>
                      {before?.[key] === undefined
                        ? "Not recorded"
                        : JSON.stringify(before[key], null, 2)}
                    </pre>
                  </div>
                  <div>
                    <span>Proposed</span>
                    <pre>
                      {object?.[key] === undefined
                        ? "Not recorded"
                        : JSON.stringify(object[key], null, 2)}
                    </pre>
                  </div>
                </div>
              ))}
            </section>
          )}
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              primary
              disabled={!review?.ok || !review.changed.length}
              onClick={() => {
                if (review?.ok) {
                  download(`${target.id}.patch`, review.patch, "text/x-diff");
                  setExported(true);
                }
              }}
            >
              Export correction patch <Icon name="download" />
            </Button>
            <Button
              type="button"
              onClick={() => {
                setDraft(undefined);
                setExported(false);
              }}
            >
              Reset draft
            </Button>
          </div>
          {exported && (
            <Notice>
              Patch exported. Apply it with <code>git apply {target.id}.patch</code>, then run{" "}
              <code>just check</code> before opening a PR.
            </Notice>
          )}
        </>
      )}
    </Drawer>
  );
}
