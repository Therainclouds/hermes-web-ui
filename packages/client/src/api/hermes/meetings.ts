import { request, requestText } from '../client'
import type { RecapEntry, RecapImage, RecapImageKind, RecapOptions } from '../../../../shared/trpg-recap'
const path = (id: string) => `/api/meeting-storage/${encodeURIComponent(id)}/recaps`
export const listRecaps = (id: string) => request<{ recaps: RecapEntry[] }>(path(id))
export const deleteRecap = (id: string, recapId: string) => request(`${path(id)}/${encodeURIComponent(recapId)}`, { method: 'DELETE' })
export const prepareRecap = (input: RecapOptions & { meetingId: string; sentences: { text: string; speaker?: string }[] }) => request<{ requestId: string }>('/api/plugins/trpg/recap', { method: 'POST', body: JSON.stringify(input) })
/** Attach or replace one chronicle illustration (cover or chapter content). */
export const saveRecapImage = (id: string, recapId: string, input: { kind: RecapImageKind; chapterId?: string; mime: RecapImage['mime']; dataBase64: string; model?: string; prompt?: string }) =>
  request<{ image: RecapImage }>(`${path(id)}/${encodeURIComponent(recapId)}/images/${input.kind}`, { method: 'PUT', body: JSON.stringify(input) })
/** Fetch the saved Markdown chronicle; `download` adds the attachment disposition. */
export const getRecapMarkdown = (id: string, recapId: string, download = false) =>
  requestText(`${path(id)}/${encodeURIComponent(recapId)}/markdown${download ? '?download=1' : ''}`)

import type { NovelJob } from '../../../../shared/trpg-novel'
const novelPath = (id: string) => `/api/meeting-storage/${encodeURIComponent(id)}/novel-jobs`
export const listNovelJobs = (id: string) => request<{ jobs: NovelJob[] }>(novelPath(id))
export const startNovelJob = (id: string, requestId: string) => request<{ job: NovelJob }>(novelPath(id), { method: 'POST', body: JSON.stringify({ requestId }) })
export const resumeNovelJob = (id: string, jobId: string) => request<{ job: NovelJob }>(`${novelPath(id)}/${encodeURIComponent(jobId)}/resume`, { method: 'POST' })
export const cancelNovelJob = (id: string, jobId: string) => request<{ job: NovelJob }>(`${novelPath(id)}/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' })
