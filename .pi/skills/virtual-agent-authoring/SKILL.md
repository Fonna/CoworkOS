---
name: virtual-agent-authoring
description: Design, test, and package a custom Virtual Agent with an executable probe, readable wake-up instructions, persistent state, and explicit activation. Use only when a task needs custom executable observer code. For built-in monitoring templates call create_watcher directly; this skill is unnecessary. Do not use for ordinary one-shot Subagent work.
---

# Virtual Agent Authoring

Use this skill when the requested result is a reusable Virtual Agent definition. `call_subagent(task, mode)` remains a one-shot delegation interface: do not add lifecycle, profile, monitor, or experiment fields to that call, and do not infer persistence from task wording.

For built-in job, metric, resource, feed, entity or timer monitoring, use `create_watcher` directly with its documented config. Runtime validates and probes the template; do not copy, read or re-test its source just to register it. Pass `programId` to keep multiple sources under the same long-term goal. Continue below only when custom code is required.

## Deliverable

Main can author the package directly or delegate it to an ordinary Subagent. Draft it in Main's private `work/virtual-agents/<slug>/` or a Subagent's private `deliverables/virtual-agents/<slug>/`. After review, Main uses ordinary file/command tools to copy the accepted package into Task `artifacts/virtual-agents/<slug>/` for user delivery; this does not activate it.

```text
<slug>/
├── manifest.json       # identity, entrypoint, sources, and state contract
├── AGENT.md            # human-readable role and wake-up instructions
├── watcher/rule.mjs    # deterministic probe; no direct Main calls
└── tests/              # fixtures for unchanged, changed, duplicate, and failure cases
```

Read [the package contract](references/package-contract.md) before writing `manifest.json` or `watcher/rule.mjs`. Keep the handler instructions in `AGENT.md` separate from the low-cost probe: the probe observes and emits evidence, while the awakened Agent decides relevance, validates evidence, and reports to Main.

For standard observer tasks, start with the [reference templates](templates/README.md). They cover job lifecycle, metric thresholds, resource versions, new-item keyword filters, entity state transitions, and timers. Copy the complete package into the authoring workspace, configure its sources and inline rule settings, and rerun its tests before review. The reference library itself is never a live monitor.

Resolve references and scripts against the skill directory returned by `load_skill`. Subagent `read_file` is restricted to its own workspace; use `run_command` with absolute paths to read this reference or run the validator, and keep generated files in the Agent's workspace.

## Workflow

1. Clarify the observable sources, change condition, evidence required, state/cursor, and the circumstances that should wake Main. Put unresolved choices in the report instead of silently inventing them.
2. Inspect the workspace and any existing package before editing. Preserve a working rule and change the smallest necessary surface.
3. Write the manifest, `AGENT.md`, probe, and fixtures. The probe must be idempotent, bounded, re-entrant, and safe when a source is unavailable. It should return no events for no change.
4. Test with local fixtures first. Cover the first run, no change, a meaningful change, a duplicate observation, malformed input or fetch failure, and state persistence. Use live sources only as needed within the task's authorized scope; report any behavior checked only with fixtures.
5. Run the bundled structural validator (`node <skill-directory>/scripts/validate_package.mjs <package-path>`) and the package's declared test command. The validator checks the manifest, package boundaries, required files, and probe syntax without importing or executing the probe. Report the exact commands and results, plus the package path and any unverified source behavior.
6. Stop at a reviewable package. A file appearing in a workspace, a successful Subagent run, or loading this skill never activates a Virtual Agent. Main must inspect the package and explicitly register it with `activate_virtual_agent(path, task, cadenceSeconds)`, which validates it, runs its probe once, and activates the monitor only if that run succeeded.

## Runtime boundary

For the six reference templates, Main may call `create_watcher` with `template`, `task`, `source`, `config`, `cadenceSeconds`, and `scope`. `session` belongs to the current Task; `background` creates an independent parked Task. Only `activated: true` with a durable `monitorId` confirms activation. An unsuccessful live probe remains a draft. The model and frontend use the same management service.

Custom packages still require explicit acceptance with `activate_virtual_agent`. Runtime validates the package, installs the rule and handler, and establishes the initial checkpoint. The Supervisor loads the accepted `AGENT.md` up to 16 KiB. Configure keys by reading the template's factory signature; defaults apply when omitted, and placeholders are not usable sources. Reference tests cover behavior, while registration probes check that the configured real source can currently be observed.

`ScriptWatcher` executes a bounded child process and atomically commits state plus an event outbox. `WatchSupervisor` owns cadence, Inbox delivery, daily model and wake budgets, retries, and Main wake-ups. A deterministic check must return; it must not start an internal monitoring loop. Direct mode is appropriate for verified time/threshold/lifecycle events; analysis mode spends model runs on semantic judgment. An empty check runs no model. Closing a browser does not stop the service; stopping the host does, and the next host startup resumes persisted monitors.

Use the context helpers for web access and state; Node built-ins can implement parsing and hashing. Declare any additional dependencies and verify they are available. Never call Main directly, fabricate an event when evidence is missing, or hide a failed check as “no change”. Keep secrets and source-specific credentials out of the package and its fixtures.

## Final report

Return a concise report containing:

- package path and the files created or changed;
- sources, change condition, event/dedupe behavior, and state cursor;
- test/validation commands and their observed results;
- known limitations and the explicit activation step still required.

Do not report an activated, scheduled, or persistent Agent unless Main has performed that separate activation and the runtime has returned a durable identifier.
