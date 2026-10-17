from contextlib import closing
import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('desktop_catalog', Path(__file__).parents[1] / 'catalog.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class StatusTest(unittest.TestCase):
    def test_v2_attention_takes_priority_over_latest_run_state(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / '.t3/userdata').mkdir(parents=True)
            connection = sqlite3.connect(home / '.t3/userdata/statev2.sqlite')
            connection.executescript('''
                CREATE TABLE orchestration_v2_projection_runs(thread_id, ordinal, status);
                CREATE TABLE orchestration_v2_projection_runtime_requests(thread_id, status);
                INSERT INTO orchestration_v2_projection_runs VALUES ('thread', 1, 'running');
            ''')
            connection.commit()
            class Sessions:
                matches = {'handle': 'thread'}
                reason = ''
                def titles(self, leases): return {1: {'title': 'Test agent', 'icon': ''}}
            leases = [{'desktop': 1, 'host': 'remote', 'handle': 'handle', 'created': 0, 'owner': 'Test'}]
            status = lambda: module.catalog(home, Sessions(), leases)[0]['agentStatus']
            self.assertEqual(status(), 'Working')
            connection.execute("INSERT INTO orchestration_v2_projection_runtime_requests VALUES ('thread', 'pending')"); connection.commit()
            self.assertEqual(status(), 'Waiting for you')
            connection.execute("UPDATE orchestration_v2_projection_runtime_requests SET status='resolved'")
            connection.execute("UPDATE orchestration_v2_projection_runs SET status='completed'"); connection.commit()
            self.assertEqual(status(), 'Finished')
            connection.close()

    def test_missing_t3_is_viewable_with_an_explicit_chat_reason(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            leases = [{'desktop': 1, 'host': 'local', 'handle': 'handle', 'created': 0, 'owner': 'Test'}]
            result = module.catalog(home, module.Sessions(home), leases)[0]
            self.assertEqual(result['title'], 'Test')
            self.assertIsNone(result['threadId'])
            self.assertIn('T3', result['chatUnavailableReason'])

    def test_unsupported_or_legacy_database_never_guesses_conversation_ownership(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / '.t3/userdata').mkdir(parents=True)
            leases = [{'desktop': 1, 'handle': 'handle', 'created': 0, 'owner': 'Task'}]
            with closing(sqlite3.connect(home / '.t3/userdata/state.sqlite')) as db, db:
                db.execute('CREATE TABLE projection_threads(thread_id)')
            sessions = module.Sessions(home)
            result = module.catalog(home, sessions, leases)[0]
            self.assertIsNone(result['threadId'])
            self.assertIn('No local T3 V2', result['chatUnavailableReason'])
            with closing(sqlite3.connect(home / '.t3/userdata/statev2.sqlite')) as db, db:
                db.execute('CREATE TABLE unsupported_schema(id)')
            result = module.catalog(home, sessions, leases)[0]
            self.assertIsNone(result['threadId'])
            self.assertIn('unsupported V2', result['chatUnavailableReason'])

if __name__ == '__main__': unittest.main()
