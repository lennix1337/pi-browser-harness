# Implicit state machines in pi-browser-harness

Catalog made on `origin/main` (04bcb8e). Line references are by function name.

Severity: P1 wrong behaviour with real impact, P2 wrong behaviour in a reachable situation, P3 latent or cosmetic.

## 1. Owned tab (`src/controller.ts`, `Controller.tabs`)

- **States per tab id:** `unknown` -> `owned` -> `unknown`. There is no explicit record; "owned" is membership in a `Map<string, {endpoint, target, session}>`.
- **Events and transitions**

| event | from | to | notes |
| --- | --- | --- | --- |
| `open` returns `{target, session}` | unknown | owned | identity recorded **before** the follow-up navigate, so a failed navigate still leaves an owned tab (tested) |
| `close` returns `{success: true}` | owned | unknown | any other reply throws and the tab stays owned |
| `close` fails with CDP "No target with given id" | owned | unknown | **new**: the browser no longer has the tab |
| page action on a tab not in the map | unknown | unknown | rejected before transport ("never adopt personal tabs") |

- **Invariants:** at most 16 owned tabs; every page action carries the endpoint, target and session recorded at open; one controller per Pi session id (`src/index.ts` `sessions`, at most 32).
- **Findings**
  - **BH-1 (P2, fixed).** An owned tab the browser no longer had (user closed it by hand, it crashed) could never leave the map: `close` goes to `Target.closeTarget`, the browser answers "No target with given id found", the controller reports `outcome_uncertain` and keeps the handle. The dead handle stayed in `status.tabs`, counted against the 16-tab limit and made `open` refuse once 16 had accumulated. Fix: that CDP answer on `close` releases ownership (closing an absent target changes nothing, so releasing is safe); every other close failure (timeout, abort, transport) still keeps the handle as uncertain. Test: `a tab the browser no longer has is released on close instead of staying owned forever`.
  - BH-2 (P3, catalogued). If the bridge is killed (deadline/abort) after `Target.createTarget` ran but before its reply, the tab exists in the browser but is not recorded: an unowned orphan the controller will never address. Unavoidable without a server-side marker (`BH_TAB_MARKER` is deliberately off); the response says `outcome_uncertain`.
  - BH-3 (P3, catalogued). `sessions` in `src/index.ts` has a hard cap of 32 controllers (its bridge worker is ended on `session_shutdown`, see section 3); after 32 distinct sessions in one Pi process the tool throws for new ones until reload. Intentional: dropping a controller would lose the handles of tabs still open ("reload only after finishing existing browser work").
  - BH-4 (P3, catalogued). `busy`, `acquired` and `dispatched` are set by the same statement; `busy` is the instance lock, the other two are call-local and only choose the error wording and whether `finally` releases the lock. They never disagree, so they were left as they are.

## 2. Session operation lock (`Controller.busy`)

- **States:** free / busy. `status` and `read` do not take it (they never touch the browser); `open` and page actions take it, so a second call is refused ("Serialize interactions"), never queued. Released in `finally` only by the call that took it (`acquired`), tested by `parallel request cannot retarget or release another operation lock`. Explicit and correct. No findings.

## 3. Bridge process (`src/bridge-worker.ts`, `BridgeSession`; one-shot path `src/client.ts`, `bridge`)

- **States per (session, endpoint):** absent -> starting (hello answered `ready`) -> idle <-> busy (one request in flight) -> `ended` (EOF, exit 0) or `killed` (deadline, abort, crash, bad reply, grace expired). A killed or exited worker is replaced, never reused.
- **Transitions:** before every dispatch the worker must answer a ping within 2 s; otherwise it is killed and a fresh one starts, so an action is never sent to a dead worker and nothing is replayed. A crash, deadline, abort, reply over 8 MiB or non-protocol output during a request kills the worker and reports the action as outcome uncertain; the next action starts a fresh worker. `close()` sends EOF and kills the worker only if it ignores EOF for 3 s.
- **Mechanism:** `python/bridge.py --serve` runs `serve()`: a hello with the endpoint, then requests carrying an `id` (ping answered without touching the browser). Each action runs the same endpoint check and daemon self-heal as the one-shot path (`prepare`). The one-shot `client.ts` `bridge` remains for the benchmark baseline and the smoke test.
- **Findings**
  - BH-5 (P3, measured on this Windows host). Killing a worker ends its venv launcher and its interpreter child (three runs). The upstream daemon the worker started outlives the kill, as designed: the next worker reuses it (same daemon pid), and a daemon replaced under a live worker is reached without restarting it (new daemon pid, same worker). Not verified under other console or job setups.
  - BH-6 (P3, catalogued). `python/bridge.py` has a `shutdown` action the controller's field table does not allow: a dead branch from the TypeScript side.
  - BH-7 (P3, catalogued). `startup_lock` uses a non-blocking OS lock: two Pi processes opening on the same endpoint at the same instant make one of them fail with a lock error (reported as an error, nothing dispatched) instead of waiting. Per-session serialization means it needs two sessions.

  - BH-11 (P3, new). An idle worker lives until its session shuts down. Measured resident size: about 43 MB (launcher, helper, interpreter). Controllers are capped at 32, so the worst case is about 1.4 GB of idle workers. No idle reaping yet.

## 4. Local browser record (`scripts/browser.mjs`: `browser.json`, `start`, `stop`)

- **States (persisted in `$PI_BROWSER_HARNESS_HOME/browser.json`):** absent -> recorded (written after the browser answered `/json/version` with its identity) -> absent (written by `stop` after closure is verified). The record holds `{endpoint, ws, profile, pid}`.
- **Transitions:** `start`: absent -> launch -> readiness (DevToolsActivePort, version identity) -> recorded; recorded -> identity check -> `running`. `stop`: recorded -> identity check -> `Browser.close` -> wait until the endpoint refuses -> unlink. Idle close (`closeIdle`, run by the extension every minute): recorded and unused for `PI_BROWSER_HARNESS_IDLE_MINUTES` (default 30; last use = newer mtime of `last-used`, touched before and after each page action, or of `browser.json`) -> identity check -> the same verified close as `stop`; another identity is left running (`refused`).
- **Findings**
  - **BH-8 (P2, fixed).** The record was read back and trusted: `start` and `stop` both did `await version(saved.endpoint)` and let any failure propagate. After the browser was closed by hand, crashed or the machine restarted, the record named a dead endpoint: `start` failed with `fetch failed`, `stop` failed the same way, and neither removed the record, so the CLI could never start or stop again until someone deleted `browser.json` by hand. Fix: `recordedBrowser()` treats a connection **refusal** (the same proof `waitForClosed` already requires) as "browser gone", removes the stale record and lets `start` launch a new browser / `stop` report `not_running`; resets, timeouts and an identity mismatch are not proof and still stop with an error, record kept (a live browser at that port with another identity is never touched). Test: `a record whose endpoint refuses connections is stale and removed; other probe failures keep it`.
  - BH-9 (P3, catalogued). `status` reports `recorded` from the file alone, without probing, so it can say `recorded` for a dead browser until `start` or `stop` cleans it (BH-8). It is read-only by design.
  - **BH-12 (P2, fixed).** Nothing closed the browser once the work ended: on 03-04/11 an Edge started at 17:34 for one task kept 13 `msedge.exe` processes running until the operator found them the next night. Fix: idle close above. Tests: `an idle recorded browser is closed after the idle window; recent use, another identity or zero keep it`, `a browser started but never used counts its idle time from the launch record`, and the lifecycle test (page actions restart the idle clock, `status` does not).
  - BH-10 (P3, catalogued). Two concurrent `start` calls both see no record and both launch; the second write wins and the first browser is left without a record. Readiness failure after launch also leaves a detached browser without a record ("outcome uncertain, no automatic restart" in the message). Needs a start lock; not worth it for a manual CLI.

## 5. Result receipts (`Controller.receipts`)

FIFO of 8 results; unknown or expired receipts and bad offsets are errors, not empty reads. Explicit and tested. No findings.

## Summary

| machine | states | explicitness before | after | findings |
| --- | --- | --- | --- | --- |
| Owned tab | unknown / owned | map membership, one writer per transition | map membership + "target gone" release | BH-1 P2 fixed, BH-2 P3, BH-3 P3, BH-4 P3 |
| Session operation lock | free / busy | one flag, released by owner only | unchanged | none |
| Bridge process | one process per action (before), one worker per session: starting / idle / busy / ended / killed | `failure` string + listeners | ping before dispatch, replace on kill, EOF on close | BH-5 P3 (measured), BH-6 P3, BH-7 P3, BH-11 P3 |
| Local browser record | absent / recorded | persisted JSON read unvalidated | stale record detected by connection refusal | BH-8 P2 fixed, BH-9 P3, BH-10 P3 |
| Result receipts | up to 8 | explicit | unchanged | none |

Not run here: `browser-smoke` (launches a real local browser) and the real CDP error text of BH-1 was matched from Chromium's documented message; the controller test uses a fake transport that raises it.
