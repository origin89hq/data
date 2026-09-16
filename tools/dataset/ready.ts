import { Publication } from "@origin89/equipment-schema/releases";

/** Refuse an older Worker before changing any public dataset files. */
export async function requireReleaseHistory(base: string): Promise<void> {
  const response = await fetch(`${base}/manifest.json?publication-check=${Date.now()}`, {
    headers: { accept: "application/json", "cache-control": "no-cache" },
    cache: "no-store",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Cannot check publication support: HTTP ${response.status}`);
  const value = (await response.json()) as { publication?: { historyVersion?: number } };
  // 4 is the Worker that says what it already publishes; 3 kept record snapshots in parts; 2 loaded releases into the store behind the API (#83).
  if (value?.publication?.historyVersion !== 4)
    throw new Error(
      "The Worker cannot say what it already publishes yet. Deploy the updated Worker; a successful deployment automatically starts a fresh publication. No files were uploaded.",
    );
}

/** What the Worker already publishes, asked with this job's token. */
export async function publication(base: string, token: string): Promise<Publication> {
  const response = await fetch(`${base}/publication`, {
    headers: { accept: "application/json", authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new Error(
      `Cannot check what is already published: HTTP ${response.status} ${await response.text()}`,
    );
  const parsed = Publication.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success)
    throw new Error("Cannot check what is already published: the answer is not a publication");
  return parsed.data;
}
