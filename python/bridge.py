"""Browser-harness bridge: one request per process (default) or a persistent worker (`--serve`).

Both paths run the same checks on every action: loopback endpoint, no redirects, advertised WebSocket origin, and
self-healing of the upstream daemon under the startup lock. `--serve` only avoids paying the interpreter start and the
upstream imports again. No CLI exec or active-tab helpers.
"""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("CDP redirects refused before following")


def local_endpoint(value):
    u = urlparse(value)
    if (u.scheme != "http" or u.hostname not in {"127.0.0.1", "localhost", "::1"}
            or u.username or u.password or u.path not in {"", "/"} or u.query or u.fragment):
        raise ValueError("Use an explicit loopback HTTP CDP endpoint, e.g. http://127.0.0.1:9333")
    return value.rstrip("/")


@contextlib.contextmanager
def startup_lock(path):
    # OS-released lock: a crashed caller cannot leave an unstealable mkdir lock.
    with open(path, "a+b") as handle:
        handle.seek(0)
        handle.write(b"0")
        handle.flush()
        handle.seek(0)
        if sys.platform == "win32":
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            if sys.platform == "win32":
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def runtime_for(endpoint):
    home = Path(os.environ.get("PI_BROWSER_HARNESS_HOME", Path.home() / ".cache" / "pi-browser-harness"))
    return home / hashlib.sha256(endpoint.encode()).hexdigest()[:16]


def network_file(endpoint, session):
    digest = hashlib.sha256(session.encode()).hexdigest()[:16]
    return runtime_for(endpoint) / f"network-{digest}.json"


def apply_network_event(entries, event):
    method, params = event.get("method", ""), event.get("params") or {}
    rid = str(params.get("requestId", ""))
    if not rid:
        return
    entry = entries.setdefault(rid, {"requestId": rid, "method": "", "url": "", "resourceType": ""})
    if params.get("type"):
        entry["resourceType"] = params["type"]
    if method == "Network.requestWillBeSent":
        req = params.get("request") or {}
        entry.update(method=req.get("method", entry["method"]), url=req.get("url", entry["url"]))
        if isinstance(req.get("postData"), str):
            entry["postData"] = req["postData"][:4096]
    elif method == "Network.responseReceived":
        resp = params.get("response") or {}
        entry.update(url=entry["url"] or resp.get("url", ""), status=resp.get("status"), mimeType=resp.get("mimeType", ""))
    elif method == "Network.loadingFailed":
        entry["errorText"] = params.get("errorText", "loadingFailed")


def load_network_entries(path):
    if not path.exists():
        return {}
    return {item["requestId"]: item for item in json.loads(path.read_text(encoding="utf-8")) if "requestId" in item}


def collect_network(endpoint, session, events):
    grouped = {}
    for event in events:
        sid = event.get("session_id")
        if sid and str(event.get("method", "")).startswith("Network."):
            grouped.setdefault(sid, []).append(event)
    with startup_lock(runtime_for(endpoint) / "startup.lock"):
        for sid, batch in grouped.items():
            path = network_file(endpoint, sid)
            entries = load_network_entries(path)
            for event in batch:
                apply_network_event(entries, event)
            path.write_text(json.dumps(list(entries.values())[-256:], ensure_ascii=True), encoding="utf-8")
        return list(load_network_entries(network_file(endpoint, session)).values())


def configure(value):
    """Validate the endpoint and set the upstream environment. Must run before any upstream import."""
    endpoint = local_endpoint(value)
    runtime = runtime_for(endpoint)
    runtime.mkdir(parents=True, exist_ok=True)
    os.environ.update(BH_HOME=str(runtime), BH_RECORD="0", BH_TELEMETRY="0", BH_TAB_MARKER="0",
                      BH_DOMAIN_SKILLS="0", BU_CDP_URL=endpoint, BU_NAME="pi", NO_PROXY="localhost,127.0.0.1,::1")
    for key in ("BU_CDP_WS", "BU_BROWSER_ID", "BROWSER_USE_API_KEY", "BH_AGENT_WORKSPACE",
                "BH_RUNTIME_DIR", "BH_TMP_DIR", "BROWSER_HARNESS_HOME"):
        os.environ.pop(key, None)
    return endpoint


def verify_endpoint(endpoint):
    # Fail before daemon startup: no auto-discovery, personal browser launch, cloud bootstrap or redirects.
    opener = build_opener(ProxyHandler({}), NoRedirect())
    with opener.open(endpoint + "/json/version", timeout=2) as response:
        if response.geturl() != endpoint + "/json/version":
            raise ValueError("CDP endpoint redirected; refused")
        version = json.load(response)
    ws = urlparse(version["webSocketDebuggerUrl"])
    expected = urlparse(endpoint)
    if ws.scheme != "ws" or ws.hostname != expected.hostname or ws.port != expected.port:
        raise ValueError("CDP WebSocket does not match the configured loopback endpoint")


def prepare(endpoint):
    """Run before every action: verify the endpoint, then self-heal the upstream daemon under the startup lock."""
    verify_endpoint(endpoint)
    from browser_harness.admin import ensure_daemon
    with startup_lock(runtime_for(endpoint) / "startup.lock"):
        ensure_daemon(wait=10)


def main(request):
    """One request, one process: the original one-shot contract."""
    prepare(configure(request["endpoint"]))
    return act(request)


def act(request):
    from browser_harness.helpers import cdp, _send, SCREENSHOT_IPC_RESPONSE_TIMEOUT_SECONDS
    # Upstream's 5s IPC default is too short for awaited page scripts and navigation, and a timeout leaves the
    # effect uncertain. Stay below the host's 45s deadline so the worker, not the host, reports the slow call.
    PAGE_ACTION_IPC_RESPONSE_TIMEOUT_SECONDS = 40.0
    action = request["action"]
    if action == "shutdown":
        return _send({"meta": "shutdown"})
    if action == "open":
        target = cdp("Target.createTarget", url="about:blank", background=True)["targetId"]
        session = cdp("Target.attachToTarget", targetId=target, flatten=True)["sessionId"]
        cdp("Network.enable", session_id=session)
        # Return identity BEFORE navigating. The host records ownership before any further effects.
        return {"target": target, "session": session}
    target, session = request["target"], request["session"]
    def call(method, **params):
        return cdp(method, session_id=session, **params)
    def page_url():
        # The page this tab shows, so the host can tell a consent or billing page before the next input.
        try:
            return cdp("Target.getTargetInfo", targetId=target)["targetInfo"].get("url", "")
        except Exception:
            return ""
    if action == "close":
        closed = cdp("Target.closeTarget", targetId=target)
        network_file(local_endpoint(request["endpoint"]), session).unlink(missing_ok=True)
        return closed
    if action == "network":
        requests = collect_network(local_endpoint(request["endpoint"]), session, _send({"meta": "drain_events"}).get("events", []))
        return {"url": page_url(), "requests": requests, "totalRequests": len(requests)}
    if action == "navigate":
        result = call("Page.navigate", _response_timeout=PAGE_ACTION_IPC_RESPONSE_TIMEOUT_SECONDS, url=request["url"])
        if result.get("errorText"):
            raise RuntimeError(result["errorText"])
        return result
    if action == "inspect":
        nodes = call("Accessibility.getFullAXTree")["nodes"]
        return {"url": page_url(), "nodes": [{"node": n.get("backendDOMNodeId"), "role": n.get("role", {}).get("value"),
                           "name": n.get("name", {}).get("value", "")}
                          for n in nodes if not n.get("ignored")], "totalNodes": len(nodes)}
    if action == "screenshot":
        return call("Page.captureScreenshot", _response_timeout=SCREENSHOT_IPC_RESPONSE_TIMEOUT_SECONDS, format="png", captureBeyondViewport=False)
    if action == "evaluate":
        result = call("Runtime.evaluate", _response_timeout=PAGE_ACTION_IPC_RESPONSE_TIMEOUT_SECONDS, expression=request["expression"], returnByValue=True, awaitPromise=True)
        if "exceptionDetails" in result:
            raise RuntimeError("JavaScript failed: " + result["exceptionDetails"].get("text", "exception"))
        remote = result.get("result", {})
        return {"value": remote.get("value"), "type": remote.get("type"),
                "unserializableValue": remote.get("unserializableValue")}
    if action == "click":
        call("DOM.scrollIntoViewIfNeeded", backendNodeId=request["node"])
        quad = call("DOM.getBoxModel", backendNodeId=request["node"])["model"]["content"]
        x, y = sum(quad[0::2]) / 4, sum(quad[1::2]) / 4
        call("Input.dispatchMouseEvent", type="mousePressed", x=x, y=y, button="left", clickCount=1)
        call("Input.dispatchMouseEvent", type="mouseReleased", x=x, y=y, button="left", clickCount=1)
        return {"dispatched": True, "url": page_url()}
    if action == "type":
        call("DOM.focus", backendNodeId=request["node"])
        call("Input.insertText", text=request["text"])
        return {"dispatched": True, "url": page_url()}
    raise ValueError("Unknown action")


def serve(read, write):
    """Persistent worker for one endpoint. `read` returns one request line (bytes, b"" at EOF); `write` takes one reply.

    Protocol: the host sends a hello with the endpoint, then requests carrying an `id`. Every reply repeats that id.
    A failed action is one error reply and the worker keeps serving. EOF from the host is a clean exit.
    """
    line = read()
    if not line:
        return 0
    hello = json.loads(line)
    try:
        endpoint = configure(hello["endpoint"])
        # Import once per worker: the upstream modules read their environment at import, so configure() ran first.
        from browser_harness import admin, helpers  # noqa: F401
    except Exception as error:
        write({"id": hello.get("id"), "control": "error", "error": str(error)[:500]})
        return 1
    write({"id": hello.get("id"), "control": "ready"})
    while True:
        line = read()
        if not line:
            return 0
        request = None
        try:
            request = json.loads(line)
            if request.get("control") == "ping":
                write({"id": request.get("id"), "ok": True, "control": "pong"})
                continue
            if request.get("endpoint") != endpoint:
                raise ValueError("request endpoint does not match this worker")
            prepare(endpoint)
            write({"id": request.get("id"), "ok": True, "result": act(request)})
        except Exception as error:
            write({"id": request.get("id") if isinstance(request, dict) else None, "ok": False, "error": str(error)[:500]})


if __name__ == "__main__":
    if "--serve" in sys.argv[1:]:
        protocol = sys.stdout.buffer
        # The protocol owns the real stdout; anything upstream prints goes to stderr, which the host discards.
        sys.stdout = sys.stderr

        def write(message):
            protocol.write((json.dumps(message, ensure_ascii=True) + "\n").encode("ascii"))
            protocol.flush()
        sys.exit(serve(sys.stdin.buffer.readline, write))
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        print(json.dumps({"ok": True, "result": main(json.load(sys.stdin))}, ensure_ascii=True))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)[:500]}))
        sys.exit(1)
