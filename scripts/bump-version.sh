#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <new-version>  (e.g. $0 0.2.0)"
  exit 1
fi

VERSION="$1"

# Validate semver-ish format
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: '$VERSION' doesn't look like a version (expected e.g. 1.2.3 or 1.2.3-beta.1)"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# package.json
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$ROOT/package.json"

# src-tauri/tauri.conf.json
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$ROOT/src-tauri/tauri.conf.json"

# src-tauri/Cargo.toml  (first occurrence only — the [package] block)
sed -i '' "1,/^version = /s/^version = \"[^\"]*\"/version = \"$VERSION\"/" "$ROOT/src-tauri/Cargo.toml"

# Cargo.lock — regenerate to reflect new version without upgrading deps
(cd "$ROOT/src-tauri" && cargo update --workspace)

echo "Bumped to $VERSION in:"
echo "  package.json"
echo "  src-tauri/tauri.conf.json"
echo "  src-tauri/Cargo.toml"
echo "  src-tauri/Cargo.lock"
echo ""
echo "Next steps:"
echo "  git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock"
echo "  git commit -m \"chore: bump version to $VERSION\""
echo "  git tag v$VERSION"
echo "  git push && git push --tags"
