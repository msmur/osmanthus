import { useState, useEffect, useRef, useCallback } from 'react'
import type { Book } from '../types'
import { parseEpub } from '../lib/epub'
import { upsertBook, removeBook, cacheWords, cacheToc, cacheParagraphBreaks } from '../lib/store'

interface Props {
  books: Book[]
  onBooksChange: (books: Book[]) => void
  onOpenBook: (book: Book) => void
  onShowAbout: () => void
  theme: 'light' | 'dark'
  onToggleTheme: () => void
}

interface PendingImport {
  existing: Book
  incoming: Book
  words: string[]
  paragraphBreaks: number[]
}

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

function nanoid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

function formatProgress(book: Book): string {
  if (book.totalWords === 0) return '0%'
  return `${Math.round((book.wordIndex / book.totalWords) * 100)}%`
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

async function importBook(filePath: string, buffer: ArrayBuffer) {
  const { title, author, coverDataUrl, words, toc, paragraphBreaks } = await parseEpub(buffer)
  const book: Book = {
    id: nanoid(),
    title,
    author,
    filePath,
    coverDataUrl,
    wordIndex: 0,
    totalWords: words.length,
    addedAt: Date.now(),
    toc,
  }
  return { book, words, paragraphBreaks }
}

function applyCache(id: string, words: string[], toc: Book['toc'], breaks: number[]) {
  cacheWords(id, words)
  cacheToc(id, toc ?? [])
  cacheParagraphBreaks(id, breaks)
}

function currentChapterTitle(book: Book): string | null {
  if (!book.toc || book.toc.length === 0) return null
  let chapter = book.toc[0]
  for (const entry of book.toc) {
    if (entry.wordIndex <= book.wordIndex) chapter = entry
  }
  return chapter.title
}

export function Library({ books, onBooksChange, onOpenBook, onShowAbout, theme, onToggleTheme }: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null)
  const [showLibHelp, setShowLibHelp] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const selectedIdxRef = useRef(0)
  const sortedRef = useRef<Book[]>([])
  const booksRef = useRef(books)
  const showLibHelpRef = useRef(false)
  booksRef.current = books
  showLibHelpRef.current = showLibHelp

  const saveBook = useCallback(async (
    book: Book, words: string[], paragraphBreaks: number[],
  ) => {
    applyCache(book.id, words, book.toc, paragraphBreaks)
    onBooksChange(await upsertBook(book))
  }, [onBooksChange])

  const checkDuplicate = useCallback((incoming: Book) => {
    return booksRef.current.find(
      b => b.title.toLowerCase() === incoming.title.toLowerCase(),
    ) ?? null
  }, [])

  const handleAdd = useCallback(async () => {
    if (!isTauri) {
      fileInputRef.current?.click()
      return
    }
    setLoading(true)
    setError(null)
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Epub', extensions: ['epub'] }],
      })
      if (!selected) return
      const filePath = typeof selected === 'string' ? selected : selected[0]
      if (!filePath) return

      const { readFile } = await import('@tauri-apps/plugin-fs')
      const bytes = await readFile(filePath)
      const buffer = bytes.buffer as ArrayBuffer

      const { book, words, paragraphBreaks } = await importBook(filePath, buffer)
      const existing = checkDuplicate(book)
      if (existing) {
        setPendingImport({ existing, incoming: book, words, paragraphBreaks })
      } else {
        await saveBook(book, words, paragraphBreaks)
      }
    } catch (err) {
      console.error('[Library] handleAdd failed:', err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [saveBook, checkDuplicate])

  const handleFile = useCallback(async (file: File) => {
    setLoading(true)
    setError(null)
    try {
      const buffer = await file.arrayBuffer()
      const { book, words, paragraphBreaks } = await importBook(file.name, buffer)
      const existing = checkDuplicate(book)
      if (existing) {
        setPendingImport({ existing, incoming: book, words, paragraphBreaks })
      } else {
        await saveBook(book, words, paragraphBreaks)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open epub')
    } finally {
      setLoading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [saveBook, checkDuplicate])

  // ── Duplicate resolution handlers ─────────────────────────────────────────

  const handleReplacePathOnly = useCallback(async () => {
    if (!pendingImport) return
    const { existing, incoming, words, paragraphBreaks } = pendingImport
    const updated: Book = {
      ...existing,
      filePath: incoming.filePath,
      coverDataUrl: incoming.coverDataUrl,
      totalWords: incoming.totalWords,
      toc: incoming.toc,
    }
    applyCache(existing.id, words, updated.toc, paragraphBreaks)
    onBooksChange(await upsertBook(updated))
    setPendingImport(null)
  }, [pendingImport, onBooksChange])

  const handleReplaceBook = useCallback(async () => {
    if (!pendingImport) return
    const { existing, incoming, words, paragraphBreaks } = pendingImport
    await removeBook(existing.id)
    applyCache(incoming.id, words, incoming.toc, paragraphBreaks)
    onBooksChange(await upsertBook(incoming))
    setPendingImport(null)
  }, [pendingImport, onBooksChange])

  const handleKeepBoth = useCallback(async () => {
    if (!pendingImport) return
    const { incoming, words, paragraphBreaks } = pendingImport
    applyCache(incoming.id, words, incoming.toc, paragraphBreaks)
    onBooksChange(await upsertBook(incoming))
    setPendingImport(null)
  }, [pendingImport, onBooksChange])

  // ── Other handlers ────────────────────────────────────────────────────────

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    const file = e.dataTransfer.files?.[0]
    if (file?.name.endsWith('.epub')) handleFile(file)
  }

  async function handleRemove(e: React.MouseEvent, bookId: string) {
    e.stopPropagation()
    if (window.confirm('Remove this book from your library?')) {
      onBooksChange(await removeBook(bookId))
    }
  }

  const handleRemoveSelected = useCallback(async () => {
    const book = sortedRef.current[selectedIdxRef.current]
    if (!book) return
    if (window.confirm(`Remove "${book.title}" from your library?`)) {
      onBooksChange(await removeBook(book.id))
      setSelectedIdx(i => Math.max(0, i - 1))
    }
  }, [onBooksChange])

  const sorted = [...books].sort(
    (a, b) => (b.lastReadAt ?? b.addedAt) - (a.lastReadAt ?? a.addedAt),
  )
  sortedRef.current = sorted
  selectedIdxRef.current = selectedIdx

  // Keyboard navigation
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (showLibHelpRef.current) { setShowLibHelp(false); return }
      if (e.target instanceof HTMLInputElement) return
      const len = sortedRef.current.length
      if (e.key === '/') { e.preventDefault(); setShowLibHelp(true); return }
      if (e.code === 'KeyN') { handleAdd(); return }
      if ((e.metaKey || e.ctrlKey) && e.code === 'Backspace') {
        e.preventDefault()
        handleRemoveSelected()
        return
      }
      if (len === 0) return
      if (e.code === 'ArrowDown' || e.code === 'ArrowRight') {
        e.preventDefault()
        setSelectedIdx(i => Math.min(len - 1, i + 1))
      } else if (e.code === 'ArrowUp' || e.code === 'ArrowLeft') {
        e.preventDefault()
        setSelectedIdx(i => Math.max(0, i - 1))
      } else if (e.code === 'Enter') {
        const book = sortedRef.current[selectedIdxRef.current]
        if (book) onOpenBook(book)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onOpenBook, handleAdd, handleRemoveSelected])

  useEffect(() => {
    document.querySelector<HTMLElement>('.book-card-selected')?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  return (
    <div className="library">
      <header className="library-header">
        <img src="/logo.png" alt="" className="app-logo" aria-hidden="true" />
        <h1>Library</h1>
        <div className="library-shortcuts">
          <kbd>N</kbd><span>Add</span>
          <span className="lib-sep">·</span>
          <kbd>↑↓←→</kbd><span>Navigate</span>
          <span className="lib-sep">·</span>
          <kbd>↵</kbd><span>Open</span>
          <span className="lib-sep">·</span>
          <kbd>⌘⌫</kbd><span>Remove</span>
        </div>
        <button
          className="btn-add"
          onClick={handleAdd}
          disabled={loading}
        >
          {loading ? 'Importing…' : '+ Add book'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".epub"
          style={{ display: 'none' }}
          onChange={handleInputChange}
        />
      </header>

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      {sorted.length === 0 && !loading ? (
        <div
          className="empty-drop"
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          onClick={handleAdd}
        >
          <div className="empty-drop-icon">📚</div>
          <p className="empty-drop-title">No books yet</p>
          <p className="empty-drop-sub">Drop an epub here or click to browse</p>
        </div>
      ) : (
        <div
          className="book-grid"
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
        >
          {sorted.map((book, i) => {
            const pct = book.totalWords > 0
              ? (book.wordIndex / book.totalWords) * 100
              : 0
            const status = book.completedAt ? 'finished' : book.wordIndex > 0 ? 'reading' : 'unread'
            return (
              <div key={book.id} className={`book-card${i === selectedIdx ? ' book-card-selected' : ''}`} onClick={() => onOpenBook(book)}>
                <button
                  className="book-remove-btn"
                  title="Remove"
                  onClick={(e) => handleRemove(e, book.id)}
                >
                  ×
                </button>

                <div className="book-cover">
                  {book.coverDataUrl ? (
                    <img src={book.coverDataUrl} alt={book.title} />
                  ) : (
                    <div className="book-cover-placeholder">
                      {(book.title[0] ?? '?').toUpperCase()}
                    </div>
                  )}
                </div>

                <div className="book-meta">
                  <p className="book-title" title={book.title}>{book.title}</p>
                  <p className="book-author">{book.author}</p>
                  <span className={`book-status-badge status-${status}`}>
                    {status === 'finished' ? 'Finished' : status === 'reading' ? 'Reading' : 'Unread'}
                  </span>
                  {currentChapterTitle(book) && (
                    <p className="book-chapter" title={currentChapterTitle(book) ?? ''}>{currentChapterTitle(book)}</p>
                  )}
                  <div className="book-progress-bar">
                    <div className="book-progress-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="book-progress-row">
                    <span className="book-progress-pct">
                      {book.completedAt ? '✓ Done' : formatProgress(book)}
                    </span>
                    {book.lastReadAt && (
                      <span className="book-last-read">
                        {formatDate(book.lastReadAt)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <footer className="library-footer">
        <button className="btn-icon" onClick={() => setShowLibHelp(true)} title="Keyboard shortcuts (/)">?</button>
        <button className="btn-icon" onClick={onToggleTheme} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode (D)`}>{theme === 'dark' ? '☀' : '☾'}</button>
        <button className="btn-icon" onClick={onShowAbout} title="About (I)">ℹ</button>
      </footer>

      {showLibHelp && (
        <div className="help-overlay" onClick={() => setShowLibHelp(false)}>
          <div className="help-card" onClick={e => e.stopPropagation()}>
            <p className="help-title">Library shortcuts</p>
            <button className="help-close" onClick={() => setShowLibHelp(false)}>×</button>
            <div className="help-shortcuts">
              <span className="help-key">N</span>        <span className="help-desc">Add book</span>
              <span className="help-key">↑↓←→</span>    <span className="help-desc">Navigate books</span>
              <span className="help-key">↵</span>         <span className="help-desc">Open book</span>
              <span className="help-key">⌘⌫</span>       <span className="help-desc">Remove book</span>
              <span className="help-key">⌘K</span>        <span className="help-desc">Search books</span>
              <span className="help-key">/</span>          <span className="help-desc">Keyboard shortcuts</span>
              <span className="help-key">D</span>          <span className="help-desc">Toggle dark / light mode</span>
              <span className="help-key">I</span>          <span className="help-desc">About</span>
            </div>
          </div>
        </div>
      )}

      {pendingImport && (
        <div className="dup-overlay" onClick={() => setPendingImport(null)}>
          <div className="dup-card" onClick={e => e.stopPropagation()}>
            <p className="dup-title">"{pendingImport.incoming.title}" already exists</p>
            <p className="dup-sub">How would you like to handle this?</p>
            <div className="dup-actions">
              <button className="dup-btn" onClick={handleReplacePathOnly}>
                <span className="dup-btn-label">Update file path</span>
                <span className="dup-btn-desc">Keep reading progress, position, and settings</span>
              </button>
              <button className="dup-btn dup-btn-danger" onClick={handleReplaceBook}>
                <span className="dup-btn-label">Replace book</span>
                <span className="dup-btn-desc">Remove old entry, add fresh copy</span>
              </button>
              <button className="dup-btn" onClick={handleKeepBoth}>
                <span className="dup-btn-label">Keep both</span>
                <span className="dup-btn-desc">Add as a separate library entry</span>
              </button>
            </div>
            <button className="dup-cancel" onClick={() => setPendingImport(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}
