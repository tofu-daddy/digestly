import { transcribeUrlWithYtDlp } from "./transcribe.js";

const ANDROID_CLIENT = {
  clientName: "ANDROID",
  clientVersion: "20.10.38",
  androidSdkVersion: 34,
  hl: "en",
};

export function parseYouTubeId(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\.|^m\./, "");
  if (host === "youtu.be") return url.pathname.slice(1, 12) || null;
  if (host !== "youtube.com" && host !== "music.youtube.com") return null;
  if (url.searchParams.get("v")) return url.searchParams.get("v");
  const match = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
  return match ? match[1] : null;
}

async function fetchPlayer(videoId) {
  const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 14)",
    },
    body: JSON.stringify({ context: { client: ANDROID_CLIENT }, videoId }),
  });
  if (!res.ok) throw new Error(`YouTube returned ${res.status} for this video.`);
  return res.json();
}

function pickTrack(tracks) {
  const isEn = (t) => t.languageCode?.startsWith("en");
  return (
    tracks.find((t) => isEn(t) && t.kind !== "asr") ||
    tracks.find((t) => isEn(t)) ||
    tracks.find((t) => t.kind !== "asr") ||
    tracks[0]
  );
}

async function fetchCaptions(track) {
  const url = track.baseUrl.replace(/&fmt=[^&]*/, "") + "&fmt=json3";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download captions (${res.status}).`);
  const data = await res.json();
  return (data.events || [])
    .filter((e) => e.segs)
    .map((e) => ({
      start: e.tStartMs / 1000,
      text: e.segs.map((s) => s.utf8).join("").replace(/\s+/g, " ").trim(),
    }))
    .filter((s) => s.text);
}

export async function getYouTubeTranscript(videoId) {
  const player = await fetchPlayer(videoId);
  const status = player.playabilityStatus?.status;
  if (status && status !== "OK") {
    throw new Error(player.playabilityStatus?.reason || `Video is not available (${status}).`);
  }
  const details = player.videoDetails || {};
  const meta = {
    title: details.title || "YouTube video",
    author: details.author,
    durationSeconds: Number(details.lengthSeconds) || undefined,
    sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };

  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (tracks.length) {
    const track = pickTrack(tracks);
    const segments = await fetchCaptions(track);
    if (segments.length) {
      const method = track.kind === "asr" ? "YouTube auto-captions" : "YouTube captions";
      return { ...meta, segments, method: `${method} (${track.languageCode})` };
    }
  }

  const segments = await transcribeUrlWithYtDlp(meta.sourceUrl);
  return { ...meta, segments, method: "Speech-to-text (Whisper)" };
}
