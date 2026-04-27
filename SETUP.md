# Osmanthus — Setup

RSVP speed reader for epub files. Built with Tauri v2 + React + TypeScript.

## Prerequisites

```bash
# 1. Rust (required by Tauri)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 2. Node.js 18+ (you likely have this)
node --version

# 3. Tauri CLI prerequisites on macOS
xcode-select --install
```

## Install & run

```bash
npm install
npm run tauri dev
```

## Build a distributable .app

```bash
npm run tauri build
# Output: src-tauri/target/release/bundle/macos/Osmanthus.app
```

## Project structure

```
osmanthus/
├── src/                    # React frontend
│   ├── lib/
│   │   ├── epub.ts         # Epub parsing (JSZip, no deps)
│   │   ├── rsvp.ts         # ORP calculation and word splitting
│   │   └── store.ts        # Book library persistence (Tauri Store plugin)
│   ├── views/
│   │   ├── Library.tsx     # Book grid, add/remove books
│   │   └── Reader.tsx      # RSVP reader with controls
│   ├── App.tsx
│   └── app.css
└── src-tauri/              # Rust / Tauri config
    ├── tauri.conf.json
    ├── Cargo.toml
    └── capabilities/
        └── default.json    # File system + dialog permissions
```

## How progress is stored

Book metadata and word positions are stored in a JSON file in the OS app data directory
via `@tauri-apps/plugin-store`. Epub files stay where you put them — only the path is
stored. If you move an epub, Osmanthus will prompt you to re-locate it.

## Cross-platform notes

- macOS: tested, primary target
- Windows: should work out of the box, uses WebView2
- Linux: requires `webkit2gtk` — `sudo apt install libwebkit2gtk-4.1-dev`
