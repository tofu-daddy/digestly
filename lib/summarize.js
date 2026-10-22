import { GoogleGenAI } from "@google/genai";
import { formatTimestamp, hasTimestamps, toPromptText } from "./transcript.js";

const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";

const LENGTHS = {
  short: {
    overview: "2 to 3 sentences",
    takeaways: "3 to 5 takeaways, each a single crisp sentence",
    quotes: "1 to 2 quotes",
    sections: "3 to 4 sections, each summarized in one sentence",
  },
  medium: {
    overview: "4 to 5 sentences",
    takeaways: "6 to 8 takeaways, each one or two sentences",
    quotes: "3 to 4 quotes",
    sections: "4 to 6 sections, each summarized in one or two sentences",
  },
  detailed: {
    overview: "6 to 8 sentences",
    takeaways: "10 to 15 takeaways, each one to three sentences with the supporting reasoning or example",
    quotes: "5 to 6 quotes",
    sections: "6 to 10 sections, each summarized in two to three sentences",
  },
};

const SCHEMA = {
  type: "object",
  properties: {
    overview: { type: "string" },
    takeaways: { type: "array", items: { type: "string" } },
    quotes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          speaker: { type: "string" },
          timestamp: { type: "string" },
        },
        required: ["text", "speaker", "timestamp"],
        additionalProperties: false,
      },
    },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          timestamp: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
        },
        required: ["timestamp", "title", "summary"],
        additionalProperties: false,
      },
    },
  },
  required: ["overview", "takeaways", "quotes", "sections"],
  additionalProperties: false,
};

const SYSTEM = `You write Cliffsnotes-style digests of podcasts and videos from their transcripts. Readers use the digest to decide whether to watch or listen, and to remember what was said afterwards, so favor the specific claims, numbers, names, and recommendations from the content over generic description.

Write the overview as one paragraph of plain prose. Takeaways should each stand on their own and read as insights, not as topic labels. Quotes must be copied verbatim from the transcript (fix only obvious caption errors), chosen because they are memorable or capture a key idea. Use the speaker's name for a quote only when the transcript or metadata makes it clear, otherwise leave speaker empty.

When the transcript has [m:ss] or [h:mm:ss] markers, give each section and quote the timestamp where it begins in that same format, and order sections chronologically so they cover the whole recording. When there are no timestamps, leave every timestamp empty and return sections as an empty list.`;

let client;
function getClient() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set. Add it to your .env file and restart the server.");
  }
  client ??= new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: { retryOptions: { attempts: 4 } },
  });
  return client;
}

export async function summarize(transcript, length = "medium") {
  const spec = LENGTHS[length] || LENGTHS.medium;
  const timed = hasTimestamps(transcript.segments);
  const header = [
    `Title: ${transcript.title}`,
    transcript.author && `Channel or show: ${transcript.author}`,
    transcript.durationSeconds && `Duration: ${formatTimestamp(transcript.durationSeconds)}`,
  ]
    .filter(Boolean)
    .join("\n");

  const request = `${header}

<transcript>
${toPromptText(transcript.segments)}
</transcript>

Write the digest at this length:
- Overview: ${spec.overview}
- Key takeaways: ${spec.takeaways}
- Notable quotes: ${spec.quotes}
- Sections: ${timed ? spec.sections : "none, the transcript has no timestamps"}`;

  const response = await getClient().models.generateContent({
    model: MODEL,
    contents: request,
    config: {
      systemInstruction: SYSTEM,
      maxOutputTokens: 32000,
      responseMimeType: "application/json",
      responseJsonSchema: SCHEMA,
    },
  });

  if (response.promptFeedback?.blockReason) {
    throw new Error("The model declined to summarize this content.");
  }
  const finish = response.candidates?.[0]?.finishReason;
  if (finish === "MAX_TOKENS") {
    throw new Error("The summary was cut off. Try a shorter length.");
  }
  if (finish && finish !== "STOP") {
    throw new Error("The model declined to summarize this content.");
  }
  const text = response.text;
  if (!text) throw new Error("The model returned an empty summary.");

  const digest = JSON.parse(text);
  if (!timed) digest.sections = [];
  return digest;
}
