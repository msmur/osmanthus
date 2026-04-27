import { useState, useEffect, useRef, useCallback } from 'react'
import type { Book, TocEntry } from '../types'
import { splitAtOrp, wordDelay } from '../lib/rsvp'
import { parseEpub } from '../lib/epub'
import {
  getCachedWords, cacheWords, getCachedToc, cacheToc,
  getCachedParagraphBreaks, cacheParagraphBreaks,
  updateProgress, getSettings, saveSettings,
} from '../lib/store'

interface Props {
  book: Book
  onBack: () => void
  onProgressUpdate: (bookId: string, wordIndex: number, totalWords: number) => void
  onComplete: (bookId: string) => void
  onShowAbout: () => void
  theme: 'light' | 'dark'
  onToggleTheme: () => void
}

const CONTEXT_BEFORE = 3
const CONTEXT_AFTER = 5
const AUTOSAVE_INTERVAL = 25

function getParagraphsAroundIndex(words: string[], breaks: Set<number>, currentIdx: number) {
  const sorted = Array.from(breaks).sort((a, b) => a - b)
  let pi = sorted.length
  let paraEnd = words.length - 1
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] >= currentIdx) { paraEnd = sorted[i]; pi = i; break }
  }
  const paraStart = pi > 0 ? sorted[pi - 1] + 1 : 0
  const currentWords = words.slice(paraStart, paraEnd + 1)
  const currentHighlight = currentIdx - paraStart
  let prev1: string | null = null
  if (pi > 0) {
    const pe = sorted[pi - 1]
    const ps = pi > 1 ? sorted[pi - 2] + 1 : 0
    prev1 = words.slice(ps, pe + 1).join(' ')
  }
  let prev2: string | null = null
  if (pi > 1) {
    const pe = sorted[pi - 2]
    const ps = pi > 2 ? sorted[pi - 3] + 1 : 0
    prev2 = words.slice(ps, pe + 1).join(' ')
  }
  return { prev2, prev1, currentWords, currentHighlight }
}

export function Reader({ book, onBack, onProgressUpdate, onComplete, onShowAbout, theme, onToggleTheme }: Props) {
  const [words, setWords] = useState<string[]>([])
  const [toc, setToc] = useState<TocEntry[]>([])
  const [idx, setIdx] = useState(book.wordIndex)
  const [playing, setPlaying] = useState(false)
  const [wpm, setWpm] = useState(280)
  const [wpmLoaded, setWpmLoaded] = useState(false)
  const [showToc, setShowToc] = useState(false)
  const [showContext, setShowContext] = useState(true)
  const [showControls, setShowControls] = useState(true)
  const [posHistory, setPosHistory] = useState<number[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [flashedKey, setFlashedKey] = useState<string | null>(null)
  const [jumpInput, setJumpInput] = useState('')
  const [zenMode, setZenMode] = useState(false)
  const [wpmInputValue, setWpmInputValue] = useState(String(wpm))
  const [paragraphBreaks, setParagraphBreaks] = useState<Set<number>>(new Set())
  const [isFinished, setIsFinished] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [fontSize, setFontSize] = useState(1)
  const [fontSizeInputValue, setFontSizeInputValue] = useState('1.0')
  const [showParagraphPopup, setShowParagraphPopup] = useState(false)
  const [showTimeline, setShowTimeline] = useState(false)
  const [showHeader, setShowHeader] = useState(true)
  const [tocFocusIdx, setTocFocusIdx] = useState(0)
  const [rampUp, setRampUp] = useState(false)

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const idxRef = useRef(idx)
  const playingRef = useRef(playing)
  const wpmRef = useRef(wpm)
  const wordsRef = useRef(words)
  const paragraphBreaksRef = useRef(paragraphBreaks)
  const lastSavedRef = useRef(idx)
  const onProgressUpdateRef = useRef(onProgressUpdate)
  const onBackRef = useRef(onBack)
  const onCompleteRef = useRef(onComplete)
  const wasPlayingRef = useRef(false)
  const scrubStartIdxRef = useRef(0)
  const showHelpRef = useRef(showHelp)
  const showParagraphPopupRef = useRef(showParagraphPopup)
  const showTimelineRef = useRef(showTimeline)
  const wasPlayingBeforePopupRef = useRef(false)
  const zenModeRef = useRef(zenMode)
  const showControlsRef = useRef(showControls)
  const showHeaderRef = useRef(showHeader)
  const showTocRef = useRef(showToc)
  const fontSizeRef = useRef(fontSize)
  const isFullscreenRef = useRef(false)
  const tocRef = useRef(toc)
  const tocFocusIdxRef = useRef(tocFocusIdx)
  const tocListRef = useRef<HTMLDivElement>(null)
  const jumpInputRef = useRef<HTMLInputElement>(null)
  const wpmInputRef = useRef<HTMLInputElement>(null)
  const fontInputRef = useRef<HTMLInputElement>(null)
  const rampUpRef = useRef(rampUp)
  const rampStartRef = useRef<number | null>(null)

  // Keep refs in sync with latest props/state each render
  idxRef.current = idx
  playingRef.current = playing
  wpmRef.current = wpm
  wordsRef.current = words
  paragraphBreaksRef.current = paragraphBreaks
  onProgressUpdateRef.current = onProgressUpdate
  onBackRef.current = onBack
  onCompleteRef.current = onComplete
  showHelpRef.current = showHelp
  showParagraphPopupRef.current = showParagraphPopup
  showTimelineRef.current = showTimeline
  zenModeRef.current = zenMode
  showControlsRef.current = showControls
  showHeaderRef.current = showHeader
  showTocRef.current = showToc
  fontSizeRef.current = fontSize
  tocRef.current = toc
  tocFocusIdxRef.current = tocFocusIdx
  rampUpRef.current = rampUp

  // ── Load/save WPM ──────────────────────────────────────────────────────────
  useEffect(() => {
    getSettings().then((s) => {
      setWpm(s.wpm)
      const fs = s.fontSize ?? 1
      setFontSize(fs)
      setFontSizeInputValue(fs.toFixed(1))
      setRampUp(s.rampUp ?? false)
      setWpmLoaded(true)
    })
  }, [])

  useEffect(() => {
    if (wpmLoaded) saveSettings({ wpm, fontSize: fontSizeRef.current, rampUp: rampUpRef.current })
  }, [wpm, wpmLoaded])

  useEffect(() => {
    if (wpmLoaded) saveSettings({ wpm: wpmRef.current, fontSize, rampUp: rampUpRef.current })
  }, [fontSize, wpmLoaded])

  useEffect(() => {
    if (wpmLoaded) saveSettings({ wpm: wpmRef.current, fontSize: fontSizeRef.current, rampUp })
  }, [rampUp, wpmLoaded])

  useEffect(() => { setWpmInputValue(String(wpm)) }, [wpm])
  useEffect(() => { setFontSizeInputValue(fontSize.toFixed(1)) }, [fontSize])

  // ── Load words + TOC ───────────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      const cached = getCachedWords(book.id)
      if (cached) {
        setWords(cached)
        setToc(getCachedToc(book.id) ?? [])
        setParagraphBreaks(getCachedParagraphBreaks(book.id) ?? new Set())
        setIdx(book.wordIndex)
        return
      }
      setLoading(true)
      try {
        if ('__TAURI_INTERNALS__' in window) {
          const { readFile } = await import('@tauri-apps/plugin-fs')
          const bytes = await readFile(book.filePath)
          const buffer = bytes.buffer as ArrayBuffer
          const { words: parsed, toc: parsedToc, paragraphBreaks: parsedBreaks } = await parseEpub(buffer)
          cacheWords(book.id, parsed)
          cacheToc(book.id, parsedToc)
          cacheParagraphBreaks(book.id, parsedBreaks)
          setWords(parsed)
          setToc(parsedToc)
          setParagraphBreaks(new Set(parsedBreaks))
          setIdx(book.wordIndex)
        } else {
          setError('Words not cached. Please re-open the book from the library.')
        }
      } catch (e) {
        console.error('[Reader] load failed:', e)
        setError(
          e instanceof Error
            ? `Could not load "${book.filePath}": ${e.message}`
            : 'Failed to load book.',
        )
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [book.id, book.filePath, book.wordIndex])

  // ── Auto-pause on window blur ──────────────────────────────────────────────
  useEffect(() => {
    const onBlur = () => setPlaying(false)
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [])

  // ── Track native fullscreen via resize (ESC exits fullscreen before next keydown) ─
  useEffect(() => {
    const update = () => {
      isFullscreenRef.current =
        document.fullscreenElement !== null ||
        window.innerHeight >= window.screen.height - 5
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  // ── TOC keyboard focus ─────────────────────────────────────────────────────
  useEffect(() => {
    if (showToc) {
      let ci = 0
      for (let i = 0; i < tocRef.current.length; i++) {
        if (tocRef.current[i].wordIndex <= idxRef.current) ci = i
      }
      setTocFocusIdx(ci)
    }
  }, [showToc])

  useEffect(() => {
    if (!showToc || !tocListRef.current) return
    const el = tocListRef.current.querySelector<HTMLElement>('.toc-item-focused')
    el?.scrollIntoView({ block: 'nearest' })
  }, [tocFocusIdx, showToc])

  // ── Playback engine ────────────────────────────────────────────────────────
  const scheduleNext = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    const currentWords = wordsRef.current
    const currentIdx = idxRef.current

    if (!playingRef.current || currentIdx >= currentWords.length - 1) {
      const atEnd = currentIdx >= currentWords.length - 1 && currentWords.length > 0
      playingRef.current = false
      setPlaying(false)
      if (atEnd) {
        setIsFinished(true)
        onCompleteRef.current(book.id)
        updateProgress(book.id, currentWords.length - 1)
        onProgressUpdateRef.current(book.id, currentWords.length - 1, currentWords.length)
      }
      return
    }

    const targetWpm = wpmRef.current
    let effectiveWpm = targetWpm
    if (rampUpRef.current && targetWpm > 500 && rampStartRef.current !== null) {
      const elapsed = Date.now() - rampStartRef.current
      const t = Math.min(1, elapsed / 5000)
      effectiveWpm = Math.round(targetWpm * (0.5 + 0.5 * t))
    }
    const delay = wordDelay(currentWords[currentIdx] ?? '', effectiveWpm, paragraphBreaksRef.current.has(currentIdx))
    timerRef.current = setTimeout(() => {
      const next = idxRef.current + 1
      setIdx(next)
      idxRef.current = next

      if (next - lastSavedRef.current >= AUTOSAVE_INTERVAL) {
        lastSavedRef.current = next
        updateProgress(book.id, next)
        onProgressUpdateRef.current(book.id, next, wordsRef.current.length)
      }

      scheduleNext()
    }, delay)
  }, [book.id])

  useEffect(() => {
    if (playing && words.length > 0) {
      rampStartRef.current = Date.now()
      scheduleNext()
    } else {
      rampStartRef.current = null
      if (timerRef.current) clearTimeout(timerRef.current)
    }
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [playing, words.length, scheduleNext])

  // Save progress on unmount
  useEffect(() => {
    return () => {
      updateProgress(book.id, idxRef.current)
      onProgressUpdateRef.current(book.id, idxRef.current, wordsRef.current.length)
    }
  }, [book.id])

  // ── Navigation ─────────────────────────────────────────────────────────────

  const seek = useCallback((delta: number) => {
    const next = Math.max(0, Math.min(wordsRef.current.length - 1, idxRef.current + delta))
    setIdx(next)
    idxRef.current = next
  }, [])

  const navigate = useCallback((target: number) => {
    const next = Math.max(0, Math.min(wordsRef.current.length - 1, target))
    setIdx(next)
    idxRef.current = next
  }, [])

  const flash = useCallback((key: string) => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    setFlashedKey(key)
    flashTimerRef.current = setTimeout(() => setFlashedKey(null), 150)
  }, [])

  const handleUndo = useCallback(() => {
    setPosHistory((h) => {
      if (h.length === 0) return h
      const prev = h[h.length - 1]
      setIdx(prev)
      idxRef.current = prev
      return h.slice(0, -1)
    })
  }, [])

  function handleJump() {
    const target = parseInt(jumpInput, 10)
    if (!isNaN(target)) {
      const prev = idxRef.current
      navigate(target)
      setPosHistory((h) => [...h.slice(-19), prev])
    }
    setJumpInput('')
    jumpInputRef.current?.blur()
  }

  function commitWpm() {
    const v = parseInt(wpmInputValue, 10)
    const clamped = isNaN(v) ? wpm : Math.max(60, Math.min(900, v))
    setWpm(clamped)
    setWpmInputValue(String(clamped))
  }

  function commitFontSize() {
    const v = parseFloat(fontSizeInputValue)
    const clamped = isNaN(v) ? fontSize : Math.max(0.5, Math.min(2.5, v))
    const rounded = Math.round(clamped * 10) / 10
    setFontSize(rounded)
    setFontSizeInputValue(rounded.toFixed(1))
  }

  const closeParagraphPopup = useCallback(() => {
    setShowParagraphPopup(false)
    if (wasPlayingBeforePopupRef.current) setPlaying(true)
  }, [])

  const toggleParagraphPopup = useCallback(() => {
    if (showParagraphPopupRef.current) {
      setShowParagraphPopup(false)
      if (wasPlayingBeforePopupRef.current) setPlaying(true)
    } else {
      wasPlayingBeforePopupRef.current = playingRef.current
      if (playingRef.current) setPlaying(false)
      setShowParagraphPopup(true)
    }
  }, [])

  const exitZenMode = useCallback(() => {
    setZenMode(false)
    setShowContext(true)
    setShowControls(true)
    setShowHeader(true)
  }, [])

  // Scrubber: pause while dragging, push history on release
  function handleScrubStart() {
    scrubStartIdxRef.current = idxRef.current
    wasPlayingRef.current = playingRef.current
    if (playingRef.current) setPlaying(false)
  }

  function handleScrub(e: React.ChangeEvent<HTMLInputElement>) {
    const next = parseInt(e.target.value, 10)
    setIdx(next)
    idxRef.current = next
  }

  function handleScrubEnd() {
    setPosHistory((h) => [...h.slice(-19), scrubStartIdxRef.current])
    if (wasPlayingRef.current) setPlaying(true)
  }

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (showHelpRef.current) { setShowHelp(false); return }
      if (showParagraphPopupRef.current) {
        if (e.code === 'Escape' || e.code === 'KeyP') {
          setShowParagraphPopup(false)
          if (wasPlayingBeforePopupRef.current) setPlaying(true)
        }
        return
      }
      if (e.target instanceof HTMLInputElement) return
      if (e.key === '/') { setShowHelp(true); return }
      // TOC keyboard navigation
      if (showTocRef.current) {
        if (e.code === 'ArrowDown') { e.preventDefault(); setTocFocusIdx(i => Math.min(tocRef.current.length - 1, i + 1)); return }
        if (e.code === 'ArrowUp') { e.preventDefault(); setTocFocusIdx(i => Math.max(0, i - 1)); return }
        if (e.code === 'Enter') {
          const entry = tocRef.current[tocFocusIdxRef.current]
          if (entry) {
            // Capture before navigate() mutates idxRef.current synchronously
            const prevIdx = idxRef.current
            navigate(entry.wordIndex)
            setPosHistory(h => [...h.slice(-19), prevIdx])
            setShowToc(false)
          }
          return
        }
      }
      if (e.code === 'Space') { e.preventDefault(); setPlaying((p) => !p); flash('play') }
      if (e.code === 'ArrowRight' && e.shiftKey && !e.metaKey) {
        e.preventDefault()
        const p = idxRef.current; navigate(p + 50); setPosHistory(h => [...h.slice(-19), p]); flash('ff')
      }
      if (e.code === 'ArrowLeft' && e.shiftKey && !e.metaKey) {
        e.preventDefault()
        const p = idxRef.current; navigate(p - 50); setPosHistory(h => [...h.slice(-19), p]); flash('rew')
      }
      if (e.code === 'ArrowRight' && !e.shiftKey) {
        const p = idxRef.current; seek(10); setPosHistory(h => [...h.slice(-19), p]); flash('fwd')
      }
      if (e.code === 'ArrowLeft' && !e.shiftKey) {
        const p = idxRef.current; seek(-10); setPosHistory(h => [...h.slice(-19), p]); flash('back')
      }
      if (e.code === 'ArrowUp' && !e.ctrlKey && !e.metaKey) { setWpm((w) => Math.min(900, w + 20)); flash('wpm-plus') }
      if (e.code === 'ArrowDown' && !e.ctrlKey && !e.metaKey) { setWpm((w) => Math.max(60, w - 20)); flash('wpm-minus') }
      if (e.code === 'ArrowRight' && e.shiftKey && e.metaKey) {
        e.preventDefault()
        let target = wordsRef.current.length - 1
        for (const b of paragraphBreaksRef.current) {
          if (b + 1 > idxRef.current && b + 1 < target) target = b + 1
        }
        navigate(target)
      }
      if (e.code === 'ArrowLeft' && e.shiftKey && e.metaKey) {
        e.preventDefault()
        let target = 0
        for (const b of paragraphBreaksRef.current) {
          if (b + 1 < idxRef.current && b + 1 > target) target = b + 1
        }
        navigate(target)
      }
      if (e.code === 'Escape') {
        if (isFullscreenRef.current) {
          isFullscreenRef.current = false
          if ('__TAURI_INTERNALS__' in window) {
            import('@tauri-apps/api/window').then(({ getCurrentWindow }) =>
              getCurrentWindow().setFullscreen(false)
            )
          }
          return
        }
      }
      if (e.code === 'KeyL' && !e.metaKey && !e.ctrlKey) { setPlaying(false); onBackRef.current() }
      if (e.code === 'KeyT') setShowToc((s) => !s)
      if (e.code === 'KeyZ' && !e.metaKey && !e.ctrlKey) {
        if (zenModeRef.current) {
          exitZenMode()
        } else {
          setZenMode(true)
          setShowContext(false); setShowToc(false); setShowControls(false); setShowHeader(false); setShowTimeline(false)
        }
      }
      if (e.code === 'KeyN') setShowHeader((s) => !s)
      if (e.code === 'KeyC') setShowContext((s) => !s)
      if (e.code === 'KeyX') setShowControls((s) => !s)
      if (e.code === 'BracketLeft')  setFontSize((f) => Math.max(0.5, Math.round((f - 0.1) * 10) / 10))
      if (e.code === 'BracketRight') setFontSize((f) => Math.min(2.5, Math.round((f + 0.1) * 10) / 10))
      if (e.code === 'KeyP') {
        if (showParagraphPopupRef.current) {
          setShowParagraphPopup(false)
          if (wasPlayingBeforePopupRef.current) setPlaying(true)
        } else {
          wasPlayingBeforePopupRef.current = playingRef.current
          if (playingRef.current) setPlaying(false)
          setShowParagraphPopup(true)
        }
      }
      if (e.code === 'KeyG') { e.preventDefault(); jumpInputRef.current?.select(); jumpInputRef.current?.focus() }
      if (e.code === 'KeyW') { e.preventDefault(); wpmInputRef.current?.select(); wpmInputRef.current?.focus() }
      if (e.code === 'KeyS') { e.preventDefault(); fontInputRef.current?.select(); fontInputRef.current?.focus() }
      if (e.code === 'KeyH') setShowTimeline((s) => !s)
      if (e.code === 'KeyR' && !e.metaKey && !e.ctrlKey) { setRampUp((s) => !s); flash('ramp') }
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ') { e.preventDefault(); handleUndo(); setShowTimeline(false); flash('undo') }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [seek, navigate, handleUndo, flash])

  // ── Derived display values ─────────────────────────────────────────────────
  const currentWord = words[idx] ?? ''
  const displayWord = currentWord.length <= 2 && idx + 1 < words.length
    ? currentWord + ' ' + (words[idx + 1] ?? '')
    : currentWord
  const [before, orp, after] = splitAtOrp(displayWord)

  const contextStart = Math.max(0, idx - CONTEXT_BEFORE)
  const contextEnd = Math.min(words.length - 1, idx + CONTEXT_AFTER)
  const contextWords = words.slice(contextStart, contextEnd + 1)
  const contextHighlightIdx = idx - contextStart

  const pct = words.length > 0 ? Math.round((idx / words.length) * 100) : 0
  const paragraphContext = showParagraphPopup && words.length > 0
    ? getParagraphsAroundIndex(words, paragraphBreaks, idx)
    : null

  let currentChapterIdx = -1
  for (let i = 0; i < toc.length; i++) {
    if (toc[i].wordIndex <= idx) currentChapterIdx = i
  }

  function chapterAt(wordIdx: number) {
    let title = ''
    for (const entry of toc) {
      if (entry.wordIndex <= wordIdx) title = entry.title
    }
    return title
  }

  // Timeline entries: current position first, then undo history newest → oldest
  const timelineEntries = showTimeline
    ? [
        { wordIdx: idx, isCurrent: true },
        ...[...posHistory].reverse().map((wordIdx) => ({ wordIdx, isCurrent: false })),
      ]
    : []

  // ── Render ─────────────────────────────────────────────────────────────────
  if (loading) {
    return <div className="reader-loading"><p>Parsing epub…</p></div>
  }

  if (error) {
    return (
      <div className="reader-error">
        <p>{error}</p>
        <button onClick={onBack}>← Back to library</button>
      </div>
    )
  }

  if (isFinished) {
    return (
      <div className="reader-finished">
        <div className="finished-card">
          <div className="finished-check">✓</div>
          <h2 className="finished-title">{book.title}</h2>
          <p className="finished-author">{book.author}</p>
          <div className="finished-actions">
            <button className="btn-add" onClick={onBack}>← Library</button>
            <button className="finished-reread" onClick={() => { navigate(0); setIsFinished(false) }}>Read again</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`reader${zenMode ? ' zen' : ''}`} style={{ '--font-scale': fontSize } as React.CSSProperties}>
      <header className={`reader-header${showHeader ? '' : ' header-hidden'}`}>
        <button className="btn-icon" onClick={onBack} title="Back to library (Esc)">←</button>
        <img src="/logo.png" alt="" className="app-logo" aria-hidden="true" />
        <div className="reader-book-info">
          <span className="reader-title">{book.title}</span>
          {toc.length > 0 && currentChapterIdx >= 0 && (
            <span className="reader-chapter">{toc[currentChapterIdx].title}</span>
          )}
        </div>
        <div className="reader-wpm-control">
          <button
            className={flashedKey === 'wpm-minus' ? 'btn-flash' : ''}
            onClick={() => { setWpm((w) => Math.max(60, w - 20)); flash('wpm-minus') }}
            title="Speed −20 wpm (↓)"
          >−</button>
          <input
            ref={wpmInputRef}
            type="number"
            className="wpm-input"
            value={wpmInputValue}
            onChange={(e) => setWpmInputValue(e.target.value)}
            onBlur={commitWpm}
            onKeyDown={(e) => { if (e.key === 'Enter') { commitWpm(); e.currentTarget.blur() } }}
            title="Words per minute (W to focus)"
          />
          <span>wpm</span>
          <button
            className={flashedKey === 'wpm-plus' ? 'btn-flash' : ''}
            onClick={() => { setWpm((w) => Math.min(900, w + 20)); flash('wpm-plus') }}
            title="Speed +20 wpm (↑)"
          >+</button>
        </div>
        <div className="reader-font-control">
          <button
            onClick={() => setFontSize((f) => Math.max(0.5, Math.round((f - 0.1) * 10) / 10))}
            title="Font size − ([)"
          >−</button>
          <input
            ref={fontInputRef}
            type="number"
            className="font-input"
            step="0.1"
            value={fontSizeInputValue}
            onChange={(e) => setFontSizeInputValue(e.target.value)}
            onBlur={commitFontSize}
            onKeyDown={(e) => { if (e.key === 'Enter') { commitFontSize(); e.currentTarget.blur() } }}
            title="Font scale (S to focus)"
          />
          <span>×</span>
          <button
            onClick={() => setFontSize((f) => Math.min(2.5, Math.round((f + 0.1) * 10) / 10))}
            title="Font size + (])"
          >+</button>
        </div>
      </header>

      <div className="reader-body">
        {showToc && toc.length > 0 && (
          <aside className="toc-sidebar">
            <div className="toc-sidebar-heading">Contents</div>
            <div className="toc-list" ref={tocListRef}>
              {toc.map((entry, i) => (
                <button
                  key={i}
                  className={`toc-item${i === currentChapterIdx ? ' toc-item-current' : ''}${i === tocFocusIdx ? ' toc-item-focused' : ''}`}
                  onClick={() => {
                    // Capture before navigate() mutates idxRef.current synchronously
                    const prevIdx = idxRef.current
                    navigate(entry.wordIndex)
                    setPosHistory((h) => [...h.slice(-19), prevIdx])
                    setShowToc(false)
                  }}
                >
                  {entry.title}
                </button>
              ))}
            </div>
          </aside>
        )}

        <main className="reader-stage" onClick={zenMode ? exitZenMode : undefined}>
          {/* rsvp-focal contains only the word so translateY(-50%) centers the word itself, not word+context */}
          <div className="rsvp-focal">
            <div className="rsvp-word">
              <span className="rsvp-left"><span className="rsvp-before">{before}</span><span className="rsvp-orp">{orp}</span></span><span className="rsvp-right"><span className="rsvp-after">{after}</span></span>
            </div>
          </div>
          {/* context is fixed below the word; top offset = 50vh + half word height + orp guide clearance */}
          <p className={`reader-context${showContext ? '' : ' context-hidden'}`}>
            {contextWords.map((w, i) => (
              <span
                key={i}
                className={
                  i === contextHighlightIdx ? 'ctx-current'
                  : i < contextHighlightIdx ? 'ctx-past'
                  : 'ctx-future'
                }
              >
                {w}{' '}
              </span>
            ))}
          </p>
          {zenMode && <span className="zen-exit-hint">click or Z to exit</span>}
        </main>

        {showTimeline && (
          <aside className="timeline-sidebar">
            <div className="timeline-header">Undo history</div>
            <div className="timeline-scroll">
              {timelineEntries.length === 1 ? (
                <p className="timeline-empty">No undo history yet.</p>
              ) : (
                timelineEntries.map((entry, i) => {
                  const entryPct = words.length > 0 ? Math.round((entry.wordIdx / words.length) * 100) : 0
                  const chapter = chapterAt(entry.wordIdx)
                  return (
                    <div key={i} className={`timeline-row${entry.isCurrent ? ' timeline-row-current' : ''}`}>
                      <span className="timeline-badge">{entry.isCurrent ? 'now' : `↩ ${i}`}</span>
                      <span className="timeline-idx">word {entry.wordIdx.toLocaleString()}</span>
                      <span className="timeline-pct">{entryPct}%</span>
                      {chapter && <span className="timeline-chapter">{chapter}</span>}
                    </div>
                  )
                })
              )}
            </div>
          </aside>
        )}
      </div>

      <footer className={`reader-controls${showControls ? '' : ' controls-hidden'}`}>
        <div className="scrubber-row">
          <span className="scrubber-label">{pct}%</span>
          <input
            type="range"
            min={0}
            max={Math.max(0, words.length - 1)}
            value={idx}
            onMouseDown={handleScrubStart}
            onTouchStart={handleScrubStart}
            onChange={handleScrub}
            onMouseUp={handleScrubEnd}
            onTouchEnd={handleScrubEnd}
            className="scrubber"
            title="Seek position"
          />
          <span className="scrubber-label right">
            {Math.round((words.length - idx) / wpm)} min left
          </span>
        </div>

        <div className="jump-row">
          <span className="jump-row-label">
            Word {idx.toLocaleString()} of {words.length.toLocaleString()}
          </span>
          <input
            ref={jumpInputRef}
            type="number"
            className="jump-input"
            value={jumpInput}
            onChange={(e) => setJumpInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleJump() }}
            placeholder={String(idx)}
            min={0}
            max={words.length - 1}
          />
          <button className="jump-btn" onClick={handleJump} title="Jump to word (G → Enter)">Go</button>
        </div>

        <div className="playback-row">
          <button
            className={`ctrl-btn${flashedKey === 'rew' ? ' btn-flash' : ''}`}
            onClick={() => { const p = idxRef.current; navigate(p - 50); setPosHistory(h => [...h.slice(-19), p]) }}
            title="Back 50 words (⇧←)"
          >«</button>
          <button
            className={`ctrl-btn${flashedKey === 'back' ? ' btn-flash' : ''}`}
            onClick={() => { const p = idxRef.current; seek(-10); setPosHistory(h => [...h.slice(-19), p]) }}
            title="Back 10 words (←)"
          >‹</button>
          <button
            className={`ctrl-btn play-btn${flashedKey === 'play' ? ' btn-flash' : ''}`}
            onClick={() => setPlaying((p) => !p)}
            title="Play/Pause (Space)"
          >
            {playing ? '⏸' : '▶'}
          </button>
          <button
            className={`ctrl-btn${flashedKey === 'fwd' ? ' btn-flash' : ''}`}
            onClick={() => { const p = idxRef.current; seek(10); setPosHistory(h => [...h.slice(-19), p]) }}
            title="Forward 10 words (→)"
          >›</button>
          <button
            className={`ctrl-btn${flashedKey === 'ff' ? ' btn-flash' : ''}`}
            onClick={() => { const p = idxRef.current; navigate(p + 50); setPosHistory(h => [...h.slice(-19), p]) }}
            title="Forward 50 words (⇧→)"
          >»</button>
        </div>

        <div className="footer-btns">
          <button className={`btn-icon${rampUp ? ' btn-icon-active' : ''}`} onClick={() => setRampUp(s => !s)} title="Ramp up WPM on play (R) — active above 500 WPM">⇡</button>
          <button className={`btn-icon${showParagraphPopup ? ' btn-icon-active' : ''}`} onClick={toggleParagraphPopup} title="Paragraph view (P)">¶</button>
          <button className={`btn-icon${showHeader ? ' btn-icon-active' : ''}`} onClick={() => setShowHeader(s => !s)} title="Toggle navbar (N)">⊤</button>
          <button className={`btn-icon${showControls ? ' btn-icon-active' : ''}`} onClick={() => setShowControls(s => !s)} title="Toggle controls (X)">⊥</button>
          <button className="btn-icon" onClick={() => setShowHelp(true)} title="Keyboard shortcuts (/)">?</button>
          <button className="btn-icon" onClick={onToggleTheme} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode (D)`}>{theme === 'dark' ? '☀' : '☾'}</button>
          <button className="btn-icon" onClick={onShowAbout} title="About (I)">ℹ</button>
          <button className={`btn-icon${showToc ? ' btn-icon-active' : ''}`} onClick={() => setShowToc(s => !s)} title="Table of contents (T)">☰</button>
          <button className={`btn-icon${showTimeline ? ' btn-icon-active' : ''}`} onClick={() => setShowTimeline(s => !s)} title="Undo history (H)">⊙</button>
          <button className="btn-icon" onClick={() => { handleUndo(); flash('undo') }} title="Undo (⌘Z)">↩</button>
        </div>
      </footer>

      {paragraphContext && (
        <div className="para-overlay" onClick={closeParagraphPopup}>
          <div className="para-card" onClick={(e) => e.stopPropagation()}>
            <div className="para-card-header">
              <span className="para-card-title">Paragraph context</span>
              <button className="help-close" onClick={closeParagraphPopup}>×</button>
            </div>
            {paragraphContext.prev2 && <p className="para-text para-text-prev">{paragraphContext.prev2}</p>}
            {paragraphContext.prev1 && <p className="para-text para-text-prev">{paragraphContext.prev1}</p>}
            <p className="para-text para-text-current">
              {paragraphContext.currentWords.map((w, i) => (
                <span key={i} className={i === paragraphContext.currentHighlight ? 'para-word-current' : ''}>{w}{' '}</span>
              ))}
            </p>
          </div>
        </div>
      )}

      {showHelp && (
        <div className="help-overlay" onClick={() => setShowHelp(false)}>
          <div className="help-card" onClick={(e) => e.stopPropagation()}>
            <p className="help-title">Keyboard shortcuts</p>
            <button className="help-close" onClick={() => setShowHelp(false)}>×</button>
            <div className="help-shortcuts">
              <span className="help-key">Space</span>       <span className="help-desc">Play / Pause</span>
              <span className="help-key">← →</span>         <span className="help-desc">Skip ±10 words</span>
              <span className="help-key">⇧← ⇧→</span>      <span className="help-desc">Skip ±50 words</span>
              <span className="help-key">↑ ↓</span>         <span className="help-desc">Speed ±20 wpm</span>
              <span className="help-key">⌘⇧← ⌘⇧→</span>    <span className="help-desc">Prev / Next paragraph</span>
              <span className="help-key">C</span>            <span className="help-desc">Toggle context words</span>
              <span className="help-key">N</span>            <span className="help-desc">Toggle navbar</span>
              <span className="help-key">X</span>            <span className="help-desc">Toggle player controls</span>
              <span className="help-key">[ ]</span>          <span className="help-desc">Font size ±</span>
              <span className="help-key">P</span>            <span className="help-desc">Paragraph view</span>
              <span className="help-key">T</span>            <span className="help-desc">Table of contents (↑↓ Enter)</span>
              <span className="help-key">Z</span>            <span className="help-desc">Zen mode</span>
              <span className="help-key">F</span>            <span className="help-desc">Toggle fullscreen</span>
              <span className="help-key">⌘K</span>          <span className="help-desc">Open book search</span>
              <span className="help-key">G</span>            <span className="help-desc">Go to word #</span>
              <span className="help-key">W</span>            <span className="help-desc">Set WPM</span>
              <span className="help-key">S</span>            <span className="help-desc">Set font size</span>
              <span className="help-key">R</span>            <span className="help-desc">Toggle ramp-up (WPM &gt; 500 only)</span>
              <span className="help-key">H</span>            <span className="help-desc">Toggle undo history</span>
              <span className="help-key">⌘Z</span>          <span className="help-desc">Undo word index change</span>
              <span className="help-key">D</span>            <span className="help-desc">Toggle dark / light mode</span>
              <span className="help-key">L</span>            <span className="help-desc">Go to library</span>
              <span className="help-key">Esc</span>          <span className="help-desc">Exit fullscreen</span>
              <span className="help-key">/</span>            <span className="help-desc">This help</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
