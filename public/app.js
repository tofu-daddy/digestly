const $ = (id) => document.getElementById(id);

const API_BASE = ["localhost", "127.0.0.1"].includes(location.hostname)
  ? ""
  : (document.querySelector('meta[name="api-base"]')?.content || "").replace(/\/$/, "");

const state = {
  mode: "link",
  length: "medium",
  file: null,
  transcript: null,
  digest: null,
  feedUrl: null,
  busy: false,
};

async function api(path, options = {}) {
  const res = await fetch(API_BASE + path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const postJson = (path, body) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function setStatus(text) {
  $("status").hidden = !text;
  $("status").textContent = text || "";
}

function setError(text) {
  $("error").hidden = !text;
  $("error").textContent = text || "";
}

function setBusy(busy) {
  state.busy = busy;
  $("submit").disabled = busy;
}

function formatDuration(seconds) {
  if (!seconds) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m} min`;
}

function toSeconds(stamp) {
  if (!stamp) return null;
  return stamp.split(":").map(Number).reduce((t, n) => t * 60 + n, 0);
}

function timestampHref(stamp) {
  const url = state.transcript?.sourceUrl;
  const seconds = toSeconds(stamp);
  if (!url || seconds == null || !/youtube\.com|youtu\.be/.test(url)) return null;
  return `${url}${url.includes("?") ? "&" : "?"}t=${seconds}s`;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c != null && c !== ""));
  return node;
}

function timestampNode(stamp) {
  if (!stamp) return null;
  const href = timestampHref(stamp);
  return href ? el("a", { class: "ts", href, target: "_blank", rel: "noopener" }, stamp) : el("span", { class: "ts" }, stamp);
}

function render() {
  const t = state.transcript;
  const d = state.digest;
  if (!t || !d) return;

  $("r-title").textContent = t.title;
  $("r-meta").textContent = [t.author, formatDuration(t.durationSeconds), t.method, `${t.wordCount.toLocaleString()} words`]
    .filter(Boolean)
    .join(" · ");
  $("r-overview").textContent = d.overview;
  $("r-takeaways").replaceChildren(...d.takeaways.map((x) => el("li", {}, x)));

  $("r-quotes-wrap").hidden = !d.quotes.length;
  $("r-quotes").replaceChildren(
    ...d.quotes.map((q) => {
      const cite = [q.speaker, q.timestamp].filter(Boolean).join(", ");
      return el("blockquote", {}, `“${q.text}”`, cite ? el("cite", {}, cite) : null);
    }),
  );

  $("r-sections-wrap").hidden = !d.sections.length;
  $("r-sections").replaceChildren(
    ...d.sections.map((s) =>
      el("li", {}, timestampNode(s.timestamp) || el("span"), el("div", {}, el("strong", {}, s.title), s.summary)),
    ),
  );

  $("r-transcript").href = `${API_BASE}/api/transcript/${t.id}.txt`;
  $("preview").hidden = true;
  $("result").hidden = false;
  document.querySelector(".layout").classList.add("has-result");
  $("result").classList.remove("stale");
}

function toMarkdown() {
  const t = state.transcript;
  const d = state.digest;
  const out = [`# ${t.title}`];
  if (t.sourceUrl) out.push(t.sourceUrl);
  out.push("", "## Overview", d.overview, "", "## Key takeaways", ...d.takeaways.map((x) => `- ${x}`));
  if (d.quotes.length) {
    out.push("", "## Notable quotes");
    for (const q of d.quotes) {
      const cite = [q.speaker, q.timestamp].filter(Boolean).join(", ");
      out.push(`> ${q.text}${cite ? ` (${cite})` : ""}`, "");
    }
  }
  if (d.sections.length) {
    out.push("", "## Sections", ...d.sections.map((s) => `- **${s.timestamp ? `[${s.timestamp}] ` : ""}${s.title}**: ${s.summary}`));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

async function summarizeCurrent() {
  setStatus(`Summarizing (${state.length})…`);
  if (!$("result").hidden) $("result").classList.add("stale");
  state.digest = await postJson("/api/summarize", { id: state.transcript.id, length: state.length });
  render();
}

function showEpisodes(data) {
  state.feedUrl = data.feedUrl;
  $("episodes-label").textContent = `Pick an episode of ${data.show}`;
  $("episode-select").replaceChildren(
    ...data.episodes.map((e) => {
      const date = e.published ? new Date(e.published).toLocaleDateString() : "";
      return el("option", { value: e.id }, [e.title, date].filter(Boolean).join(" · "));
    }),
  );
  $("episodes").hidden = false;
}

async function fetchTranscript() {
  if (state.mode === "file") {
    if (!state.file) throw new Error("Choose a file first.");
    setStatus("Uploading and transcribing… this can take a few minutes for long recordings.");
    const form = new FormData();
    form.append("file", state.file);
    return api("/api/transcript/upload", { method: "POST", body: form });
  }

  const url = $("url").value.trim();
  if (!url) throw new Error("Paste a link first.");
  const picking = !$("episodes").hidden;
  setStatus(picking ? "Getting the episode transcript…" : "Getting the transcript…");
  const body = picking ? { url: state.feedUrl, episodeId: $("episode-select").value } : { url };
  return postJson("/api/transcript", body);
}

async function onSubmit(event) {
  event.preventDefault();
  if (state.busy) return;
  setError("");
  setBusy(true);
  try {
    const data = await fetchTranscript();
    if (data.needsEpisode) {
      showEpisodes(data);
      setStatus("");
      return;
    }
    state.transcript = data;
    await summarizeCurrent();
    setStatus("");
  } catch (err) {
    setStatus("");
    setError(err.message);
  } finally {
    setBusy(false);
  }
}

function resetEpisodes() {
  $("episodes").hidden = true;
  state.feedUrl = null;
}

document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    state.mode = tab.dataset.mode;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    document.querySelectorAll(".mode").forEach((m) => (m.hidden = m.dataset.mode !== state.mode));
    resetEpisodes();
  }),
);

document.querySelectorAll(".segmented button").forEach((btn) =>
  btn.addEventListener("click", async () => {
    if (state.busy || btn.dataset.length === state.length) return;
    state.length = btn.dataset.length;
    document.querySelectorAll(".segmented button").forEach((b) => b.classList.toggle("active", b === btn));
    $("d-length").textContent = btn.textContent;
    if (!state.transcript) return;
    setError("");
    setBusy(true);
    try {
      await summarizeCurrent();
      setStatus("");
    } catch (err) {
      setStatus("");
      setError(err.message);
      $("result").classList.remove("stale");
    } finally {
      setBusy(false);
    }
  }),
);

$("url").addEventListener("input", resetEpisodes);

function chooseFile(file) {
  state.file = file || null;
  $("file-label").textContent = file ? `${file.name} (${(file.size / 1048576).toFixed(1)} MB)` : "Choose or drop an audio/video file";
}

$("file").addEventListener("change", (e) => chooseFile(e.target.files[0]));
const drop = $("drop");
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  chooseFile(e.dataTransfer.files[0]);
});

$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(toMarkdown());
  $("copy").textContent = "Copied";
  setTimeout(() => ($("copy").textContent = "Copy"), 1500);
});

$("form").addEventListener("submit", onSubmit);

api("/api/health")
  .then((h) => {
    const missing = [];
    if (!h.gemini) missing.push("<code>GEMINI_API_KEY</code> is not set, so summaries won't work.");
    if (!h.openai) missing.push("<code>OPENAI_API_KEY</code> is not set, so only sources with captions or published transcripts will work.");
    if (missing.length) {
      $("setup-warning").innerHTML = `${missing.join("<br>")}<br>Add keys to <code>.env</code> and restart.`;
      $("setup-warning").hidden = false;
    }
  })
  .catch(() => {});
