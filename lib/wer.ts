export type NormalizeOptions = {
  lowercase: boolean;
  stripPunctuation: boolean;
  ignoreTerms?: string[];
  ignoreTimestamps?: boolean;
};

export type Token = {
  original: string;
  normalized: string;
  ignored: boolean;
  endsLine: boolean;
};

export type OpType = "equal" | "sub" | "del" | "ins" | "skip";

export type AlignmentOp = {
  type: OpType;
  ref?: string;
  hyp?: string;
  // True when the reference token consumed by this op ended a source line —
  // used by the diff view to break rows so both columns stay aligned.
  refEndsLine?: boolean;
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
  ignoredRefWords: number;
  ops: AlignmentOp[];
};

const MAX_MATRIX_CELLS = 300_000_000;
// Matches a timestamp at the START of a token: 0:06, 08:19AM, 1:22:30, …
// No trailing $ so it also peels off a timestamp glued to a word ("0:06Sehr").
const TIMESTAMP_RE = /^\d{1,2}:\d{2}(?::\d{2})?(?:[ap]m)?/i;

function normalizeWord(s: string, opts: NormalizeOptions): string {
  let n = s;
  if (opts.lowercase) n = n.toLowerCase();
  if (opts.stripPunctuation) n = n.replace(/\p{P}+/gu, "");
  return n;
}

function makeToken(
  original: string,
  opts: NormalizeOptions,
  ignoreSet: Set<string>,
  forceIgnore: boolean
): Token | null {
  const normalized = normalizeWord(original, opts);
  if (normalized.length === 0) return null;
  return {
    original,
    normalized,
    ignored: forceIgnore || ignoreSet.has(normalized),
    endsLine: false,
  };
}

export function tokenize(text: string, opts: NormalizeOptions): Token[] {
  // Each whitespace-separated word in the ignore list is matched individually,
  // so "Rolf Meier" filters both "Rolf" and "Meier".
  const ignoreSet = new Set<string>();
  for (const term of opts.ignoreTerms ?? []) {
    for (const word of term.split(/\s+/)) {
      const t = normalizeWord(word.trim(), opts);
      if (t) ignoreSet.add(t);
    }
  }

  const tokens: Token[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    let lastIdx = -1;
    for (const raw of line.split(/\s+/).filter(Boolean)) {
      let rest = raw;
      // Peel a leading timestamp off a glued word: "0:06Sehr" -> "0:06" + "Sehr"
      if (opts.ignoreTimestamps) {
        const m = TIMESTAMP_RE.exec(rest);
        if (m && m[0].length > 0) {
          const tsTok = makeToken(m[0], opts, ignoreSet, true);
          if (tsTok) {
            tokens.push(tsTok);
            lastIdx = tokens.length - 1;
          }
          rest = rest.slice(m[0].length);
          if (rest.length === 0) continue;
        }
      }
      const tok = makeToken(rest, opts, ignoreSet, false);
      if (tok) {
        tokens.push(tok);
        lastIdx = tokens.length - 1;
      }
    }
    // Mark the last token of this source line so the diff view can break rows here.
    if (lastIdx >= 0) tokens[lastIdx].endsLine = true;
  }
  return tokens;
}

// Re-inserts ignored tokens from the original arrays into the active-only ops
// as "skip" ops, and stamps every ref-consuming op with the source line break.
function mergeIgnoredIntoOps(
  ref: Token[],
  hyp: Token[],
  activeOps: AlignmentOp[]
): AlignmentOp[] {
  const merged: AlignmentOp[] = [];
  let refFull = 0;
  let hypFull = 0;
  let opIdx = 0;

  while (refFull < ref.length || hypFull < hyp.length) {
    const refIgnored = refFull < ref.length && ref[refFull].ignored;
    const hypIgnored = hypFull < hyp.length && hyp[hypFull].ignored;

    if (refIgnored && hypIgnored) {
      merged.push({
        type: "skip",
        ref: ref[refFull].original,
        hyp: hyp[hypFull].original,
        refEndsLine: ref[refFull].endsLine,
      });
      refFull++;
      hypFull++;
    } else if (refIgnored) {
      merged.push({
        type: "skip",
        ref: ref[refFull].original,
        refEndsLine: ref[refFull].endsLine,
      });
      refFull++;
    } else if (hypIgnored) {
      merged.push({ type: "skip", hyp: hyp[hypFull].original });
      hypFull++;
    } else if (opIdx < activeOps.length) {
      const op = activeOps[opIdx++];
      if (op.type === "equal" || op.type === "sub" || op.type === "del") {
        op.refEndsLine = ref[refFull].endsLine;
        refFull++;
      }
      if (op.type === "equal" || op.type === "sub" || op.type === "ins") {
        hypFull++;
      }
      merged.push(op);
    } else {
      break;
    }
  }

  return merged;
}

/**
 * Word-level Levenshtein alignment between reference and hypothesis.
 * Ignored tokens are excluded from the DP but re-inserted into the ops
 * as "skip" entries for display purposes.
 */
export function calculateWer(
  refTokens: Token[],
  hypTokens: Token[]
): WerResult {
  const activeRef = refTokens.filter((t) => !t.ignored);
  const activeHyp = hypTokens.filter((t) => !t.ignored);
  const n = activeRef.length;
  const m = activeHyp.length;

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
    const refWord = activeRef[i - 1].normalized;
    const rowOffset = i * width;
    for (let j = 1; j <= m; j++) {
      if (refWord === activeHyp[j - 1].normalized) {
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

  const activeOps: AlignmentOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const p = ptr[i * width + j];
    if (p === 0) {
      activeOps.push({
        type: "equal",
        ref: activeRef[i - 1].original,
        hyp: activeHyp[j - 1].original,
      });
      i--;
      j--;
    } else if (p === 1) {
      activeOps.push({
        type: "sub",
        ref: activeRef[i - 1].original,
        hyp: activeHyp[j - 1].original,
      });
      i--;
      j--;
    } else if (p === 2) {
      activeOps.push({ type: "del", ref: activeRef[i - 1].original });
      i--;
    } else {
      activeOps.push({ type: "ins", hyp: activeHyp[j - 1].original });
      j--;
    }
  }
  activeOps.reverse();

  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  let hits = 0;
  for (const op of activeOps) {
    if (op.type === "sub") substitutions++;
    else if (op.type === "del") deletions++;
    else if (op.type === "ins") insertions++;
    else hits++;
  }

  const ops = mergeIgnoredIntoOps(refTokens, hypTokens, activeOps);
  const wer = n > 0 ? distance / n : activeHyp.length > 0 ? 1 : 0;

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
    ignoredRefWords: refTokens.filter((t) => t.ignored).length,
    ops,
  };
}
