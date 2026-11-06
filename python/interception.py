"""Bounded request editing on a dedicated, tab-scoped CDP session. No request values in journals."""
import base64
from collections import deque
from concurrent.futures import Future
from fnmatch import fnmatchcase
import json
import re
import threading
from urllib.parse import urlsplit, urlunsplit

TOKEN = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+\Z")


def text(value, maximum=2048, empty=False):
    return isinstance(value, str) and (empty or bool(value)) and len(value) <= maximum and not any(c in value for c in '\r\n\0')


def http_url(value):
    if not text(value, 8192):
        return False
    try:
        u = urlsplit(value)
        return u.scheme in {'http', 'https'} and bool(u.hostname) and not u.username and not u.password and (u.port is None or u.port > 0)
    except ValueError:
        return False


def validate_rules(rules):
    def fail():
        raise ValueError('Invalid interception rules; use bounded HTTP(S) matches and request edits')
    if not isinstance(rules, list) or not 1 <= len(rules) <= 16 or len(json.dumps(rules, ensure_ascii=False, separators=(',', ':')).encode('utf-8')) > 262144:
        fail()
    for rule in rules:
        if not isinstance(rule, dict) or set(rule) - {'match', 'edit', 'maxMatches'}:
            fail()
        m, e, limit = rule.get('match'), rule.get('edit'), rule.get('maxMatches', 1)
        if not isinstance(m, dict) or set(m) - {'urlPattern', 'urlContains', 'method', 'resourceType'}:
            fail()
        if not text(m.get('urlPattern')) or not re.match(r'https?://[^/]+/', m['urlPattern']):
            fail()
        if any(k in m and not text(m[k]) for k in ('urlContains', 'resourceType')):
            fail()
        if 'method' in m and (not text(m['method'], 32) or not TOKEN.fullmatch(m['method'])):
            fail()
        if type(limit) is not int or not 1 <= limit <= 100:
            fail()
        if not isinstance(e, dict) or not e or set(e) - {'url', 'method', 'headers', 'postData'}:
            fail()
        if 'url' in e and not http_url(e['url']):
            fail()
        if 'method' in e and (not text(e['method'], 32) or not TOKEN.fullmatch(e['method'])):
            fail()
        if 'postData' in e and (not isinstance(e['postData'], str) or len(e['postData']) > 65536):
            fail()
        if 'headers' in e:
            h = e['headers']
            if not isinstance(h, dict) or not 1 <= len(h) <= 32:
                fail()
            seen = set()
            for name, value in h.items():
                lower = name.lower()
                if (not TOKEN.fullmatch(name) or len(name) > 128 or lower in seen
                        or lower in {'host', 'content-length', 'connection', 'transfer-encoding'}
                        or (value is not None and not text(value, 8192, empty=True))):
                    fail()
                seen.add(lower)


def origin(url):
    u = urlsplit(url)
    return u.scheme, u.hostname, u.port or (443 if u.scheme == 'https' else 80)


def safe_url(url):
    u = urlsplit(url)
    # Paths can also contain identifiers: this is metadata, not a privacy boundary for arbitrary URLs.
    return urlunsplit((u.scheme, u.netloc.split('@')[-1], u.path, '', ''))[:2048]


class RuleSet:
    def __init__(self, rules):
        validate_rules(rules)
        self.rules = rules
        self.counts = [0] * len(rules)

    def apply(self, event):
        req = event['request']
        patch = {'requestId': event['requestId']}
        for index, rule in enumerate(self.rules):
            m, e = rule['match'], rule['edit']
            if (self.counts[index] >= rule.get('maxMatches', 1)
                    or not fnmatchcase(req['url'], m['urlPattern'])
                    or ('urlContains' in m and m['urlContains'] not in req['url'])
                    or ('method' in m and m['method'].upper() != req['method'].upper())
                    or ('resourceType' in m and m['resourceType'] != event.get('resourceType'))):
                continue
            self.counts[index] += 1
            record = {'rule': index, 'method': req['method'], 'url': safe_url(req['url']), 'fields': sorted(e), 'outcome': 'pending'}
            if 'url' in e and origin(e['url']) != origin(req['url']):
                record['outcome'] = 'skipped_cross_origin'
                return patch, record
            for key in ('url', 'method'):
                if key in e:
                    patch[key] = e[key]
            if 'postData' in e:
                patch['postData'] = base64.b64encode(e['postData'].encode('utf-8')).decode('ascii')
            if 'headers' in e or 'postData' in e:
                headers = {k.lower(): (k, v) for k, v in req.get('headers', {}).items()}
                for name, value in e.get('headers', {}).items():
                    headers.pop(name.lower(), None)
                    if value is not None:
                        headers[name.lower()] = (name, value)
                # Chromium computes the byte length after a body change; preserving the old length truncates requests.
                if 'postData' in e:
                    headers.pop('content-length', None)
                patch['headers'] = [{'name': k, 'value': str(v)} for k, v in headers.values()]
            return patch, record
        return patch, None


class Interceptor:
    def __init__(self, ws_url, target, rules):
        from websockets.sync.client import connect
        self.rules = RuleSet(rules)
        self.lock = threading.RLock()
        self.pending = {}
        self.journal = deque(maxlen=100)
        self.sequence = 0
        self.session = None
        self.error = None
        self.observed = 0
        self.last_type = None
        self.ws = connect(ws_url, open_timeout=3, close_timeout=2, max_size=8 * 1024 * 1024, proxy=None)
        self.thread = threading.Thread(target=self.receive, daemon=True)
        self.thread.start()
        try:
            self.session = self.send('Target.attachToTarget', {'targetId': target, 'flatten': True}).result(timeout=5)['sessionId']
            self.send('Fetch.enable', {'patterns': [{'urlPattern': '*', 'requestStage': 'Request'}]}).result(timeout=5)
        except Exception:
            self.close()
            raise RuntimeError('Could not enable tab interception; connection released') from None

    def send(self, method, params):
        future = Future()
        with self.lock:
            if len(self.pending) >= 256:
                raise RuntimeError('Interception backlog exceeded; disconnect instead of holding requests')
            self.sequence += 1
            message = {'id': self.sequence, 'method': method, 'params': params}
            if self.session:
                message['sessionId'] = self.session
            self.pending[self.sequence] = future
            try:
                self.ws.send(json.dumps(message))
            except Exception:
                self.pending.pop(self.sequence, None)
                raise
        return future

    def receive(self):
        try:
            for raw in self.ws:
                message = json.loads(raw)
                if 'id' in message:
                    with self.lock:
                        future = self.pending.pop(message['id'], None)
                    if future is not None:
                        if 'error' in message:
                            future.set_exception(RuntimeError('CDP refused request; inspect server state before retrying'))
                        else:
                            future.set_result(message.get('result', {}))
                elif message.get('method') == 'Fetch.requestPaused' and message.get('sessionId') == self.session:
                    self.paused(message['params'])
                elif ((message.get('method') == 'Target.detachedFromTarget' and message.get('params', {}).get('sessionId') == self.session)
                      or (message.get('method') == 'Inspector.detached' and message.get('sessionId') == self.session)):
                    self.error = 'Owned target detached; interception released'
                    break
        except Exception:
            self.error = 'Interception transport lost; connection released, no requests replayed'
        finally:
            # Disconnecting this dedicated session also releases Fetch pauses after crash/EOF.
            self.ws.close()
            with self.lock:
                waiting = list(self.pending.values())
                self.pending.clear()
            for future in waiting:
                future.set_exception(RuntimeError('Interception connection closed; outcome uncertain'))

    def paused(self, event):
        self.observed += 1
        self.last_type = event.get('resourceType')
        patch, record = self.rules.apply(event)
        if record:
            with self.lock:
                self.journal.append(record)
        future = self.send('Fetch.continueRequest', patch)
        def acknowledged(done):
            try:
                done.result()
                if record and record['outcome'] == 'pending':
                    record['outcome'] = 'continued'
            except Exception:
                # Never retry a possibly dispatched edit. Closing releases any request still paused.
                self.error = 'Request continuation failed; disconnected, inspect server state before retrying'
                if record:
                    record['outcome'] = 'uncertain'
                self.ws.close()
        future.add_done_callback(acknowledged)

    def status(self):
        with self.lock:
            return {'active': self.thread.is_alive() and self.error is None, 'matches': list(self.rules.counts),
                    'events': [dict(item) for item in self.journal], 'error': self.error, 'observed': self.observed, 'lastResourceType': self.last_type,
                    'verification': 'CDP continuation only; verify the server response and resulting state separately.'}

    def close(self):
        try:
            if self.thread.is_alive() and self.session:
                self.send('Fetch.disable', {}).result(timeout=3)
        finally:
            self.ws.close()
            self.thread.join(timeout=3)
