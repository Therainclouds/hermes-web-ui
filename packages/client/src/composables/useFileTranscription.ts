import { onUnmounted, ref } from 'vue'
import {
  meetingASRApi,
  type FileTranscriptionJob,
  type FileTranscriptionOptions,
  type FileTranscriptionResult,
} from '@/utils/meeting-asr-api'

export interface UseFileTranscriptionDeps {
  /**
   * Called once the backend job reaches `done`. The caller merges the
   * sentences into the active meeting (replace when the transcript is empty,
   * otherwise timestamp-match and fill speaker labels).
   */
  onComplete: (result: FileTranscriptionResult, options: FileTranscriptionOptions) => void | Promise<void>
  /** Called on every failure (upload rejected, backend error, network). */
  onError?: (message: string) => void
}

const POLL_INTERVAL_MS = 1500
/** Hard ceiling so a stuck job cannot poll forever. */
const MAX_POLL_MS = 60 * 60 * 1000

/**
 * Whole-file transcription driver shared by the two entry points:
 *  - 「拆分人声」 on a finished recording (re-diarize the whole audio), and
 *  - the 「直接音频转录」 tab of the create-meeting dialog.
 *
 * Uploads the audio once, then polls the backend job until it settles.
 * Progress is reported as a 0–1 fraction so both call sites can render a
 * single progress bar.
 */
export function useFileTranscription(deps: UseFileTranscriptionDeps) {
  const isTranscribing = ref(false)
  const progress = ref(0)
  const phase = ref('')
  const errorMessage = ref('')

  let cancelled = false

  function stop() {
    cancelled = true
    isTranscribing.value = false
    phase.value = ''
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async function pollUntilDone(jobId: string): Promise<FileTranscriptionJob> {
    const deadline = Date.now() + MAX_POLL_MS
    for (;;) {
      if (cancelled) throw new Error('cancelled')
      const job = await meetingASRApi.getFileTranscriptionStatus(jobId)
      progress.value = Math.max(progress.value, Math.min(0.98, job.progress || 0))
      phase.value = job.message || job.status
      if (job.status === 'done') return job
      if (job.status === 'error') throw new Error(job.error || 'transcription failed')
      if (Date.now() > deadline) throw new Error('transcription timed out')
      await sleep(POLL_INTERVAL_MS)
    }
  }

  async function transcribe(file: Blob, options: FileTranscriptionOptions): Promise<boolean> {
    if (isTranscribing.value) return false
    cancelled = false
    isTranscribing.value = true
    progress.value = 0
    phase.value = 'uploading'
    errorMessage.value = ''

    try {
      const started = await meetingASRApi.startFileTranscription(file, options)
      phase.value = 'transcribing'
      const job = await pollUntilDone(started.job_id)
      if (!job.result) throw new Error('transcription returned no result')
      progress.value = 1
      await deps.onComplete(job.result, options)
      return true
    } catch (err: any) {
      const message = err?.message === 'cancelled'
        ? ''
        : (err?.message || String(err) || 'transcription failed')
      if (message) {
        errorMessage.value = message
        deps.onError?.(message)
      }
      return false
    } finally {
      isTranscribing.value = false
      phase.value = ''
    }
  }

  onUnmounted(() => {
    cancelled = true
  })

  return { isTranscribing, progress, phase, errorMessage, transcribe, stop }
}
