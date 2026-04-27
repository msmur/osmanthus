# Osmanthus — Internals Guide

This document is for anyone who wants to understand, modify, or extend Osmanthus without relying on an LLM. It covers the technology choices, the core concepts behind them, where each feature lives in the code, and the patterns that will trip you up if you don't know they're there.

---

## 1. Tech stack and where to learn it

### Tauri v2
- [ ] I understand what Tauri is and how it differs from Electron
- [ ] I understand the Rust ↔ JS bridge (`invoke`, `emit`, `listen`)
- [ ] I understand the capability/ACL system (`default.json`)

Tauri is the desktop shell. It wraps a native OS webview (WebKit on macOS) around a regular web app, then exposes Rust-backed APIs to the frontend via a message-passing bridge. There is no Electron, no bundled Chromium — the binary is tiny (~10 MB).

The shape of a Tauri app:
- `src-tauri/` — Rust process. Owns the window, file system, and any custom commands.
- `src/` — React/TypeScript web app rendered in the webview.
- The two sides communicate via `invoke()` (JS → Rust) and `emit`/`listen` (Rust → JS events).
- Osmanthus uses only official plugins (fs, dialog, store, opener) — no custom Rust commands.

| Topic                            | Resource                                    |
|----------------------------------|---------------------------------------------|
| Architecture & process model     | https://v2.tauri.app/concept/architecture/  |
| Plugin system                    | https://v2.tauri.app/develop/plugins/       |
| Capabilities / permissions (ACL) | https://v2.tauri.app/security/capabilities/ |

**The capability file** (`src-tauri/capabilities/default.json`) is the ACL: if a JS API call fails silently in production but works in dev, the permission is probably missing from that file.

---

### React 18 + TypeScript
- [ ] I understand function components and hooks (`useState`, `useEffect`, `useCallback`)
- [ ] I understand the stale closure problem in timer callbacks
- [ ] I understand the refs-vs-state pattern used throughout `Reader.tsx`

The entire UI is React function components with hooks. No class components, no Redux, no context API — state is passed down as props or lives at the `App` level.

**Critical pattern: refs vs state in timer callbacks**

The playback engine uses `setTimeout` recursively. If a `setTimeout` callback closes over a React state value, it captures a *stale* copy from when the closure was created — changes to `wpm` or `idx` mid-playback will be invisible to it.

The fix used throughout `Reader.tsx`: every piece of state that a timer callback needs to read is *mirrored into a ref*. The ref is updated on every render (`wpmRef.current = wpm`), and the callback reads only refs, never state values directly.

```ts
// Refs stay current across timer callbacks; state values do not.
const wpmRef = useRef(wpm)
wpmRef.current = wpm  // runs on every render, before any timer fires

// Inside setTimeout callback:
const delay = wordDelay(word, wpmRef.current)  // ✓ always fresh
```

This pattern appears ~15 times in `Reader.tsx`. If you add any state that a playback callback needs to read, mirror it to a ref the same way.

| Topic            | Resource                                      |
|------------------|-----------------------------------------------|
| useRef docs      | https://react.dev/reference/react/useRef      |
| useCallback docs | https://react.dev/reference/react/useCallback |

---

### Vite
- [ ] I understand what Vite does and how it differs from webpack
- [ ] I understand why port 1420 is required in Tauri dev mode

The frontend bundler. You mostly don't need to touch it. `vite.config.ts` sets port 1420 (required by Tauri in dev mode) and splits vendor chunks for smaller builds. The config is ~25 lines.

| Topic                 | Resource                 |
|-----------------------|--------------------------|
| Vite config reference | https://vite.dev/config/ |

---

### JSZip
- [ ] I understand that an epub is a ZIP file
- [ ] I understand how JSZip unpacks it in-memory

An epub file is a renamed ZIP archive. JSZip unpacks it in-memory in the browser/webview — no native dep needed, no temp files on disk.

| Topic     | Resource                      |
|-----------|-------------------------------|
| JSZip API | https://stuk.github.io/jszip/ |

---

### Epub format
- [ ] I understand the structure of an epub (container.xml → OPF → spine → chapters)
- [ ] I understand what the manifest and spine are
- [ ] I understand how cover images are located (three fallback strategies)

An epub contains:
1. `META-INF/container.xml` — pointer to the OPF file.
2. The OPF file — metadata (title/author), a manifest (id→path map), and a spine (ordered chapter list).
3. HTML chapter files referenced by the spine.
4. Optionally a cover image and an NCX/NAV table of contents.

| Topic                | Resource                                |
|----------------------|-----------------------------------------|
| EPUB 3 spec overview | https://www.w3.org/TR/epub-overview-33/ |

---

### RSVP and ORP
- [ ] I understand what RSVP is and why it speeds up reading
- [ ] I understand what ORP is and how the red letter alignment works
- [ ] I can explain why the ORP column is fixed and what happens if it moves

**RSVP (Rapid Serial Visual Presentation):** instead of moving your eye across a line, one word appears at a fixed screen position. Eliminates saccades (eye jumps), which are the main speed bottleneck.

**ORP (Optimal Recognition Point):** the letter ~30% from the left of a word where the brain identifies the word fastest. Osmanthus highlights that letter in red and pads the left side of each word so the ORP column never moves horizontally — your eye is stationary the whole time.

| Topic                    | Resource                                                       |
|--------------------------|----------------------------------------------------------------|
| RSVP overview            | https://en.wikipedia.org/wiki/Rapid_serial_visual_presentation |
| ORP explanation (Spritz) | https://www.spritzreader.com/how-it-works                      |

---

## 2. Feature map

Each feature below is named, briefly explained, and traced to the exact file and line range you need to read.

---

### ORP calculation and word display
- [ ] I've read `src/lib/rsvp.ts` and understand all four functions

`src/lib/rsvp.ts` — the entire file (67 lines).

| Function                               | Lines | What it does                                                                                  |
|----------------------------------------|-------|-----------------------------------------------------------------------------------------------|
| `getOrpIndex(word)`                    | 10–31 | Returns the 0-based index of the ORP letter: `floor(letterCount * 0.3)`, skipping punctuation |
| `splitAtOrp(word)`                     | 33–45 | Returns `[before, orpLetter, after]` for rendering                                            |
| `wordDelay(word, wpm, isParagraphEnd)` | 60–67 | Base delay = `60000 / wpm` ms, multiplied 1.8× at sentence ends, 1.3× at clause pauses        |
| `tokenise(text)`                       | 47–58 | Normalises whitespace and splits to word array                                                |

The rendered word: `Reader.tsx:495–500`. Short words (≤2 letters) are merged with the next word before ORP splitting.

---

### Epub parsing
- [ ] I've traced through `parseEpub()` from ZIP bytes to the final word array
- [ ] I understand why `allByLocalName()` exists instead of using `getElementsByTagName`
- [ ] I understand how paragraph breaks are detected and stored

`src/lib/epub.ts` — the entire file (278 lines).

| Section            | Lines   | What it does                                                                                                  |
|--------------------|---------|---------------------------------------------------------------------------------------------------------------|
| `allByLocalName()` | 41–51   | Namespace-safe XML element finder (epub XML can use arbitrary namespace prefixes)                             |
| Cover extraction   | 57–105  | Three fallback strategies: OPF `<meta name="cover">`, manifest id containing "cover", href containing "cover" |
| `extractText()`    | 110–124 | Strips nav/aside/script/style from a chapter HTML doc, collects text nodes                                    |
| TOC parsing        | 129–195 | Reads NCX (epub2) or NAV (epub3), maps chapter title → word index                                             |
| `parseEpub()`      | 199–278 | Main entry point: unzip → OPF → manifest → spine → chapters → words + TOC + paragraph breaks                  |

Paragraph breaks are detected as the *last word index of each HTML `<p>` element*, stored as a `Set<number>` and used by the playback engine to insert inter-paragraph pauses.

---

### Persistence (store)
- [ ] I understand the Tauri vs browser dual-mode detection
- [ ] I understand why `store.save()` must be called explicitly after `store.set()`
- [ ] I understand what is persisted to disk vs what is only in-memory

`src/lib/store.ts` — 138 lines total.

| Section                             | Lines   | What it does                                                                                              |
|-------------------------------------|---------|-----------------------------------------------------------------------------------------------------------|
| Tauri vs browser detection          | 26      | `'__TAURI_INTERNALS__' in window` — determines which storage backend to use                               |
| `storeGet` / `storeSet`             | 30–47   | Generic read/write: Tauri plugin-store (→ `osmanthus.json` on disk) or localStorage                       |
| Book CRUD                           | 51–93   | `getBooks`, `saveBooks`, `upsertBook`, `updateProgress`, `removeBook`, `markCompleted`                    |
| Settings                            | 100–107 | `getSettings` / `saveSettings` — persists `wpm`, `fontSize`, and `rampUp`                                 |
| In-memory word/TOC/paragraph caches | 116–138 | Words are expensive to re-parse; cached per `bookId` for the session. Only the word *index* is persisted. |

The store is append-on-write: every `set` also calls `store.save()` to flush to disk immediately so progress survives crashes.

The data file lives at `~/Library/Application Support/com.orchardatelier.osmanthus/osmanthus.json` on macOS.

---

### Playback engine
- [ ] I understand the recursive `setTimeout` loop in `scheduleNext`
- [ ] I can explain why the loop reads only refs and never state values
- [ ] I understand when and how auto-save is triggered
- [ ] I understand how ramp-up modifies the effective WPM

`src/views/Reader.tsx:237–287`

`scheduleNext` is a recursive `setTimeout` loop:
1. If `rampUp` is enabled and target WPM > 500, compute `effectiveWpm` by linearly interpolating from 50% to 100% of target over the 5 seconds since play started (`rampStartRef`).
2. Compute delay for the *current* word using `wordDelay(word, effectiveWpm)`.
3. `setTimeout(delay)` → on fire: increment `idx`, trigger re-render, call `scheduleNext` again.
4. Every 25 words, auto-save progress.
5. When `idx` reaches end of words array, stops and marks book complete.

`rampStartRef` is set to `Date.now()` whenever playback transitions from paused → playing, and reset to `null` on pause/stop.

The loop reads only refs (`wpmRef`, `idxRef`, `wordsRef`, `paragraphBreaksRef`, `rampUpRef`, `rampStartRef`) to avoid stale closures.

---

### Ramp-up mode
- [ ] I understand when ramp-up activates (only above 500 WPM)
- [ ] I understand the interpolation formula and the 5-second window
- [ ] I understand where `rampStartRef` is set and reset

`src/views/Reader.tsx:76, 107–109, 255–261, 278–287` (state, refs, engine, play-effect)
`src/types.ts:25` (`rampUp?: boolean` in `Settings`)

When enabled, every time playback starts (after any pause), `rampStartRef.current = Date.now()` is recorded. Inside `scheduleNext`, if `rampUpRef.current && targetWpm > 500`:

```ts
const elapsed = Date.now() - rampStartRef.current
const t = Math.min(1, elapsed / 5000)          // 0 → 1 over 5 seconds
effectiveWpm = Math.round(targetWpm * (0.5 + 0.5 * t))  // 50% → 100%
```

Toggled by `R`, persisted in `Settings`, and indicated by the `⇡` button in the reader footer.

---

### Word loading (cache + disk fallback)
- [ ] I understand the two-path load: cache hit vs cache miss
- [ ] I understand what happens when a book file is moved or deleted

`src/views/Reader.tsx:158–198`

On mount:
1. Check in-memory word cache (`getCachedWords`).
2. If hit, use cached words immediately — no disk read.
3. If miss (app was restarted, cache cleared), call `readFile(book.filePath)` via Tauri fs plugin, then `parseEpub(buffer)` again.
4. In browser dev mode with no cache: show an error asking to re-open from the library.

---

### Undo history
- [ ] I understand what gets pushed onto `posHistory` and when
- [ ] I understand that positions are captured *before* navigation, not after
- [ ] I understand that "Go to word #" jumps are also undoable

`src/views/Reader.tsx:60, 317–325, 327–336`

`posHistory: number[]` — a stack of word indices captured *before* each navigation action. Max 20 entries (`slice(-19)`).

Pushes happen at:
- Scrubber drag end (captures position at drag-start)
- TOC chapter jump
- ±10 / ±50 word keyboard skips
- "Go to word #" (`handleJump`) — added so direct index jumps are also undoable

`handleUndo` pops the last entry and sets `idx` to it.

---

### Timeline sidebar (undo history panel)
- [ ] I understand how timeline entries are derived from `posHistory`
- [ ] I understand how chapter names are resolved per entry

`src/views/Reader.tsx:509–516` (derive entries), `649–673` (JSX)
`src/app.css` — `.timeline-sidebar`, `.timeline-header`, `.timeline-row` etc.

The panel is a right sidebar showing the current position plus each undo-stack entry with word index, percentage, and chapter name. The header uses the same small-caps style as the TOC panel heading for visual consistency. Toggled by `H`.

---

### Paragraph context popup
- [ ] I understand how `getParagraphsAroundIndex` finds paragraph boundaries
- [ ] I understand the play/pause save-restore behaviour on open/close

`src/views/Reader.tsx:25–48` (`getParagraphsAroundIndex`), `480–487` (derive), `741–769` (JSX)

Pressing `P` opens a modal overlay showing the current paragraph (with the current word highlighted) and the two preceding paragraphs. The popup pauses playback on open and resumes on close (unless it was already paused).

`getParagraphsAroundIndex` walks the sorted `paragraphBreaks` set to find paragraph boundaries around `currentIdx`.

---

### Table of contents
- [ ] I understand how the TOC is parsed from NCX vs NAV files
- [ ] I understand how TOC entries map to word indices
- [ ] I understand the keyboard navigation inside the TOC sidebar

`src/views/Reader.tsx:219–234` (focus sync), `385–416` (keyboard nav), `615–641` (JSX sidebar)
`src/lib/epub.ts:129–195` (parsing)

The TOC is parsed from the epub's NCX or NAV file and stored as `TocEntry[]` (title + word index). In the reader it appears as a left sidebar. Arrow keys + Enter navigate it; clicking a chapter sets `idx` and pushes undo history.

---

### Library — keyboard navigation and book management
- [ ] I understand how `selectedIdx` + `sortedRef` drive keyboard navigation
- [ ] I understand the duplicate detection flow and the three resolution options
- [ ] I understand how book status (unread/reading/finished) is derived

`src/views/Library.tsx:69–82` (state + refs), `213–246` (keyboard handler), `305–358` (book grid JSX)

The library supports full keyboard navigation:
- `↑↓←→` move the selection through the sorted book grid
- `↵` opens the selected book
- `N` triggers add book
- `⌘⌫` removes the selected book

Books are sorted by `lastReadAt` (most recently read first), falling back to `addedAt`. Status is derived at render time:
```ts
const status = book.completedAt ? 'finished' : book.wordIndex > 0 ? 'reading' : 'unread'
```

**Duplicate detection** (`checkDuplicate`, `pendingImport` state, `src/views/Library.tsx:88–94, 155–182`): when importing a book whose title case-insensitively matches an existing entry, a modal offers three choices:
1. *Update file path* — keeps reading position, replaces `filePath`/`coverDataUrl`/`totalWords`/`toc`
2. *Replace book* — removes old entry, inserts fresh copy with no progress
3. *Keep both* — inserts as a separate entry

---

### About dialog
- [ ] I understand why the About dialog lives in `App.tsx` rather than in a view
- [ ] I understand how the app version is fetched

`src/App.tsx:13–14, 29–32, 38–42, 231–254`

The About dialog is rendered at the `App` level (not inside Library or Reader) so the `I` shortcut and `Escape` to dismiss work globally from any view without prop-drilling. `appVersion` is fetched on mount via Tauri's `getVersion()` API and falls back to `'0.1.0'` in browser dev mode. External links use `openExternal()` which calls `@tauri-apps/plugin-opener` in Tauri or `window.open` in browser.

---

### Theme toggle (dark / light mode)
- [ ] I understand how `[data-theme]` overrides the system media query
- [ ] I understand where the preference is persisted and how it initialises

`src/App.tsx:15–36` (state + effect + callback)
`src/app.css` — `[data-theme="dark"]` and `[data-theme="light"]` blocks alongside each `@media (prefers-color-scheme: dark)` block

`theme` state initialises from `localStorage` if previously set, otherwise falls back to the system preference (`window.matchMedia`). On every change, `document.documentElement.setAttribute('data-theme', theme)` is called, which activates the matching CSS variable overrides. The `[data-theme]` selectors have the same specificity as `:root`, so they override the media query.

Toggled globally by `D` (handled in `App.tsx`'s global key listener), and by ☾/☀ buttons in both the library and reader footers.

---

### Command palette
- [ ] I understand why the palette lives in `App.tsx` rather than `Library.tsx` or `Reader.tsx`
- [ ] I understand the `clampedSelected` pattern for keeping selection in bounds
- [ ] I understand what status information is shown per book

`src/App.tsx:10–13, 84–91, 120–146, 185–229` (state + keyboard + JSX)
`src/app.css` — `.palette-overlay`, `.palette-card`, `.palette-item` etc.

`⌘K` opens a search overlay that filters the book list by title (case-insensitive, max 8 results). Arrow keys navigate, Enter opens the book. Each result shows the book title, a coloured status badge (Unread / Reading / Finished), and the read percentage. Works from both Library and Reader views because it lives in `App.tsx` above both.

---

### Zen mode and independent panel toggles
- [ ] I understand the difference between `zenMode` and the individual panel show/hide states
- [ ] I understand why entering zen hides panels but exiting zen restores them independently

`src/views/Reader.tsx:65, 446–452, 454–456, 463–464` (keyboard handlers)

`Z` toggles zen mode. *Entering* zen auto-hides all panels (context words, TOC, controls, header). Exiting zen restores them. Each panel can also be toggled independently at any time:
- `C` — context words
- `T` — table of contents
- `X` — playback controls
- `N` — navbar/header
- `H` — undo timeline

The `zenMode` boolean controls the CSS class and the auto-hide behaviour on enter. Panel visibility is tracked independently in `showContext`, `showControls`, `showToc`, `showTimeline`, `showHeader`.

---

### Fullscreen
- [ ] I understand how fullscreen state is tracked via the resize listener
- [ ] I understand why ESC needs the fullscreen check before navigating back

`src/App.tsx:93–100` (F key, global)
`src/views/Reader.tsx:207–217` (resize listener), `443–455` (ESC handler)

`F` calls `getCurrentWindow().setFullscreen(!current)` via Tauri's window API. The reader tracks fullscreen state via a `resize` listener (not a Tauri event) because macOS triggers resize before the next `keydown`, making it detectable in the ESC handler. ESC exits fullscreen if currently fullscreen; otherwise does nothing.

Permission required: `core:window:allow-set-fullscreen` in `src-tauri/capabilities/default.json`.

---

### Font scaling and WPM
- [ ] I understand how `--font-scale` is applied via inline CSS on the reader root
- [ ] I understand why both settings are persisted on every change rather than on unmount
- [ ] I understand that `rampUp` is also persisted in `Settings`

`src/views/Reader.tsx:55–56, 70–71, 131–153` (state + persistence)

WPM, font size, and ramp-up are all persisted via `saveSettings` on every change and reloaded on every Reader mount. Font size is injected as a CSS custom property (`--font-scale`) on the `.reader` root element so CSS can scale the word display, ORP guides, and context text proportionally without JS.

---

### ORP guide lines
- [ ] I understand what the guide lines are for and how their position is calculated

`src/app.css` — `.orp-guide-top`, `.orp-guide-bottom`

Two thin vertical tick marks positioned at `left: calc(13ch * 0.5)` (half of the maximum ORP padding width in monospace). They give your eye a fixed anchor point to lock onto even as words change.

---

### Word centering
- [ ] I understand why `.rsvp-focal` and the context paragraph are separate elements
- [ ] I understand what `translateY(-50%)` is doing and why it targets only the word

`src/app.css` — `.rsvp-focal`

```css
position: fixed;
top: 50vh;
transform: translateY(-50%);
```

`.rsvp-focal` contains *only* the word element, not the context text below it. This ensures `translateY(-50%)` centers the word itself at the exact viewport midpoint. The context paragraph is a separate `position: fixed` element with its own `top` offset.

---

### Reader and Library footers
- [ ] I understand what buttons live in the reader footer and what each does
- [ ] I understand why the library footer is `position: fixed`

**Reader footer** (`src/views/Reader.tsx:748–778`, `src/app.css` — `.footer-btns`):
A row of `btn-icon` buttons at the bottom of the reader: `⇡` (ramp-up toggle), `¶` (paragraph view), `⊤` (navbar toggle), `⊥` (controls toggle), `?` (shortcuts help), `☾/☀` (theme toggle), `ℹ` (about), `☰` (TOC), `⊙` (undo timeline), `↩` (undo). Active-state buttons use `.btn-icon-active`.

**Library footer** (`src/views/Library.tsx:362–365`, `src/app.css` — `.library-footer`):
Fixed to the bottom of the viewport, centered, only as wide as its contents: `?` (shortcuts), `☾/☀` (theme), `ℹ` (about).

---

## 3. Things that will bite you

- [ ] **Stale closures in timer callbacks** — if a `setTimeout` callback misbehaves after a state change, it's almost certainly reading a stale value. Mirror the state to a ref and read the ref.

- [ ] **Epub namespace prefixes** — standard DOM `getElementsByTagName('opf:item')` won't work — epub OPF files use arbitrary prefixes. Always use `allByLocalName()` in `epub.ts` when walking epub XML.

- [ ] **File paths in Tauri vs browser dev** — in Tauri, `book.filePath` is a full OS path (e.g. `/Users/you/Downloads/book.epub`). In browser dev mode, it's just the filename. Code that calls `readFile(book.filePath)` only runs inside `if ('__TAURI_INTERNALS__' in window)` blocks; make sure any new file-access code does the same.

- [ ] **Tauri plugin-store saves are async — and explicit** — `store.set()` alone does *not* flush to disk. `store.save()` must be called after. The wrapper in `storeSet()` already does this, but if you bypass it and call the Tauri store directly, you'll lose data on crash.

- [ ] **The `isTauri` constant is defined in multiple files** — `src/lib/store.ts:26` and `src/views/Library.tsx:22` both define their own `const isTauri`. They're identical one-liners, not imported from a shared location. If you add a third, keep it consistent.

- [ ] **Paragraph breaks are last-word indices, not first** — `paragraphBreaks: Set<number>` stores the index of the *last word in each paragraph*, not the first. `wordDelay()` receives `isParagraphEnd` (not `isParagraphStart`). Keep this in mind when writing new paragraph-aware navigation.

- [ ] **Undo history is captured before navigation, not after** — all `setPosHistory` pushes capture `idxRef.current` *before* calling `navigate()`. If you add a new navigation action, follow the same pattern:
  ```ts
  const prevIdx = idxRef.current
  navigate(target)
  setPosHistory(h => [...h.slice(-19), prevIdx])
  ```

- [ ] **CSS custom properties for dynamic values** — `--font-scale` is set inline on the `.reader` root via React's `style` prop. Don't try to change font scale from CSS alone — it needs to match React state.

- [ ] **Theme toggle needs both `[data-theme]` and `@media` selectors** — the media query handles the system default; the `[data-theme]` attribute handles manual overrides. Any new dark-mode CSS rule needs both, otherwise the manual toggle won't work for that rule.

- [ ] **Ramp-up only activates above 500 WPM** — the condition in `scheduleNext` is `rampUpRef.current && targetWpm > 500`. If you lower the threshold, update the tooltip text on the `⇡` button and the help modal entry too.

---

## 4. File overview (quick reference)

| File                                  | Lines | Role                                                                          |
|---------------------------------------|-------|-------------------------------------------------------------------------------|
| `src/types.ts`                        | 30    | Shared TypeScript types (`Book`, `Settings`, `View`, `TocEntry`)              |
| `src/lib/rsvp.ts`                     | 67    | ORP maths, word delay, tokeniser — pure functions, no side effects            |
| `src/lib/epub.ts`                     | 278   | Epub ZIP parsing → words, TOC, paragraph breaks, cover                        |
| `src/lib/store.ts`                    | 138   | Tauri/localStorage persistence + in-memory word/TOC cache                     |
| `src/App.tsx`                         | 257   | Root: books/view state, palette, theme toggle, about dialog, global shortcuts |
| `src/views/Library.tsx`               | 412   | Book grid: add/remove/navigate books, duplicate handling, library footer      |
| `src/views/Reader.tsx`                | 840   | RSVP playback engine, ramp-up, all keyboard shortcuts, all panels             |
| `src/app.css`                         | 1222  | All styles — CSS variables for theming, `[data-theme]` manual overrides       |
| `src-tauri/capabilities/default.json` | 21    | Tauri ACL: which JS APIs are permitted                                        |
| `src-tauri/src/lib.rs`                | ~11   | Rust entry: registers four plugins (dialog, fs, store, opener)                |
