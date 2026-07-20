import { getApiKey } from '@/api/client'

const API_BASE = '/api/meeting-asr'

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  const apiKey = getApiKey()
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }
  return headers
}

export interface MeetingASRStatus {
  isRunning: boolean
  asrPort: number | null
  diarizePort: number | null
  pid: number | null
  uptime: number | null
  error: string | null
}

export interface MeetingASRConfig {
  dashscopeApiKey?: string
  paraformerWsUrl?: string
  paraformerModel?: string
  paraformerSampleRate?: number
  paraformerFormat?: string
  paraformerLanguageHints?: string
  paraformerSemanticPunctuation?: boolean
  llmApiKey?: string
  llmBaseUrl?: string
  llmModel?: string
  dataDir?: string
  host?: string
  asrPort?: number
  diarizePort?: number
}

export const meetingASRApi = {
  async getStatus(): Promise<MeetingASRStatus> {
    const response = await fetch(`${API_BASE}/status`, {
      headers: getAuthHeaders(),
    })
    return response.json()
  },

  async start(config: MeetingASRConfig = {}): Promise<{ status: string } & MeetingASRStatus> {
    const response = await fetch(`${API_BASE}/start`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(config),
    })
    return response.json()
  },

  async stop(): Promise<{ status: string }> {
    const response = await fetch(`${API_BASE}/stop`, {
      method: 'POST',
      headers: getAuthHeaders(),
    })
    return response.json()
  },

  async updateConfig(config: Partial<MeetingASRConfig>): Promise<{ status: string; message: string }> {
    const response = await fetch(`${API_BASE}/config`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(config),
    })
    return response.json()
  },

  async healthCheck(): Promise<{ status: string; asr_model: string; llm_model: string }> {
    const response = await fetch(`${API_BASE}/healthz`, {
      headers: getAuthHeaders(),
    })
    return response.json()
  },

  // Analysis methods
  async startAnalysis(intervalSeconds: number = 60, customPrompt?: string): Promise<any> {
    const response = await fetch(`${API_BASE}/analysis/start`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ interval_seconds: intervalSeconds, custom_prompt: customPrompt }),
    })
    return response.json()
  },

  async stopAnalysis(): Promise<any> {
    const response = await fetch(`${API_BASE}/analysis/stop`, {
      method: 'POST',
      headers: getAuthHeaders(),
    })
    return response.json()
  },

  async triggerAnalysis(): Promise<any> {
    const response = await fetch(`${API_BASE}/analysis/trigger`, {
      method: 'POST',
      headers: getAuthHeaders(),
    })
    return response.json()
  },

  async getAnalysisStatus(): Promise<any> {
    const response = await fetch(`${API_BASE}/analysis/status`, {
      headers: getAuthHeaders(),
    })
    return response.json()
  },

  async getAnalysisResult(): Promise<any> {
    const response = await fetch(`${API_BASE}/analysis/result`, {
      headers: getAuthHeaders(),
    })
    return response.json()
  },

  async getAnalysisHTML(): Promise<string> {
    const response = await fetch(`${API_BASE}/analysis/html`, {
      headers: getAuthHeaders(),
    })
    return response.text()
  },

  // Note: addTranscript / getTranscript / clearTranscript / getPrompts were
  // removed as dead code (v0.7.6 audit #17). Frontend manages transcript
  // locally via meetingStore; prompts are configured via updateConfig() above.
}
