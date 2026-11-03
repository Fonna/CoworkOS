import { createHash } from "node:crypto";

// Source: JSON { items: [{ id, title, summary?, url?, publishedAt? }] }.
// Replace these keywords; github-atom is restricted to GitHub release feeds.
const CONFIG = { keywords: ["REPLACE_KEYWORD"], maxEvents: 4, maxSeen: 1_000 };
export default createWatcher(CONFIG);

export function createWatcher({
  keywords,
  sourceFormat = "items",
  maxEvents = 4,
  maxSeen = 1_000,
  now = Date.now
} = {}) {
  return async function check(context) {
    if (
      !Array.isArray(keywords) ||
      !keywords.length ||
      keywords.length > 100 ||
      keywords.some(
        (word) => typeof word !== "string" || !word.trim() || word.startsWith("REPLACE_") || word.length > 128
      ) ||
      !["items", "github-releases", "github-atom", "hn-search"].includes(sourceFormat) ||
      !Number.isSafeInteger(maxEvents) ||
      maxEvents < 1 ||
      maxEvents > 100 ||
      !Number.isSafeInteger(maxSeen) ||
      maxSeen < maxEvents ||
      maxSeen > 10_000
    )
      throw new Error("invalid feed configuration");
    const source = context.sources[0];
    if (
      typeof source !== "string" ||
      source.length > 512 ||
      Buffer.byteLength(source) > 2_048 ||
      !/^https?:\/\//.test(source)
    )
      throw new Error("feed needs a bounded http/https source");
    const words = [...new Set(keywords.map((word) => word.trim().toLowerCase()))];
    const key = hash(
      JSON.stringify(
        sourceFormat === "items"
          ? [source, words, maxEvents, maxSeen]
          : [source, words, maxEvents, maxSeen, sourceFormat]
      )
    );
    const saved = context.previousState;
    if (saved?.key !== key && saved?.pending?.length) {
      throw new Error("drain pending events before changing feed configuration");
    }
    const previous = saved?.key === key ? saved : undefined;
    // Evidence already observed is independent of the source's current window.
    // Drain it first, including after a restart or a subsequent source outage.
    if (previous?.pending?.length) {
      return {
        events: previous.pending.slice(0, maxEvents),
        state: { ...previous, pending: previous.pending.slice(maxEvents) }
      };
    }
    const response = await context.fetchUrl(source);
    if (
      !response ||
      !Number.isInteger(response.status) ||
      response.status < 200 ||
      response.status >= 300 ||
      typeof response.content !== "string" ||
      Buffer.byteLength(response.content) > 262_144
    )
      throw new Error(`invalid or oversized feed response (HTTP ${response?.status ?? "unknown"})`);
    const data = normalizeFeed(
      sourceFormat === "github-atom" ? response.content : JSON.parse(response.content),
      sourceFormat,
      source,
      maxSeen
    );
    if (!Array.isArray(data?.items) || data.items.length > maxSeen)
      throw new Error("feed items exceed retention or have invalid shape");
    const ids = new Set();
    const items = data.items.map((item) => {
      if (
        !item ||
        typeof item.id !== "string" ||
        !item.id ||
        Buffer.byteLength(item.id) > 512 ||
        ids.has(item.id) ||
        typeof item.title !== "string" ||
        !item.title ||
        item.title.length > 4_000 ||
        (item.summary !== undefined && (typeof item.summary !== "string" || item.summary.length > 16_000)) ||
        (item.url !== undefined &&
          (typeof item.url !== "string" ||
            !/^https?:\/\//.test(item.url) ||
            Buffer.byteLength(item.url) > 2_048)) ||
        (item.publishedAt !== undefined &&
          (typeof item.publishedAt !== "string" ||
            item.publishedAt.length > 64 ||
            !Number.isFinite(Date.parse(item.publishedAt))))
      )
        throw new Error("invalid or duplicate feed item");
      ids.add(item.id);
      const entry = {
        id: item.id,
        title: item.title,
        summary: item.summary ?? "",
        url: item.url ?? null,
        publishedAt: item.publishedAt ?? null
      };
      return {
        ...entry,
        searchText: item.searchText ?? `${entry.title}\n${entry.summary}`,
        version: hash(JSON.stringify(sourceFormat === "items" ? entry : [entry, item.sourceVersion]))
      };
    });
    const seen = new Map(previous?.seen ?? []);
    const pending = [];
    const clock = now();
    if (!Number.isFinite(clock)) throw new Error("invalid clock");
    const observedAt = new Date(clock).toISOString();
    let sequence = previous?.sequence ?? 0;
    for (const item of items) {
      if (seen.get(item.id) === item.version) continue;
      const text = item.searchText.toLowerCase();
      const hits = words.filter((word) => text.includes(word));
      if (previous && hits.length) {
        pending.push({
          source,
          type: seen.has(item.id) ? "feed.updated" : "feed.new",
          priority: 2,
          dedupeKey: hash(`${key}:${++sequence}:${item.id}:${item.version}`),
          occurredAt: observedAt,
          payload: {
            id: item.id,
            title: excerpt(item.title, 512),
            url: item.url,
            publishedAt: item.publishedAt,
            observedAt,
            version: item.version,
            hits: hits.slice(0, 8).map((word) => excerpt(word, 128)),
            hitCount: hits.length,
            summary: excerpt(item.summary, 1_000),
            evidenceUrl: source
          }
        });
      }
      seen.delete(item.id);
      seen.set(item.id, item.version);
    }
    // Overflow is an observation failure, with no new cursor committed.
    // The caller can reduce its page size rather than silently losing entries.
    if (Buffer.byteLength(JSON.stringify(pending)) > 524_288) {
      throw new Error("candidate backlog exceeds 512 KiB; reduce the source page size");
    }
    // Keep every currently visible accepted item; evict only historical entries.
    for (const [id] of seen) {
      if (seen.size <= maxSeen) break;
      if (!ids.has(id)) seen.delete(id);
    }
    return {
      events: pending.slice(0, maxEvents),
      state: { key, seen: [...seen], sequence, pending: pending.slice(maxEvents) }
    };
  };
}

function normalizeFeed(data, format, source, maxSeen) {
  if (format === "items") return data;
  if (format === "github-atom") return { items: atomReleases(data, source, maxSeen) };
  const records = format === "github-releases" ? data : data?.hits;
  if (!Array.isArray(records) || records.length > maxSeen) throw new Error("invalid source feed shape");
  const repo = new URL(source).pathname.match(/^\/repos\/[^/]+\/([^/]+)\/releases\/?$/)?.[1];
  if (format === "github-releases" && !repo)
    throw new Error("GitHub source must be a repository releases endpoint");
  const items = [];
  for (const record of records) {
    if (!record || typeof record !== "object") throw new Error("invalid source feed item");
    if (format === "github-releases") {
      if (record.draft === true) continue;
      if (
        !Number.isSafeInteger(record.id) ||
        record.id < 1 ||
        typeof record.tag_name !== "string" ||
        !record.tag_name ||
        (record.name != null && typeof record.name !== "string") ||
        (record.body != null && typeof record.body !== "string") ||
        typeof record.html_url !== "string" ||
        typeof record.published_at !== "string"
      )
        throw new Error("invalid GitHub release");
      const title = `${repo.replaceAll("-", " ")} ${record.name || record.tag_name}${record.prerelease === true ? " (prerelease)" : ""}`;
      const body = record.body ?? "";
      items.push({
        id: String(record.id),
        title,
        summary: excerpt(body, 12000),
        url: record.html_url,
        publishedAt: record.published_at,
        searchText: `${title}\n${body}`,
        sourceVersion: hash(JSON.stringify([title, body, record.html_url, record.published_at]))
      });
    } else {
      if (
        typeof record.objectID !== "string" ||
        !record.objectID ||
        typeof record.title !== "string" ||
        !record.title ||
        (record.story_text != null && typeof record.story_text !== "string") ||
        (record.url != null && typeof record.url !== "string") ||
        typeof record.created_at !== "string"
      )
        throw new Error("invalid Hacker News story");
      const body = record.story_text ?? "";
      const url = record.url || `https://news.ycombinator.com/item?id=${encodeURIComponent(record.objectID)}`;
      items.push({
        id: record.objectID,
        title: record.title,
        summary: excerpt(body, 12000),
        url,
        publishedAt: record.created_at,
        searchText: `${record.title}\n${body}`,
        sourceVersion: hash(JSON.stringify([record.title, body, url, record.created_at]))
      });
    }
  }
  return { items };
}

function atomReleases(xml, source, maxSeen) {
  const endpoint = new URL(source);
  const repo = endpoint.pathname.match(/^\/[^/]+\/([^/]+)\/releases\.atom\/?$/)?.[1];
  if (endpoint.hostname !== "github.com" || !repo)
    throw new Error("GitHub Atom source must be a github.com repository releases.atom endpoint");
  if (
    typeof xml !== "string" ||
    !/<feed[\s>][\s\S]*<\/feed\s*>/.test(xml) ||
    /<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(xml)
  )
    throw new Error("invalid GitHub Atom feed shape");
  const blocks = xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry\s*>/g) ?? [];
  if (blocks.length > maxSeen || blocks.length !== (xml.match(/<entry[\s>]/g) ?? []).length)
    throw new Error("invalid GitHub Atom entries");
  return blocks.map((block) => {
    const id = atomTag(block, "id");
    const title = atomTag(block, "title");
    const publishedAt = atomTag(block, "updated");
    const url = atomLink(block);
    const content = atomTag(block, "content") ?? "";
    if (!id || !title || !publishedAt || !url) throw new Error("invalid GitHub release entry");
    const name = `${repo.replaceAll("-", " ")} ${title}`;
    const body = decodeXml(content)
      .replace(/<[^>]*>/g, " ")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .trim();
    return {
      id,
      title: name,
      summary: excerpt(body, 12000),
      url,
      publishedAt,
      searchText: `${name}\n${body}`,
      sourceVersion: hash(JSON.stringify([name, content, url, publishedAt]))
    };
  });
}
function atomTag(block, name) {
  const value = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}\\s*>`))?.[1];
  return value === undefined ? undefined : decodeXml(value).trim();
}
function atomLink(block) {
  for (const tag of block.match(/<link\b[^>]*>/g) ?? []) {
    if (/\brel=["']alternate["']/.test(tag)) {
      const href = tag.match(/\bhref=(["'])(.*?)\1/)?.[2];
      if (href) return decodeXml(href);
    }
  }
  return undefined;
}
function decodeXml(value) {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, "\u00a0")
    .replace(/&amp;/g, "&");
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
function excerpt(value, bytes) {
  return Buffer.from(value).subarray(0, bytes).toString("utf8");
}
