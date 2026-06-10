# WER Calculator

A mühlemann+popp PoC for benchmarking transcript quality. Paste (or upload) a
**baseline** (ground-truth) document and a **transcript** (e.g. Whisper
output), and the tool calculates the **word error rate** and renders a visual
word-level diff.

## How it works

- Both texts are tokenized into words; optional normalization lowercases them
  and strips punctuation (both on by default).
- A word-level Levenshtein alignment is computed via dynamic programming
  (rolling cost rows + a full backtrack-pointer matrix), ported from
  `word-error-rate.py` in the parent scratchpad folder.
- `WER = (substitutions + deletions + insertions) / words in baseline`
- The backtracked alignment drives the diff view: substitutions (mustard),
  deletions (red, missing in transcript), insertions (green, extra in
  transcript).
- `.srt` / `.vtt` uploads are cleaned automatically (cue numbers, timestamps,
  and tags are stripped).

Everything runs client-side; no documents leave the browser.

## Stack

Next.js 16 (App Router) · HeroUI v3 · Tailwind CSS v4 · pnpm · Vercel

## Development

```bash
task dev      # run dev server
task build    # production build
task lint     # lint
task deploy   # preview deploy to Vercel (muehlemann-popp team)
```

---

_Last updated: 2026-06-10 · 5be65d3_
