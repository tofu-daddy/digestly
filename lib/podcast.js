import { XMLParser } from "fast-xml-parser";
import { transcribeRemoteAudio } from "./transcribe.js";
import { parseCaptionFile, parseJsonTranscript } from "./transcript.js";

const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|mp4|m4v|mov|webm)(\?|$)/i;
const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Digest/0.1" };

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const textOf = (v) => (v && typeof v === "object" ? v["#text"] ?? "" : v ?? "");

function parseDuration(value) {
  if (!value) return undefined;
  const str = String(value);
  if (/^\d+$/.test(str)) return Number(str);
  return str.split(":").map(Number).reduce((t, n) => t * 60 + n, 0) || undefined;
}

function episodeFromItem(item, index) {
  const enclosure = asArray(item.enclosure)[0];
  return {
    id: String(textOf(item.guid) || enclosure?.["@_url"] || index),
    title: String(textOf(item.title) || `Episode ${index + 1}`),
    published: item.pubDate ? String(item.pubDate) : undefined,
    durationSeconds: parseDuration(item["itunes:duration"]),
    audioUrl: enclosure?.["@_url"],
    transcripts: asArray(item["podcast:transcript"]).map((t) => ({ url: t["@_url"], type: t["@_type"] || "" })),
    link: item.link ? String(textOf(item.link)) : undefined,
  };
}

function parseFeed(body) {
  const doc = xml.parse(body);
  const channel = doc.rss?.channel;
  if (!channel) throw new Error("That URL looks like XML but not a podcast RSS feed.");
  return {
    title: String(textOf(channel.title) || "Podcast"),
    episodes: asArray(channel.item).map(episodeFromItem).filter((e) => e.audioUrl),
  };
}

async function fetchPublishedTranscript(transcripts) {
  const rank = (t) =>
    /vtt/.test(t.type) ? 0 : /subrip|srt/.test(t.type) ? 1 : /json/.test(t.type) ? 2 : 9;
  for (const t of [...transcripts].sort((a, b) => rank(a) - rank(b))) {
    if (rank(t) === 9) continue;
    try {
      const res = await fetch(t.url, { headers: UA });
      if (!res.ok) continue;
      const segments = /json/.test(t.type) ? parseJsonTranscript(await res.json()) : parseCaptionFile(await res.text());
      if (segments.length) return segments;
    } catch {
      continue;
    }
  }
  return null;
}

async function transcribeEpisode(episode, showTitle, sourceUrl) {
  const meta = {
    title: episode.title,
    author: showTitle,
    durationSeconds: episode.durationSeconds,
    sourceUrl: episode.link || sourceUrl,
  };
  const published = await fetchPublishedTranscript(episode.transcripts);
  if (published) return { ...meta, segments: published, method: "Published podcast transcript" };
  const segments = await transcribeRemoteAudio(episode.audioUrl);
  return { ...meta, segments, method: "Speech-to-text (Whisper)" };
}

async function resolveApplePodcasts(url) {
  const episodeId = url.searchParams.get("i");
  const showId = url.pathname.match(/id(\d+)/)?.[1];
  if (!showId) return null;
  const res = await fetch(`https://itunes.apple.com/lookup?id=${showId}&entity=podcastEpisode&limit=200`);
  const data = await res.json();
  const show = data.results?.find((r) => r.kind === "podcast" || r.wrapperType === "track");
  if (!episodeId) return show?.feedUrl ? { feedUrl: show.feedUrl } : null;
  const ep = data.results?.find((r) => String(r.trackId) === episodeId);
  if (show?.feedUrl && ep) return { feedUrl: show.feedUrl, matchTitle: ep.trackName, audioUrl: ep.episodeUrl };
  return ep?.episodeUrl ? { audioUrl: ep.episodeUrl, title: ep.trackName } : null;
}

function findAudioInHtml(html, base) {
  const patterns = [
    /<meta[^>]+property=["']og:audio(?::url)?["'][^>]+content=["']([^"']+)/i,
    /<audio[^>]+src=["']([^"']+)/i,
    /<source[^>]+src=["']([^"']+\.(?:mp3|m4a|aac|ogg|opus)[^"']*)/i,
    /["'](https?:\/\/[^"']+\.(?:mp3|m4a)(?:\?[^"']*)?)["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return new URL(m[1].replace(/&amp;/g, "&"), base).href;
  }
  return null;
}

function findFeedInHtml(html, base) {
  const m = html.match(/<link[^>]+type=["']application\/rss\+xml["'][^>]+href=["']([^"']+)/i);
  return m ? new URL(m[1], base).href : null;
}

async function loadFeed(feedUrl) {
  const res = await fetch(feedUrl, { headers: UA });
  if (!res.ok) throw new Error(`Could not load the RSS feed (${res.status}).`);
  return parseFeed(await res.text());
}

export async function getPodcastTranscript(input, episodeId) {
  const url = new URL(input);

  if (/spotify\.com$/.test(url.hostname)) {
    throw new Error("Spotify doesn't expose episode audio. Paste the show's RSS feed or an Apple Podcasts link instead.");
  }

  let feedUrl = null;
  let matchTitle = null;

  if (url.hostname === "podcasts.apple.com") {
    const apple = await resolveApplePodcasts(url);
    if (!apple) throw new Error("Couldn't find that Apple Podcasts episode.");
    if (apple.feedUrl) {
      feedUrl = apple.feedUrl;
      matchTitle = apple.matchTitle;
    } else {
      const segments = await transcribeRemoteAudio(apple.audioUrl);
      return { title: apple.title, sourceUrl: input, segments, method: "Speech-to-text (Whisper)" };
    }
  } else if (AUDIO_EXT.test(url.pathname)) {
    const segments = await transcribeRemoteAudio(input);
    return { title: decodeURIComponent(url.pathname.split("/").pop()), sourceUrl: input, segments, method: "Speech-to-text (Whisper)" };
  } else {
    const res = await fetch(input, { headers: UA });
    if (!res.ok) throw new Error(`Could not load that URL (${res.status}).`);
    const type = res.headers.get("content-type") || "";
    if (/^(audio|video)\//.test(type)) {
      const segments = await transcribeRemoteAudio(input);
      return { title: "Audio", sourceUrl: input, segments, method: "Speech-to-text (Whisper)" };
    }
    const body = await res.text();
    if (/xml/.test(type) || /^\s*(<\?xml|<rss)/.test(body)) {
      feedUrl = input;
    } else {
      const audioUrl = findAudioInHtml(body, res.url);
      if (audioUrl) {
        const title = body.match(/<title>([^<]+)/i)?.[1]?.trim() || "Episode";
        const segments = await transcribeRemoteAudio(audioUrl);
        return { title, sourceUrl: input, segments, method: "Speech-to-text (Whisper)" };
      }
      feedUrl = findFeedInHtml(body, res.url);
      if (!feedUrl) throw new Error("Couldn't find any audio or podcast feed on that page.");
    }
  }

  const feed = await loadFeed(feedUrl);
  if (!feed.episodes.length) throw new Error("That feed has no playable episodes.");

  let episode = episodeId ? feed.episodes.find((e) => e.id === episodeId) : null;
  if (!episode && matchTitle) episode = feed.episodes.find((e) => e.title === matchTitle);
  if (!episode) {
    return {
      needsEpisode: true,
      feedUrl,
      show: feed.title,
      episodes: feed.episodes.slice(0, 100).map(({ id, title, published, durationSeconds }) => ({
        id,
        title,
        published,
        durationSeconds,
      })),
    };
  }
  return transcribeEpisode(episode, feed.title, input);
}
