"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button, Switch } from "@heroui/react";
import {
  calculateWer,
  tokenize,
  type AlignmentOp,
  type WerResult,
} from "@/lib/wer";
import {
  semanticCompare,
  alignWithAnchors,
  buildEffective,
  isValidAnchorSet,
  type Anchor,
  type Effective,
  type ProgressInfo,
  type SemData,
  type SemResult,
  type SemRow,
} from "@/lib/semantic";
import { extractText } from "@/lib/extract-text";

const EXAMPLE_BASELINE = `The quick brown fox jumps over the lazy dog. It was a bright cold day in April, and the clocks were striking thirteen. Winston Smith, his chin nuzzled into his breast in an effort to escape the vile wind, slipped quickly through the glass doors of Victory Mansions.`;

const EXAMPLE_TRANSCRIPT = `The quick brown fox jumped over a lazy dog. It was a bright cold day in april and the clocks were striking thirty. Winston Smith, his chin nuzzled into his chest in an effort to escape the vile wind, slipped quickly through the doors of victory mansions today.`;

type PanelProps = {
  title: string;
  description: string;
  value: string;
  onChange: (value: string) => void;
  fileName: string | null;
  onFile: (name: string, text: string) => void;
};

async function readUploadedFile(file: File): Promise<string> {
  if (file.name.toLowerCase().endsWith(".docx")) {
    // Dynamic import keeps mammoth out of the initial bundle
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({
      arrayBuffer: await file.arrayBuffer(),
    });
    return result.value;
  }
  return extractText(file.name, await file.text());
}

function DocumentPanel({
  title,
  description,
  value,
  onChange,
  fileName,
  onFile,
}: PanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const wordCount = value.split(/\s+/).filter(Boolean).length;

  return (
    <div className="flex flex-col rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="flex items-start justify-between gap-2 border-b border-gray-100 px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-[#2d3748]">{title}</h2>
          <p className="mt-0.5 text-sm text-[#718096]">{description}</p>
        </div>
        <Button size="sm" onPress={() => fileInputRef.current?.click()}>
          Upload file
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.srt,.vtt,.md,.docx,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setFileError(null);
            try {
              onFile(file.name, await readUploadedFile(file));
            } catch {
              setFileError(`Could not read ${file.name} — is it a valid file?`);
            }
            e.target.value = "";
          }}
        />
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Paste text here or upload a .txt / .docx / .srt / .vtt file…"
        spellCheck={false}
        className="h-56 w-full resize-y px-5 py-4 font-mono text-[13px] leading-relaxed text-[#1a1a1a] outline-none placeholder:text-gray-400 focus:bg-[hsl(41,75%,98%)]"
      />
      <div className="flex items-center justify-between border-t border-gray-100 px-5 py-2 text-xs text-[#718096]">
        <span>{wordCount.toLocaleString()} words</span>
        {fileError && <span className="text-red-700">{fileError}</span>}
        {fileName && (
          <span className="rounded-full bg-[hsl(41,75%,93%)] px-2 py-0.5 text-[#2d3748]">
            {fileName}
          </span>
        )}
      </div>
    </div>
  );
}

function MetricTile({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border bg-white px-4 py-3 shadow-sm ${
        highlight ? "border-[hsl(41,75%,61%)] border-t-4" : "border-gray-200"
      }`}
    >
      <div
        className={`text-2xl font-bold tabular-nums ${
          highlight ? "text-[hsl(41,75%,40%)]" : "text-[#1a1a1a]"
        }`}
      >
        {value}
      </div>
      <div className="mt-0.5 text-xs font-medium uppercase tracking-wide text-[#718096]">
        {label}
      </div>
    </div>
  );
}

type DiffRow = { left: React.ReactNode[]; right: React.ReactNode[] };

function DiffView({ ops }: { ops: AlignmentOp[] }) {
  const rows: DiffRow[] = [];
  let cur: DiffRow = { left: [], right: [] };

  let pendingBreak = false;

  const closeRow = () => {
    if (cur.left.length > 0 || cur.right.length > 0) {
      rows.push(cur);
      cur = { left: [], right: [] };
    }
  };

  ops.forEach((op, idx) => {
    // A break is deferred until the next ref-consuming op, so trailing
    // transcript-only insertions stay in the line they belong to.
    if (pendingBreak && op.ref != null) {
      closeRow();
      pendingBreak = false;
    }
    if (op.type === "equal") {
      cur.left.push(<span key={idx}>{op.ref} </span>);
      cur.right.push(<span key={idx}>{op.hyp} </span>);
    } else if (op.type === "sub") {
      cur.left.push(
        <span
          key={idx}
          className="rounded bg-[hsl(41,75%,88%)] px-0.5 text-[#9b2c2c]"
          title="Geändert"
        >
          {op.ref}
        </span>,
        " "
      );
      cur.right.push(
        <span
          key={idx}
          className="rounded bg-[hsl(41,75%,88%)] px-0.5 font-semibold text-[#1a1a1a]"
          title="Geändert"
        >
          {op.hyp}
        </span>,
        " "
      );
    } else if (op.type === "del") {
      cur.left.push(
        <span
          key={idx}
          className="rounded bg-red-100 px-0.5 text-red-800"
          title="Nur in Baseline (fehlt im Transkript)"
        >
          {op.ref}
        </span>,
        " "
      );
    } else if (op.type === "ins") {
      cur.right.push(
        <span
          key={idx}
          className="rounded bg-emerald-100 px-0.5 text-emerald-800"
          title="Nur im Transkript (zusätzlich)"
        >
          {op.hyp}
        </span>,
        " "
      );
    } else if (op.type === "skip") {
      if (op.ref) {
        cur.left.push(
          <span key={`l-${idx}`} className="text-gray-300" title="Ignoriert">
            {op.ref}
          </span>,
          " "
        );
      }
      if (op.hyp) {
        cur.right.push(
          <span key={`r-${idx}`} className="text-gray-300" title="Ignoriert">
            {op.hyp}
          </span>,
          " "
        );
      }
    }
    // A source line in the baseline ended here — defer the row break so both
    // columns stay vertically aligned turn by turn.
    if (op.refEndsLine) pendingBreak = true;
  });
  closeRow();

  return (
    <div className="grid grid-cols-2">
      {rows.map((row, r) => (
        <Fragment key={r}>
          <div className="border-t border-gray-100 py-2 pr-4 text-[15px] leading-relaxed text-[#2d3748]">
            {row.left.length > 0 ? row.left : <span>&nbsp;</span>}
          </div>
          <div className="border-t border-gray-100 border-l py-2 pl-4 text-[15px] leading-relaxed text-[#2d3748]">
            {row.right.length > 0 ? row.right : <span>&nbsp;</span>}
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function LegendItem({
  swatchClass,
  label,
}: {
  swatchClass: string;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-[#718096]">
      <span className={`h-3 w-3 rounded-sm ${swatchClass}`} />
      {label}
    </span>
  );
}

const SEM_TINT: Record<SemRow["kind"], string> = {
  same: "bg-emerald-50",
  reworded: "bg-[hsl(41,75%,96%)]",
  diverged: "bg-red-50",
  omitted: "bg-red-50",
  added: "bg-emerald-50",
};

const SEM_BADGE: Record<SemRow["kind"], string> = {
  same: "bg-emerald-100 text-emerald-800",
  reworded: "bg-[hsl(41,75%,85%)] text-[hsl(41,75%,30%)]",
  diverged: "bg-red-100 text-red-800",
  omitted: "bg-red-100 text-red-800",
  added: "bg-emerald-100 text-emerald-800",
};

function AnchorPin() {
  return (
    <span
      className="mt-0.5 shrink-0 rounded bg-[hsl(41,75%,55%)] px-1 text-[10px] font-bold leading-tight text-white"
      title="Verankert — klicken zum Lösen"
    >
      ⚓
    </span>
  );
}

function MergeTag({ parts, onSplit }: { parts: number; onSplit: () => void }) {
  if (parts <= 1) return null;
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onSplit();
      }}
      className="mt-0.5 shrink-0 rounded-full bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 hover:bg-gray-300"
      title="Verbundene Abschnitte wieder trennen"
    >
      {parts}× · trennen
    </button>
  );
}

function SemanticView({
  result,
  effective,
  pending,
  onCellClick,
  onSplit,
}: {
  result: SemResult;
  effective: Effective;
  pending: { side: "ref" | "hyp"; idx: number } | null;
  onCellClick: (side: "ref" | "hyp", idx: number) => void;
  onSplit: (side: "ref" | "hyp", idx: number) => void;
}) {
  return (
    <div className="grid grid-cols-2 text-[14px] leading-relaxed text-[#2d3748]">
      {result.rows.map((row, r) => {
        const tint = SEM_TINT[row.kind];
        const leftClickable = row.refIdx != null;
        const rightClickable = row.hypIdx != null;
        const leftPending = pending?.side === "ref" && pending.idx === row.refIdx;
        const rightPending = pending?.side === "hyp" && pending.idx === row.hypIdx;
        const leftParts = row.refIdx != null ? effective.refParts[row.refIdx] : 1;
        const rightParts = row.hypIdx != null ? effective.hypParts[row.hypIdx] : 1;
        return (
          <Fragment key={r}>
            <div
              onClick={leftClickable ? () => onCellClick("ref", row.refIdx!) : undefined}
              className={`flex items-start gap-2 border-t border-gray-100 px-3 py-2 ${tint} ${
                row.anchored ? "border-l-2 border-l-[hsl(41,75%,55%)]" : ""
              } ${leftClickable ? "cursor-pointer hover:brightness-95" : ""} ${
                leftPending ? "ring-2 ring-inset ring-[hsl(41,75%,55%)]" : ""
              }`}
            >
              {row.anchored && <AnchorPin />}
              <span className="flex-1">
                {row.ref ?? (
                  <span className="italic text-gray-400">— im Transkript ergänzt —</span>
                )}
              </span>
              <MergeTag parts={leftParts} onSplit={() => onSplit("ref", row.refIdx!)} />
            </div>
            <div
              onClick={rightClickable ? () => onCellClick("hyp", row.hypIdx!) : undefined}
              className={`flex items-start gap-2 border-l border-t border-gray-100 px-3 py-2 ${tint} ${
                rightClickable ? "cursor-pointer hover:brightness-95" : ""
              } ${rightPending ? "ring-2 ring-inset ring-[hsl(41,75%,55%)]" : ""}`}
            >
              <span className="flex-1">
                {row.hyp ?? (
                  <span className="italic text-gray-400">
                    — im Transkript ausgelassen —
                  </span>
                )}
              </span>
              <MergeTag parts={rightParts} onSplit={() => onSplit("hyp", row.hypIdx!)} />
              {row.score != null && (
                <span
                  className={`shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${SEM_BADGE[row.kind]}`}
                  title="Semantische Ähnlichkeit"
                >
                  {Math.round(row.score * 100)}%
                </span>
              )}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

export default function Home() {
  const [baseline, setBaseline] = useState("");
  const [transcript, setTranscript] = useState("");
  const [baselineFile, setBaselineFile] = useState<string | null>(null);
  const [transcriptFile, setTranscriptFile] = useState<string | null>(null);
  const [lowercase, setLowercase] = useState(true);
  const [stripPunctuation, setStripPunctuation] = useState(true);
  const [ignoreRaw, setIgnoreRaw] = useState("");
  const [ignoreTimestamps, setIgnoreTimestamps] = useState(false);
  const [result, setResult] = useState<WerResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [computing, setComputing] = useState(false);

  const [semData, setSemData] = useState<SemData | null>(null);
  // Anchors store RAW representative indices; merges store glued boundaries.
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [refGlue, setRefGlue] = useState<number[]>([]);
  const [hypGlue, setHypGlue] = useState<number[]>([]);
  const [pendingAnchor, setPendingAnchor] = useState<{
    side: "ref" | "hyp";
    idx: number; // effective unit index
  } | null>(null);
  const [semProgress, setSemProgress] = useState<ProgressInfo | null>(null);
  const [semError, setSemError] = useState<string | null>(null);
  const [semHint, setSemHint] = useState<string | null>(null);

  // Effective units after merges, then the alignment honouring anchors. Both
  // are pure derivations of the cached embeddings — instant, no model run.
  const effective = useMemo<Effective | null>(
    () =>
      semData && semData.refVecs.length === semData.refDisplays.length
        ? buildEffective(semData, refGlue, hypGlue)
        : null,
    [semData, refGlue, hypGlue]
  );
  const semResult = useMemo<SemResult | null>(() => {
    if (!effective) return null;
    const effAnchors = anchors.map((a) => ({
      refIdx: effective.refOf[a.refIdx],
      hypIdx: effective.hypOf[a.hypIdx],
    }));
    return alignWithAnchors(effective.eff, effAnchors);
  }, [effective, anchors]);

  const compute = useCallback(() => {
    setError(null);
    setComputing(true);
    // Let the browser paint the "computing" state before the synchronous DP runs
    setTimeout(() => {
      try {
        const ignoreTerms = ignoreRaw.split("\n").map((s) => s.trim()).filter(Boolean);
        const opts = { lowercase, stripPunctuation, ignoreTerms, ignoreTimestamps };
        const refTokens = tokenize(baseline, opts);
        const hypTokens = tokenize(transcript, opts);
        setResult(calculateWer(refTokens, hypTokens));
      } catch (e) {
        setResult(null);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setComputing(false);
      }
    }, 20);
  }, [baseline, transcript, lowercase, stripPunctuation, ignoreRaw, ignoreTimestamps]);

  // Re-run with new normalization settings if a result is already shown
  const hasResult = result !== null;
  useEffect(() => {
    if (hasResult) compute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lowercase, stripPunctuation, ignoreRaw, ignoreTimestamps]);

  const semBusy = semProgress !== null;
  const runSemantic = useCallback(async () => {
    setSemError(null);
    setSemData(null);
    setSemProgress({ label: "Initialisiere …", pct: null });
    try {
      const ignoreTerms = ignoreRaw
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const opts = { lowercase, stripPunctuation, ignoreTerms, ignoreTimestamps };
      const data = await semanticCompare(baseline, transcript, opts, (info) =>
        setSemProgress(info)
      );
      setSemData(data);
      setAnchors([]);
      setRefGlue([]);
      setHypGlue([]);
      setPendingAnchor(null);
      setSemHint(null);
    } catch (e) {
      setSemError(e instanceof Error ? e.message : String(e));
    } finally {
      setSemProgress(null);
    }
  }, [baseline, transcript, ignoreRaw, ignoreTimestamps, lowercase, stripPunctuation]);

  // Click handling on effective units (rows):
  //  • opposite side  → fix a horizontal anchor (these two correspond)
  //  • same side, adjacent → merge them into one section (vertical anchor)
  //  • on an anchored unit → release the anchor
  const handleAnchorClick = useCallback(
    (side: "ref" | "hyp", idx: number) => {
      if (!effective) return;
      setSemHint(null);
      const ofMap = side === "ref" ? effective.refOf : effective.hypOf;
      const isAnchored = anchors.some(
        (a) => ofMap[side === "ref" ? a.refIdx : a.hypIdx] === idx
      );
      if (isAnchored) {
        setAnchors((prev) =>
          prev.filter(
            (a) => ofMap[side === "ref" ? a.refIdx : a.hypIdx] !== idx
          )
        );
        setPendingAnchor(null);
        return;
      }
      if (!pendingAnchor) {
        setPendingAnchor({ side, idx });
        return;
      }
      if (pendingAnchor.side === side) {
        if (pendingAnchor.idx === idx) {
          setPendingAnchor(null);
          return;
        }
        if (Math.abs(pendingAnchor.idx - idx) === 1) {
          // Merge the two adjacent units: glue the boundary between them.
          const upper = Math.min(pendingAnchor.idx, idx);
          const ends = side === "ref" ? effective.refEnds : effective.hypEnds;
          const boundary = ends[upper];
          const setGlue = side === "ref" ? setRefGlue : setHypGlue;
          setGlue((prev) =>
            prev.includes(boundary) ? prev : [...prev, boundary]
          );
          setPendingAnchor(null);
          return;
        }
        setPendingAnchor({ side, idx });
        return;
      }
      // Opposite side → anchor. Store RAW representative indices so the anchor
      // survives later merges.
      const refEff = side === "ref" ? idx : pendingAnchor.idx;
      const hypEff = side === "hyp" ? idx : pendingAnchor.idx;
      const candidate = {
        refIdx: effective.refReps[refEff],
        hypIdx: effective.hypReps[hypEff],
      };
      if (!isValidAnchorSet([...anchors, candidate])) {
        setSemHint(
          "Diese Zuordnung kreuzt eine bestehende — Anker müssen die Reihenfolge wahren."
        );
        setPendingAnchor(null);
        return;
      }
      setAnchors((prev) => [...prev, candidate]);
      setPendingAnchor(null);
    },
    [anchors, pendingAnchor, effective]
  );

  // Undo a merge: drop every glued boundary inside this effective unit's range.
  const handleSplit = useCallback(
    (side: "ref" | "hyp", idx: number) => {
      if (!effective) return;
      const lo = (side === "ref" ? effective.refReps : effective.hypReps)[idx];
      const hi = (side === "ref" ? effective.refEnds : effective.hypEnds)[idx];
      const setGlue = side === "ref" ? setRefGlue : setHypGlue;
      setGlue((prev) => prev.filter((b) => b < lo || b >= hi));
      setPendingAnchor(null);
    },
    [effective]
  );

  // Inputs / ignore settings changed → discard the (now stale) embeddings so the
  // user re-runs the model. Anchors/merges only make sense for one embedding set.
  useEffect(() => {
    setSemData(null);
    setAnchors([]);
    setRefGlue([]);
    setHypGlue([]);
    setPendingAnchor(null);
    setSemError(null);
    setSemHint(null);
  }, [baseline, transcript, ignoreRaw, ignoreTimestamps, lowercase, stripPunctuation]);

  const canCompute = baseline.trim().length > 0 && transcript.trim().length > 0;

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <header className="border-b border-gray-200">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-baseline gap-3">
            <span className="text-lg font-bold tracking-tight text-[#1a1a1a]">
              WER Calculator
            </span>
            <span className="hidden text-sm text-[#718096] sm:inline">
              Transcript quality benchmarking
            </span>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="https://muehlemann.com/img/muehlemann+popp.svg"
            alt="mühlemann+popp"
            className="h-7"
          />
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 pb-16">
        <section className="py-10">
          <h1
            className="text-4xl text-[#1a1a1a]"
            style={{
              fontFamily: "var(--font-source-serif)",
              fontStyle: "italic",
            }}
          >
            Word Error Rate
          </h1>
          <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-[#718096]">
            Compare a transcript against its baseline (ground truth) document.
            The tool aligns both texts word by word using Levenshtein distance
            and highlights every substitution, deletion, and insertion.
          </p>
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <DocumentPanel
            title="Baseline"
            description="Reference / ground-truth document"
            value={baseline}
            onChange={(v) => {
              setBaseline(v);
              setBaselineFile(null);
            }}
            fileName={baselineFile}
            onFile={(name, text) => {
              setBaseline(text);
              setBaselineFile(name);
            }}
          />
          <DocumentPanel
            title="Transcript"
            description="Hypothesis to evaluate (e.g. Whisper output)"
            value={transcript}
            onChange={(v) => {
              setTranscript(v);
              setTranscriptFile(null);
            }}
            fileName={transcriptFile}
            onFile={(name, text) => {
              setTranscript(text);
              setTranscriptFile(name);
            }}
          />
        </section>

        <section className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-4 rounded-xl border border-gray-200 bg-[#f7fafc] px-5 py-4">
          <Switch isSelected={lowercase} onChange={setLowercase} size="sm">
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Switch.Content>
              <span className="text-sm text-[#2d3748]">Ignore case</span>
            </Switch.Content>
          </Switch>
          <Switch
            isSelected={stripPunctuation}
            onChange={setStripPunctuation}
            size="sm"
          >
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Switch.Content>
              <span className="text-sm text-[#2d3748]">Ignore punctuation</span>
            </Switch.Content>
          </Switch>
          <div className="ml-auto flex items-center gap-3">
            <Button
              size="sm"
              variant="ghost"
              onPress={() => {
                setBaseline(EXAMPLE_BASELINE);
                setTranscript(EXAMPLE_TRANSCRIPT);
                setBaselineFile(null);
                setTranscriptFile(null);
              }}
            >
              Load example
            </Button>
            <Button
              variant="primary"
              isDisabled={!canCompute || computing}
              onPress={compute}
            >
              {computing ? "Computing…" : "Calculate WER"}
            </Button>
          </div>
        </section>

        <section className="mt-4 rounded-xl border border-gray-200 bg-[#f7fafc] px-5 py-4">
          <div className="flex flex-wrap gap-6 items-start">
            <div className="flex-1 min-w-48">
              <label className="block text-sm font-medium text-[#2d3748] mb-1">
                Wörter ignorieren
              </label>
              <p className="mt-0.5 mb-2 text-xs text-[#718096]">
                Ein Begriff pro Zeile — Gross-/Kleinschreibung und Satzzeichen werden automatisch angeglichen
              </p>
              <textarea
                value={ignoreRaw}
                onChange={(e) => setIgnoreRaw(e.target.value)}
                spellCheck={false}
                className="w-full h-24 rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-[13px] text-[#1a1a1a] resize-y outline-none focus:ring-2 focus:ring-[hsl(41,75%,61%)] focus:border-[hsl(41,75%,61%)]"
                placeholder={"Interviewer\nRolf Meier\nModeratorin"}
              />
            </div>
            <div className="pt-7">
              <Switch
                isSelected={ignoreTimestamps}
                onChange={setIgnoreTimestamps}
                size="sm"
              >
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
                <Switch.Content>
                  <span className="text-sm text-[#2d3748]">
                    Zeitstempel ignorieren (z.B. 08:19AM)
                  </span>
                </Switch.Content>
              </Switch>
            </div>
          </div>
        </section>

        {error && (
          <section className="mt-6 rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-800">
            {error}
          </section>
        )}

        {result && (
          <>
            <section className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
              <MetricTile
                label="WER"
                value={`${(result.wer * 100).toFixed(1)}%`}
                highlight
              />
              <MetricTile
                label="Accuracy"
                value={`${(result.accuracy * 100).toFixed(1)}%`}
              />
              <MetricTile
                label="Substitutions"
                value={result.substitutions.toLocaleString()}
              />
              <MetricTile
                label="Deletions"
                value={result.deletions.toLocaleString()}
              />
              <MetricTile
                label="Insertions"
                value={result.insertions.toLocaleString()}
              />
              <MetricTile
                label="Ref words"
                value={result.refWordCount.toLocaleString()}
              />
            </section>

            <section className="mt-8 rounded-xl border border-gray-200 bg-white shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[hsl(41,75%,85%)] px-5 py-4">
                <h2 className="text-base font-semibold text-[#2d3748]">
                  Word-level diff
                </h2>
                <div className="flex flex-wrap gap-4">
                  <LegendItem
                    swatchClass="bg-[hsl(41,75%,88%)]"
                    label="Geändert"
                  />
                  <LegendItem
                    swatchClass="bg-red-100"
                    label="Nur in Baseline (fehlt)"
                  />
                  <LegendItem
                    swatchClass="bg-emerald-100"
                    label="Nur im Transkript (zusätzlich)"
                  />
                  {result.ignoredRefWords > 0 && (
                    <span className="inline-flex items-center gap-1.5 text-xs text-[#718096]">
                      <span className="text-gray-300 font-semibold">Wort</span>
                      Ignoriert ({result.ignoredRefWords.toLocaleString()})
                    </span>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-2 border-b border-gray-100 px-6 py-2 text-xs font-medium uppercase tracking-wide text-[#718096]">
                <div className="pr-4">Baseline</div>
                <div className="border-l border-gray-100 pl-4">Transkript</div>
              </div>
              <div className="h-[32rem] min-h-48 resize-y overflow-auto px-6 py-2">
                <DiffView ops={result.ops} />
              </div>
            </section>
          </>
        )}

        {canCompute && (
          <section className="mt-8 rounded-xl border border-gray-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-4">
              <div>
                <h2 className="text-base font-semibold text-[#2d3748]">
                  Semantischer Vergleich
                </h2>
                <p className="mt-0.5 text-sm text-[#718096]">
                  Vergleicht satzweise die <em>Bedeutung</em> statt der Wörter —
                  erkennt Umformulierungen, Auslassungen und sinnverändernde
                  Stellen.
                </p>
              </div>
              <Button
                variant="primary"
                isDisabled={semBusy}
                onPress={runSemantic}
              >
                {semBusy
                  ? "Analysiere …"
                  : semResult
                    ? "Neu berechnen"
                    : "Semantischen Vergleich starten"}
              </Button>
            </div>

            {!semResult && !semBusy && !semError && (
              <p className="px-5 py-4 text-xs text-[#718096]">
                Beim ersten Start wird ein Sprachmodell (~120 MB) in den Browser
                geladen und dort zwischengespeichert. Alles läuft lokal — es
                verlässt nichts deinen Rechner.
              </p>
            )}

            {semBusy && (
              <div className="px-5 py-5">
                <div className="mb-2 flex items-center justify-between text-xs text-[#718096]">
                  <span>{semProgress?.label}</span>
                  {semProgress?.pct != null && <span>{semProgress.pct}%</span>}
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
                  <div
                    className={`h-full rounded-full bg-[hsl(41,75%,61%)] transition-all ${
                      semProgress?.pct == null ? "w-1/3 animate-pulse" : ""
                    }`}
                    style={
                      semProgress?.pct != null
                        ? { width: `${semProgress.pct}%` }
                        : undefined
                    }
                  />
                </div>
              </div>
            )}

            {semError && (
              <p className="px-5 py-4 text-sm text-red-800">
                Konnte das Modell nicht laden oder ausführen: {semError}
              </p>
            )}

            {semResult && effective && semResult.rows.length > 0 && (
              <>
                <div className="grid grid-cols-2 gap-4 px-5 py-5 sm:grid-cols-3 lg:grid-cols-6">
                  <MetricTile
                    label="Ø Ähnlichkeit"
                    value={`${(semResult.meanSimilarity * 100).toFixed(0)}%`}
                    highlight
                  />
                  <MetricTile
                    label="Gleich"
                    value={semResult.rows
                      .filter((r) => r.kind === "same")
                      .length.toLocaleString()}
                  />
                  <MetricTile
                    label="Umformuliert"
                    value={semResult.rows
                      .filter((r) => r.kind === "reworded")
                      .length.toLocaleString()}
                  />
                  <MetricTile
                    label="Abweichend"
                    value={semResult.rows
                      .filter((r) => r.kind === "diverged")
                      .length.toLocaleString()}
                  />
                  <MetricTile
                    label="Ausgelassen"
                    value={semResult.omitted.toLocaleString()}
                  />
                  <MetricTile
                    label="Ergänzt"
                    value={semResult.added.toLocaleString()}
                  />
                </div>

                <div className="flex flex-wrap gap-4 border-t border-gray-100 px-5 py-3">
                  <LegendItem swatchClass="bg-emerald-50 border border-emerald-200" label="Gleiche Bedeutung" />
                  <LegendItem swatchClass="bg-[hsl(41,75%,90%)]" label="Umformuliert" />
                  <LegendItem swatchClass="bg-red-50 border border-red-200" label="Abweichend / fehlt / ergänzt" />
                  <LegendItem swatchClass="bg-[hsl(41,75%,55%)]" label="⚓ Verankert (fixe Zuordnung)" />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 bg-[#f7fafc] px-5 py-2.5 text-xs text-[#718096]">
                  <span>
                    {pendingAnchor
                      ? `Abschnitt gewählt — jetzt das Gegenstück ${
                          pendingAnchor.side === "ref" ? "rechts" : "links"
                        } anklicken (= zuordnen) oder den Nachbarn darüber/darunter (= verbinden). Nochmal klicken bricht ab.`
                      : "Klick einen Abschnitt und dann sein Gegenstück auf der anderen Seite (= fest zuordnen) oder einen direkten Nachbarn auf derselben Seite (= zu einem Abschnitt verbinden)."}
                  </span>
                  {(anchors.length > 0 || refGlue.length + hypGlue.length > 0) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onPress={() => {
                        setAnchors([]);
                        setRefGlue([]);
                        setHypGlue([]);
                        setPendingAnchor(null);
                      }}
                    >
                      Zurücksetzen
                    </Button>
                  )}
                </div>
                {semHint && (
                  <div className="border-t border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-800">
                    {semHint}
                  </div>
                )}

                <div className="grid grid-cols-2 border-y border-gray-100 px-5 py-2 text-xs font-medium uppercase tracking-wide text-[#718096]">
                  <div className="pr-4">Baseline</div>
                  <div className="border-l border-gray-100 pl-4">Transkript</div>
                </div>
                <div className="h-[32rem] min-h-48 resize-y overflow-auto px-5 py-2">
                  <SemanticView
                    result={semResult}
                    effective={effective}
                    pending={pendingAnchor}
                    onCellClick={handleAnchorClick}
                    onSplit={handleSplit}
                  />
                </div>
              </>
            )}

            {semResult && semResult.rows.length === 0 && (
              <p className="px-5 py-4 text-sm text-[#718096]">
                Keine Sätze zum Vergleichen gefunden.
              </p>
            )}
          </section>
        )}
      </main>

      <footer className="border-t border-gray-200 py-5">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 text-xs text-[#718096]">
          <span>
            WER = (substitutions + deletions + insertions) / words in baseline
          </span>
          <span>mühlemann+popp · PoC</span>
        </div>
      </footer>
    </div>
  );
}
