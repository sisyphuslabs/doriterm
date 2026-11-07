# Render bench and the release gate

#670. herdr profiles full rendering at 1, 15 and 50 panes and runs a release smoke bench against the current stable binary before every release; Doriterm does the same for its web client, which is what the desktop app and the PWA draw terminals with.

## Running it

```sh
bun run bench:render                       # 1, 15 and 50 panes, the web app built from this checkout
bun run bench:render -- --panes 50 --rounds 3
bun run bench:render -- --build v0.1.2=/path/to/old/dist --build candidate=/path/to/new/dist --rounds 5 --compare v0.1.2
```

It needs `hc` on `PATH` (or `HC_BIN`) and Playwright's Chromium (`bunx playwright install chromium` in `apps/web`), as the web e2e suite does. It prints one table row per run and writes `render-bench.json` (every run) and `render-bench.md` (the table and, with `--compare`, the verdict) to `--out` (default `apps/web/bench-out`). With `--compare` it exits 1 when a gated metric regressed.

## Method

`apps/web/bench/render.bench.ts`, one Playwright test per pane count, against the e2e suite's real host and hc core (one worker, so nothing else runs on that core):

1. N terminals start on the core, each running the same `sh` program, plus one idle terminal. The core's herdr-app layout is seeded with two tabs: `bench`, the N terminals in a grid of near-equal rows (`gridOf`: 1; 5×3; 9,9,8,8,8,8 for 50), and `idle`, the idle terminal. The window is 1920×1080.
2. Every program prints a ready line and waits. Once every pane shows it, the bench starts recording and creates the go file: every program then prints the same ten-line chunk (about 800 bytes: build-log lines, a third of them in colour) every 100 ms for 60 ticks (100 lines a second per pane, about 6 s), then an end line, then a done file.
3. Visible phase, from the go file to every pane showing its end line:
   - **Frame p50 / p95 / max**: intervals between `requestAnimationFrame` callbacks from a probe added before the app's own scripts (so any build is measured the same way), nearest-rank; the run is refused under 20 frames.
   - **Main busy**: Chromium's main-thread `TaskDuration` over wall time (`Performance.getMetrics` over CDP).
   - **Long tasks**: count and total of `longtask` entries.
   - **Drawn KiB/s**: the bytes the programs wrote over the time until every pane showed its end line.
   - **Catch-up ms**: from the last program finishing to every pane showing its end line: how far drawing trails the output.
   - **Heap MB, DOM nodes**: `JSHeapUsedSize` and `Nodes` once recording has stopped and a full garbage collection (`HeapProfiler.collectGarbage`) has run: what the page keeps. Read without that collection they depended on when the collector last ran and swung about 30 MB between runs of one build (#1037).
4. Hidden phase: the `idle` tab is selected, the same workload runs again, and **Hidden busy** is the main-thread share while the `bench` tab is not shown; then the `bench` tab is selected and **Show catch-up ms** is the time until every pane shows the hidden phase's end line.
5. Prompt phase (#986): every pane in view, the programs write the same chunks again, and the `bench` tab's close button is clicked 5 times (Cancel after each; confirm-close-surface is `always`, so the question comes every time). **Close prompt ms** is each click's time from the browser's `pointerdown` timestamp to the first DOM mutation that shows the dialog, in the page's own clock (`bench/close-prompt.ts`): time the click waited behind the main thread counts, the driver's round trip does not. The first click waits until every pane shows output of this phase, and the programs keep writing until the bench creates a stop file after the last click, so every click lands while the page draws their output, however long the clicks take. This is #560's budget, which the Web e2e case `flood-input.e2e.ts` used to assert on whatever runner the suite shared; there it measured how much CPU the page got, so that case now only holds that every click is answered (within 10 s).

Each program starts one `sleep` per tick; at 50 panes that is 500 short processes a second on the machine, the same for every build.

## The release gate

`.github/workflows/render-bench.yml`, called by `release.yml` before the draft release is made (and runnable by hand, or by pushing a `bench/**` branch):

- the candidate's web app is built from the release commit, and the baseline's from the tag of the last published release (`gh release view`: never a draft or a prerelease);
- the candidate's bench drives both builds on the same runner (same spec, host and core: only the web app differs), every round running each build once and alternating which goes first, so drift on the runner falls on both;
- `bench/run.ts --compare` takes each gated metric's median over the rounds per pane count and fails when the candidate passes its limit in `apps/web/bench/thresholds.json`: a metric that grows when worse fails past `ratio` times the baseline **and** `floor` above it; drawn bytes per second fails under `ratio` times the baseline; a metric with a `max` (Close prompt ms: 200, #560's product budget) also fails past it, however slow the baseline was;
- a failure fails the release before the draft exists, so nothing is published; the table and every run are attached to the release as `Doriterm-<version>-render-bench.md` and `.json`.

## Noise floor

Measured on 2026-11-06 on GitHub's `ubuntu-24.04` runner, the one the release workflow uses: the same build benched against itself (`self-a` against `self-b`, Render bench run 42196735742, branch `bench/670-noise`), 5 rounds, medians per pane count. Each limit in `apps/web/bench/thresholds.json` records the spread it was set from.

| Panes | Frame p95 ms (a / b) | Main busy (a / b) | Catch-up ms (a / b) | Drawn KiB/s (a / b) | Heap MB (a / b) | Hidden busy (a / b) | Show catch-up ms (a / b) |
| ----- | -------------------- | ----------------- | ------------------- | ------------------- | --------------- | ------------------- | ------------------------ |
| 1     | 16.7 / 16.8          | 8.8% / 9.3%       | 7 / 9               | 7.72 / 7.71         | 18.2 / 22.0     | 1.2% / 1.3%         | 108 / 113                |
| 15    | 16.8 / 16.8          | 49.4% / 51.1%     | 54 / 13             | 115.1 / 115.6       | 43.6 / 35.5     | 2.8% / 2.9%         | 251 / 213                |
| 50    | 100.0 / 100.1        | 98.4% / 98.3%     | 213 / 215           | 371.2 / 371.3       | 95.5 / 101.3    | 8.1% / 7.8%         | 473 / 651                |

What the noise says:

- Frame intervals come in whole 60 Hz frames (16.7 ms steps). A single run's p95 at 50 panes spread over two steps (83 to 117 ms), but the median over 5 rounds moved 0.1 ms. The limit is the larger of 1.25 times the baseline and the baseline plus 4 ms: at a baseline of three frames or fewer (50 ms or less, as at 1 and 15 panes and v0.1.2's 50) a one-frame shift of the median fails; at a 66.7 ms baseline the limit is 83.4 ms, so a one-frame shift sits at the line; at 100 ms (the noise run's 50-pane baseline) the limit is 125 ms and one frame passes, two fail.
- Catch-up is read at a 50 ms poll, so single runs land near 5 or 55 ms; its floor is 100 ms.
- The heap column above was read before the bench collected garbage first; it depended on when the collector last ran, and across release runs one build's 50-pane median moved about 30 MB (v0.1.3: 60.9 then 99.8 MB; v0.1.4: 94.0 then 67.9 MB), which stopped v0.1.5 on noise (#1037). Read after a full collection (Render bench runs 42306731684, `bench/1037-heap-after-gc-noise`, and 42306731425, v0.1.4 against dev `9ec0795b`), every round of a build lands within 0.7 MB (50 panes: 40.1 to 40.7 MB A/A, medians 40.2 / 40.1; v0.1.4 39.9 to 40.5, dev 40.1 to 40.8) and DOM nodes do not move at all within a build. The heap floor stays 15 MB.
- The time to catch up once a hidden tab is shown moved 178 ms at 50 panes; its floor is 300 ms.
- Close prompt ms, A/A on `ubuntu-24.04` (Render bench run 42338764501, `bench/986-close-prompt-noise`, 5 rounds): medians 9.4 / 9.5 ms at 1 pane, 22.2 / 22.5 at 15 and 76.3 / 65.1 at 50 (single runs' medians 55 to 80 ms, single clicks 46 to 111 ms at 50 panes). The same A/A on a loaded Linux host measured 142.5 / 107.3 ms at 50 panes (runs' medians 83 to 186). The medians moved 1.33x at most, so the regression limit is 1.5x and 50 ms above the baseline; the 200 ms cap is 2.6x the release runner's 50-pane median.
- The absolute numbers differ between runners: this run's 50-pane frame p95 was 100 ms, while another `ubuntu-24.04` job measured 50 to 67 ms the same day. That is why the gate compares two builds on one runner and never with a stored number.

The first comparison with the last release (Render bench run 42196737507, `v0.1.2` against the branch at dev `b5e2fec4`, 5 rounds) failed at 50 panes: frame p95 50.1 to 66.7 ms (every candidate round 66.7, four of five `v0.1.2` rounds 50), with the median long tasks per run up from 13 (756 ms) to 28 (1,695 ms). The other 20 gated medians were within their limits. That regression on dev is tracked apart from this bench.
