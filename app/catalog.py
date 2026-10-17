#!/usr/bin/env python3
"""Resolve local desktop ownership without exporting agent ownership handles."""
from contextlib import closing
import base64
import json
import sqlite3
from pathlib import Path
import sys
import os
from urllib.parse import unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from session_labels import Sessions


def catalog(home, sessions, leases=None):
    path = home / '.local/share/hypr-desktop/leases.json'
    if leases is None:
        leases = json.loads(path.read_text()) if path.exists() else []
    titles = sessions.titles(leases)
    statuses = {}
    database = Path(os.environ.get('AGENT_DESKTOP_T3_BASE_DIR', str(home / '.t3'))) / 'userdata/statev2.sqlite'
    if database.exists():
        try:
            with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=1)) as connection:
                for thread, state in connection.execute("""
                    SELECT r.thread_id, r.status FROM orchestration_v2_projection_runs r
                    WHERE r.ordinal=(SELECT MAX(last.ordinal) FROM orchestration_v2_projection_runs last WHERE last.thread_id=r.thread_id)
                """):
                    statuses[thread] = ({'preparing': 'Working', 'queued': 'Working', 'starting': 'Working',
                        'running': 'Working', 'waiting': 'Working', 'completed': 'Finished',
                        'interrupted': 'Stopped', 'cancelled': 'Stopped', 'rolled_back': 'Stopped',
                        'failed': 'Needs attention'}.get(state, 'Ready'))
                for (thread,) in connection.execute("SELECT DISTINCT thread_id FROM orchestration_v2_projection_runtime_requests WHERE status='pending'"):
                    statuses[thread] = 'Waiting for you'
        except (sqlite3.Error, OSError):
            pass

    result = []
    for lease in leases:
        label = titles[lease['desktop']]
        icon = ''
        uri = urlparse(label.get('icon', ''))
        if uri.scheme == 'file':
            path = Path(unquote(uri.path))
            mime = {'.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png'}.get(path.suffix.lower())
            if mime and path.is_file() and path.stat().st_size <= 1024 * 1024:
                icon = f'data:{mime};base64,' + base64.b64encode(path.read_bytes()).decode()
        result.append({'desktop': lease['desktop'], 'host': lease.get('host'),
                       'generation': lease.get('generation', str(lease['created'])),
                       'title': label['title'], 'icon': icon,
                       'agentStatus': statuses.get(sessions.matches.get(lease['handle']), 'Unknown'),
                       'threadId': sessions.matches.get(lease['handle']),
                       'chatUnavailableReason': '' if sessions.matches.get(lease['handle']) else getattr(sessions, 'reason', 'No verified T3 conversation.')})
    return result


if __name__ == '__main__':
    home = Path.home()
    sessions = {}
    for line in sys.stdin:
        try:
            request = json.loads(line.strip() or '{}')
            leases = request.get('leases')
            if leases is None:
                result = catalog(home, sessions.setdefault('local', Sessions(home)))
            else:
                result = []
                for host in set(lease.get('host', 'local') for lease in leases):
                    group = [lease for lease in leases if lease.get('host', 'local') == host]
                    result.extend(catalog(home, sessions.setdefault(host, Sessions(home)), group))
            print(json.dumps({'desktops': result}), flush=True)
        except Exception as error:
            print(json.dumps({'error': str(error)}), flush=True)
