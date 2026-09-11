/** Refuse an older Worker before changing any public dataset files. */
export async function requireReleaseHistory(base: string): Promise<void> {
  const response = await fetch(`${base}/manifest.json?publication-check=${Date.now()}`, {
    headers: { accept: "application/json", "cache-control": "no-cache" },
    cache: "no-store",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Cannot check publication support: HTTP ${response.status}`);
  const value = (await response.json()) as { publication?: { historyVersion?: number } };
  if (value?.publication?.historyVersion !== 1)
    throw new Error(
      "The Worker does not support release history yet. Deploy the updated Worker; a successful deployment automatically starts a fresh publication. No files were uploaded.",
    );
}
