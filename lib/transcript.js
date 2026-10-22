export function formatTimestamp(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return null;
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function parseClock(value) {
  const parts = value.trim().replace(",", ".").split(":").map(Number);
  return parts.reduce((total, n) => total * 60 + n, 0);
}

export function parseCaptionFile(text) {
  const segments = [];
  const blocks = text.replace(/\r/g, "").split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((l) => l.includes("-->"));
    if (timingIndex === -1) continue;
    const start = parseClock(lines[timingIndex].split("-->")[0]);
    const body = lines
      .slice(timingIndex + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (body) segments.push({ start, text: body });
  }
  return segments;
}

export function parseJsonTranscript(data) {
  const items = Array.isArray(data) ? data : data.segments || [];
  return items
    .map((s) => ({ start: Number(s.startTime ?? s.start ?? NaN), text: String(s.body ?? s.text ?? "").trim() }))
    .map((s) => ({ ...s, start: Number.isNaN(s.start) ? null : s.start }))
    .filter((s) => s.text);
}

export function hasTimestamps(segments) {
  return segments.some((s) => s.start != null && s.start > 0);
}

export function toPromptText(segments, windowSeconds = 30) {
  if (!hasTimestamps(segments)) return segments.map((s) => s.text).join(" ");
  const lines = [];
  let current = null;
  for (const seg of segments) {
    if (!current || seg.start - current.start >= windowSeconds) {
      current = { start: seg.start, parts: [] };
      lines.push(current);
    }
    current.parts.push(seg.text);
  }
  return lines.map((l) => `[${formatTimestamp(l.start)}] ${l.parts.join(" ")}`).join("\n");
}

export function wordCount(segments) {
  return segments.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
}
