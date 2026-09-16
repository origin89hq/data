/** Refuse an older Worker before changing any public dataset files. */
export async function requireReleaseHistory(base: string): Promise<void> {
  const response = await fetch(`${base}/manifest.json?publication-check=${Date.now()}`, {
    headers: { accept: "application/json", "cache-control": "no-cache" },
    cache: "no-store",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Cannot check publication support: HTTP ${response.status}`);
  const value = (await response.json()) as { publication?: { historyVersion?: number } };
  // 3 is the Worker that keeps record snapshots in parts; 2 loaded releases into the store behind the API (#83).
  if (value?.publication?.historyVersion !== 3)
    throw new Error(
      "The Worker does not keep record snapshots in parts yet. Deploy the updated Worker; a successful deployment automatically starts a fresh publication. No files were uploaded.",
    );
}
