---
name: iterative-optimization
description: Set up and run a self-directed optimization loop — revise a pipeline or dataset, train, evaluate, read the result, decide the next round. Use when the goal is to improve a measurable score over repeated rounds and the work spans more than one attempt. Do not use for a single training run, a one-off evaluation, or ordinary work that merely mentions training.
---

# Iterative Optimization

Work that repeatedly changes something, measures the effect, and decides what to change next. The Runtime records each round automatically and hands the history back at context resets and callbacks, so the loop survives a reset and a restart. What it cannot supply is which files decide the score.

## Establish the referee first

**An agent optimizing a score must not be able to edit what produces the score.** Nothing else in this skill matters if that is wrong: a round that edits the scorer raises the number, the ledger records it faithfully, and every later comparison is against a corrupted baseline. The failure is silent — rising numbers look the same either way.

Agents write only their own directory until the user grants more, so this work needs a grant before it can start. Ask for it once, with the evidence already in hand:

1. **Inspect the project.** Find the scorer, the test data, how a score is produced, and how synthesis, training and evaluation are run — an eval script, a benchmark runner, a metrics file, a CI target. Read enough to state concretely what you found.
2. **Ask once, in one question.** Use `askhuman` to cover the whole grant together: that you need to edit the project, which paths you believe must stay read-only, and whether jobs will run for minutes or hours. Listing what you found and asking them to correct it is far better than asking them to describe their project from scratch.
3. **Record the answer with `grant_capabilities`.** Until you do, the grant has no effect — an agreement in the transcript does not change what the tools allow. Record every read-only path the user named, even if they decline project writes.

If the user declines to identify what produces the score, continue but say once what that means: results cannot be trusted as evidence of improvement, because nothing prevents a round from editing the measurement. Do not repeat it every round.

Read a protected path freely. Understanding how the work is scored is legitimate and often necessary; only writing is refused.

## Running a round

Establish a baseline before changing anything: one measurement of the current state. Without it there is nothing for later rounds to be compared against.

Each round changes **one** thing. Two simultaneous changes and a moved number produce no knowledge of which change moved it — an expensive round that teaches nothing.

- **Write metrics to a file.** Every measured run writes `metrics.json` in its own working directory: a flat JSON object of metric names to numbers, optionally with a `variant` key naming the dataset version, checkpoint or commit. The Runtime reads that file. Numbers relayed through a summary are a report of a measurement, not the measurement.
- **Supervise long work instead of waiting on it.** With `longRunning` granted, start training and large synthesis with `start_job`, then poll `check_job`. A job still writing output is working; one silent far longer than its normal rhythm is probably wedged — `check_job` reports how long it has run and how long since the log grew, and judging that is your call. Use `kill_job` when a job is stuck, has clearly failed, or is no longer worth its cost, then record what happened and move on. Do not let a wedged job consume the whole budget, and do not kill a slow job that is still making progress.
- **Let failures be results.** A diverged run or a pipeline that errored on new data is evidence about the search space, not a fault to repeat. With `longRunning` granted, delegations are not retried automatically for this reason. Record what happened and use it.

## Deciding the next round

The recorded rounds arrive on their own — after a measured callback and after a context reset — as a metric series with each round's variant and parent. Read the trend rather than the last number: a rise that is flattening, a change that helped once and not again, a direction that has stopped paying are all decisions, and they are yours to make. The record states what happened and never what to do next.

Keep the *judgment* in `agents/main/context/memory.md`: the current hypothesis, directions ruled out and why, constraints discovered along the way. The per-round numbers are already recorded; copying them into memory duplicates the record and eventually contradicts it.

Stop and tell the user when the goal is met, when several rounds in a row produce no movement, or when continuing would cost significantly more than what has been spent. Spending the remaining budget is not a reason to keep going.

## Reporting

Report the trajectory, not just the final number: the baseline, what each round changed, where the score went, and what was ruled out. A round that failed to improve is a result and belongs in the report.

State plainly which numbers came from a metrics file and which did not. If evaluation paths were never confirmed, say so in the final report as well — a reader cannot tell from the numbers alone.
