# Osmanthus / Flashread — Codebase Guide

A desktop RSVP speed-reader for epub files. Built with Tauri v2 (Rust shell) + React 18 + TypeScript + Vite.

---

## How to run

```bash
# Dev (hot-reload frontend, no Rust recompile needed unless you touch src-tauri/)
pnpm tauri dev        # or: npm run tauri dev

# Production build (.app on macOS, .exe on Windows)
pnpm tauri build

# Frontend only (no Tauri window — useful for UI layout work in browser)
pnpm dev
```

---

## Conceptual overview

### What is RSVP?

Rapid Serial Visual Presentation (RSVP) is a speed-reading technique: instead of moving your eyes across a line of text, a single word flashes in one fixed spot. This eliminates saccadic eye movement (the time the eye spends jumping) which is the main bottleneck in reading speed.

### What is ORP?

Optimal Recognition Point (ORP) is a specific letter within each word — roughly 30% from the left — where the brain recognises the word fastest. The reader highlights this letter in red and pads the left side of the word so the ORP always falls on the same horizontal pixel. Your eye never moves.

### User flow

```
Library view  →  pick epub  →  parse to word array  →  Reader view
                                                          ↓
                                                     RSVP playback
                                                     (word by word at N wpm)
```

Progress (word position) is auto-saved every 25 words and on exit.

---

## Tech stack

| Layer | Technology | Why |
|---|---|---|
| Desktop shell | Tauri v2 (Rust) | Native OS window, no Electron, tiny binary |
| Frontend | React 18 + TypeScript | Component model; strict TS catches bugs |
| Bundler | Vite | Fast HMR, ESM-first |
| Epub parsing | JSZip (JS) | Epub is a ZIP; no native dep needed |
| Persistence | @tauri-apps/plugin-store | JSON file in OS app data dir |
| Package manager | pnpm | Faster installs, strict dep graph |

---

## Project structure

```
osmanthus/
├── index.html                  # Single HTML shell; Vite injects /src/main.tsx
├── vite.config.ts              # Port 1420, Tauri-aware build settings
├── tsconfig.json               # Strict TS, ES2021 target
├── package.json
│
├── src/                        # React frontend (all business logic lives here)
│   ├── main.tsx                # ReactDOM.createRoot entry point
│   ├── App.tsx                 # Root component: owns [books, view] state
│   ├── app.css                 # All CSS — no framework, CSS variables for theming
│   ├── types.ts                # Shared TypeScript types
│   │
│   ├── lib/
│   │   ├── epub.ts             # Parse .epub → { title, author, coverDataUrl, words[] }
│   │   ├── rsvp.ts             # ORP maths + tokenise() + wordDelay()
│   │   └── store.ts            # Read/write books and settings (Tauri store or localStorage)
│   │
│   └── views/
│       ├── Library.tsx         # Book grid; add/remove books
│       └── Reader.tsx          # RSVP playback engine + controls
│
└── src-tauri/                  # Rust / Tauri layer
    ├── tauri.conf.json         # Window config, bundle targets, CSP
    ├── Cargo.toml              # Rust deps: tauri + three plugins
    ├── build.rs                # Tauri codegen (do not edit)
    ├── capabilities/
    │   └── default.json        # Tauri ACL: which APIs the frontend can call
    └── src/
        ├── main.rs             # Binary entry point (1 line)
        └── lib.rs              # Registers Tauri plugins; nothing custom yet
```

---

## File-by-file breakdown

### `src/types.ts`

Three types:

- **`Book`** — everything stored per book: `id`, `title`, `author`, `filePath` (full OS path), optional `coverDataUrl` (base64), `wordIndex` (reading position), `totalWords`, timestamps.
- **`Settings`** — currently just `{ wpm: number }`.
- **`View`** — a discriminated union: `{ type: 'library' }` | `{ type: 'reader'; bookId: string }`. App.tsx switches on this to decide what to render.

### `src/App.tsx`

The root. Owns two pieces of state:
- `books: Book[]` — the full library, loaded from the store on mount.
- `view: View` — which screen is showing.

Passes callbacks down: `onOpenBook` switches to reader, `onBack` switches to library, `onProgressUpdate` syncs word position back into the books array (and persists it).

### `src/lib/epub.ts`

Parses an `ArrayBuffer` (the raw epub file bytes) into `{ title, author, coverDataUrl, words[] }`.

An epub is a ZIP file. The parse steps:
1. `JSZip.loadAsync(buffer)` — unzip in memory.
2. Read `META-INF/container.xml` → find the path to the **OPF** file (the epub's table of contents).
3. Parse the OPF for: metadata (title, author), **manifest** (id → file path map), **spine** (ordered list of chapter ids).
4. Walk the spine: for each chapter, read the HTML file, strip non-text tags (nav, aside, script, style…), collect the text.
5. Join all chapter text → `tokenise()` → word array.
6. Try to find a cover image in the manifest (three fallback methods: OPF meta tag, id containing "cover", href containing "cover").

Key function: `allByLocalName(doc, tag)` — a namespace-safe XML tree walker (epub XML can have arbitrary namespace prefixes).

### `src/lib/rsvp.ts`

Three pure functions, no side effects:

- **`getOrpIndex(word)`** — returns the 0-based index of the ORP letter. Formula: take ~30% of the letter-count (ignoring punctuation), minus 1 for words longer than 4 letters. Skips non-letter characters.
- **`splitAtOrp(word)`** — returns `[before, orpLetter, after]` for rendering with the red highlight.
- **`wordDelay(word, wpm)`** — base delay = `60000 / wpm` ms. Multiplied by 1.8 at sentence endings (`.!?`), 1.3 at clause boundaries (`,;:`), so reading feels less robotic.
- **`tokenise(text)`** — normalises whitespace and splits into a word array.

### `src/lib/store.ts`

Persistence layer with a Tauri/browser dual-mode:

- In Tauri: uses `@tauri-apps/plugin-store` which writes a JSON file to `{OS app data dir}/osmanthus.json`.
- In browser dev: falls back to `localStorage` with a `osmanthus:` key prefix.

The detection is: `'__TAURI_INTERNALS__' in window`.

Exported functions: `getBooks`, `saveBooks`, `upsertBook`, `updateProgress`, `removeBook`, `getSettings`, `saveSettings`.

Also exports an **in-memory word cache** (`cacheWords` / `getCachedWords`): words are re-parsed from the epub file each session — only the word-index position is persisted. Caching avoids re-parsing when navigating library → reader → library → reader.

### `src/views/Library.tsx`

Renders the book grid. Handles adding books in two different ways:

- **Tauri mode** (`isTauri === true`): calls the `@tauri-apps/plugin-dialog` `open()` function to show a native file picker. This returns the **full filesystem path**, which is what gets stored in `book.filePath` (needed for re-reading the file later).
- **Browser dev mode**: uses a hidden `<input type="file">` — the `File` object's `arrayBuffer()` is read directly. The path stored is just `file.name` (a filename, not a full path) — this is fine for dev since words stay in-memory cache.

Drag-and-drop (`.epub` files dropped onto the grid) works in browser dev mode via the same `handleFile` code path. In Tauri, drag-drop goes through the same path but stores only the filename; use the "Add book" button in Tauri for reliable path storage.

Books are sorted by `lastReadAt` (most recently read first), falling back to `addedAt`.

### `src/views/Reader.tsx`

The playback engine. Key implementation details:

**Refs vs state for playback timing**: `setTimeout`-based playback needs up-to-date values without triggering re-renders in the closure. The solution: `wpmRef`, `idxRef`, `playingRef`, `wordsRef` are refs kept in sync with their corresponding state on every render. The timer callback reads only refs, never stale closure values.

**Loading words**: on mount it checks the in-memory word cache first. If missing (new session after app restart), it re-reads the epub from `book.filePath` via `@tauri-apps/plugin-fs readFile`. In browser dev mode with no cache it shows an error asking you to re-open from the library.

**Auto-save**: every 25 words during playback, and on unmount (navigation back to library).

**Keyboard shortcuts**: Space (play/pause), ←→ (seek ±10), ↑↓ (speed ±20 wpm), Esc (back). WPM changes are also persisted to the store so they survive app restarts.

### `src/app.css`

All styles in one file, no framework. Uses CSS custom properties (`--bg`, `--text`, `--accent`, etc.) for theming. `@media (prefers-color-scheme: dark)` redefines the root variables — no JS needed for dark mode.

The `--accent` colour (warm red) is specifically for the ORP letter highlight.

The ORP guide lines (`.orp-guide-top/bottom`) are thin vertical tick marks positioned at the ORP column using `left: calc(13ch * 0.5)` — 13 characters is the maximum ORP offset for a ~45-character word in monospace.

### `src-tauri/capabilities/default.json`

Tauri's Access Control List. Controls which JavaScript APIs the frontend can call:

- `core:default` — basic Tauri core (app info, events, etc.)
- `dialog:allow-open` — `open()` file picker dialog
- `fs:allow-read-file` — binary `readFile()` (for epub bytes)
- `fs:allow-read-text-file` — text `readTextFile()` (not currently used directly)
- `fs:scope-home-recursive` — allows fs operations on any path under `$HOME` (needed so users can open epub files from Downloads, Documents, Desktop, etc.)
- `store:allow-load`, `store:allow-get`, `store:allow-set`, `store:allow-save` — the persistence store

### `src-tauri/lib.rs`

Registers the three Tauri plugins: `tauri_plugin_dialog`, `tauri_plugin_fs`, `tauri_plugin_store`. No custom Rust commands — all business logic is in the frontend.

---

## Data flow diagram

```
User opens epub
     │
     ▼
Library.tsx: Tauri dialog → full path
     │
     ├─ readFile(path) → ArrayBuffer
     │
     ├─ parseEpub(ArrayBuffer)
     │    ├─ JSZip.loadAsync → ZipObject
     │    ├─ container.xml → opfPath
     │    ├─ OPF → manifest + spine + metadata
     │    ├─ spine chapters → extractText() → raw text
     │    └─ tokenise(text) → words[]
     │
     ├─ cacheWords(bookId, words)   ← in-memory only
     └─ upsertBook(book)            ← persisted to osmanthus.json

User opens book in Reader
     │
     ├─ getCachedWords(bookId) ── hit: use cached words
     │                       └── miss: readFile(filePath) + parseEpub again
     │
     └─ Playback loop:
          setTimeout(wordDelay(word, wpm))
          → setIdx(idx + 1)
          → every 25 words: updateProgress(bookId, idx)  ← persisted
          → on unmount: updateProgress(bookId, idx)
```

---

## How to extend this codebase

### Add a new setting (e.g., font size)

1. Add the field to `Settings` in `src/types.ts`.
2. Update `DEFAULT_SETTINGS` in `src/lib/store.ts`.
3. Add UI in `Reader.tsx` (similar to the WPM control). Use `getSettings`/`saveSettings`.

### Add a new view (e.g., a settings screen)

1. Add a new variant to the `View` union in `src/types.ts`.
2. Create `src/views/Settings.tsx`.
3. Add a case in `App.tsx`'s render switch.
4. Add navigation (a button in the relevant view that calls a prop like `onOpenSettings`).

### Add a custom Tauri command (Rust → JS)

If you need OS-level access beyond what the plugins provide (e.g., extracting epub metadata in Rust for performance):
1. Add a `#[tauri::command]` function in `src-tauri/src/lib.rs`.
2. Register it with `.invoke_handler(tauri::generate_handler![your_fn])`.
3. Add the permission in `capabilities/default.json`.
4. Call it from JS with `invoke('your_fn', { arg: value })` from `@tauri-apps/api/core`.

### Add keyboard shortcut

Edit the `onKey` handler in `Reader.tsx`. All shortcuts are in one `useEffect` — add a new `if (e.code === '...')` branch.

### Support drag-and-drop in Tauri

The Tauri v2 window API has a `onDragDropEvent` listener. In Tauri mode, you'd listen to that event instead of the HTML `dragover`/`drop` events, because the OS-level drop gives you the real file path. See the `@tauri-apps/api/window` docs.

### Add chapter-level navigation

The epub parser (`epub.ts`) currently joins all chapters into a flat word array. To add chapter navigation, return a `chapters: { title: string; startWordIndex: number }[]` from `parseEpub`, store it alongside words in the cache, and add chapter markers to the Reader's scrubber.

---

## Known limitations

- **Drag-and-drop in Tauri stores only the filename, not the path.** Use the "Add book" button (which uses the system dialog) when running as a desktop app. Fixing this requires Tauri's `onDragDropEvent` API.
- **Words re-parsed each session.** Only the word position is persisted, not the parsed words. On the second launch, epub files are re-read from disk. If the file is moved or deleted, the reader shows an error.
- **No pagination or scrollback.** RSVP shows one word at a time. There's no way to read a full paragraph view. Adding one is a new view, not a change to the existing reader.
