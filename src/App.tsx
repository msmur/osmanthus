import { useState, useEffect, useRef, useCallback } from 'react'
import type { Book, View } from './types'
import { getBooks, updateProgress, markCompleted } from './lib/store'
import { Library } from './views/Library'
import { Reader } from './views/Reader'

export default function App() {
  const [books, setBooks] = useState<Book[]>([])
  const [view, setView] = useState<View>({ type: 'library' })
  const [showPalette, setShowPalette] = useState(false)
  const [paletteQuery, setPaletteQuery] = useState('')
  const [paletteSelected, setPaletteSelected] = useState(0)
  const [showAbout, setShowAbout] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('osmanthus:theme')
    if (saved === 'light' || saved === 'dark') return saved
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })
  const paletteInputRef = useRef<HTMLInputElement>(null)
  const paletteResultsRef = useRef<HTMLDivElement>(null)
  const booksRef = useRef(books)
  booksRef.current = books

  useEffect(() => {
    getBooks().then(setBooks)
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('osmanthus:theme', theme)
  }, [theme])

  const toggleTheme = useCallback(() => {
    setTheme(t => t === 'dark' ? 'light' : 'dark')
  }, [])

  useEffect(() => {
    if ('__TAURI_INTERNALS__' in window) {
      import('@tauri-apps/api/app').then(({ getVersion }) => getVersion().then(setAppVersion))
    }
  }, [])

  function openExternal(url: string) {
    if ('__TAURI_INTERNALS__' in window) {
      import('@tauri-apps/plugin-opener').then(({ openUrl }) => openUrl(url))
    } else {
      window.open(url, '_blank', 'noopener,noreferrer')
    }
  }

  const openBook = useCallback((book: Book) => {
    setShowPalette(false)
    setView({ type: 'reader', bookId: book.id })
  }, [])

  const handleOpenBook = useCallback((book: Book) => {
    setView({ type: 'reader', bookId: book.id })
  }, [])

  const handleBack = useCallback(() => {
    setView({ type: 'library' })
  }, [])

  const handleProgressUpdate = useCallback((bookId: string, wordIndex: number, totalWords: number) => {
    setBooks((prev) =>
      prev.map((b) =>
        b.id === bookId ? { ...b, wordIndex, totalWords, lastReadAt: Date.now() } : b,
      ),
    )
    updateProgress(bookId, wordIndex)
  }, [])

  const handleComplete = useCallback((bookId: string) => {
    setBooks((prev) =>
      prev.map((b) => b.id === bookId ? { ...b, completedAt: Date.now() } : b),
    )
    markCompleted(bookId)
  }, [])

  // ── Global shortcuts: Cmd+K (palette), F (fullscreen), I (about) ───────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setShowPalette((p) => {
          if (!p) { setPaletteQuery(''); setPaletteSelected(0) }
          return !p
        })
        return
      }
      if (e.target instanceof HTMLInputElement) return
      if (e.code === 'KeyF' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        if ('__TAURI_INTERNALS__' in window) {
          import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
            const win = getCurrentWindow()
            win.isFullscreen().then((fs) => win.setFullscreen(!fs))
          })
        }
      }
      if (e.code === 'KeyD' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        toggleTheme()
      }
      if (e.code === 'KeyI' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        setShowAbout(s => !s)
      }
      if (e.key === 'Escape') {
        setShowAbout(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleTheme])

  // Focus the search input when palette opens
  useEffect(() => {
    if (showPalette) setTimeout(() => paletteInputRef.current?.focus(), 0)
  }, [showPalette])

  const paletteBooks = books
    .filter((b) => paletteQuery.trim() === '' || b.title.toLowerCase().includes(paletteQuery.toLowerCase()))
    .slice(0, 8)

  const clampedSelected = Math.min(paletteSelected, Math.max(0, paletteBooks.length - 1))

  useEffect(() => {
    if (!paletteResultsRef.current) return
    const el = paletteResultsRef.current.querySelector<HTMLElement>('.palette-item-active')
    el?.scrollIntoView({ block: 'nearest' })
  }, [clampedSelected, showPalette])

  function handlePaletteKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setPaletteSelected((s) => Math.min(paletteBooks.length - 1, s + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setPaletteSelected((s) => Math.max(0, s - 1))
    } else if (e.key === 'Enter') {
      const book = paletteBooks[clampedSelected]
      if (book) openBook(book)
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      setShowPalette(false)
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  let currentView: React.ReactNode
  if (view.type === 'reader') {
    const book = books.find((b) => b.id === view.bookId)
    if (!book) {
      setView({ type: 'library' })
      return null
    }
    currentView = (
      <Reader
        book={book}
        onBack={handleBack}
        onProgressUpdate={handleProgressUpdate}
        onComplete={handleComplete}
        onShowAbout={() => setShowAbout(true)}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
    )
  } else {
    currentView = (
      <Library
        books={books}
        onBooksChange={setBooks}
        onOpenBook={handleOpenBook}
        onShowAbout={() => setShowAbout(true)}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
    )
  }

  return (
    <>
      {currentView}

      {showPalette && (
        <div className="palette-overlay" onClick={() => setShowPalette(false)}>
          <div className="palette-card" onClick={(e) => e.stopPropagation()}>
            <input
              ref={paletteInputRef}
              className="palette-input"
              placeholder="Search books…"
              value={paletteQuery}
              onChange={(e) => { setPaletteQuery(e.target.value); setPaletteSelected(0) }}
              onKeyDown={handlePaletteKey}
            />
            <div className="palette-results" ref={paletteResultsRef}>
              {paletteBooks.length === 0 ? (
                <p className="palette-empty">No books match "{paletteQuery}"</p>
              ) : (
                paletteBooks.map((b, i) => {
                  const pct = b.totalWords > 0 ? Math.round((b.wordIndex / b.totalWords) * 100) : 0
                  const status = b.completedAt ? 'finished' : b.wordIndex > 0 ? 'reading' : 'unread'
                  return (
                    <button
                      key={b.id}
                      className={`palette-item${i === clampedSelected ? ' palette-item-active' : ''}`}
                      onClick={() => openBook(b)}
                      onMouseEnter={() => setPaletteSelected(i)}
                    >
                      <div className="palette-item-row">
                        <span className="palette-item-title">{b.title}</span>
                        <div className="palette-item-right">
                          <span className={`book-status-badge status-${status}`}>
                            {status === 'finished' ? 'Finished' : status === 'reading' ? 'Reading' : 'Unread'}
                          </span>
                          <span className={`palette-item-pct status-${status}`}>
                            {b.completedAt ? '✓' : `${pct}%`}
                          </span>
                        </div>
                      </div>
                      <span className="palette-item-meta">{b.author}</span>
                    </button>
                  )
                })
              )}
            </div>
          </div>
        </div>
      )}

      {showAbout && (
        <div className="about-overlay" onClick={() => setShowAbout(false)}>
          <div className="about-card" onClick={e => e.stopPropagation()}>
            <button className="about-close" onClick={() => setShowAbout(false)}>×</button>
            <div className="about-header">
              <span className="about-app-name">Osmanthus</span>
              {appVersion && <span className="about-version">v{appVersion}</span>}
            </div>
            <p className="about-tagline">RSVP speed-reader for epub files</p>
            <div className="about-author">
              <span className="about-author-label">Made by</span>
              <span className="about-author-name">Maahir Ur Rahman Mohamed Shibly</span>
            </div>
            <div className="about-links">
              <button className="about-link" onClick={() => openExternal('https://github.com/msmur/osmanthus')}>
                GitHub →
              </button>
              <button className="about-link" onClick={() => openExternal('https://msmur.github.io/osmanthus')}>
                Docs & Site →
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
