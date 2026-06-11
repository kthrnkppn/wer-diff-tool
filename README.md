# WER Calculator

A mühlemann+popp PoC for benchmarking transcript quality. Paste (or upload) a
**baseline** (ground-truth) document and a **transcript** (e.g. Whisper output);
the tool compares them two ways:

1. **Word-level WER** — a lexical, word-by-word error rate with a visual diff.
2. **Semantic comparison** — a meaning-level, sentence-by-sentence similarity
   that recognises paraphrases and flags content that drifted in meaning.

Everything runs **client-side** — no documents (and no embeddings) ever leave
the browser. There are no server calls and no LLM/API involved (see
[Limitations & next steps](#limitations--next-steps)).

---

## 1. Word-level WER (lexical)

- Both texts are tokenized into words; optional normalization lowercases them
  and strips punctuation (both on by default).
- A word-level Levenshtein alignment is computed via dynamic programming
  (rolling cost rows + a full backtrack-pointer matrix).
- `WER = (substitutions + deletions + insertions) / words in baseline`
- The alignment drives a **two-column, line-aligned diff**: baseline on the
  left, transcript on the right, with corresponding source lines kept at the
  same height. The pane is resizable. Colours: changed (mustard), only in
  baseline / missing (red), only in transcript / extra (green), ignored (gray).

## 2. Semantic comparison (meaning-level)

Lexical WER counts a reworded-but-equivalent sentence as many errors, and barely
reacts when a single word flips the meaning. The semantic mode addresses both:
it compares **meaning**, so "Ich bin einverstanden" ≈ "Das passt für mich"
scores high, while a dropped negation scores low.

- **Opt-in:** runs only when you press *Semantischen Vergleich starten*. On first
  use it downloads a sentence-embedding model
  (`Xenova/paraphrase-multilingual-MiniLM-L12-v2`, q8, ~120 MB) via
  [transformers.js](https://github.com/huggingface/transformers.js) and caches it
  in the browser. All inference runs locally (WASM/ONNX).
- **Units:** one per source line (speaker turn); falls back to sentence
  splitting (`Intl.Segmenter`) when the text has no line breaks. Each unit is
  cleaned of ignored terms and timestamps using the same tokenizer as WER, so
  speaker labels and timestamps don't pollute the embeddings.
- **Scoring:** mean-pooled, L2-normalized embeddings compared by cosine
  similarity. Units are aligned with an order-preserving Needleman–Wunsch pass.
- **Bands:** ≥ 80 % "gleich" (green), ≥ 55 % "umformuliert" (mustard), otherwise
  "abweichend" (red); plus "ausgelassen" (baseline-only) and "ergänzt"
  (transcript-only). Headline metrics: mean similarity and per-band counts.

### Fixing the alignment by hand

Automatic alignment of two diverging transcripts is hard, so the matching can be
corrected manually. Both corrections re-align **instantly** (no model rerun):

- **Anchor (horizontal):** click a baseline unit, then its transcript
  counterpart (or vice versa) to fix them as a corresponding pair (⚓). The spans
  between consecutive anchors are re-aligned automatically. Click an anchored
  unit to release it. Crossing/duplicate anchors are rejected — order is
  preserved, so anchors fix offsets and gaps, not reordered turns.
- **Merge (vertical):** click a unit, then an adjacent unit **on the same side**
  to combine them into one section (useful when one side split a single
  utterance into two). The merged embedding is the mean of its parts. Merged
  cells show an `N× · trennen` chip to split them again.
- *Zurücksetzen* clears all anchors and merges.

Changing the inputs or the ignore settings discards the semantic result (the
embeddings would be stale); press the button again to recompute — the model is
cached, so it's fast.

---

## Filtering & normalization (applies to both modes)

- **Normalization:** lowercase and strip punctuation (both on by default).
- **Ignore list:** terms entered in the ignore box (one per line) are excluded.
  Matching is per-word on the normalized form, so `Rolf Meier` filters both
  names individually. Speaker labels need their exact normalized form (e.g.
  `Interviewer:in`, `TP20`). In WER, ignored tokens are dropped from the
  alignment but shown in light gray for context; in the semantic mode they are
  removed from each unit before embedding.
- **Ignore timestamps:** when enabled, timestamps like `0:06`, `08:19AM` or
  `1:22:30` are detected and peeled off — even when glued to the next word
  (`0:06Sehr` → `0:06` + `Sehr`).
- **Uploads:** `.srt` / `.vtt` are cleaned automatically (cue numbers,
  timestamps, tags stripped); `.docx` is converted to plain text in the browser
  via [mammoth](https://github.com/mwilliamson/mammoth.js).

---

## Limitations & next steps

- **Negation is the weak spot of embeddings.** A flipped meaning via a single
  "nicht" only dents the score (it won't reliably land in the red band).
- **Turn-level alignment assumes both sides have a line/turn structure.** If the
  transcript merges or splits turns very differently, expect "ausgelassen" /
  "ergänzt" gaps — use anchors and merges to correct them.
- **Merged-unit embeddings are a mean approximation** of the parts, not a fresh
  embedding of the combined text. Accurate enough for alignment; could be
  upgraded to re-embedding if scores feel off.
- **Deeper evaluation needs an LLM.** Judging whether meaning is *factually*
  preserved (not merely similar) — negations, entailment, hallucinated content —
  is an LLM-judge task. That is **intentionally out of scope** for now: it would
  require sending text to an external API, which breaks the local-first /
  no-data-leaves-the-browser property this tool is built on.

---

## Code map

- [`lib/wer.ts`](lib/wer.ts) — tokenization (ignore list, timestamp peeling),
  Levenshtein alignment, WER metrics, diff ops.
- [`lib/semantic.ts`](lib/semantic.ts) — embedding pipeline, sentence/turn
  segmentation + cleaning, Needleman–Wunsch alignment, anchors, merging.
- [`lib/extract-text.ts`](lib/extract-text.ts) — `.srt` / `.vtt` cleanup.
- [`app/page.tsx`](app/page.tsx) — the entire UI (inputs, options, WER diff,
  semantic view, anchor/merge interactions).

## Stack

Next.js 16 (App Router) · React 19 · HeroUI v3 · Tailwind CSS v4 ·
[transformers.js](https://github.com/huggingface/transformers.js) (client-side
embeddings) · pnpm · Vercel

## Development

```bash
pnpm install   # or: pnpm install --ignore-scripts (skips sharp/native builds)
pnpm dev       # run dev server (http://localhost:3000)
pnpm build     # production build
pnpm lint      # lint
```

The equivalent `task dev` / `task build` / `task lint` / `task deploy` targets
(see `Taskfile.yml`) are also available; `task deploy` does a preview deploy to
Vercel (muehlemann-popp team).

---

_Last updated: 2026-06-11_
