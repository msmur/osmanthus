# Osmanthus — Internals Guide

This document is for anyone who wants to understand, modify, or extend Osmanthus without relying on an LLM. It covers the technology choices, the core concepts behind them, where each feature lives in the code, and the patterns that will trip you up if you don't know they're there.

---

## 1. Tech stack and where to learn it

### Tauri v2

Tauri is the desktop shell. It wraps a native OS webview (WebKit on macOS) around a regular web app, then exposes Rust-backed APIs to the frontend via a message-passing bridge. There is no Electron, no bundled Chromium — the binary is tiny (~10 MB).

The shape of a Tauri app:
- `src-tauri/` — Rust process. Owns the window, file system, and any custom commands.
- `src/` — React/TypeScript web app rendered in the webview.
- The two sides communicate via `invoke()` (JS → Rust) and `emit`/`listen` (Rust → JS events).
- Osmanthus uses only official plugins (fs, dialog, store) — no custom Rust commands yet.

| Topic | Resource |
|---|---|
| Architecture & process model | https://v2.tauri.app/concept/architecture/ |
| Plugin system | https://v2.tauri.app/develop/plugins/ |
| Capabilities / permissions (ACL) | https://v2.tauri.app/security/capabilities/ |

**The capability file** (`src-tauri/capabilities/default.json`) is the ACL: if a JS API call fails silently in production but works in dev, the permission is probably missing from that file.

---

### React 18 + TypeScript

The entire UI is React function components with hooks. No class components, no Redux, no context API — state is passed down as props or lives at the `App` level.

**Critical pattern: refs vs state in timer callbacks**

The playback engine uses `setTimeout` recursively. If a `setTimeout` callback closes over a React state value, it captures a *stale* copy from when the closure was created — changes to `wpm` or `idx` mid-playback will be invisible to it.

The fix used throughout Reader.tsx: every piece of state that a timer callback needs to read is *mirrored into a ref*. The ref is updated on every render (`wpmRef.current = wpm`), and the callback reads only refs, never state values directly.

```ts
// Refs stay current across timer callbacks; state values do not.
const wpmRef = useRef(wpm)
wpmRef.current = wpm  // runs on every render, before any timer fires

// Inside setTimeout callback:
const delay = wordDelay(word, wpmRef.current)  // ✓ always fresh
```

This pattern appears ~10 times in `Reader.tsx`. If you add any state that a playback callback needs to read, mirror it to a ref the same way.

| Topic | Resource |
|---|---|
| useRef docs | https://react.dev/reference/react/useRef |
| useCallback docs | https://react.dev/reference/react/useCallback |

---

### Vite

The frontend bundler. You mostly don't need to touch it. `vite.config.ts` sets port 1420 (required by Tauri in dev mode) and a few Tauri-specific build options. The config is 10 lines.

| Topic | Resource |
|---|---|
| Vite config reference | https://vite.dev/config/ |

---

### JSZip

An epub file is a renamed ZIP archive. JSZip unpacks it in-memory in the browser/webview — no native dep needed, no temp files on disk.

| Topic | Resource |
|---|---|
| JSZip API | https://stuk.github.io/jszip/ |

---

### Epub format

An epub contains:
1. `META-INF/container.xml` — pointer to the OPF file.
2. The OPF file — metadata (title/author), a manifest (id→path map), and a spine (ordered chapter list).
3. HTML chapter files referenced by the spine.
4. Optionally a cover image and an NCX/NAV table of contents.

| Topic | Resource |
|---|---|
| EPUB 3 spec overview | https://www.w3.org/TR/epub-overview-33/ |

---

### RSVP and ORP

**RSVP (Rapid Serial Visual Presentation):** instead of moving your eye across a line, one word appears at a fixed screen position. Eliminates saccades (eye jumps), which are the main speed bottleneck.

**ORP (Optimal Recognition Point):** the letter ~30% from the left of a word where the brain identifies the word fastest. Osmanthus highlights that letter in red and pads the left side of each word so the ORP column never moves horizontally — your eye is stationary the whole time.

| Topic | Resource |
|---|---|
| RSVP overview | https://en.wikipedia.org/wiki/Rapid_serial_visual_presentation |
| ORP explanation (Spritz) | https://www.spritzreader.com/how-it-works |

---

## 2. Feature map

Each feature below is named, briefly explained, and traced to the exact file and line range you need to read.

---

### ORP calculation and word display

`src/lib/rsvp.ts` — the entire file (67 lines).

| Function | Lines | What it does |
|---|---|---|
| `getOrpIndex(word)` | 10–31 | Returns the 0-based index of the ORP letter: `floor(letterCount * 0.3)`, skipping punctuation |
| `splitAtOrp(word)` | 33–45 | Returns `[before, orpLetter, after]` for rendering |
| `wordDelay(word, wpm, isParagraphEnd)` | 60–67 | Base delay = `60000 / wpm` ms, multiplied 1.8× at sentence ends, 1.3× at clause pauses |
| `tokenise(text)` | 47–58 | Normalises whitespace and splits to word array |

The rendered word: `Reader.tsx:458–463`. Short words (≤2 letters) are merged with the next word before ORP splitting.

---

### Epub parsing

`src/lib/epub.ts` — the entire file (278 lines).

| Section | Lines | What it does |
|---|---|---|
| `allByLocalName()` | 41–51 | Namespace-safe XML element finder (epub XML can use arbitrary namespace prefixes) |
| Cover extraction | 57–105 | Three fallback strategies: OPF `<meta name="cover">`, manifest id containing "cover", href containing "cover" |
| `extractText()` | 110–124 | Strips nav/aside/script/style from a chapter HTML doc, collects text nodes |
| TOC parsing | 129–195 | Reads NCX (epub2) or NAV (epub3), maps chapter title → word index |
| `parseEpub()` | 199–278 | Main entry point: unzip → OPF → manifest → spine → chapters → words + TOC + paragraph breaks |

Paragraph breaks are detected as the *last word index of each HTML `<p>` element*, stored as a `Set<number>` and used by the playback engine to insert inter-paragraph pauses.

---

### Persistence (store)

`src/lib/store.ts` — 138 lines total.

| Section | Lines | What it does |
|---|---|---|
| Tauri vs browser detection | 26 | `'__TAURI_INTERNALS__' in window` — determines which storage backend to use |
| `storeGet` / `storeSet` | 30–47 | Generic read/write: Tauri plugin-store (→ `osmanthus.json` on disk) or localStorage |
| Book CRUD | 51–93 | `getBooks`, `saveBooks`, `upsertBook`, `updateProgress`, `removeBook`, `markCompleted` |
| Settings | 100–107 | `getSettings` / `saveSettings` — persists `wpm` and `fontSize` |
| In-memory word/TOC/paragraph caches | 116–138 | Words are expensive to re-parse; cached per `bookId` for the session. Only the word *index* is persisted. |

The store is append-on-write: every `set` also calls `store.save()` to flush to disk immediately so progress survives crashes.

---

### Playback engine

`src/views/Reader.tsx:221–271`

`scheduleNext` is a recursive `setTimeout` loop:
1. Compute delay for the *current* word using `wordDelay()`.
2. `setTimeout(delay)` → on fire: increment `idx`, trigger re-render, call `scheduleNext` again.
3. Every 25 words, auto-save progress.
4. When `idx` reaches end of words array, stops and marks book complete.

The loop reads only refs (`wpmRef`, `idxRef`, `wordsRef`, `paragraphBreaksRef`) to avoid stale closures. See the refs-vs-state section above.

---

### Word loading (cache + disk fallback)

`src/views/Reader.tsx:143–185`

On mount:
1. Check in-memory word cache (`getCachedWords`).
2. If hit, use cached words immediately — no disk read.
3. If miss (app was restarted, cache cleared), call `readFile(book.filePath)` via Tauri fs plugin, then `parseEpub(buffer)` again.
4. In browser dev mode with no cache: show an error asking to re-open from the library.

---

### Undo history

`src/views/Reader.tsx:57, 293–305, 348–455` (push sites throughout keyboard handler)

`posHistory: number[]` — a stack of word indices captured *before* each navigation action. Max 50 entries (`slice(-49)`).

Pushes happen at:
- Scrubber drag end (captures position at drag-start)
- TOC chapter jump
- ±10 / ±50 word keyboard skips

`handleUndo` pops the last entry and sets `idx` to it. `⌘Z` also hides the timeline sidebar.

---

### Timeline sidebar (undo history panel)

`src/views/Reader.tsx:487–494` (derive entries), `717–748` (JSX)
`src/app.css` — `.timeline-sidebar`, `.timeline-header`, `.timeline-row` etc.

The panel is a `position: fixed; right: 0` sidebar, always on top. It shows the current position plus each undo-stack entry with word index, percentage, and chapter name. Toggled by `H`.

---

### Paragraph context popup

`src/views/Reader.tsx:22–45` (`getParagraphsAroundIndex`), `468–473` (derive), `729–757` (JSX)

Pressing `P` opens a modal overlay showing the current paragraph (with the current word highlighted) and the two preceding paragraphs. The popup pauses playback on open and resumes on close (unless it was already paused).

`getParagraphsAroundIndex` walks the sorted `paragraphBreaks` set to find paragraph boundaries around `currentIdx`.

---

### Table of contents

`src/views/Reader.tsx:204–219` (focus sync), `348–396` (keyboard nav), `580–601` (JSX sidebar)
`src/lib/epub.ts:129–195` (parsing)

The TOC is parsed from the epub's NCX or NAV file and stored as `TocEntry[]` (title + word index). In the reader it appears as a left sidebar. Arrow keys + Enter navigate it; clicking a chapter sets `idx` and pushes undo history.

---

### Zen mode and independent panel toggles

`src/views/Reader.tsx:62, 427–432, 434–436, 453–454` (keyboard handlers)
`src/app.css` — `.reader.zen` rules

`Z` toggles zen mode. *Entering* zen auto-hides all three panels (context words, TOC, controls). Once in zen mode, each panel can be turned back on independently:
- `C` — context words
- `T` — table of contents  
- `X` — playback controls
- `H` — undo timeline

The `zenMode` boolean only controls the `.zen` CSS class (which hides the header) and the auto-hide on enter. Panel visibility is tracked independently in `showContext`, `showControls`, `showToc`, `showTimeline`.

---

### Command palette

`src/App.tsx:10–13, 55–60, 78–112, 141–174` (state + keyboard + JSX)
`src/app.css` — `.palette-overlay`, `.palette-card`, `.palette-item` etc.

`⌘K` opens a search overlay that filters the book list by title (case-insensitive, max 8 results). Arrow keys navigate, Enter opens the book. Works from both Library and Reader views because it lives in `App.tsx` above both.

---

### Fullscreen

`src/App.tsx:65–72` (F key, global)
`src/views/Reader.tsx:192–203` (resize listener), `431–445` (ESC handler)

`F` calls `getCurrentWindow().setFullscreen(!current)` via Tauri's window API. ESC in the reader exits fullscreen if the window is currently fullscreen (detected via a `resize` listener), and navigates back to the library only on a second ESC.

Permission required: `core:window:allow-set-fullscreen` in `src-tauri/capabilities/default.json`.

---

### Font scaling and WPM

`src/views/Reader.tsx:52, 68, 121–140` (state + persistence)
`src/app.css` — `--font-scale` CSS variable usage

Both WPM and font size are persisted via `saveSettings` and reloaded on every Reader mount. Font size is injected as a CSS custom property (`--font-scale`) on the `.reader` root element; CSS uses it with `calc()` to scale font sizes proportionally across the word display, ORP guides, and context text.

---

### ORP guide lines

`src/app.css` — `.orp-guide-top`, `.orp-guide-bottom`

Two thin vertical tick marks positioned at `left: calc(13ch * 0.5)` (half of the maximum ORP padding width in monospace). They give your eye a fixed anchor point to lock onto even as words change.

---

### Word centering

`src/app.css` — `.rsvp-focal`

```css
position: fixed;
top: 50vh;
transform: translateY(-50%);
```

`.rsvp-focal` contains *only* the word element, not the context text below it. This ensures `translateY(-50%)` centers the word itself at the exact viewport midpoint. The context paragraph is a separate `position: fixed` element with its own `top` offset.

---

## 3. Things that will bite you

**1. Stale closures in timer callbacks**
Already covered above, but it's the most common source of bugs: if a `setTimeout` callback misbehaves after a state change, it's almost certainly reading a stale value. Mirror the state to a ref and read the ref.

**2. Epub namespace prefixes**
Standard DOM `getElementsByTagName('opf:item')` won't work — epub OPF files use arbitrary prefixes. Always use `allByLocalName()` in `epub.ts` when walking epub XML.

**3. File paths in Tauri vs browser dev**
In Tauri, `book.filePath` is a full OS path (e.g. `/Users/you/Downloads/book.epub`). In browser dev mode, it's just the filename. Code that calls `readFile(book.filePath)` only runs inside `if ('__TAURI_INTERNALS__' in window)` blocks; make sure any new file-access code does the same.

**4. Tauri plugin-store saves are async — and explicit**
`store.set()` alone does *not* flush to disk. `store.save()` must be called after. The wrapper in `storeSet()` already does this, but if you bypass it and call the Tauri store directly, you'll lose data on crash.

**5. The `isTauri` constant is defined in multiple files**
`src/lib/store.ts:26` and `src/views/Library.tsx` both define their own `const isTauri`. They're identical one-liners, not imported from a shared location. If you add a third, keep it consistent.

**6. Paragraph breaks are last-word indices, not first**
`paragraphBreaks: Set<number>` stores the index of the *last word in each paragraph*, not the first. `wordDelay()` receives `isParagraphEnd` (not `isParagraphStart`). Keep this in mind when writing new paragraph-aware navigation.

**7. Undo history is captured before navigation, not after**
All `setPosHistory` pushes capture `idxRef.current` *before* calling `navigate()`. If you add a new navigation action, follow the same pattern:
```ts
const prevIdx = idxRef.current
navigate(target)
setPosHistory(h => [...h.slice(-49), prevIdx])
```

**8. CSS custom properties for dynamic values**
`--font-scale` and `--sidebar-width` are set inline on the `.reader` root via React's `style` prop. Don't try to change font scale or sidebar width from CSS alone — they need to match React state.

---

## 4. File overview (quick reference)

| File | Lines | Role |
|---|---|---|
| `src/types.ts` | 29 | Shared TypeScript types (`Book`, `Settings`, `View`, `TocEntry`) |
| `src/lib/rsvp.ts` | 67 | ORP maths, word delay, tokeniser — pure functions, no side effects |
| `src/lib/epub.ts` | 278 | Epub ZIP parsing → words, TOC, paragraph breaks, cover |
| `src/lib/store.ts` | 138 | Tauri/localStorage persistence + in-memory word/TOC cache |
| `src/App.tsx` | 177 | Root: owns `[books, view]` state, command palette, fullscreen shortcut |
| `src/views/Library.tsx` | 227 | Book grid: add/remove books, drag-drop, file picker |
| `src/views/Reader.tsx` | 780 | RSVP playback engine, all keyboard shortcuts, all panels |
| `src/app.css` | 933 | All styles — one file, CSS variables for theming, no framework |
| `src-tauri/capabilities/default.json` | 21 | Tauri ACL: which JS APIs are permitted |
| `src-tauri/src/lib.rs` | ~15 | Rust entry: registers three plugins, no custom commands |
