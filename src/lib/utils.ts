import type { TocEntry } from '../types'

export async function sha256(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export function getChapterAt(toc: TocEntry[], wordIdx: number): string | null {
  if (toc.length === 0) return null
  let title = toc[0].title
  for (const entry of toc) {
    if (entry.wordIndex <= wordIdx) title = entry.title
  }
  return title
}
