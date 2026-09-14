/**
 * URL of the standalone ancient-book chronicle reader.
 *
 * The reader is a separate Vite entry (`recap-book.html` +
 * `recap-book-main.ts`), not a Hermes SPA route: it owns the whole document and
 * has none of the app shell around it. Keeping the URL here means the panel and
 * the reader agree on the query contract.
 */
export function recapBookUrl(meetingId: string, recapId: string, profile?: string): string {
  const query = new URLSearchParams({ meetingId, recapId, ...(profile ? { profile } : {}) })
  return `/recap-book.html?${query.toString()}`
}

export function novelWorkbenchUrl(meetingId: string, jobId: string, profile: string): string {
  return `/recap-book.html?${new URLSearchParams({ workspace: 'novel', meetingId, jobId, profile }).toString()}`
}

/**
 * Highlight manager inside the novel workflow.
 *
 * With a `jobId` it opens the novel workbench on its highlights tab so the user
 * can see how each highlight relates to a scene; without one (no long novel yet)
 * it opens the standalone highlights workspace, which needs no job.
 */
export function highlightWorkbenchUrl(meetingId: string, profile: string, jobId?: string): string {
  const query: Record<string, string> = jobId
    ? { workspace: 'novel', meetingId, jobId, profile, panel: 'highlights' }
    : { workspace: 'highlights', meetingId, profile }
  return `/recap-book.html?${new URLSearchParams(query).toString()}`
}
