# Digest

Paste a YouTube link, a podcast episode, an RSS feed, or upload an audio/video file, and get a Cliffsnotes-style digest: a one-paragraph overview, key takeaways, notable quotes, and timestamped sections.

## How it works

1. **Transcript.** Digest uses existing text first and only falls back to speech-to-text when it has to.
   - YouTube: the video's captions (manual captions preferred, then auto-captions). If a video has none, it downloads the audio with `yt-dlp` and transcribes it.
   - Podcasts: RSS feeds, Apple Podcasts links, episode pages, or direct audio URLs. If the feed publishes a transcript (`<podcast:transcript>`), that is used; otherwise the episode audio is transcribed.
   - Uploads: transcribed with OpenAI Whisper.
2. **Digest.** The transcript is summarized by Google Gemini (`gemini-flash-latest`) into structured JSON, rendered in the page. Switching between Short, Medium, and Detailed re-summarizes the same transcript without fetching it again.

## Setup

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env
```

Then fill in `.env`:

| Variable | Required | Used for |
| --- | --- | --- |
| `GEMINI_API_KEY` | Yes | Writing the digest (free key from Google AI Studio) |
| `OPENAI_API_KEY` | For audio | Speech-to-text on uploads and sources without captions or transcripts |
| `GEMINI_MODEL` | No | Override the summarization model (default `gemini-flash-latest`) |
| `WHISPER_MODEL` | No | Override the transcription model (default `whisper-1`) |
| `PORT` | No | Server port (default `5055`) |

Optional tools, used when installed:

- `ffmpeg` compresses audio larger than Whisper's 25 MB upload limit (recordings up to roughly 2 hours).
- `yt-dlp` downloads audio for YouTube videos that have no captions.

On macOS: `brew install ffmpeg yt-dlp`.

## Run

```bash
npm start
```

Open http://localhost:5055. Use `npm run dev` to restart automatically on file changes.

## Notes and limits

- Transcripts and digests are cached in memory only and are lost on restart.
- Spotify links are not supported because Spotify does not expose episode audio. Use the show's RSS feed or Apple Podcasts link instead.
- Timestamps in sections link straight to that moment for YouTube videos.
