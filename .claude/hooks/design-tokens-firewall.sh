#!/usr/bin/env bash
# design-tokens-firewall.sh
#
# PostToolUse hook on Write|Edit|MultiEdit. Blocks design-token violations
# in user-facing UI files before they land. Mirrors the §7.5 design
# discipline rules in CLAUDE.md.
#
# Wires into .claude/settings.json:
#
#   "PostToolUse": [
#     {
#       "matcher": "Write|Edit|MultiEdit",
#       "hooks": [
#         { "type": "command",
#           "command": ".claude/hooks/design-tokens-firewall.sh" }
#       ]
#     }
#   ]
#
# Exit codes:
#   0   pass — no violations
#   2   block — violations found, agent must fix before proceeding
#
# The hook receives the tool input as JSON on stdin (Claude Code contract).

set -euo pipefail

# ── 1. Read the tool input and extract the file path ────────────────────
INPUT_JSON="$(cat)"

FILE_PATH="$(printf '%s' "$INPUT_JSON" \
  | python3 -c 'import sys, json; d=json.load(sys.stdin); print((d.get("tool_input") or {}).get("file_path") or (d.get("tool_input") or {}).get("path") or "")' \
  2>/dev/null || echo "")"

if [[ -z "$FILE_PATH" ]]; then
  exit 0  # nothing to inspect
fi

# ── 2. Scope: only user-facing UI files ─────────────────────────────────
# Skip tests, server-only code, configs, generated files.
case "$FILE_PATH" in
  *.test.ts|*.test.tsx|*.test.js|*.test.jsx) exit 0 ;;
  *.spec.ts|*.spec.tsx|*.spec.js|*.spec.jsx) exit 0 ;;
  */node_modules/*|*/.next/*|*/dist/*|*/build/*) exit 0 ;;
  */src/app/api/*|*/src/lib/*|*/src/server/*) exit 0 ;;
esac

# Only enforce on UI surfaces.
case "$FILE_PATH" in
  */src/components/*.tsx|*/src/components/*.jsx) ;;
  */src/styles/*.css|*/src/styles/*.scss) ;;
  */src/app/*page.tsx|*/src/app/*layout.tsx) ;;
  */src/app/*page.jsx|*/src/app/*layout.jsx) ;;
  *) exit 0 ;;
esac

# Tokens file is exempt — that's where the values live.
case "$FILE_PATH" in
  */src/styles/tokens.css) exit 0 ;;
esac

# ── 3. Read the file (may not exist on Write of new file; tolerate) ────
if [[ ! -f "$FILE_PATH" ]]; then
  exit 0
fi

VIOLATIONS=()

emit() {
  # $1 = severity, $2 = rule, $3 = grep output (file:line:match)
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    VIOLATIONS+=("[$1] $2 → $line")
  done <<< "$3"
}

# Helper: grep with line numbers, suppress no-match exit.
gn() { grep -nE "$@" "$FILE_PATH" 2>/dev/null || true; }

# ── 4. Standing checks ──────────────────────────────────────────────────

# 4a. Raw hex color literals (3, 4, 6, or 8 hex chars after #)
HEX_HITS="$(gn '#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b' \
  | grep -vE '(^[^:]+:[0-9]+:\s*//|^[^:]+:[0-9]+:\s*\*)' \
  | grep -vE 'data:image|sha(256|384|512)-|integrity=' \
  || true)"
emit CRITICAL "raw hex color literal (use a token)" "$HEX_HITS"

# 4b. font-family not using a token
FF_HITS="$(gn 'font-family\s*:' \
  | grep -vE 'var\(--(serif|serif-i|sans|mono)\)' \
  || true)"
emit CRITICAL "untokenized font-family (use var(--serif|--serif-i|--sans))" "$FF_HITS"

# 4c. box-shadow not using a token (allow 'none' and var(--elev-*))
SHADOW_HITS="$(gn 'box-shadow\s*:' \
  | grep -vE 'box-shadow\s*:\s*(none|0\s+0\s+0\s+(2|3)px|var\(--elev-)' \
  || true)"
emit HIGH "untokenized box-shadow (use var(--elev-soft) or 'none')" "$SHADOW_HITS"

# 4d. Tailwind shadow utilities (banned)
TW_SHADOW_HITS="$(gn 'className=.*\b(shadow-(sm|md|lg|xl|2xl)|drop-shadow-)' || true)"
emit HIGH "Tailwind shadow utility (use elevation token)" "$TW_SHADOW_HITS"

# 4e. Gradient utilities used as decoration (allow inside primitives folder)
case "$FILE_PATH" in
  */src/components/primitives/*) ;;  # primitives may use gradients (ResonanceField etc.)
  *)
    GRAD_HITS="$(gn 'bg-gradient-to-|linear-gradient\(|radial-gradient\(' || true)"
    emit HIGH "gradient as decoration (only allowed inside primitives/)" "$GRAD_HITS"
    ;;
esac

# 4f. Filled icon library imports
ICON_HITS="$(gn '^import\b.*(lucide-react|react-icons|@heroicons|@radix-ui/react-icons|@tabler/icons|phosphor-react)' || true)"
emit CRITICAL "third-party icon library import (use Mark* primitives)" "$ICON_HITS"

# 4g. Streak / badge / level vocabulary in user-facing strings
GAMIF_HITS="$(gn '\b(streak|badge|level|XP|points)\b' \
  | grep -viE '(eslint|stylelint|//|/\*|process\.env|key=|test|spec|\.length)' \
  || true)"
emit HIGH "gamification vocabulary (banned in user-facing copy)" "$GAMIF_HITS"

# 4h. Emoji in JSX text content (Unicode ranges most-likely-emoji)
# Scan with python3 to handle Unicode reliably.
EMOJI_HITS="$(python3 - "$FILE_PATH" <<'PY' || true
import re, sys, pathlib
p = pathlib.Path(sys.argv[1])
try:
    src = p.read_text(encoding="utf-8", errors="replace")
except Exception:
    sys.exit(0)
# Loose match for emoji code points (Misc Symbols, Pictographs, Transport,
# Supplementary Symbols, Dingbats, Regional Indicators, Variation Selector,
# Emoticons). Excludes the wordmark glyph ◎ (U+25CE) which is the brand mark.
PATTERN = re.compile(
    r'[\U0001F300-\U0001FAFF'
    r'\U0001F600-\U0001F64F'
    r'\U0001F900-\U0001F9FF'
    r'\u2600-\u27BF'
    r'\U0001F1E6-\U0001F1FF]'
)
ALLOW = {'\u25CE', '\u300C', '\u300D'}  # ◎ 「 」 — the brand glyph + serif quote marks
for i, line in enumerate(src.splitlines(), 1):
    if any(ch in PATTERN.pattern and ch not in ALLOW for ch in line):
        if PATTERN.search(line):
            stripped = ''.join(c for c in line if c not in ALLOW)
            if PATTERN.search(stripped):
                print(f"{p}:{i}:{line.strip()[:120]}")
PY
)"
emit CRITICAL "emoji in UI source (use Mark* primitives)" "$EMOJI_HITS"

# 4i. Inline SVG that looks like a redrawn primitive
# (cheap heuristic: <svg> in a non-primitive file with a circle/path
# pattern that hints at a ring system or wave)
case "$FILE_PATH" in
  */src/components/primitives/*) ;;
  *)
    SVG_HITS="$(gn '<svg[^>]*>' || true)"
    if [[ -n "$SVG_HITS" ]]; then
      # Only flag if the file *also* mentions ring/wave/resonance keywords
      if grep -qiE 'ring|wave|resonance|breathe' "$FILE_PATH"; then
        emit HIGH "inline SVG resembling a primitive (import from primitives/)" "$SVG_HITS"
      fi
    fi
    ;;
esac

# ── 5. Report ──────────────────────────────────────────────────────────
if [[ ${#VIOLATIONS[@]} -eq 0 ]]; then
  exit 0
fi

{
  echo ""
  echo "╭────────────────────────────────────────────────────────────╮"
  echo "│  design-tokens-firewall: ${#VIOLATIONS[@]} violation(s) in:"
  echo "│    $FILE_PATH"
  echo "╰────────────────────────────────────────────────────────────╯"
  echo ""
  for v in "${VIOLATIONS[@]}"; do
    echo "  $v"
  done
  echo ""
  echo "Fix the root cause. Do not edit this hook to bypass it."
  echo "See CLAUDE.md §7.5 (Design Discipline) and docs/design-system.md."
  echo ""
} >&2

exit 2
