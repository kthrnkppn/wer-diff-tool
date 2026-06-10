export type NormalizeOptions = {
  lowercase: boolean;
  stripPunctuation: boolean;
};

export type Token = {
  original: string;
  normalized: string;
};

export type OpType = "equal" | "sub" | "del" | "ins";

export type AlignmentOp = {
  type: OpType;
  ref?: string;
  hyp?: string;
};

export type WerResult = {
  wer: number;
  accuracy: number;
  distance: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  hits: number;
  refWordCount: number;
  hypWordCount: number;
  ops: AlignmentOp[];
};

const MAX_MATRIX_CELLS = 300_000_000;

export function tokenize(text: string, opts: NormalizeOptions): Token[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((original) => {
      let normalized = original;
      if (opts.lowercase) normalized = normalized.toLowerCase();
      if (opts.stripPunctuation) {
        normalized = normalized.replace(/\p{P}+/gu, "");
      }
      return { original, normalized };
    })
    .filter((t) => t.normalized.length > 0);
}

/**
 * Word-level Levenshtein alignment between reference and hypothesis.
 * Distance is computed with two rolling rows; a full byte matrix of
 * backtrack pointers is kept to recover the alignment for the diff view.
 */
export function calculateWer(
  refTokens: Token[],
  hypTokens: Token[]
): WerResult {
  const n = refTokens.length;
  const m = hypTokens.length;

  if ((n + 1) * (m + 1) > MAX_MATRIX_CELLS) {
    throw new Error(
      `Documents too large for alignment (${n.toLocaleString()} × ${m.toLocaleString()} words). Try shorter documents.`
    );
  }

  // Pointer codes: 0 = diagonal match, 1 = diagonal substitution,
  // 2 = up (deletion from reference), 3 = left (insertion in hypothesis)
  const width = m + 1;
  const ptr = new Uint8Array((n + 1) * width);
  let prev = new Uint32Array(width);
  let curr = new Uint32Array(width);

  for (let j = 1; j <= m; j++) {
    prev[j] = j;
    ptr[j] = 3;
  }
  for (let i = 1; i <= n; i++) {
    ptr[i * width] = 2;
  }

  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    const refWord = refTokens[i - 1].normalized;
    const rowOffset = i * width;
    for (let j = 1; j <= m; j++) {
      if (refWord === hypTokens[j - 1].normalized) {
        curr[j] = prev[j - 1];
        ptr[rowOffset + j] = 0;
      } else {
        // On ties, deletion/insertion are preferred over substitution:
        // this recovers alignments with more exact matches (same distance)
        let best = prev[j - 1] + 1; // substitution
        let p = 1;
        if (prev[j] + 1 <= best) {
          best = prev[j] + 1; // deletion
          p = 2;
        }
        if (curr[j - 1] + 1 <= best) {
          best = curr[j - 1] + 1; // insertion
          p = 3;
        }
        curr[j] = best;
        ptr[rowOffset + j] = p;
      }
    }
    [prev, curr] = [curr, prev];
  }

  const distance = prev[m];

  const ops: AlignmentOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const p = ptr[i * width + j];
    if (p === 0) {
      ops.push({
        type: "equal",
        ref: refTokens[i - 1].original,
        hyp: hypTokens[j - 1].original,
      });
      i--;
      j--;
    } else if (p === 1) {
      ops.push({
        type: "sub",
        ref: refTokens[i - 1].original,
        hyp: hypTokens[j - 1].original,
      });
      i--;
      j--;
    } else if (p === 2) {
      ops.push({ type: "del", ref: refTokens[i - 1].original });
      i--;
    } else {
      ops.push({ type: "ins", hyp: hypTokens[j - 1].original });
      j--;
    }
  }
  ops.reverse();

  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  let hits = 0;
  for (const op of ops) {
    if (op.type === "sub") substitutions++;
    else if (op.type === "del") deletions++;
    else if (op.type === "ins") insertions++;
    else hits++;
  }

  const wer = n > 0 ? distance / n : hypTokens.length > 0 ? 1 : 0;

  return {
    wer,
    accuracy: n > 0 ? hits / n : 0,
    distance,
    substitutions,
    deletions,
    insertions,
    hits,
    refWordCount: n,
    hypWordCount: m,
    ops,
  };
}
