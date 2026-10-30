"""One request through upstream browser-harness. No CLI exec or active-tab helpers."""
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


def main(request):
    endpoint = local_endpoint(request["endpoint"])
    home = Path(os.environ.get("PI_BROWSER_HARNESS_HOME", Path.home() / ".cache" / "pi-browser-harness"))
    runtime = home / hashlib.sha256(endpoint.encode()).hexdigest()[:16]
    runtime.mkdir(parents=True, exist_ok=True)
    os.environ.update(BH_HOME=str(runtime), BH_RECORD="0", BH_TELEMETRY="0", BH_TAB_MARKER="0",
                      BH_DOMAIN_SKILLS="0", BU_CDP_URL=endpoint, BU_NAME="pi", NO_PROXY="localhost,127.0.0.1,::1")
    for key in ("BU_CDP_WS", "BU_BROWSER_ID", "BROWSER_USE_API_KEY", "BH_AGENT_WORKSPACE",
                "BH_RUNTIME_DIR", "BH_TMP_DIR", "BROWSER_HARNESS_HOME"):
        os.environ.pop(key, None)
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
    from browser_harness.admin import ensure_daemon
    from browser_harness.helpers import cdp, _send, SCREENSHOT_IPC_RESPONSE_TIMEOUT_SECONDS
    with startup_lock(runtime / "startup.lock"):
        ensure_daemon(wait=10)
    action = request["action"]
    if action == "shutdown":
        return _send({"meta": "shutdown"})
    if action == "open":
        target = cdp("Target.createTarget", url="about:blank", background=True)["targetId"]
        session = cdp("Target.attachToTarget", targetId=target, flatten=True)["sessionId"]
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
        return cdp("Target.closeTarget", targetId=target)
    if action == "navigate":
        result = call("Page.navigate", url=request["url"])
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
        result = call("Runtime.evaluate", expression=request["expression"], returnByValue=True, awaitPromise=True)
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


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        print(json.dumps({"ok": True, "result": main(json.load(sys.stdin))}, ensure_ascii=True))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)[:500]}))
        sys.exit(1)
