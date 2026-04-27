export interface TocEntry {
  title: string
  wordIndex: number
}

export interface Book {
  id: string
  title: string
  author: string
  /** Absolute path to the .epub file on disk */
  filePath: string
  coverDataUrl?: string
  /** Current word index (reading position) */
  wordIndex: number
  totalWords: number
  addedAt: number
  lastReadAt?: number
  completedAt?: number
  toc?: TocEntry[]
}

export interface Settings {
  wpm: number
  fontSize?: number
  rampUp?: boolean
}

export type View =
  | { type: 'library' }
  | { type: 'reader'; bookId: string }
