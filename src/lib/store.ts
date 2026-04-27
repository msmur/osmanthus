/**
 * Persistence layer.
 *
 * Uses @tauri-apps/plugin-store which writes a JSON file to the OS app data
 * directory. Falls back to localStorage when running outside Tauri (e.g.
 * during `pnpm run dev` in the browser for UI development).
 */

import type { Book, Settings, TocEntry } from '../types'

// ─── Tauri Store wrapper ─────────────────────────────────────────────────────

// Lazy-loaded so the import doesn't blow up outside Tauri
let _storePromise: Promise<import('@tauri-apps/plugin-store').Store> | null = null

async function getStore() {
  if (!_storePromise) {
    _storePromise = (async () => {
      const { load } = await import('@tauri-apps/plugin-store')
      return load('osmanthus.json')
    })()
  }
  return _storePromise
}

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

// ─── Generic get/set ─────────────────────────────────────────────────────────

async function storeGet<T>(key: string): Promise<T | null> {
  if (isTauri) {
    const store = await getStore()
    return (await store.get<T>(key)) ?? null
  }
  const raw = localStorage.getItem(`osmanthus:${key}`)
  return raw ? (JSON.parse(raw) as T) : null
}

async function storeSet<T>(key: string, value: T): Promise<void> {
  if (isTauri) {
    const store = await getStore()
    await store.set(key, value)
    await store.save() // flush to disk immediately so data survives app restarts and races
  } else {
    localStorage.setItem(`osmanthus:${key}`, JSON.stringify(value))
  }
}

// ─── Books ───────────────────────────────────────────────────────────────────

export async function getBooks(): Promise<Book[]> {
  return (await storeGet<Book[]>('books')) ?? []
}

export async function saveBooks(books: Book[]): Promise<void> {
  await storeSet('books', books)
}

export async function upsertBook(book: Book): Promise<Book[]> {
  const books = await getBooks()
  const idx = books.findIndex((b) => b.id === book.id)
  if (idx >= 0) {
    books[idx] = book
  } else {
    books.unshift(book)
  }
  await saveBooks(books)
  return books
}

export async function updateProgress(bookId: string, wordIndex: number): Promise<void> {
  const books = await getBooks()
  const book = books.find((b) => b.id === bookId)
  if (book) {
    book.wordIndex = wordIndex
    book.lastReadAt = Date.now()
    await saveBooks(books)
  }
}

export async function removeBook(bookId: string): Promise<Book[]> {
  const books = (await getBooks()).filter((b) => b.id !== bookId)
  await saveBooks(books)
  return books
}

export async function markCompleted(bookId: string): Promise<void> {
  const books = await getBooks()
  const book = books.find((b) => b.id === bookId)
  if (book) {
    book.completedAt = Date.now()
    await saveBooks(books)
  }
}

// ─── Settings ────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: Settings = { wpm: 280, fontSize: 1, dupDetection: 'title' }

export async function getSettings(): Promise<Settings> {
  const saved = await storeGet<Settings>('settings')
  return { ...DEFAULT_SETTINGS, ...saved }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await storeSet('settings', settings)
}

// ─── In-memory caches (per session) ──────────────────────────────────────────
// Words and TOC are re-parsed from the epub each session; only word position is persisted.

const wordCache = new Map<string, string[]>()
const tocCache = new Map<string, TocEntry[]>()
const paragraphBreakCache = new Map<string, Set<number>>()

export function cacheWords(bookId: string, words: string[]): void {
  wordCache.set(bookId, words)
}

export function getCachedWords(bookId: string): string[] | null {
  return wordCache.get(bookId) ?? null
}

export function cacheToc(bookId: string, toc: TocEntry[]): void {
  tocCache.set(bookId, toc)
}

export function getCachedToc(bookId: string): TocEntry[] | null {
  return tocCache.get(bookId) ?? null
}

export function cacheParagraphBreaks(bookId: string, breaks: number[]): void {
  paragraphBreakCache.set(bookId, new Set(breaks))
}

export function getCachedParagraphBreaks(bookId: string): Set<number> | null {
  return paragraphBreakCache.get(bookId) ?? null
}
