// Client-side semantic comparison via sentence embeddings.
// Everything runs in the browser (transformers.js / ONNX) — no text leaves the
// machine, matching the tool's privacy model. The model (~120 MB, q8) is
// downloaded on first use and cached by the browser afterwards.

import { tokenize, type NormalizeOptions } from "./wer";

const MODEL_ID = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";

export type ProgressInfo = { label: string; pct: number | null };
export type ProgressCb = (info: ProgressInfo) => void;

export type SemKind = "same" | "reworded" | "diverged" | "omitted" | "added";

export type SemRow = {
  kind: SemKind;
  ref?: string;
  hyp?: string;
  score?: number; // cosine similarity for matched pairs (0..1)
  refIdx?: number; // index into the baseline units (for anchoring)
  hypIdx?: number; // index into the transcript units (for anchoring)
  anchored?: boolean; // true when this pair was fixed by the user
};

export type SemResult = {
  rows: SemRow[];
  meanSimilarity: number; // mean cosine over matched pairs
  matched: number;
  omitted: number;
  added: number;
  refSentences: number;
};

// A user-fixed correspondence between a baseline unit and a transcript unit.
export type Anchor = { refIdx: number; hypIdx: number };

// Embeddings + display text, kept around so the alignment can be recomputed
// instantly when anchors change — without re-running the model.
export type SemData = {
  refDisplays: string[];
  hypDisplays: string[];
  refVecs: number[][];
  hypVecs: number[][];
};

// Thresholds for labelling a matched sentence pair.
const SAME = 0.8;
const REWORDED = 0.55;
// Gap penalty for the sentence alignment (Needleman–Wunsch).
const GAP = 0.4;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let extractorPromise: Promise<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getExtractor(onProgress?: ProgressCb): Promise<any> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      // Skip the local-model lookup; load straight from the HF hub (and cache).
      env.allowLocalModels = false;
      return pipeline("feature-extraction", MODEL_ID, {
        dtype: "q8",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        progress_callback: (p: any) => {
          if (!onProgress) return;
          if (p.status === "progress" && typeof p.progress === "number") {
            onProgress({ label: `Lade Sprachmodell … (einmalig)`, pct: p.progress });
          } else if (p.status === "ready") {
            onProgress({ label: "Modell bereit", pct: 100 });
          }
        },
      });
    })();
  }
  return extractorPromise;
}

export async function embed(
  texts: string[],
  onProgress?: ProgressCb
): Promise<number[][]> {
  const extractor = await getExtractor(onProgress);
  const vectors: number[][] = [];
  const BATCH = 16;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const out = await extractor(batch, { pooling: "mean", normalize: true });
    for (const v of out.tolist() as number[][]) vectors.push(v);
    const done = Math.min(i + BATCH, texts.length);
    onProgress?.({
      label: `Sätze analysiert: ${done}/${texts.length}`,
      pct: Math.round((done / texts.length) * 100),
    });
    // Yield so the browser can repaint the progress bar between batches.
    await new Promise((r) => setTimeout(r, 0));
  }
  return vectors;
}

// Dot product; vectors are already L2-normalized, so this is cosine similarity.
export function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function splitSentences(text: string, locale = "de"): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const SegmenterCtor = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter })
    .Segmenter;
  if (SegmenterCtor) {
    const seg = new SegmenterCtor(locale, { granularity: "sentence" });
    return Array.from(seg.segment(trimmed), (s) => s.segment.trim()).filter(
      (s) => s.length > 0
    );
  }
  // Fallback for environments without Intl.Segmenter
  return trimmed
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function classify(score: number): SemKind {
  if (score >= SAME) return "same";
  if (score >= REWORDED) return "reworded";
  return "diverged";
}

/**
 * Order-preserving Needleman–Wunsch alignment over a sub-range of the units
 * (ref[r0,r1) × hyp[h0,h1)), with cosine similarity as the match score.
 * Row indices are reported in the GLOBAL unit coordinates so the UI can anchor.
 */
function nwRange(
  data: SemData,
  r0: number,
  r1: number,
  h0: number,
  h1: number
): SemRow[] {
  const { refDisplays, hypDisplays, refVecs, hypVecs } = data;
  const n = r1 - r0;
  const m = h1 - h0;
  if (n <= 0 && m <= 0) return [];

  const H = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  // 0 = diagonal (match), 1 = up (omit ref), 2 = left (add hyp)
  const ptr = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  for (let i = 1; i <= n; i++) {
    H[i][0] = H[i - 1][0] - GAP;
    ptr[i][0] = 1;
  }
  for (let j = 1; j <= m; j++) {
    H[0][j] = H[0][j - 1] - GAP;
    ptr[0][j] = 2;
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = H[i - 1][j - 1] + cosine(refVecs[r0 + i - 1], hypVecs[h0 + j - 1]);
      const up = H[i - 1][j] - GAP;
      const left = H[i][j - 1] - GAP;
      let best = diag;
      let p = 0;
      if (up > best) {
        best = up;
        p = 1;
      }
      if (left > best) {
        best = left;
        p = 2;
      }
      H[i][j] = best;
      ptr[i][j] = p;
    }
  }

  const rows: SemRow[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && ptr[i][j] === 0) {
      const ri = r0 + i - 1;
      const hj = h0 + j - 1;
      const score = cosine(refVecs[ri], hypVecs[hj]);
      rows.push({ kind: classify(score), ref: refDisplays[ri], hyp: hypDisplays[hj], score, refIdx: ri, hypIdx: hj });
      i--;
      j--;
    } else if (i > 0 && (j === 0 || ptr[i][j] === 1)) {
      const ri = r0 + i - 1;
      rows.push({ kind: "omitted", ref: refDisplays[ri], refIdx: ri });
      i--;
    } else {
      const hj = h0 + j - 1;
      rows.push({ kind: "added", hyp: hypDisplays[hj], hypIdx: hj });
      j--;
    }
  }
  rows.reverse();
  return rows;
}

// Keep only anchors that stay strictly monotonic in both columns (and in range).
// Crossing or duplicate anchors are dropped — order must be preserved.
export function isValidAnchorSet(anchors: Anchor[], n?: number, m?: number): boolean {
  const sorted = [...anchors].sort((a, b) => a.refIdx - b.refIdx);
  let lastRef = -1;
  let lastHyp = -1;
  for (const a of sorted) {
    if (a.refIdx <= lastRef || a.hypIdx <= lastHyp) return false;
    if (n != null && a.refIdx >= n) return false;
    if (m != null && a.hypIdx >= m) return false;
    lastRef = a.refIdx;
    lastHyp = a.hypIdx;
  }
  return true;
}

/**
 * Align baseline vs transcript units, holding the user's anchor pairs fixed and
 * auto-aligning each span between consecutive anchors. No model run needed.
 */
export function alignWithAnchors(data: SemData, anchors: Anchor[]): SemResult {
  const n = data.refDisplays.length;
  const m = data.hypDisplays.length;

  // Defensive: keep a valid monotonic subset.
  const sorted = [...anchors].sort((a, b) => a.refIdx - b.refIdx);
  const valid: Anchor[] = [];
  let lastRef = -1;
  let lastHyp = -1;
  for (const a of sorted) {
    if (a.refIdx > lastRef && a.hypIdx > lastHyp && a.refIdx < n && a.hypIdx < m) {
      valid.push(a);
      lastRef = a.refIdx;
      lastHyp = a.hypIdx;
    }
  }

  const rows: SemRow[] = [];
  let pr = 0;
  let ph = 0;
  for (const a of valid) {
    rows.push(...nwRange(data, pr, a.refIdx, ph, a.hypIdx));
    const score = cosine(data.refVecs[a.refIdx], data.hypVecs[a.hypIdx]);
    rows.push({
      kind: classify(score),
      ref: data.refDisplays[a.refIdx],
      hyp: data.hypDisplays[a.hypIdx],
      score,
      refIdx: a.refIdx,
      hypIdx: a.hypIdx,
      anchored: true,
    });
    pr = a.refIdx + 1;
    ph = a.hypIdx + 1;
  }
  rows.push(...nwRange(data, pr, n, ph, m));

  let simSum = 0;
  let matched = 0;
  let omitted = 0;
  let added = 0;
  for (const r of rows) {
    if (r.kind === "omitted") omitted++;
    else if (r.kind === "added") added++;
    else {
      matched++;
      simSum += r.score ?? 0;
    }
  }

  return {
    rows,
    meanSimilarity: matched > 0 ? simSum / matched : 0,
    matched,
    omitted,
    added,
    refSentences: n,
  };
}

// ---------------------------------------------------------------------------
// Merging (vertical anchoring): the user can glue adjacent units on one side
// into a single "effective" unit. Merges are stored as the set of glued
// boundaries (boundary b joins raw units b and b+1). The combined embedding is
// the L2-normalized mean of the parts — instant, no model run.
// ---------------------------------------------------------------------------

export type Effective = {
  eff: SemData;
  refReps: number[]; // effective index -> first raw index of its group
  refEnds: number[]; // effective index -> last raw index of its group
  refParts: number[]; // effective index -> how many raw units it spans
  refOf: number[]; // raw index -> effective index
  hypReps: number[];
  hypEnds: number[];
  hypParts: number[];
  hypOf: number[];
};

function meanNormalize(vecs: number[][]): number[] {
  if (vecs.length === 1) return vecs[0];
  const dim = vecs[0].length;
  const out = new Array(dim).fill(0);
  for (const v of vecs) for (let d = 0; d < dim; d++) out[d] += v[d];
  let norm = 0;
  for (let d = 0; d < dim; d++) {
    out[d] /= vecs.length;
    norm += out[d] * out[d];
  }
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < dim; d++) out[d] /= norm;
  return out;
}

function groupSide(displays: string[], vecs: number[][], glue: Set<number>) {
  const reps: number[] = [];
  const ends: number[] = [];
  const parts: number[] = [];
  const of: number[] = [];
  const effDisplays: string[] = [];
  const effVecs: number[][] = [];
  const n = displays.length;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && glue.has(j)) j++; // extend while boundary j (j↔j+1) is glued
    const effIdx = reps.length;
    const members: number[] = [];
    for (let k = i; k <= j; k++) {
      members.push(k);
      of[k] = effIdx;
    }
    reps.push(i);
    ends.push(j);
    parts.push(j - i + 1);
    effDisplays.push(members.map((k) => displays[k]).join(" "));
    effVecs.push(meanNormalize(members.map((k) => vecs[k])));
    i = j + 1;
  }
  return { reps, ends, parts, of, effDisplays, effVecs };
}

// Derive effective units (after merges) from the raw embeddings. Pure — runs in
// a useMemo so merges/anchors re-align instantly without touching the model.
export function buildEffective(
  data: SemData,
  refGlue: number[],
  hypGlue: number[]
): Effective {
  const R = groupSide(data.refDisplays, data.refVecs, new Set(refGlue));
  const H = groupSide(data.hypDisplays, data.hypVecs, new Set(hypGlue));
  return {
    eff: {
      refDisplays: R.effDisplays,
      hypDisplays: H.effDisplays,
      refVecs: R.effVecs,
      hypVecs: H.effVecs,
    },
    refReps: R.reps,
    refEnds: R.ends,
    refParts: R.parts,
    refOf: R.of,
    hypReps: H.reps,
    hypEnds: H.ends,
    hypParts: H.parts,
    hypOf: H.of,
  };
}

type Unit = { clean: string; display: string };

// Rebuild a piece of text with the same tokenizer the WER side uses, dropping
// ignored terms and timestamps. Returns natural-cased text (from `original`),
// since embeddings work best on untouched text.
function cleanText(text: string, opts: NormalizeOptions): string {
  return tokenize(text, opts)
    .filter((t) => !t.ignored)
    .map((t) => t.original)
    .join(" ")
    .trim();
}

// Split into comparison units — one per source line (speaker turn), each cleaned
// of ignored terms/timestamps. Falls back to sentence splitting when the text
// has no line structure (e.g. a single pasted paragraph).
function splitUnits(text: string, opts: NormalizeOptions): Unit[] {
  let lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length <= 1) lines = splitSentences(text);
  const units: Unit[] = [];
  for (const line of lines) {
    const clean = cleanText(line, opts);
    if (clean) units.push({ clean, display: clean });
  }
  return units;
}

// Embeds both documents and returns the reusable SemData. The actual alignment
// is produced separately by alignWithAnchors, so anchors can be tweaked without
// re-running the model.
export async function semanticCompare(
  baseline: string,
  transcript: string,
  opts: NormalizeOptions,
  onProgress?: ProgressCb
): Promise<SemData> {
  const refUnits = splitUnits(baseline, opts);
  const hypUnits = splitUnits(transcript, opts);
  const refDisplays = refUnits.map((u) => u.display);
  const hypDisplays = hypUnits.map((u) => u.display);
  if (refUnits.length === 0 || hypUnits.length === 0) {
    // Nothing to compare — keep displays/vectors aligned (both empty).
    return { refDisplays: [], hypDisplays: [], refVecs: [], hypVecs: [] };
  }
  // Embed both documents in one pass, then split the vectors back apart.
  const all = await embed(
    [...refUnits.map((u) => u.clean), ...hypUnits.map((u) => u.clean)],
    onProgress
  );
  return {
    refDisplays,
    hypDisplays,
    refVecs: all.slice(0, refUnits.length),
    hypVecs: all.slice(refUnits.length),
  };
}
