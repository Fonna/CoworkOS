import assert from "node:assert/strict";
import { test } from "node:test";
import check, { createWatcher } from "../watcher/rule.mjs";
import { fixture } from "./support.mjs";

const SOURCE = "https://example.test/news.json";
const item = (id, title = "CoworkOS release", summary = "") => ({
  id,
  title,
  summary,
  url: `https://example.test/${id}`
});
const atomEntry = (version, body = "Added a feature") =>
  `<entry><id>tag:github.com,2008:Release/${version}</id><updated>2026-10-12T00:00:00Z</updated><link rel="alternate" href="https://github.com/anthropics/claude-code/releases/tag/v${version}"/><title>v${version}</title><content type="html">&lt;p&gt;${body}&lt;/p&gt;</content></entry>`;
const atomFeed = (...entries) => `<feed xmlns="http://www.w3.org/2005/Atom">${entries.join("")}</feed>`;
test("GitHub Atom releases establish a baseline, decode evidence and detect full-body edits", async (t) => {
  const lab = await fixture(t, "https://github.com/anthropics/claude-code/releases.atom");
  const rule = createWatcher({ keywords: ["claude code"], sourceFormat: "github-atom" });
  lab.response(atomFeed(atomEntry(1)));
  assert.deepEqual(await lab.poll(rule), []);
  lab.response(atomFeed(atomEntry(2, "Fix &amp;amp; improve &#x4e2d;&#25991;"), atomEntry(1)));
  const [event] = await lab.poll(rule);
  assert.equal(event.type, "feed.new");
  assert.equal(event.payload.title, "claude code v2");
  assert.equal(event.payload.summary, "Fix & improve 中文");
  assert.deepEqual(await lab.poll(rule), []);
  lab.response(atomFeed(atomEntry(2, "x".repeat(20000)), atomEntry(1)));
  const [firstEdit] = await lab.poll(rule);
  lab.response(atomFeed(atomEntry(2, "x".repeat(20000) + " edited after excerpt"), atomEntry(1)));
  const [lastEdit] = await lab.poll(rule);
  assert.equal(lastEdit.type, "feed.updated");
  assert.equal(firstEdit.payload.summary, lastEdit.payload.summary);
  assert.notEqual(firstEdit.payload.version, lastEdit.payload.version);
});
test("GitHub Atom failures retain state and explain HTTP rate limiting", async (t) => {
  const source = "https://github.com/anthropics/claude-code/releases.atom";
  const lab = await fixture(t, source);
  const rule = createWatcher({ keywords: ["claude code"], sourceFormat: "github-atom" });
  lab.response(atomFeed(atomEntry(1)));
  await lab.poll(rule);
  for (const malformed of [
    "<html>not a feed</html>",
    "<feed><entry></feed>",
    atomFeed(atomEntry(1), atomEntry(1)),
    "<!DOCTYPE feed><feed></feed>",
    atomFeed(atomEntry(2).replace(/<updated>.*?<\/updated>/, ""))
  ]) {
    lab.response(malformed);
    await assert.rejects(lab.poll(rule));
  }
  lab.response("rate limited", 403);
  await assert.rejects(lab.poll(rule), /HTTP 403/);
  lab.response(atomFeed(atomEntry(2), atomEntry(1)));
  assert.equal((await lab.poll(rule))[0].type, "feed.new");
  await assert.rejects(
    rule({
      sources: ["https://example.test/releases.atom"],
      previousState: {},
      fetchUrl: async () => ({ status: 200, content: atomFeed() })
    }),
    /endpoint/
  );
});

const release = (id, body = "Added a feature") => ({
  id,
  tag_name: `v${id}`,
  name: `v${id}`,
  body,
  html_url: `https://github.com/anthropics/claude-code/releases/tag/v${id}`,
  published_at: "2026-10-12T00:00:00Z",
  draft: false,
  prerelease: false
});
test("GitHub releases normalize, establish a baseline and detect full-body edits", async (t) => {
  const source = "https://api.github.com/repos/anthropics/claude-code/releases?per_page=3";
  const lab = await fixture(t, source);
  const rule = createWatcher({ keywords: ["claude code"], sourceFormat: "github-releases" });
  lab.response([release(1)]);
  assert.deepEqual(await lab.poll(rule), []);
  lab.response([release(2, "x".repeat(20000)), release(1), { draft: true }]);
  const [event] = await lab.poll(rule);
  assert.equal(event.type, "feed.new");
  assert.equal(event.payload.title, "claude code v2");
  assert.equal(event.payload.publishedAt, "2026-10-12T00:00:00Z");
  assert.deepEqual(await lab.poll(rule), []);
  lab.response([release(2, "x".repeat(20000) + " edited after the excerpt"), release(1)]);
  const [edit] = await lab.poll(rule);
  assert.equal(edit.type, "feed.updated");
  assert.notEqual(edit.payload.version, event.payload.version);
});
test("GitHub keyword matching reaches past the bounded summary", async (t) => {
  const lab = await fixture(t, "https://api.github.com/repos/example/tool/releases?per_page=3");
  const rule = createWatcher({ keywords: ["security"], sourceFormat: "github-releases" });
  lab.response([]);
  await lab.poll(rule);
  lab.response([release(2, "x".repeat(20000) + " security fix")]);
  const [event] = await lab.poll(rule);
  assert.deepEqual(event.payload.hits, ["security"]);
  assert.ok(!event.payload.summary.includes("security"));
});
test("Hacker News stories ignore ranking changes and retain titles, dates and discussion URLs", async (t) => {
  const lab = await fixture(t, "https://hn.algolia.com/api/v1/search_by_date?tags=story");
  const rule = createWatcher({ keywords: ["claude code"], sourceFormat: "hn-search" });
  const story = {
    objectID: "42",
    title: "Claude Code workflow",
    story_text: null,
    url: null,
    created_at: "2026-10-12T00:00:00Z",
    points: 1,
    num_comments: 0
  };
  lab.response({ hits: [] });
  await lab.poll(rule);
  lab.response({ hits: [story] });
  const [event] = await lab.poll(rule);
  assert.equal(event.payload.url, "https://news.ycombinator.com/item?id=42");
  lab.response({ hits: [{ ...story, points: 9, num_comments: 8 }] });
  assert.deepEqual(await lab.poll(rule), []);
  lab.response({ hits: [{ ...story, title: "Claude Code updated workflow" }] });
  assert.equal((await lab.poll(rule))[0].type, "feed.updated");
});
test("malformed adapters and changed formats cannot advance or discard pending evidence", async (t) => {
  const source = "https://api.github.com/repos/anthropics/claude-code/releases?per_page=3";
  const lab = await fixture(t, source);
  const config = { keywords: ["claude code"], sourceFormat: "github-releases", maxEvents: 1 };
  const rule = createWatcher(config);
  lab.response([]);
  await lab.poll(rule);
  for (const data of [{ items: [] }, [{ id: 1 }], [release(1), release(1)]]) {
    lab.response(data);
    await assert.rejects(lab.poll(rule));
  }
  lab.response([release(1), release(2)]);
  await lab.poll(rule);
  await assert.rejects(lab.poll(createWatcher({ ...config, sourceFormat: "items" })), /pending/);
  lab.fail();
  assert.equal((await lab.poll(createWatcher(config)))[0].payload.id, "2");
  await assert.rejects(
    lab.poll(createWatcher({ keywords: ["claude"], sourceFormat: "unknown" })),
    /configuration/
  );
});

test("baseline, keywords, irrelevant entries and durable deduplication", async (t) => {
  const lab = await fixture(t, SOURCE);
  const rule = createWatcher({ keywords: ["coworkos"] });
  lab.response({ items: [item("old")] });
  assert.deepEqual(await lab.poll(rule), []);
  lab.response({ items: [item("unrelated", "Weather"), item("new", "COWORKOS announced"), item("old")] });
  const [event] = await lab.poll(rule);
  assert.equal(event.payload.id, "new");
  assert.deepEqual(event.payload.hits, ["coworkos"]);
  assert.deepEqual(await lab.poll(createWatcher({ keywords: ["coworkos"] })), []);
});

test("bounded batches eventually deliver every candidate, including backfilled entries and revisions", async (t) => {
  const lab = await fixture(t, SOURCE);
  const rule = createWatcher({ keywords: ["coworkos"], maxEvents: 1, maxSeen: 4 });
  await lab.poll(rule);
  lab.response({ items: [item("3"), item("1"), item("2")] });
  const delivered = [];
  for (let i = 0; i < 3; i++) delivered.push((await lab.poll(rule))[0].payload.id);
  assert.deepEqual(delivered, ["3", "1", "2"]);
  assert.deepEqual(await lab.poll(rule), []);
  lab.response({ items: [item("1", "CoworkOS updated")] });
  const [revision] = await lab.poll(rule);
  assert.equal(revision.type, "feed.updated");
  lab.response({ items: [item("1")] });
  const [reversion] = await lab.poll(rule);
  assert.notEqual(revision.dedupeKey, reversion.dedupeKey);
});

test("retention is bounded while currently visible entries remain deduplicated", async (t) => {
  const lab = await fixture(t, SOURCE);
  const rule = createWatcher({ keywords: ["coworkos"], maxEvents: 1, maxSeen: 2 });
  lab.response({ items: [item("1"), item("2")] });
  await lab.poll(rule);
  lab.response({ items: [item("2"), item("3")] });
  await lab.poll(rule);
  assert.equal((await lab.readState()).seen.length, 2);
  assert.deepEqual(await lab.poll(rule), []);
});

test("all input is validated before state advances, and failures can be retried", async (t) => {
  const lab = await fixture(t, SOURCE);
  const rule = createWatcher({ keywords: ["coworkos"] });
  await lab.poll(rule);
  for (const data of [
    "{",
    "null",
    { items: [item("new"), { id: "bad" }] },
    { items: [item("same"), item("same")] }
  ]) {
    lab.response(data);
    await assert.rejects(lab.poll(rule));
  }
  lab.response({ items: [] }, 503);
  await assert.rejects(lab.poll(rule), /response/);
  lab.fail();
  await assert.rejects(lab.poll(rule), /unavailable/);
  lab.response("x".repeat(262_145));
  await assert.rejects(lab.poll(rule), /oversized/);
  lab.response({ items: [item("new")] });
  assert.equal((await lab.poll(rule))[0].payload.id, "new");
  await assert.rejects(lab.poll(check), /configuration/);
});

test("large Unicode articles keep full source versions but bound event evidence", async (t) => {
  const lab = await fixture(t, SOURCE);
  const words = Array.from({ length: 20 }, (_, i) => `关键${i}`);
  const rule = createWatcher({ keywords: words });
  await lab.poll(rule);
  lab.response({ items: [item("unicode", "新".repeat(1_000), words.join(" ") + "文".repeat(4_000))] });
  const [event] = await lab.poll(rule);
  assert.equal(event.payload.hitCount, 20);
  assert.equal(event.payload.hits.length, 8);
  assert.ok(Buffer.byteLength(event.payload.title) <= 515);
  assert.ok(Buffer.byteLength(event.payload.summary) <= 1_003);
});

test("observed candidates survive source removal and a fresh watcher instance", async (t) => {
  const lab = await fixture(t, SOURCE);
  const config = { keywords: ["coworkos"], maxEvents: 1, maxSeen: 4 };
  await lab.poll(createWatcher(config));
  lab.response({ items: [item("a"), item("b")] });
  assert.equal((await lab.poll(createWatcher(config)))[0].payload.id, "a");
  lab.response({ items: [] });
  assert.equal((await lab.poll(createWatcher(config)))[0]?.payload.id, "b");
  assert.deepEqual(await lab.poll(createWatcher(config)), []);
});

test("pending evidence drains even when the source becomes unavailable", async (t) => {
  const lab = await fixture(t, SOURCE);
  const config = { keywords: ["coworkos"], maxEvents: 1, maxSeen: 4 };
  await lab.poll(createWatcher(config));
  lab.response({ items: [item("a"), item("b")] });
  await lab.poll(createWatcher(config));
  lab.fail();
  assert.equal((await lab.poll(createWatcher(config)))[0]?.payload.id, "b");
  await assert.rejects(lab.poll(createWatcher(config)), /unavailable/);
});

test("a policy edit cannot silently reset pending evidence", async (t) => {
  const lab = await fixture(t, SOURCE);
  const config = { keywords: ["coworkos"], maxEvents: 1, maxSeen: 4 };
  await lab.poll(createWatcher(config));
  lab.response({ items: [item("a"), item("b")] });
  await lab.poll(createWatcher(config));
  await assert.rejects(lab.poll(createWatcher({ ...config, keywords: ["release"] })), /pending/);
  assert.equal((await lab.poll(createWatcher(config)))[0].payload.id, "b");
});

test("an oversized candidate backlog fails explicitly without advancing the cursor", async (t) => {
  const source = "https://example.test/" + "x".repeat(480);
  const lab = await fixture(t, source);
  const config = { keywords: ["coworkos"], maxEvents: 1, maxSeen: 1_000 };
  await lab.poll(createWatcher(config));
  lab.response({ items: Array.from({ length: 1_000 }, (_, i) => ({ id: String(i), title: "coworkos" })) });
  await assert.rejects(lab.poll(createWatcher(config)), /backlog/);
  lab.response({ items: [item("retry")] });
  assert.equal((await lab.poll(createWatcher(config)))[0].payload.id, "retry");
});
