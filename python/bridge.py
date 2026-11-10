"""Browser-harness bridge: one persistent worker per Pi session (`--serve`) holding a REPL namespace per owned tab.

Every request runs the same checks first: loopback endpoint, no redirects, advertised WebSocket origin, and
self-healing of the upstream daemon under the startup lock. The cell runtime itself is in repl.py. No CLI exec or
active-tab helpers.
"""
import contextlib
import hashlib
import json
import os
import re
from pathlib import Path
import sys
from urllib.error import URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, build_opener

sys.path.insert(0, str(Path(__file__).resolve().parent))


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


def daemon_name():
    """The upstream daemon this worker talks to: one per Pi session, because each daemon has a single event buffer."""
    name = os.environ.get("PI_BROWSER_HARNESS_DAEMON", "pi")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", name):
        raise ValueError("PI_BROWSER_HARNESS_DAEMON must be 1-64 letters, digits, - or _")
    return name


def configure(value):
    """Validate the endpoint and set the upstream environment. Must run before any upstream import."""
    endpoint = local_endpoint(value)
    runtime = runtime_for(endpoint)
    runtime.mkdir(parents=True, exist_ok=True)
    os.environ.update(BH_HOME=str(runtime), BH_RECORD="0", BH_TELEMETRY="0", BH_TAB_MARKER="0",
                      BH_DOMAIN_SKILLS="0", BU_CDP_URL=endpoint, BU_NAME=daemon_name(), NO_PROXY="localhost,127.0.0.1,::1")
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
    return version["webSocketDebuggerUrl"]


def transient(error):
    """A timeout before anything was dispatched: the one case a second attempt cannot repeat an effect."""
    return isinstance(error, TimeoutError) or (isinstance(error, URLError) and isinstance(error.reason, TimeoutError))


def prepare(endpoint):
    """Run before every request: verify the endpoint, then self-heal the upstream daemon under the startup lock.

    Each step is tried twice at most, and only because nothing has reached the page yet.
    """
    try:
        verify_endpoint(endpoint)
    except Exception as error:
        if not transient(error):
            raise
        verify_endpoint(endpoint)
    from browser_harness.admin import ensure_daemon
    with startup_lock(runtime_for(endpoint) / "startup.lock"):
        try:
            ensure_daemon(wait=10)
        except Exception:
            ensure_daemon(wait=10)


REMOVED = {"navigate", "inspect", "click", "type", "evaluate", "network", "intercept_start", "intercept_status", "intercept_stop"}
DOMAINS = ("Page", "Network", "DOM", "Runtime")


class Worker:
    """The tabs of one endpoint and the cell runtime behind them."""

    def __init__(self, endpoint, start_router=False):
        self.endpoint = endpoint
        self.start_router = start_router
        self.router = None

    def _router(self):
        if self.router is None:
            from repl import Router
            self.router = Router()
            if self.start_router:
                self.router.start()
        return self.router

    def tab(self, request, fresh=False):
        from repl import Tab
        router = self._router()
        target, session = request["target"], request["session"]
        tab = router.tabs.get(session)
        if tab is None:
            if not fresh:
                self.require_live(target, session)
            tab = Tab(router, self.endpoint, target, session, ws_url=lambda: verify_endpoint(self.endpoint))
        elif tab.target != target:
            raise ValueError("session belongs to another tab")
        return tab

    def require_live(self, target, session):
        """A session lives and dies with the daemon connection that attached it; one that ended with its bridge never comes back."""
        from browser_harness.helpers import cdp
        try:
            cdp("Runtime.evaluate", session_id=session, expression="1", _response_timeout=5)
        except Exception as error:
            if "Session with given id not found" in str(error):
                raise RuntimeError("the tab's CDP session ended with its bridge worker; close this tab and open a new one") from None
            raise

    def open(self):
        from browser_harness.helpers import cdp
        target = cdp("Target.createTarget", url="about:blank", background=True)["targetId"]
        try:
            session = cdp("Target.attachToTarget", targetId=target, flatten=True)["sessionId"]
            for domain in DOMAINS:
                cdp(domain + ".enable", session_id=session)
            # A hidden tab runs chained timers about once a second; telling the page it has focus keeps it a background
            # tab (never brought to the front) whose timers, waits and visibility behave like a foreground one.
            cdp("Emulation.setFocusEmulationEnabled", session_id=session, enabled=True)
        except Exception:
            try:
                cdp("Target.closeTarget", targetId=target)
            finally:
                raise
        self.tab({"target": target, "session": session}, fresh=True)
        return {"target": target, "session": session}

    def dispatch(self, request):
        action = request.get("action")
        if action == "open":
            return self.open()
        if action == "shutdown":
            from browser_harness.helpers import _send
            self.close_all()
            return _send({"meta": "shutdown"})
        if action not in {"exec", "state", "screenshot", "close"}:
            raise ValueError("Unknown action")
        if action == "close":
            return self.close_tab(request)
        tab = self.tab(request)
        if action == "exec":
            if not isinstance(request.get("code"), str):
                raise ValueError("exec needs code")
            return tab.run(request["code"])
        if action == "state":
            return tab.state(max=request.get("max", 3000))
        if action == "screenshot":
            return tab.screenshot(full=bool(request.get("full")), max_width=request.get("maxWidth", 1280))

    def close_tab(self, request):
        """Closing needs the target, not a live session, so a tab whose session ended can still be closed."""
        from browser_harness.helpers import cdp
        tab = self.router.tabs.get(request["session"]) if self.router is not None else None
        if tab is not None:
            if tab.target != request["target"]:
                raise ValueError("session belongs to another tab")
            tab.close()
        return cdp("Target.closeTarget", targetId=request["target"])

    def close_all(self):
        if self.router is not None:
            for tab in list(self.router.tabs.values()):
                try:
                    tab.close()
                except Exception:
                    pass

    def release_daemon(self):
        """The session's own daemon ends with its worker; a daemon nobody reads only holds a browser connection open."""
        if self.router is None:
            return
        try:
            self.router.helpers._send({"meta": "shutdown"})
        except Exception:
            pass


def serve(read, write, start_router=False):
    """Persistent worker for one endpoint. `read` returns one request line (bytes, b"" at EOF); `write` takes one reply.

    Protocol: the host sends a hello with the endpoint, then requests carrying an `id`. Every reply repeats that id.
    A failed request is one error reply and the worker keeps serving. EOF from the host is a clean exit. A cell that
    raises is an ok reply whose result carries its own status: the worker did its job and the cell did not.
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
    worker = Worker(endpoint, start_router)
    write({"id": hello.get("id"), "control": "ready"})
    try:
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
                if request.get("action") in REMOVED:
                    raise ValueError(f"removed action {request['action']}; use exec (click(id), type(id, text), js(expr), goto(url), network(...)) or state")
                if request.get("action") != "shutdown":
                    prepare(endpoint)
                write({"id": request.get("id"), "ok": True, "result": worker.dispatch(request)})
            except Exception as error:
                write({"id": request.get("id") if isinstance(request, dict) else None, "ok": False, "error": str(error)[:500]})
    finally:
        worker.close_all()
        worker.release_daemon()


if __name__ == "__main__":
    if "--serve" not in sys.argv[1:]:
        sys.exit("bridge.py runs only as the persistent worker: python bridge.py --serve")
    protocol = sys.stdout.buffer
    # The protocol owns the real stdout; anything upstream prints goes to stderr, which the host discards.
    sys.stdout = sys.stderr

    def write(message):
        protocol.write((json.dumps(message, ensure_ascii=True) + "\n").encode("ascii"))
        protocol.flush()
    sys.exit(serve(sys.stdin.buffer.readline, write, start_router=True))
