# Virtual Agent package contract

This is the project convention used by the authoring skill. It is a design contract for packages awaiting Main's explicit activation.

## `manifest.json`

Keep the manifest small and reviewable:

```json
{
  "name": "official-announcement-observer",
  "version": "0.1.0",
  "entrypoint": "watcher/rule.mjs",
  "handler": "AGENT.md",
  "sources": ["https://example.test/announcements"],
  "state": "watcher/state.json",
  "events": {
    "dedupeKey": "stable source id plus content version",
    "wake": "important"
  }
}
```

Required fields are `name`, `version`, `entrypoint`, `handler`, `sources`, `state`, and `events`. `events.dedupeKey` describes the identity/version rule; `events.wake` is `never`, `important`, or `always`. Paths are relative to the package. `state` names a runtime output; do not seed it with real observations or require it to exist before the first run. `sources` is a non-empty list of URLs, feeds, search queries, or other source identifiers the probe understands. Do not put API keys or access tokens in this file.

Keep `watcher/rule.mjs` and `watcher/state.json` as shown when targeting the current ScriptWatcher, which uses those fixed paths. Record the intended check frequency and the executable test command in `AGENT.md`. The manifest and handler file are authoring artifacts; the current supervisor does not load them as a package.

`events.wake` expresses escalation to Main after event analysis. It does not filter probe events before the Virtual Agent sees them. The supervisor processes accepted events first and then applies the registered monitor's wake policy: `important` wakes Main for `relevant_change`, `always` wakes Main after each successful analysis, and `never` records the result without an event-analysis wake. `activate_virtual_agent` carries this manifest field onto the monitor unchanged.

## Probe entrypoint

`watcher/rule.mjs` exports a default async function (or a named `check` function):

```js
import { createHash } from "node:crypto";

export default async function check(context) {
  const previous = context.previousState ?? {};
  const source = context.sources[0];
  const response = await context.fetchUrl(source);
  if (!response || typeof response !== "object" || !("content" in response)) {
    throw new Error("source response has no readable content");
  }
  const status = Number(response.status);
  if (!Number.isInteger(status) || status < 200 || status >= 300) throw new Error(`source returned HTTP ${status}`);
  const content = String(response.content ?? "");
  if (!content.trim()) throw new Error("source returned empty content");
  const version = createHash("sha256").update(content).digest("hex");
  if (version === previous.version) {
    return { events: [], state: previous };
  }
  return {
    events: [{
      source,
      type: "source.changed",
      dedupeKey: `${source}:${version}`,
      priority: 2,
      payload: { version, evidence: content.slice(0, 2_000) }
    }],
    state: { version }
  };
}
```

The runtime context provides `watcherId`, `task`, `sources`, `previousState`, `readState()`, `writeState(value)`, `fetchUrl(url)`, and `searchWeb(query)`. `fetchUrl` resolves to `{ url, status, contentType, content }`, where `content` is text; HTTP errors need checking. `searchWeb` requires configured search credentials and returns the provider's JSON search result. Both can reject on network errors. Use the state helpers or return `{ events, state }`; an event array is also accepted. Events use string `source`, `type`, and `dedupeKey`, a bounded `payload`, optional numeric `priority` (default 1), and optional ISO `occurredAt`. Main wake policy is separate from numeric queue priority.

The example reports whole-page changes, including an initial observation. Adapt it to the task: a first-run baseline may emit nothing, and a list of announcements usually needs per-item IDs and revisions rather than a page hash. Tests should inject the same context shapes with local fixtures. Throw on timeouts, invalid responses, and missing evidence; validate the response before updating state so a failed check does not advance the cursor.

## Handler instructions

`AGENT.md` should state:

1. what the observer is watching and what counts as a meaningful change;
2. what evidence the awakened Agent must verify;
3. what it should record in state or its report;
4. when to wake Main and what uncertainty to expose;
5. what it must not infer or do without Main's decision.

For compatibility with the current supervisor, specify an analysis result beginning with `classification: no_change`, `classification: relevant_change`, or `classification: uncertain`, followed by reasons and evidence. Tie `relevant_change` to Main's stated significance threshold; a raw source change alone need not qualify. The runtime delivers the result to Main according to its registered wake policy, so the handler need not invent a callback tool.

Main accepts these instructions when it registers the package: `activate_virtual_agent` copies `AGENT.md` next to the rule so the accepted handler is versioned with the code it governs. Event-analysis runs still use the supervisor's built-in prompt and the monitor task Main supplied at registration. Writing the file does not execute or register anything; only Main's explicit registration does.

## Registration

`activate_virtual_agent(path, task, cadenceSeconds)` is Main's acceptance action. It validates the package with this contract, copies `entrypoint` to the path ScriptWatcher polls, runs the probe once, and activates the monitor only if that run succeeded. A probe that throws leaves the monitor a `draft`, which is never polled — so a rule that cannot run can never be mistaken for a source with no changes. The probe's `state` write also becomes the cursor baseline, so the first scheduled poll reports what changed after registration rather than replaying the whole source.
