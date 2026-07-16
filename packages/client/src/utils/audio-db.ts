import type { AudioChunk } from '@/stores/hermes/meeting'

const DB_NAME = 'hermes-meeting-audio'
const DB_VERSION = 1
const STORE_NAME = 'audio-chunks'

let dbInstance: IDBDatabase | null = null

export function openAudioDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance)

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'sessionId' })
      }
    }

    request.onsuccess = (event) => {
      dbInstance = (event.target as IDBOpenDBRequest).result
      resolve(dbInstance)
    }

    request.onerror = (event) => {
      console.error('Failed to open audio IndexedDB:', event)
      reject(request.error)
    }
  })
}

export async function saveAudioChunks(sessionId: string, chunks: AudioChunk[]): Promise<void> {
  try {
    const db = await openAudioDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      store.put({ sessionId, chunks, updatedAt: Date.now() })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (e) {
    console.error('Failed to save audio chunks to IndexedDB:', e)
  }
}

export async function loadAudioChunks(sessionId: string): Promise<AudioChunk[]> {
  try {
    const db = await openAudioDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const request = store.get(sessionId)
      request.onsuccess = () => {
        resolve(request.result?.chunks || [])
      }
      request.onerror = () => reject(request.error)
    })
  } catch (e) {
    console.error('Failed to load audio chunks from IndexedDB:', e)
    return []
  }
}

export async function deleteAudioChunks(sessionId: string): Promise<void> {
  try {
    const db = await openAudioDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      store.delete(sessionId)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (e) {
    console.error('Failed to delete audio chunks from IndexedDB:', e)
  }
}
