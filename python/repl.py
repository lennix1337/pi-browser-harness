"""REPL cells on one owned tab: a namespace per tab that survives between cells, a CDP handle that cannot leave the tab,
compact accessibility state, dialog policy and per-session event routing.

This is a mistake guard, not a sandbox: it stops a cell from driving another tab or the browser by accident. Tab
ownership itself stays in the TypeScript controller, which only ever sends this worker the target/session it owns.
"""
import ast
import base64
import builtins
import contextlib
import io
import json
import math
import os
import re
import sys
import threading
import time
import traceback
from collections import deque
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ax  # noqa: E402  vendored from browser-use 1.0.0, never edited

OUTPUT_LIMIT = 1_000_000
PAGE_TIMEOUT = 40.0
NETWORK_LIMIT = 256
CAPTURE_TIMEOUT = 4.0
CAPTURE_RETRY_TIMEOUT = 60.0

BLOCKED_MODULES = {"browser_harness", "websockets", "cdp_use", "socket", "subprocess", "ctypes", "importlib", "multiprocessing"}
BLOCKED_OS = {"system", "popen", "startfile", "execv", "execve", "execl", "execle", "execlp", "execvp", "spawnv", "spawnl",
              "spawnve", "spawnvp", "fork", "forkpty", "kill", "killpg", "posix_spawn"}
BLOCKED_NAMES = {"_send", "__import__"}
READ_METHOD = re.compile(r"^[A-Za-z]+\.(get\w*|query\w*|describe\w*|resolve\w*|search\w*|captureScreenshot|enable|disable)$")


class Refused(Exception):
    """A cell the guard stops before it runs."""


def check_code(code):
    """Refuse cells that import the transport or processes, or reach the daemon directly. Syntax errors pass: compiling reports them."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return
    for node in ast.walk(tree):
        names = []
        if isinstance(node, ast.Import):
            names = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            names = [node.module or ""]
            if (node.module or "").split(".")[0] == "os":
                blocked = [alias.name for alias in node.names if alias.name in BLOCKED_OS]
                if blocked:
                    raise Refused(f"refused: cell imports os.{blocked[0]}; cells cannot start processes")
        for name in names:
            if name.split(".")[0] in BLOCKED_MODULES:
                raise Refused(f"refused: cell imports {name}; cells reach the browser only through the helpers and cdp()")
        if isinstance(node, ast.Name) and node.id in BLOCKED_NAMES:
            raise Refused(f"refused: cell uses {node.id}; cells reach the browser only through the helpers and cdp()")
        if isinstance(node, ast.Attribute) and (node.attr in BLOCKED_NAMES or (node.attr in BLOCKED_OS and isinstance(node.value, ast.Name) and node.value.id == "os")):
            raise Refused(f"refused: cell uses {node.attr}; cells reach the browser only through the helpers and cdp()")


def _type_dispatch(helper, *args, **kwargs):
    """Dispatch `type(...)` to builtins.type for 1-arg or 3-arg class creation, otherwise to the tab helper."""
    if not kwargs:
        if len(args) == 1:
            return builtins.type(args[0])
        if len(args) == 3 and isinstance(args[0], str) and isinstance(args[1], tuple):
            return builtins.type(*args)
    return helper(*args, **kwargs)


def is_effect(method):
    """Whether a CDP method can change the page or the server. Reads and domain enables are not effects."""
    return READ_METHOD.match(method) is None


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
    while len(entries) > NETWORK_LIMIT:
        entries.pop(next(iter(entries)))


def network_filter(criteria):
    unknown = set(criteria) - {"method", "urlContains", "resourceType", "status"}
    if unknown:
        raise ValueError(f"network() takes method, urlContains, resourceType, status; got {sorted(unknown)[0]}")
    for key in ("method", "urlContains", "resourceType"):
        if key in criteria and (not isinstance(criteria[key], str) or not 0 < len(criteria[key]) <= 512):
            raise ValueError(f"network({key}=...) must be a string of 1-512 characters")
    status = criteria.get("status")
    if status is not None and (isinstance(status, bool) or not isinstance(status, int) or not 100 <= status <= 599):
        raise ValueError("network(status=...) must be an HTTP status, 100-599")
    return criteria


def page_url(value):
    u = urlparse(value) if isinstance(value, str) and len(value) <= 8192 else None
    if u is None or u.scheme not in {"http", "https"} or not u.hostname or u.username or u.password:
        raise ValueError("goto() takes an http(s) URL without credentials, up to 8192 characters")
    return value


KEYS = {"Enter": (13, "\r"), "Tab": (9, None), "Escape": (27, None), "Backspace": (8, None), "Delete": (46, None),
        "ArrowUp": (38, None), "ArrowDown": (40, None), "ArrowLeft": (37, None), "ArrowRight": (39, None),
        "Home": (36, None), "End": (35, None), "PageUp": (33, None), "PageDown": (34, None), "Space": (32, " ")}


class Router:
    """Drains the daemon's event buffer once and hands each event to the tab that owns its session."""

    def __init__(self, min_interval=0.025):
        from browser_harness import helpers
        self.helpers = helpers
        self.tabs = {}
        self.lock = threading.Lock()
        self.min_interval = min_interval
        self.thread = None

    def register(self, tab):
        self.tabs[tab.session] = tab

    def unregister(self, session):
        self.tabs.pop(session, None)

    def pump(self):
        with self.lock:
            events = self.helpers._send({"meta": "drain_events"}).get("events", [])
            for event in events:
                params = event.get("params") or {}
                tab = self.tabs.get(event.get("session_id") or params.get("sessionId"))
                if tab is not None:
                    tab.on_event(event)

    def start(self):
        if self.thread is not None:
            return

        def loop():
            while True:
                try:
                    self.pump()
                    time.sleep(self.min_interval)
                except Exception:  # daemon not up yet or restarting
                    time.sleep(0.5)
        self.thread = threading.Thread(target=loop, daemon=True, name="pi-event-router")
        self.thread.start()


_SEND_LOCK = threading.Lock()


class Tab:
    """One owned tab: its namespace, its event record and the guarded CDP handle its cells use."""

    def __init__(self, router, endpoint, target, session, ax_factory=None, ws_url=None):
        self.router, self.endpoint, self.target, self.session = router, endpoint, target, session
        self.helpers = router.helpers
        self.ws_url = ws_url
        self.ax_queue = deque(maxlen=ax.EVENT_BUFFER)
        self.network_entries = {}
        self.inflight = {}
        self.last_net = 0.0
        self.dialog_accept = False
        self.dialog_reports = []
        self.interceptor = None
        self.url = None
        self.effect = False
        self.buffer = []
        self.lock = threading.RLock()
        self._ax_factory = ax_factory
        self._ax = None
        self.namespace = self._namespace()
        router.register(self)

    # --- events ---

    def on_event(self, event):
        method, params = event.get("method", ""), event.get("params") or {}
        with self.lock:
            if method == "Page.javascriptDialogOpening":
                self._dialog(params)
                return
            if method.startswith("Network."):
                apply_network_event(self.network_entries, event)
                rid = params.get("requestId")
                if method == "Network.requestWillBeSent" and params.get("type") not in ("WebSocket", "EventSource", "Media", "Ping", "Manifest"):
                    self.inflight[rid] = time.monotonic()
                elif method in ("Network.loadingFinished", "Network.loadingFailed"):
                    self.inflight.pop(rid, None)
                self.last_net = time.monotonic()
            self.ax_queue.append(event)

    def _dialog(self, params):
        kind = params.get("type")
        accept = kind in ("alert", "beforeunload") or self.dialog_accept
        self.dialog_reports.append(f"[dialog {kind}] {ax.quote(ax.clip(params.get('message', ''), 300))} ({'accepted' if accept else 'dismissed'})")
        try:
            self.helpers.cdp("Page.handleJavaScriptDialog", session_id=self.session, accept=accept,
                             promptText=params.get("defaultPrompt", ""), _response_timeout=5)
        except Exception:
            pass

    # --- the AX helpers, fed this tab's events only ---

    def _ipc(self, request, response_timeout=5.0):
        if request == {"meta": "drain_events"}:
            with self.lock:
                events = list(self.ax_queue)
                self.ax_queue.clear()
            return {"events": events}
        if request == {"meta": "session"}:
            return {"session_id": self.session}
        return self._original_send(request, response_timeout)

    def _make_ax(self, cdp, log, on_event):
        # AxHelpers binds helpers._send when built and drains the daemon's shared buffer from its own thread. Give it a
        # send that answers from this tab's events, and keep the dialog policy here (it accepts every dialog).
        with _SEND_LOCK:
            self._original_send = self.helpers._send
            self.helpers._send = self._ipc
            try:
                return ax.AxHelpers(cdp, log, on_event)
            finally:
                self.helpers._send = self._original_send

    @property
    def ax(self):
        if self._ax is None:
            factory = self._ax_factory or self._make_ax
            self._ax = factory(self._ax_cdp, self._emit, None)
        return self._ax

    # --- CDP ---

    def _raw(self, method, params):
        timeout = params.pop("_response_timeout", PAGE_TIMEOUT)
        if method == "Target.getTargetInfo":
            return self.helpers.cdp(method, _response_timeout=timeout, targetId=self.target)
        return self.helpers.cdp(method, session_id=self.session, _response_timeout=timeout, **params)

    def _guard(self, method):
        if method.split(".")[0] in ("Target", "Browser") and method != "Target.getTargetInfo":
            raise Refused(f"refused: {method} would act outside the owned tab (new tabs only through the open action)")

    def _ax_cdp(self, method, session_id=None, **params):
        self._guard(method)
        self.called = True
        return self._raw(method, params)

    def cdp(self, method, session_id=None, **params):
        """The cell's CDP handle. The session is always the owned tab's, whatever the cell passes."""
        self._guard(method)
        params.pop("targetId", None) if method == "Target.getTargetInfo" else None
        if is_effect(method):
            self.effect = True
        self.called = True
        return self._raw(method, params)

    def _emit(self, text):
        self.buffer.append(str(text) + "\n")

    def _acted(self):
        self.effect = True
        self.ax.acted = True
        self.ax.acted_at = ax.now()

    # --- helpers available to cells ---

    def _namespace(self):
        tab = self

        def echo(value):
            if value is not None and not isinstance(value, ax.Printed):
                print(repr(value))
            return None

        def goto(url, settle_ms=3000):
            page_url(url)
            started = ax.now()
            result = tab.cdp("Page.navigate", url=url)
            if result.get("errorText"):
                raise RuntimeError(f"goto failed: {result['errorText']}")
            tab._acted()
            tab.ax.settle(cap_ms=settle_ms, since=started)
            print(f"[ok] goto {url}")
            return ax.Printed(url)

        def state(max=3000):
            return tab.ax.state(max=max)

        def click(id):
            tab.effect = True
            return tab.ax.click(id)

        def _type_helper(id, text, enter=False):
            tab.effect = True
            return tab.ax.type(id, text, enter=enter)

        def type_(*args, **kwargs):
            return _type_dispatch(_type_helper, *args, **kwargs)

        def press(key):
            code, text = KEYS.get(key, (None, None))
            if code is None:
                if not isinstance(key, str) or len(key) != 1:
                    raise ValueError(f"press() takes {', '.join(KEYS)} or one character")
                code, text = ord(key.upper()), key
            fields = {"key": key if key != "Space" else " ", "code": key, "windowsVirtualKeyCode": code, "nativeVirtualKeyCode": code}
            tab.cdp("Input.dispatchKeyEvent", type="rawKeyDown", **fields)
            if text:
                tab.cdp("Input.dispatchKeyEvent", type="char", text=text, unmodifiedText=text, **fields)
            tab.cdp("Input.dispatchKeyEvent", type="keyUp", **fields)
            tab._acted()
            print(f"[ok] press {key}")
            return ax.Printed(key)

        def scroll(dy=0, dx=0):
            tab.cdp("Runtime.evaluate", expression=f"window.scrollBy({float(dx)},{float(dy)})", returnByValue=True)
            tab._acted()
            print(f"[ok] scroll dx={dx} dy={dy}")
            return ax.Printed("scroll")

        def upload(id, *paths):
            files = [os.path.abspath(p) for p in paths]
            if not files or not all(os.path.isfile(p) for p in files):
                raise ValueError("upload(id, path, ...) needs existing files")
            tab.cdp("DOM.setFileInputFiles", backendNodeId=id, files=files)
            tab._acted()
            print(f"[ok] upload [{id}] {len(files)} file(s)")
            return ax.Printed("upload")

        def js(expression):
            result = tab.cdp("Runtime.evaluate", expression=expression, returnByValue=True, awaitPromise=True, userGesture=True)
            if result.get("exceptionDetails"):
                details = result["exceptionDetails"]
                raise RuntimeError("JavaScript failed: " + ((details.get("exception") or {}).get("description") or details.get("text", "exception")))
            remote = result.get("result") or {}
            return remote.get("value", remote.get("unserializableValue", remote.get("description")))

        def visible(text):
            found = tab._read("Runtime.evaluate", expression=f"document.body && document.body.innerText.includes({json.dumps(text)})", returnByValue=True)
            return bool((found.get("result") or {}).get("value"))

        def wait_for(condition, timeout=10.0):
            deadline = time.monotonic() + timeout
            while True:
                ok = condition() if callable(condition) else visible(condition)
                if ok:
                    return True
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"wait_for timed out after {timeout}s")
                time.sleep(0.1)

        def wait_for_network_idle(timeout=10.0, idle_ms=500):
            deadline = time.monotonic() + timeout
            while True:
                tab.router.pump()
                with tab.lock:
                    busy = any(time.monotonic() - t < 1.5 for t in tab.inflight.values())
                    quiet = (time.monotonic() - tab.last_net) * 1000 >= idle_ms
                if not busy and quiet:
                    return True
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"network still busy after {timeout}s")
                time.sleep(0.05)

        def network(**criteria):
            network_filter(criteria)
            tab.router.pump()
            with tab.lock:
                entries = list(tab.network_entries.values())
            return [item for item in entries
                    if (not criteria.get("method") or item.get("method", "").upper() == criteria["method"].upper())
                    and (not criteria.get("urlContains") or criteria["urlContains"] in item.get("url", ""))
                    and (not criteria.get("resourceType") or item.get("resourceType") == criteria["resourceType"])
                    and (criteria.get("status") is None or item.get("status") == criteria["status"])]

        def dialog(accept=True):
            tab.dialog_accept = bool(accept)
            return ax.Printed(f"[dialog policy] confirm/prompt will be {'accepted' if accept else 'dismissed'}")

        def intercept(rules):
            from interception import Interceptor, validate_rules
            validate_rules(rules)
            if tab.interceptor is not None:
                raise ValueError("an interceptor is already registered; intercept_status() then intercept_stop() before replacing rules")
            if tab.ws_url is None:
                raise RuntimeError("interception needs the browser WebSocket; reopen through the bridge")
            tab.effect = True
            tab.interceptor = Interceptor(tab.ws_url(), tab.target, rules)
            return tab.interceptor.status()

        def intercept_status():
            return tab.interceptor.status() if tab.interceptor else {"active": False, "events": [], "matches": []}

        def intercept_stop():
            snapshot = intercept_status()
            tab.stop_interceptor()
            snapshot["active"] = False
            return snapshot

        def screenshot(full=False):
            shot = tab.screenshot(full=full, max_width=1280)
            directory = Path(os.environ.get("PI_BROWSER_HARNESS_HOME", Path.home() / ".cache" / "pi-browser-harness")) / "shots"
            directory.mkdir(parents=True, exist_ok=True)
            path = directory / f"{tab.target[:12]}-{int(time.time() * 1000)}.jpg"
            path.write_bytes(base64.b64decode(shot["data"]))
            print(f"[screenshot] {path}")
            return ax.Printed(str(path))

        return {"__name__": "__cell__", "__builtins__": __builtins__, "__bu_echo": echo, "json": json, "re": re, "time": time,
                "math": math, "cdp": tab.cdp, "goto": goto, "state": state, "click": click, "type": type_, "press": press,
                "scroll": scroll, "upload": upload, "js": js, "wait_for": wait_for,
                "wait_for_network_idle": wait_for_network_idle, "network": network, "dialog": dialog, "intercept": intercept,
                "intercept_status": intercept_status, "intercept_stop": intercept_stop, "screenshot": screenshot}

    def _read(self, method, **params):
        self.called = True
        return self._raw(method, params)

    def stop_interceptor(self):
        editor, self.interceptor = self.interceptor, None
        if editor is not None:
            editor.close()

    # --- running cells ---

    def _compile(self, code):
        tree = ast.parse(code, "<cell>", "exec")
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = tree.body[-1]
            call = ast.Call(ast.Name("__bu_echo", ast.Load()), [last.value], [])
            tree.body[-1] = ast.copy_location(ast.Expr(ast.copy_location(call, last)), last)
        return compile(ast.fix_missing_locations(tree), "<cell>", "exec")

    def _page_url(self):
        try:
            self.url = self.helpers.cdp("Target.getTargetInfo", targetId=self.target, _response_timeout=5)["targetInfo"].get("url", "")
        except Exception:
            pass
        return self.url or ""

    def _flush_dialogs(self):
        with self.lock:
            reports, self.dialog_reports = self.dialog_reports, []
        return reports

    def _finish(self, status, error=None):
        # A cell that acted ends with the page, so the next step starts from what is there now.
        if self._ax is not None and getattr(self._ax, "acted", False):
            try:
                self.ax.state()
            except Exception as failure:
                self._emit(f"[state unavailable: {str(failure)[:200]}]")
        for report in self._flush_dialogs():
            self._emit(report)
        output = "".join(self.buffer)
        if len(output) > OUTPUT_LIMIT:
            output = output[:OUTPUT_LIMIT // 2] + "\n... output cut ...\n" + output[-OUTPUT_LIMIT // 2:]
        result = {"status": status, "output": output, "url": self._page_url()}
        if error:
            result["error"] = error
        return result

    def run(self, code):
        self.effect = False
        self.called = False
        self.buffer = []
        stdout = _Writer(self.buffer)
        try:
            check_code(code)
            compiled = self._compile(code)
        except Refused as refusal:
            return self._finish("error", str(refusal))
        except SyntaxError as failure:
            return self._finish("error", f"SyntaxError: {failure.msg} (line {failure.lineno})")
        failure = None
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stdout):
            try:
                exec(compiled, self.namespace)
            except BaseException as error:  # SystemExit and KeyboardInterrupt end the cell, never the REPL
                failure = error
        if failure is None:
            return self._finish("ok")
        text = self._describe(failure)
        return self._finish("outcome_uncertain" if self.effect else "error", text)

    def _describe(self, failure):
        if isinstance(failure, Refused):
            return str(failure)
        frames = [f for f in traceback.extract_tb(failure.__traceback__) if f.filename == "<cell>"]
        where = f" (cell line {frames[-1].lineno})" if frames else ""
        return f"{type(failure).__name__}: {str(failure)[:1500]}{where}"

    def state(self, max=3000):
        self.effect = False
        self.called = False
        self.buffer = []
        stdout = _Writer(self.buffer)
        failure = None
        with contextlib.redirect_stdout(stdout):
            try:
                self.ax.state(max=max)
            except BaseException as error:
                failure = error
        return self._finish("error", self._describe(failure)) if failure else self._finish("ok")

    def screenshot(self, full=False, max_width=1280):
        metrics = self._read("Page.getLayoutMetrics")
        viewport = metrics.get("cssVisualViewport") or {}
        content = metrics.get("cssContentSize") or {}
        width = float(content.get("width") or viewport.get("clientWidth") or 1280) if full else float(viewport.get("clientWidth") or 1280)
        height = float(content.get("height") or viewport.get("clientHeight") or 800) if full else float(viewport.get("clientHeight") or 800)
        scale = min(1.0, max_width / max(width, height))
        params = {"format": "jpeg", "quality": 80, "captureBeyondViewport": bool(full),
                  "clip": {"x": 0, "y": 0, "width": width, "height": height, "scale": scale}}
        shot = self._capture(params)
        return {"data": shot["data"], "format": "jpeg", "width": round(width * scale), "height": round(height * scale), "url": self._page_url()}

    def _capture(self, params):
        """Chrome renders no frame for a tab that is not the front tab of its window, so a capture can wait for ever (seen on
        Windows with several tabs open). The tab is ours and a capture changes nothing, so the first wait is short; on a miss
        the tab is brought forward and the capture asked again, once."""
        try:
            return self._read("Page.captureScreenshot", _response_timeout=CAPTURE_TIMEOUT, **params)
        except TimeoutError:
            self._read("Page.bringToFront")
            return self._read("Page.captureScreenshot", _response_timeout=CAPTURE_RETRY_TIMEOUT, **params)

    def close(self):
        try:
            self.stop_interceptor()
        finally:
            self.router.unregister(self.session)
            self.namespace.clear()


class _Writer(io.TextIOBase):
    def __init__(self, sink):
        self.sink = sink

    def writable(self):
        return True

    def write(self, text):
        self.sink.append(text)
        return len(text)
