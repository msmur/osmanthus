# Osmanthus

**A desktop RSVP speed-reader for epub files.**

![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

![Osmanthus](docs/assets/osmanthus_marketing.png)

---

## What is RSVP?

Rapid Serial Visual Presentation (RSVP) flashes one word at a time in a fixed spot on screen. This eliminates the saccadic eye-movement — the time your eye spends jumping between words — which is the main speed bottleneck in conventional reading.

Osmanthus also uses the **Optimal Recognition Point (ORP)**: the letter ~30% into each word where the brain recognises it fastest. That letter is highlighted in red and aligned to a fixed horizontal column so your eye never drifts.

---

## Features

- **ORP highlighting** — the recognition-point letter is coloured red and horizontally locked
- **Adjustable WPM** — 60–900 words per minute; fine-tune with keyboard shortcuts
- **Epub import** — drag & drop or file picker; covers, titles, and authors extracted automatically
- **Table of contents** — full chapter navigation with keyboard support (↑ ↓ Enter)
- **Paragraph context** — see the current and previous paragraphs at any time (P)
- **Zen mode** — hide all chrome for distraction-free reading (Z)
- **Fullscreen** — native macOS fullscreen (F)
- **Font scaling** — resize the word display from 0.5× to 2.5× ([ ])
- **Undo history** — step back through scrubber drags, TOC jumps, and word skips (⌘Z)
- **Command palette** — search and open any book instantly from anywhere (⌘K)
- **Auto-save** — progress is saved every 25 words and on exit
- **Dark mode** — follows your system preference automatically

---

## Download

Grab the latest `.dmg` from [**Releases**](../../releases/latest).

> **macOS note:** Osmanthus is unsigned. On first launch, right-click the app → **Open** to bypass Gatekeeper.
>
> Two builds are available: `aarch64` (Apple Silicon) and `x86_64` (Intel).

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `← →` | Skip ±10 words |
| `⇧← ⇧→` | Skip ±50 words |
| `↑ ↓` | Speed ±20 wpm |
| `⌘⇧← ⌘⇧→` | Previous / next paragraph |
| `C` | Toggle context words |
| `[ ]` | Font size −/+ |
| `P` | Toggle paragraph view |
| `T` | Table of contents (↑ ↓ Enter to navigate) |
| `Z` | Zen mode |
| `F` | Toggle fullscreen |
| `G` | Go to word # |
| `W` | Set WPM |
| `S` | Set font size |
| `⌘K` | Open book search |
| `⌘Z` | Undo (scrubber / TOC / word skips) |
| `Esc` | Close panel / exit fullscreen / back to library |
| `/` | Keyboard shortcuts help |

---

## Build from source

**Prerequisites:** Rust, Node.js 18+, pnpm — see [`SETUP.md`](SETUP.md) for full instructions.

```bash
pnpm install
pnpm tauri build
# Output: src-tauri/target/release/bundle/macos/Osmanthus.app
```

For a specific architecture:

```bash
pnpm tauri build --target aarch64-apple-darwin   # Apple Silicon
pnpm tauri build --target x86_64-apple-darwin    # Intel
```

---

## Planned features

- Windows and Linux builds
- Drag-and-drop epub import with correct path storage in Tauri
- Scrollback / paragraph reading view (non-RSVP mode)
- Custom colour themes
- iCloud / local sync of reading position across devices
- Per-book WPM overrides

---

## Contributing

Issues and PRs are welcome.

> **Note:** This codebase was written primarily with the assistance of large language models (Claude). It is functional and tested, but has not yet been fully audited or refactored by a human contributor. It is currently in **beta** while I build a deeper understanding of the internals.
>
> If you want to contribute or understand how everything fits together before diving in, see [`INTERNALS.md`](INTERNALS.md) — it documents the tech stack with learning resources, maps every feature to its source files and line numbers, and calls out the patterns most likely to bite you.

The LLM-oriented codebase guide is in [`CLAUDE.md`](CLAUDE.md).

---

## License

MIT — see [`LICENSE`](LICENSE).
