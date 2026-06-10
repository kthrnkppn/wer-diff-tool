/**
 * Extract plain spoken text from an uploaded file. Subtitle formats
 * (.srt / .vtt) have cue numbers, timestamps, and markup stripped.
 */
export function extractText(filename: string, content: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".srt") || lower.endsWith(".vtt")) {
    return content
      .split(/\r?\n/)
      .filter((line) => {
        const t = line.trim();
        if (!t) return false;
        if (t.startsWith("WEBVTT")) return false;
        if (/^\d+$/.test(t)) return false;
        if (t.includes("-->")) return false;
        if (/^(NOTE|STYLE|REGION)\b/.test(t)) return false;
        return true;
      })
      .map((line) => line.replace(/<[^>]+>/g, "").trim())
      .join(" ");
  }
  return content;
}
