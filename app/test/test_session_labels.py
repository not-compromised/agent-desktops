from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from session_labels import Sessions, is_claim_response, native_claim_response


class SessionLabelsTest(unittest.TestCase):
    def test_explicit_remote_title_is_bound_to_the_lease_not_desktop_number(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            config = home / '.local/share/agent-desktop-labels/titles.json'
            config.parent.mkdir(parents=True)
            config.write_text(json.dumps({'remote-handle': {'title': 'Publish Technic 1.4', 'icon': ''}}))
            sessions = Sessions(home)
            lease = {'handle': 'remote-handle', 'desktop': 2, 'owner': 'remote task'}
            self.assertEqual(sessions.titles([lease])[2]['title'], 'Publish Technic 1.4')
            self.assertEqual(sessions.titles([dict(lease, handle='next-handle')])[2]['title'], 'remote task')

    def test_delayed_claim_identity_renames_icon_and_reused_slot(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / '.t3/userdata').mkdir(parents=True)
            with closing(sqlite3.connect(home / '.t3/userdata/statev2.sqlite')) as db, db:
                db.executescript('''
                    CREATE TABLE orchestration_v2_projection_threads(thread_id, project_id, title, deleted_at, payload_json);
                    CREATE TABLE projection_projects(project_id, workspace_root, favicon_path);
                    CREATE TABLE orchestration_v2_projection_provider_threads(thread_id, payload_json);
                    INSERT INTO orchestration_v2_projection_threads VALUES ('thread', 'project', 'Build map editor', NULL, '{}');
                    INSERT INTO orchestration_v2_projection_provider_threads VALUES ('thread', '{"driver":"codex","nativeThreadRef":{"nativeId":"provider","strength":"strong"}}');
                ''')
                db.execute('INSERT INTO projection_projects VALUES (?, ?, ?)', ('project', str(home), None))
            transcript = home / '.codex/sessions/rollout-provider.jsonl'
            transcript.parent.mkdir(parents=True)
            transcript.write_text(json.dumps({
                'timestamp': '2026-09-07T20:00:30Z',
                'payload': {'type': 'custom_tool_call_output', 'output': json.dumps({
                    'structuredContent': {'handle': 'first', 'desktop': 1, 'show': 'background desktop'},
                })},
            }) + '\n')
            lease = {'handle': 'first', 'desktop': 1, 'owner': 'agent task', 'created': 1788811200000}
            sessions = Sessions(home)
            self.assertEqual(sessions.titles([lease])[1], {'title': 'Build map editor', 'icon': ''})
            (home / 'favicon.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')
            with closing(sqlite3.connect(home / '.t3/userdata/statev2.sqlite')) as db, db:
                db.execute("UPDATE orchestration_v2_projection_threads SET title = 'Renamed session'")
            label = sessions.titles([lease])[1]
            self.assertEqual(label['title'], 'Renamed session')
            self.assertEqual(label['icon'], (home / 'favicon.svg').as_uri())
            duplicate = transcript.with_name('rollout-second-native.jsonl')
            duplicate.write_text(transcript.read_text())
            with closing(sqlite3.connect(home / '.t3/userdata/statev2.sqlite')) as db, db:
                db.execute("INSERT INTO orchestration_v2_projection_threads VALUES ('other', 'project', 'Other task', NULL, '{}')")
                db.execute('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?)',
                           ('other', json.dumps({'driver': 'codex', 'nativeThreadRef': {'nativeId': 'second-native', 'strength': 'strong'}})))
            self.assertEqual(sessions.titles([lease])[1]['title'], 'agent task')
            self.assertNotIn('first', sessions.matches, 'a second transcript invalidates cached positive ownership')
            duplicate.unlink()
            with closing(sqlite3.connect(home / '.t3/userdata/statev2.sqlite')) as db, db:
                db.execute('UPDATE orchestration_v2_projection_provider_threads SET payload_json = ? WHERE thread_id = ?',
                           (json.dumps({'driver': 'codex', 'nativeThreadRef': {'nativeId': 'provider', 'strength': 'strong'}}), 'other'))
            sessions.titles([lease])
            self.assertNotIn('first', sessions.matches, 'shared provider IDs must not select an arbitrary T3 thread')
            self.assertEqual(sessions.titles([dict(lease, handle='second', owner='next agent')])[1],
                             {'title': 'next agent', 'icon': ''})


    def test_flat_native_result_requires_the_actual_claim_call(self):
        lease = {'desktop': 1, 'handle': 'owned-handle'}
        payload = {'call_id': 'claim-call', 'output': 'Wall time: 1.8038 seconds\nOutput:\n' +
                   json.dumps(dict(lease, show='local desktop'))}
        self.assertTrue(native_claim_response(payload, lease, {'claim-call'}))
        self.assertFalse(native_claim_response(payload, lease, {'shell-call'}))
        self.assertFalse(is_claim_response(payload, lease))

    def test_mentions_and_lease_file_reads_do_not_identify_a_chat(self):
        lease = {'desktop': 1, 'handle': 'owned-handle'}
        self.assertFalse(is_claim_response({'payload': {'output': json.dumps([lease])}}, lease))
        self.assertFalse(is_claim_response({'payload': {'output': 'claimed handle owned-handle'}}, lease))
        result = {'structuredContent': dict(lease, show='background desktop')}
        wrapped = {'payload': {'output': [{'text': json.dumps({'output': json.dumps(result)})}]}}
        self.assertTrue(is_claim_response(wrapped, lease))
        self.assertTrue(is_claim_response({'payload': {'output': json.dumps({'exit_code': 0}) + '\n' + json.dumps(result)}}, lease))
        self.assertFalse(is_claim_response(dict(result, isError=True), lease))


if __name__ == '__main__':
    unittest.main()
