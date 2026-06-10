"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Switch } from "@heroui/react";
import {
  calculateWer,
  tokenize,
  type AlignmentOp,
  type WerResult,
} from "@/lib/wer";
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

function DocumentPanel({
  title,
  description,
  value,
  onChange,
  fileName,
  onFile,
}: PanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
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
          accept=".txt,.srt,.vtt,.md,text/plain"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const text = await file.text();
            onFile(file.name, extractText(file.name, text));
            e.target.value = "";
          }}
        />
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Paste text here or upload a .txt / .srt / .vtt file…"
        spellCheck={false}
        className="h-56 w-full resize-y px-5 py-4 font-mono text-[13px] leading-relaxed text-[#1a1a1a] outline-none placeholder:text-gray-400 focus:bg-[hsl(41,75%,98%)]"
      />
      <div className="flex items-center justify-between border-t border-gray-100 px-5 py-2 text-xs text-[#718096]">
        <span>{wordCount.toLocaleString()} words</span>
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

function DiffView({ ops }: { ops: AlignmentOp[] }) {
  const nodes: React.ReactNode[] = [];
  let equalBuffer: string[] = [];

  const flushEquals = (key: string) => {
    if (equalBuffer.length > 0) {
      nodes.push(<span key={key}>{equalBuffer.join(" ")} </span>);
      equalBuffer = [];
    }
  };

  ops.forEach((op, idx) => {
    if (op.type === "equal") {
      equalBuffer.push(op.ref!);
      return;
    }
    flushEquals(`eq-${idx}`);
    if (op.type === "sub") {
      nodes.push(
        <span
          key={idx}
          className="rounded bg-[hsl(41,75%,88%)] px-1"
          title="Substitution"
        >
          <s className="text-[#9b2c2c]">{op.ref}</s>{" "}
          <span className="font-semibold text-[#1a1a1a]">{op.hyp}</span>
        </span>
      );
    } else if (op.type === "del") {
      nodes.push(
        <span
          key={idx}
          className="rounded bg-red-100 px-1 text-red-800 line-through decoration-red-400"
          title="Deletion (missing in transcript)"
        >
          {op.ref}
        </span>
      );
    } else {
      nodes.push(
        <span
          key={idx}
          className="rounded bg-emerald-100 px-1 text-emerald-800"
          title="Insertion (extra in transcript)"
        >
          {op.hyp}
        </span>
      );
    }
    nodes.push(" ");
  });
  flushEquals("eq-final");

  return <p className="text-[15px] leading-loose text-[#2d3748]">{nodes}</p>;
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

export default function Home() {
  const [baseline, setBaseline] = useState("");
  const [transcript, setTranscript] = useState("");
  const [baselineFile, setBaselineFile] = useState<string | null>(null);
  const [transcriptFile, setTranscriptFile] = useState<string | null>(null);
  const [lowercase, setLowercase] = useState(true);
  const [stripPunctuation, setStripPunctuation] = useState(true);
  const [result, setResult] = useState<WerResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [computing, setComputing] = useState(false);

  const compute = useCallback(() => {
    setError(null);
    setComputing(true);
    // Let the browser paint the "computing" state before the synchronous DP runs
    setTimeout(() => {
      try {
        const opts = { lowercase, stripPunctuation };
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
  }, [baseline, transcript, lowercase, stripPunctuation]);

  // Re-run with new normalization settings if a result is already shown
  const hasResult = result !== null;
  useEffect(() => {
    if (hasResult) compute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lowercase, stripPunctuation]);

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
                    label="Substitution (baseline → transcript)"
                  />
                  <LegendItem
                    swatchClass="bg-red-100"
                    label="Deletion (missing)"
                  />
                  <LegendItem
                    swatchClass="bg-emerald-100"
                    label="Insertion (extra)"
                  />
                </div>
              </div>
              <div className="max-h-[32rem] overflow-y-auto px-6 py-5">
                <DiffView ops={result.ops} />
              </div>
            </section>
          </>
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
