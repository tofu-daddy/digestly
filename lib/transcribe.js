import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const WHISPER_LIMIT_BYTES = 24 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) =>
      reject(err.code === "ENOENT" ? Object.assign(new Error(`${cmd} not found`), { missing: cmd }) : err),
    );
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} failed: ${stderr.trim().split("\n").pop()}`)),
    );
  });
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "digest-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function shrinkForWhisper(file, dir) {
  const { size } = await stat(file);
  if (size <= WHISPER_LIMIT_BYTES) return file;
  const out = path.join(dir, "compressed.mp3");
  try {
    await run("ffmpeg", ["-y", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "24k", out]);
  } catch (err) {
    if (err.missing) {
      throw new Error(
        `This file is ${(size / 1048576).toFixed(0)} MB, over the 25 MB speech-to-text limit. Install ffmpeg so Digest can compress it automatically.`,
      );
    }
    throw err;
  }
  if ((await stat(out)).size > WHISPER_LIMIT_BYTES) {
    throw new Error("This recording is too long to transcribe in one pass (over roughly 2 hours).");
  }
  return out;
}

export async function transcribeFile(file, filename = path.basename(file)) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error("No captions or published transcript were found, and transcribing audio needs OPENAI_API_KEY set in .env.");
  }
  return withTempDir(async (dir) => {
    const input = await shrinkForWhisper(file, dir);
    const name = input === file ? filename : "audio.mp3";
    const form = new FormData();
    form.append("file", new Blob([await readFile(input)]), name);
    form.append("model", process.env.WHISPER_MODEL || "whisper-1");
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Speech-to-text failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    if (data.segments?.length) {
      return data.segments.map((s) => ({ start: s.start, text: s.text.trim() }));
    }
    return [{ start: null, text: data.text }];
  });
}

export async function transcribeRemoteAudio(url) {
  return withTempDir(async (dir) => {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`Could not download audio (${res.status}).`);
    const length = Number(res.headers.get("content-length"));
    if (length > MAX_DOWNLOAD_BYTES) throw new Error("Audio file is larger than 500 MB.");
    const buffer = Buffer.from(await res.arrayBuffer());
    const ext = path.extname(new URL(res.url || url).pathname) || ".mp3";
    const file = path.join(dir, `episode${ext}`);
    await writeFile(file, buffer);
    return transcribeFile(file);
  });
}

export async function transcribeUrlWithYtDlp(url) {
  return withTempDir(async (dir) => {
    const out = path.join(dir, "audio.%(ext)s");
    try {
      await run("yt-dlp", ["-f", "bestaudio[ext=m4a]/bestaudio", "-o", out, "--no-playlist", url]);
    } catch (err) {
      if (err.missing) {
        throw new Error("This video has no captions. Install yt-dlp so Digest can download the audio and transcribe it.");
      }
      throw err;
    }
    const [file] = (await readdir(dir)).filter((f) => f.startsWith("audio."));
    if (!file) throw new Error("yt-dlp did not produce an audio file.");
    return transcribeFile(path.join(dir, file));
  });
}
