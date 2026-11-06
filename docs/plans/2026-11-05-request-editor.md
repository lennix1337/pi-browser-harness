# Request interception and editing

Deliver rule-based outgoing request interception only on harness-owned tabs. Reuse CDP Fetch through a dedicated connection owned by the persistent bridge worker; never intercept browser-wide or adopt a user tab.

1. Add `intercept_start`, `intercept_status`, `intercept_stop` actions. Start accepts 1–16 rules, AND matching by URL glob, URL substring, method and CDP resource type. First matching rule edits URL (same origin only), method, headers (merge/delete) or UTF-8 body. A match limit (default 1, max 100) bounds edits.
2. Test validation and matching before implementation. Reject malformed edits, cross-origin redirects and invalid/unknown fields. Preserve original requests when no rule matches or an edit cannot be applied. No automatic replay.
3. Keep events in a bounded in-memory redacted journal: rule index, method, URL without query/credentials/fragment, changed field names and CDP acknowledgement only. Never persist headers/body/token values.
4. Stop disables Fetch and disconnects its session. Bridge EOF, close and shutdown release connections; hard termination also disconnects CDP. Test stop and abrupt worker loss against a local server.
5. Validate unit, Python, typecheck, guard mutations and real isolated browser smoke. Real smoke verifies server-received method/headers/body, match limits, filters, unaffected sentinel tab, stop and recovery. No third-party site, login or paid call.
6. Document API and limitations, review diff, ship on green CI, merge and verify native discovery. Reload only after recording/finishing owned browser work.

Not included: response editing, manual indefinite request suspension, cross-origin credential forwarding or a proxy server. This edits outgoing requests using bounded automatic rules, without stalling navigation awaiting another tool call.
