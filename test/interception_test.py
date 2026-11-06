import base64
import sys
from pathlib import Path
import unittest
import json
import queue
import threading
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from interception import RuleSet, Interceptor


def event(url='http://localhost:1234/api/save?token=private', method='POST', kind='Fetch'):
    return {'requestId': 'r1', 'resourceType': kind, 'request': {
        'url': url, 'method': method, 'headers': {'Authorization': 'private', 'X-Remove': 'old', 'Content-Length': '3'}, 'postData': 'old'}}


class Rules(unittest.TestCase):
    def test_matches_and_edits_only_bounded_requests_without_logging_values(self):
        rules = RuleSet([{'match': {'urlPattern': 'http://localhost:1234/api/*', 'urlContains': '/save', 'method': 'post', 'resourceType': 'Fetch'},
                          'edit': {'method': 'PUT', 'headers': {'x-remove': None, 'X-Test': 'new'}, 'postData': 'á changed'}}])
        patch, record = rules.apply(event())
        self.assertEqual(patch['requestId'], 'r1')
        self.assertEqual(patch['method'], 'PUT')
        self.assertEqual(base64.b64decode(patch['postData']).decode(), 'á changed')
        self.assertEqual(patch['headers'], [{'name': 'Authorization', 'value': 'private'}, {'name': 'X-Test', 'value': 'new'}])
        self.assertEqual(record['url'], 'http://localhost:1234/api/save')
        self.assertNotIn('private', str(record))
        self.assertNotIn('changed', str(record))
        self.assertEqual(rules.apply(event())[0], {'requestId': 'r1'}, 'default limit is one')

    def test_all_filters_and_rule_precedence(self):
        config = {'match': {'urlPattern': 'http://localhost:1234/api/*', 'urlContains': '/save', 'method': 'POST', 'resourceType': 'Fetch'}, 'edit': {'postData': 'edited'}, 'maxMatches': 2}
        rules = RuleSet([config, {**config, 'edit': {'postData': 'second'}}])
        for ev in [event(url='http://localhost:1234/other'), event(method='GET'), event(kind='Document'), event(url='http://localhost:1234/api/items')]:
            self.assertEqual(rules.apply(ev)[0], {'requestId': 'r1'})
        self.assertEqual(rules.apply(event())[1]['rule'], 0)
        self.assertEqual(rules.apply(event())[1]['rule'], 0)
        self.assertEqual(rules.apply(event())[1]['rule'], 1)

    def test_cross_origin_edit_is_skipped_and_original_continues(self):
        rules = RuleSet([{'match': {'urlPattern': 'http://localhost:1234/*'}, 'edit': {'url': 'http://localhost:9876/steal'}}])
        patch, record = rules.apply(event())
        self.assertEqual(patch, {'requestId': 'r1'})
        self.assertEqual(record['outcome'], 'skipped_cross_origin')
        self.assertNotIn('steal', str(record))

    def test_same_origin_url_and_empty_body_are_valid(self):
        rules = RuleSet([{'match': {'urlPattern': 'http://localhost:1234/*'}, 'edit': {'url': 'http://localhost:1234/new', 'postData': ''}}])
        patch, _ = rules.apply(event())
        self.assertEqual(patch['url'], 'http://localhost:1234/new')
        self.assertEqual(patch['postData'], '')

    def test_validation_before_cdp_and_no_unbounded_or_unsafe_rules(self):
        valid = {'match': {'urlPattern': 'http://localhost:1234/*'}, 'edit': {'method': 'PUT'}}
        invalid = [[], [valid] * 17, [{**valid, 'maxMatches': True}], [{**valid, 'maxMatches': 0}], [{**valid, 'maxMatches': 101}],
                   [{**valid, 'edit': {}}], [{**valid, 'edit': {'headers': {'Host': 'bad'}}}],
                   [{**valid, 'edit': {'headers': {'X-Test': 'bad\nvalue'}}}], [{**valid, 'edit': {'postData': 'x' * 65537}}],
                   [{**valid, 'match': {'urlPattern': '*'}}], [{**valid, 'extra': 1}]]
        for config in invalid:
            with self.subTest(config=str(config)[:120]), self.assertRaises(ValueError):
                RuleSet(config)


class Socket:
    def __init__(self, refuse_continue=False):
        self.incoming = queue.Queue()
        self.sent = []
        self.closed = False
        self.refuse_continue = refuse_continue
        self.continued = threading.Event()

    def send(self, raw):
        msg = json.loads(raw)
        self.sent.append(msg)
        result = {'sessionId': 'owned-session'} if msg['method'] == 'Target.attachToTarget' else {}
        reply = {'id': msg['id'], 'result': result}
        if msg['method'] == 'Fetch.continueRequest' and self.refuse_continue:
            reply = {'id': msg['id'], 'error': {'message': 'sensitive untrusted error'}}
        self.incoming.put(json.dumps(reply))
        if msg['method'] == 'Fetch.continueRequest':
            self.continued.set()

    def __iter__(self):
        while True:
            value = self.incoming.get()
            if value is None:
                return
            yield value

    def close(self):
        self.closed = True
        self.incoming.put(None)

    def paused(self, session='owned-session'):
        self.incoming.put(json.dumps({'method': 'Fetch.requestPaused', 'sessionId': session, 'params': event()}))


class Transport(unittest.TestCase):
    def make(self, socket):
        rules = [{'match': {'urlPattern': 'http://localhost:1234/*'}, 'edit': {'postData': 'private-body'}}]
        with patch('websockets.sync.client.connect', return_value=socket):
            return Interceptor('ws://127.0.0.1:9333/devtools/browser/id', 'owned-target', rules)

    def test_attaches_exact_target_ignores_foreign_events_and_disables_on_close(self):
        socket = Socket()
        editor = self.make(socket)
        try:
            socket.paused('foreign-session')
            socket.paused()
            self.assertTrue(socket.continued.wait(2))
        finally:
            editor.close()
        self.assertFalse(editor.status()['active'])
        self.assertEqual(socket.sent[0]['params'], {'targetId': 'owned-target', 'flatten': True})
        self.assertTrue(all(m['sessionId'] == 'owned-session' for m in socket.sent[1:]))
        self.assertEqual([m['method'] for m in socket.sent], ['Target.attachToTarget', 'Fetch.enable', 'Fetch.continueRequest', 'Fetch.disable'])
        self.assertTrue(socket.closed)
        self.assertEqual(editor.status()['events'][0]['outcome'], 'continued')
        self.assertNotIn('private', str(editor.status()))

    def test_failed_continuation_disconnects_without_retry_or_secret_error(self):
        socket = Socket(refuse_continue=True)
        editor = self.make(socket)
        socket.paused()
        editor.thread.join(2)
        self.assertFalse(editor.thread.is_alive())
        self.assertTrue(socket.closed)
        self.assertEqual(editor.status()['events'][0]['outcome'], 'uncertain')
        self.assertNotIn('sensitive', str(editor.status()))
        self.assertEqual(sum(m['method'] == 'Fetch.continueRequest' for m in socket.sent), 1)

    def test_detached_target_is_not_reported_active(self):
        socket = Socket()
        editor = self.make(socket)
        socket.incoming.put(json.dumps({'method': 'Target.detachedFromTarget', 'params': {'sessionId': 'owned-session'}}))
        editor.thread.join(2)
        self.assertFalse(editor.status()['active'])
        self.assertTrue(socket.closed)


if __name__ == '__main__':
    unittest.main()
