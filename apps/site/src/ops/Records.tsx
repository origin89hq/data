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
import { Drawer, Loading, Notice } from "./ui.tsx";
import { useResource } from "./useResource.ts";
import { download } from "./workspace.ts";
export default function Records() {
  const manifest = useResource<Index>();
  const db = useDuckDb(manifest.value);
  const [tier, setTier] = useState<"reviewed" | "all">("reviewed");
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
        <label className="ops-inline-label">
          Include public feeds
          <input
            type="checkbox"
            checked={tier === "all"}
            onChange={(event) => setTier(event.target.checked ? "all" : "reviewed")}
          />
        </label>
      </div>
      {manifest.error ? (
        <Notice alarm>
          {manifest.error}
          <button
            type="button"
            className="ops-button"
            onClick={() => void manifest.load(() => fetchIndex())}
          >
            Try again
          </button>
        </Notice>
      ) : (
        <Explorer index={manifest.value} db={db} tier={tier} onCorrect={setTarget} />
      )}
      <div className="ops-note-card">
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
          <button
            type="button"
            className="ops-button"
            onClick={() => void source.load((signal) => sourceRecord(target, signal))}
          >
            Try again
          </button>
        </Notice>
      )}
      {source.value && (
        <>
          <nav className="ops-detail-tabs" aria-label="Correction editor">
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
                  other fields.
                </p>
                <div className="ops-field-grid">
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
              <label className="ops-editor-label" htmlFor="record-editor">
                Record JSON <span className="ops-mono">{path}</span>
              </label>
              <textarea
                id="record-editor"
                className="ops-code-editor"
                spellCheck={false}
                value={text}
                onChange={(event) => change(event.target.value)}
              />
            </>
          )}
          {review?.ok ? (
            <div className="ops-validation">
              <span className="ops-status nominal">✓ Schema checks passed</span>
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
            <section className="ops-change-review" aria-label="Review changes">
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
          <div className="ops-action-row">
            <button
              type="button"
              className="ops-button primary"
              disabled={!review?.ok || !review.changed.length}
              onClick={() => {
                if (review?.ok) {
                  download(`${target.id}.patch`, review.patch, "text/x-diff");
                  setExported(true);
                }
              }}
            >
              Export correction patch <Icon name="download" />
            </button>
            <button
              type="button"
              className="ops-button"
              onClick={() => {
                setDraft(undefined);
                setExported(false);
              }}
            >
              Reset draft
            </button>
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
