import "dotenv/config";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import { getPodcastTranscript } from "./lib/podcast.js";
import { summarize } from "./lib/summarize.js";
import { transcribeFile } from "./lib/transcribe.js";
import { formatTimestamp, hasTimestamps, wordCount } from "./lib/transcript.js";
import { getYouTubeTranscript, parseYouTubeId } from "./lib/youtube.js";

const PORT = Number(process.env.PORT) || 5055;
const MAX_CACHE = 50;
const root = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const upload = multer({ dest: tmpdir(), limits: { fileSize: 500 * 1024 * 1024 } });
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const transcripts = new Map();
const digests = new Map();

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.set({
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST",
      "Access-Control-Allow-Headers": "Content-Type",
      Vary: "Origin",
    });
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json());
app.use(express.static(path.join(root, "public")));

function remember(transcript) {
  const id = randomUUID();
  transcripts.set(id, transcript);
  if (transcripts.size > MAX_CACHE) transcripts.delete(transcripts.keys().next().value);
  return id;
}

function describe(id, t) {
  return {
    id,
    title: t.title,
    author: t.author,
    sourceUrl: t.sourceUrl,
    method: t.method,
    durationSeconds: t.durationSeconds,
    wordCount: wordCount(t.segments),
    hasTimestamps: hasTimestamps(t.segments),
  };
}

const hasCommand = (cmd) => !spawnSync(cmd, ["-version"], { stdio: "ignore" }).error;

app.get("/api/health", (_req, res) => {
  res.json({
    gemini: Boolean(process.env.GEMINI_API_KEY),
    openai: Boolean(process.env.OPENAI_API_KEY),
    ffmpeg: hasCommand("ffmpeg"),
    ytDlp: hasCommand("yt-dlp"),
  });
});

app.post("/api/transcript", async (req, res) => {
  const { url, episodeId } = req.body || {};
  try {
    if (!url || !/^https?:\/\//i.test(url.trim())) throw new Error("Paste a full http(s) link.");
    const clean = url.trim();
    const videoId = parseYouTubeId(clean);
    const result = videoId ? await getYouTubeTranscript(videoId) : await getPodcastTranscript(clean, episodeId);
    if (result.needsEpisode) return res.json(result);
    if (!result.segments?.length) throw new Error("The transcript came back empty.");
    res.json(describe(remember(result), result));
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/transcript/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file was uploaded." });
  try {
    const segments = await transcribeFile(req.file.path, req.file.originalname);
    const transcript = {
      title: req.file.originalname.replace(/\.[^.]+$/, ""),
      segments,
      method: "Speech-to-text (Whisper)",
    };
    res.json(describe(remember(transcript), transcript));
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  } finally {
    unlink(req.file.path).catch(() => {});
  }
});

app.get("/api/transcript/:id.txt", (req, res) => {
  const t = transcripts.get(req.params.id);
  if (!t) return res.status(404).send("Transcript expired. Run it again.");
  const lines = t.segments.map((s) => (s.start != null ? `[${formatTimestamp(s.start)}] ${s.text}` : s.text));
  res.type("text/plain").send(`${t.title}\n\n${lines.join("\n")}\n`);
});

app.post("/api/summarize", async (req, res) => {
  const { id, length = "medium" } = req.body || {};
  const transcript = transcripts.get(id);
  if (!transcript) return res.status(404).json({ error: "Transcript expired. Run it again." });
  const key = `${id}:${length}`;
  try {
    if (!digests.has(key)) {
      digests.set(key, await summarize(transcript, length));
      if (digests.size > MAX_CACHE * 3) digests.delete(digests.keys().next().value);
    }
    res.json(digests.get(key));
  } catch (err) {
    console.error(err);
    res.status(err.status && err.status < 500 ? 400 : 502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Digest running at http://localhost:${PORT}`);
});
