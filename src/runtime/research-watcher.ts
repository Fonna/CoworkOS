import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WatcherEvent, WatcherPoller } from "./watcher.js";

const execFileAsync = promisify(execFile);

export interface ResearchPollingWatcherOptions {
  watcherId: string;
  query: string;
  perPage?: number;
  endpoint?: string;
  timeoutMs?: number;
}

/**
 * Provider-neutral academic watcher backed by OpenAlex's public works API.
 * It is intentionally deterministic: the watcher only discovers papers;
 * relevance and importance are decided by the Virtual Agent.
 */
export class ResearchPollingWatcher implements WatcherPoller {
  readonly watcherId: string;
  private readonly query: string;
  private readonly perPage: number;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(options: ResearchPollingWatcherOptions) {
    if (!options.watcherId.trim()) throw new Error("watcherId must not be empty");
    if (!options.query.trim()) throw new Error("query must not be empty");
    this.watcherId = options.watcherId;
    this.query = options.query.trim();
    this.perPage = Math.max(1, Math.min(50, Math.floor(options.perPage ?? 10)));
    // Crossref is used by default because it is public, stable and does not
    // require a provider key. OpenAlex-shaped fixtures are also accepted.
    this.endpoint = options.endpoint ?? "https://api.crossref.org/works";
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? 30_000);
  }

  async poll(): Promise<WatcherEvent[]> {
    const url = new URL(this.endpoint);
    url.searchParams.set(this.endpoint.includes("api.crossref.org") ? "query" : "search", this.query);
    if (this.endpoint.includes("api.crossref.org")) {
      url.searchParams.set("sort", "published");
      url.searchParams.set("order", "desc");
    } else {
      url.searchParams.set("sort", "publication_date:desc");
    }
    url.searchParams.set(
      this.endpoint.includes("api.crossref.org") ? "rows" : "per-page",
      String(this.perPage)
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const payload = (await fetchResearchJson(url, controller.signal, this.timeoutMs)) as {
        results?: Array<Record<string, unknown>>;
        message?: { items?: Array<Record<string, unknown>> };
      };
      const works = Array.isArray(payload.message?.items)
        ? payload.message.items
        : Array.isArray(payload.results)
          ? payload.results
          : [];
      return works.map((work) => normalizeWork(this.watcherId, this.query, work));
    } finally {
      clearTimeout(timer);
    }
  }
}

async function fetchResearchJson(url: URL, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "CoworkOS/0.1" },
      signal
    });
    if (!response.ok) throw new Error(`research provider HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    // Some server deployments expose HTTPS only through an environment proxy
    // that Node/undici does not consume. curl is a bounded, argument-array
    // fallback; it never receives secrets and cannot execute a shell string.
    if (process.env.COWORK_DISABLE_CURL === "1") throw error;
    const seconds = Math.max(5, Math.ceil(timeoutMs / 1_000));
    const result = await execFileAsync(
      "curl",
      ["-fsSL", "--max-time", String(seconds), "-A", "CoworkOS/0.1", url.toString()],
      { maxBuffer: 8 * 1024 * 1024 }
    );
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw error;
    }
  }
}

function normalizeWork(watcherId: string, query: string, work: Record<string, unknown>): WatcherEvent {
  const id =
    typeof work.id === "string"
      ? work.id
      : typeof work.DOI === "string"
        ? `https://doi.org/${work.DOI}`
        : "unknown";
  const rawTitle = Array.isArray(work.title) ? work.title[0] : work.title;
  const title = typeof rawTitle === "string" ? rawTitle : "Untitled research work";
  const publishedParts =
    (work["published-online"] as { [key: string]: unknown } | undefined)?.["date-parts"] ??
    (work.published as { [key: string]: unknown } | undefined)?.["date-parts"] ??
    work.publication_date;
  const rawPublicationDate =
    Array.isArray(publishedParts) && Array.isArray(publishedParts[0])
      ? publishedParts[0].filter((part): part is number => typeof part === "number").join("-")
      : typeof publishedParts === "string"
        ? publishedParts
        : undefined;
  const publicationDate = validPublicationDate(rawPublicationDate) ? rawPublicationDate : undefined;
  const doi =
    typeof work.doi === "string"
      ? work.doi
      : typeof work.DOI === "string"
        ? `https://doi.org/${work.DOI}`
        : undefined;
  const landingPage =
    (work.primary_location as { landing_page_url?: unknown } | undefined)?.landing_page_url ?? work.URL;
  const url = typeof landingPage === "string" ? landingPage : doi;
  const authors = Array.isArray(work.authorships)
    ? work.authorships
        .slice(0, 8)
        .map((author) => (author as { author?: { display_name?: unknown } }).author?.display_name)
        .filter((name): name is string => typeof name === "string")
    : Array.isArray(work.author)
      ? work.author
          .slice(0, 8)
          .map((author) => {
            const item = author as { given?: unknown; family?: unknown };
            return [item.given, item.family]
              .filter((part): part is string => typeof part === "string")
              .join(" ")
              .trim();
          })
          .filter((name) => name.length > 0)
      : [];
  const stable = `${id}|${publicationDate ?? ""}|${title}`;
  const digest = createHash("sha256").update(stable).digest("hex").slice(0, 24);
  return {
    watcherId,
    source: "openalex",
    type: "research.work_discovered",
    dedupeKey: digest,
    priority: 1,
    payload: {
      query,
      workId: id,
      title,
      publicationDate,
      rawPublicationDate,
      dateInvalid: Boolean(rawPublicationDate && !publicationDate),
      doi,
      url,
      authors,
      citedByCount: work.cited_by_count ?? work["is-referenced-by-count"],
      abstractAvailable: Boolean(work.abstract_inverted_index || work.abstract)
    }
  };
}

function validPublicationDate(value: string | undefined): boolean {
  if (!value) return false;
  const match = value.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) : 1;
  const day = match[3] ? Number(match[3]) : 1;
  const currentYear = new Date().getUTCFullYear();
  if (year < 1900 || year > currentYear + 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
