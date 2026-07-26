#!/usr/bin/env bash
set -euo pipefail

PACKAGE_ROOT="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$PACKAGE_ROOT/commercial-self-intro"
DESTINATION_ROOT="${CODEX_SKILLS_DIR:-$HOME/.agents/skills}"
REPLACE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --replace)
      REPLACE=1
      shift
      ;;
    --destination)
      DESTINATION_ROOT="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

if [[ ! -f "$SOURCE/SKILL.md" ]]; then
  echo "Package is incomplete: commercial-self-intro/SKILL.md is missing" >&2
  exit 1
fi

PYTHON=""
if command -v python3 >/dev/null 2>&1; then
  PYTHON="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON="python"
fi

if [[ -n "$PYTHON" ]]; then
  "$PYTHON" "$PACKAGE_ROOT/verify_package.py"
elif command -v sha256sum >/dev/null 2>&1; then
  (cd "$PACKAGE_ROOT" && sha256sum -c MANIFEST.sha256)
elif command -v shasum >/dev/null 2>&1; then
  (cd "$PACKAGE_ROOT" && shasum -a 256 -c MANIFEST.sha256)
else
  echo "No Python or SHA256 verifier was found; refusing an unverified install." >&2
  exit 1
fi

TARGET="$DESTINATION_ROOT/commercial-self-intro"
BACKUP=""
mkdir -p "$DESTINATION_ROOT"

if [[ -e "$TARGET" ]]; then
  if [[ "$REPLACE" -ne 1 ]]; then
    echo "Target already exists: $TARGET. Re-run with --replace to upgrade." >&2
    exit 1
  fi
  BACKUP="$TARGET.backup-$(date +%Y%m%d-%H%M%S)"
  mv "$TARGET" "$BACKUP"
fi

if ! cp -R "$SOURCE" "$TARGET"; then
  [[ -n "$BACKUP" && -e "$BACKUP" ]] && mv "$BACKUP" "$TARGET"
  echo "Copy failed; the previous installation was restored." >&2
  exit 1
fi

if [[ -n "$PYTHON" ]]; then
  if ! "$PYTHON" "$TARGET/scripts/validate_book_coverage.py"; then
    mv "$TARGET" "$TARGET.failed-$(date +%Y%m%d-%H%M%S)"
    [[ -n "$BACKUP" && -e "$BACKUP" ]] && mv "$BACKUP" "$TARGET"
    echo "Coverage validation failed; the previous installation was restored." >&2
    exit 1
  fi
fi

echo "Installed: $TARGET"
[[ -n "$BACKUP" ]] && echo "Previous version backup: $BACKUP"
echo 'Open a new Codex task and invoke: $commercial-self-intro'
