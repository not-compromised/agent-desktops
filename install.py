#!/usr/bin/env python3
"""Install an optional, per-user agent desktop runtime."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shlex
from urllib.parse import urlsplit
import socket
import shutil
import subprocess
import tempfile
import time

SOURCE = Path(__file__).resolve().parent
MARKER = "# Managed by agent-desktop install.py"
HOOK = 'require("hypr.agent-desktop")'


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def check_owned(path, previous):
    if path.is_symlink():
        raise RuntimeError(f"Refusing to replace symlink: {path}")
    if path.exists() and previous.get(str(path)) != hashlib.sha256(path.read_bytes()).hexdigest():
        raise RuntimeError(f"Existing or modified file: {path}. Preserve it before installing.")


def configuration(home, runtime, node, port, monitor, backend="hyprland"):
    state = home / ".local/share/hypr-desktop"
    # systemd expands percent specifiers and dollar variables even inside quotes.
    def unit_quote(value):
        return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%').replace('$', '$$') + '"'
    rule = '-- Managed by agent-desktop install.py\nhl.window_rule({\n  match = { class = "^agent-desktops$" },\n  no_initial_focus = true,\n'
    if monitor:
        rule += f'  monitor = {json.dumps(monitor + " silent")},\n'
    rule += '})\n'
    target = "graphical-session.target" if backend == "hyprland" else "default.target"
    service = f'''{MARKER}
[Unit]
Description=Agent desktop MCP on loopback
After={target}
PartOf={target}

[Service]
Type=simple
UMask=0077
Environment=AGENT_DESKTOP_BACKEND={backend}
Environment=HYPR_DESKTOP_PORT={port}
Environment=PATH={unit_quote(str(Path(node).parent) + ":" + str(home / ".local/bin") + ":/usr/local/bin:/usr/bin")}
ExecStart={unit_quote(node)} {unit_quote(runtime / 'mcp/index.js')}
Restart=on-failure
RestartSec=3

[Install]
WantedBy={target}
'''
    watcher = f'''{MARKER}
[Unit]
Description=Open Agent Desktops when desktops become active
After=graphical-session.target hypr-desktop.service
PartOf=graphical-session.target
ConditionPathExists=%h/.local/share/hypr-desktop/local-url

[Service]
ExecStart=/usr/bin/python3 {unit_quote(runtime / 'app/watch.py')}
Environment=PATH={unit_quote(str(Path(node).parent) + ':' + str(home / '.local/bin') + ':/usr/local/bin:/usr/bin')}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=graphical-session.target
'''
    executable = str(runtime / 'bin/agent-desktops').replace('%', '%%')
    for char in ('\\', '"', '`', '$'):
        executable = executable.replace(char, '\\' + char)
    desktop = (SOURCE / 'app/agent-desktops.desktop').read_text().replace('Exec=agent-desktops', 'Exec="' + executable + '"')
    files = {
        home / ".config/hypr/agent-desktop.lua": rule,
        home / ".config/systemd/user/hypr-desktop.service": service,
        home / ".config/systemd/user/agent-desktops-watch.service": watcher,
        home / ".local/share/applications/org.omarchy.AgentDesktops.desktop": desktop,
        state / "url": f"http://127.0.0.1:{port}/mcp\n",
        state / "local-url": f"http://127.0.0.1:{port}/mcp\n",
    }
    if backend == "xvfb":
        for path in list(files):
            if path.name in ('agent-desktop.lua', 'agent-desktops-watch.service', 'org.omarchy.AgentDesktops.desktop'):
                del files[path]
    return files


def installation_links(home, runtime, skip_skills=False, backend="hyprland", skip_command_links=False):
    links = {} if skip_command_links else {home / '.local/bin/agent-desktop': runtime / 'bin/agent-desktop'}
    if backend == 'hyprland' and not skip_command_links:
        links[home / '.local/bin/agent-desktops'] = runtime / 'bin/agent-desktops'
    if not skip_skills:
        for provider in ('.codex', '.claude'):
            links[home / provider / 'skills/agent-desktop'] = runtime / 'skill'
    return links


def legacy_ownership(home, root, files, links):
    root = root.resolve(strict=True)
    entry = root / 'mcp/hypr-desktop/index.js'
    if not entry.is_file():
        raise RuntimeError('Legacy root does not contain the desktop runtime')
    known_links = {
        home / '.local/bin/agent-desktop': root / 'scripts/common/agent-desktop',
        home / '.local/bin/agent-desktops': root / 'apps/agent-desktops/agent-desktops',
        home / '.config/systemd/user/agent-desktops-watch.service': root / 'apps/agent-desktops/agent-desktops-watch.service',
        home / '.local/share/applications/us.pmserver.AgentDesktops.desktop': root / 'apps/agent-desktops/agent-desktops.desktop',
    }
    approved = {}
    for path, target in known_links.items():
        if path not in files and path not in links and path.name != 'us.pmserver.AgentDesktops.desktop':
            continue
        if path.is_symlink() and path.resolve() == target.resolve() and target.is_file():
            approved[path] = path.readlink()
        elif (path.exists() or path.is_symlink()) and (path in files or path in links or path.name == 'us.pmserver.AgentDesktops.desktop'):
            raise RuntimeError(f'Unrecognized legacy link: {path}')
    unit = home / '.config/systemd/user/hypr-desktop.service'
    if not unit.is_file() or unit.is_symlink():
        raise RuntimeError('A regular legacy desktop service is required for adoption')
    directives = []
    environment = []
    allowed = {'Description', 'After', 'PartOf', 'Type', 'Environment', 'ExecStart', 'Restart', 'RestartSec', 'UMask', 'WantedBy'}
    for line in unit.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith(('#', ';', '[')):
            continue
        key, sep, value = line.partition('=')
        if not sep or key not in allowed:
            raise RuntimeError(f'Unrecognized legacy service directive: {key}')
        if key == 'Environment':
            for item in shlex.split(value):
                name, _, setting = item.partition('=')
                if name == 'HYPR_DESKTOP_STATE' and setting != str(home / '.local/share/hypr-desktop'):
                    raise RuntimeError('Custom legacy state directories require a separate explicit migration')
            environment.append(line)
        if key == 'ExecStart':
            directives.append(shlex.split(value))
    if len(directives) != 1 or len(directives[0]) != 2 or Path(directives[0][0]).name != 'node' or Path(directives[0][1]).resolve() != entry:
        raise RuntimeError('Legacy service does not run the expected desktop entry point')
    hashes = {str(unit): hashlib.sha256(unit.read_bytes()).hexdigest()}
    state = home / '.local/share/hypr-desktop'
    for name in ('url', 'local-url'):
        path = state / name
        if path.exists():
            if path.is_symlink():
                raise RuntimeError(f'Refusing legacy endpoint symlink: {path}')
            raw = path.read_text().strip()
            url = urlsplit(raw)
            if url.username or url.password or url.query or url.fragment or not url.hostname or not (url.scheme == 'https' or url.scheme == 'http' and url.hostname in ('127.0.0.1', 'localhost', '::1')):
                raise RuntimeError(f'Invalid legacy endpoint: {path}')
            hashes[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
    return approved, hashes, environment


def install(home, source, port, monitor, start, backend=None, adopt_legacy=None, skip_skills=None, skip_command_links=None):
    state = home / ".local/share/hypr-desktop"
    manifest = state / "installation.json"
    previous = json.loads(manifest.read_text()) if manifest.exists() else {}
    backend = backend or previous.get('backend', 'hyprland')
    if backend not in ('hyprland', 'xvfb'):
        raise RuntimeError('Unknown desktop backend')
    if previous and backend != previous.get('backend', 'hyprland'):
        raise RuntimeError('Remove the managed installation before changing backend')
    if adopt_legacy and previous:
        raise RuntimeError('Legacy adoption is only for an unmanaged installation')
    if adopt_legacy and not start:
        raise RuntimeError('Legacy adoption requires activation, without --no-start')
    skip_skills = previous.get('skip_skills', False) if skip_skills is None else skip_skills
    if previous and skip_skills != previous.get('skip_skills', False):
        raise RuntimeError('Keep the existing skill ownership when updating')
    skip_command_links = previous.get('skip_command_links', False) if skip_command_links is None else skip_command_links
    if previous and skip_command_links != previous.get('skip_command_links', False):
        raise RuntimeError('Keep the existing command ownership when updating')
    root = home / ".local/share/agent-desktop"
    runtime = root / "package"
    node = "/usr/bin/node" if (source / ".packaged").is_file() and Path("/usr/bin/node").is_file() else shutil.which("node")
    if not node:
        raise RuntimeError("Node.js 20 or later is required")
    major = int(run(node, '-p', 'process.versions.node.split(".")[0]', capture_output=True).stdout)
    if major < 20:
        raise RuntimeError("Node.js 20 or later is required")
    config = home / ".config/hypr/hyprland.lua"
    if backend == "hyprland" and not config.is_file():
        raise RuntimeError("A Lua-based Hyprland configuration is required")
    config_target = config.resolve()
    original_config = config_target.read_text() if backend == "hyprland" else None
    if port is None:
        endpoint = state / 'local-url'
        port = previous.get('port') or (urlsplit(endpoint.read_text().strip()).port if endpoint.is_file() else None) or 7873
    if not isinstance(port, int) or not 1024 <= port <= 65535:
        raise RuntimeError('Port must be between 1024 and 65535')
    files = configuration(home, runtime, node, port, monitor, backend)
    links = installation_links(home, runtime, skip_skills, backend, skip_command_links)
    adopted, owned, environment = legacy_ownership(home, Path(adopt_legacy), files, links) if adopt_legacy else ({}, previous.get('files', {}), previous.get('legacy_environment', []))
    unit = home / '.config/systemd/user/hypr-desktop.service'
    if environment:
        files[unit] = files[unit].replace('Type=simple\n', 'Type=simple\n' + '\n'.join(environment) + '\n', 1)
    if (state / 'url').exists() and (adopt_legacy or previous and (state / 'url').read_text() != (state / 'local-url').read_text()):
        files[state / 'url'] = (state / 'url').read_text()
    for path in files:
        if path not in adopted:
            check_owned(path, owned)
    for link, target in links.items():
        if link.exists() or link.is_symlink():
            if link not in adopted and (not link.is_symlink() or link.readlink() != target):
                raise RuntimeError(f"Existing installation at {link}; refusing to replace it")
    if runtime.exists() and previous.get("runtime") != str(runtime):
        raise RuntimeError(f"Unmanaged runtime at {runtime}")
    if runtime.exists() and not start:
        raise RuntimeError("--no-start is for first-time staging; use a normal install to update a runtime")
    if runtime.is_symlink():
        raise RuntimeError(f"Refusing symlink runtime: {runtime}")
    if state.exists() and not manifest.exists() and not adopt_legacy:
        raise RuntimeError(f"Existing MCP state at {state}; migrate that installation explicitly")
    if start:
        dependencies = ('Hyprland', 'hyprctl', 'jq', 'wtype', 'wlrctl', 'grim', 'Xwayland', 'systemd-run', 'wayvnc', 'pw-dump', 'pw-cli', 'pw-link') if backend == 'hyprland' else ('Xvfb', 'xauth', 'xdpyinfo', 'xprop', 'openbox', 'xdotool', 'maim', 'x11vnc', 'dbus-run-session', 'systemd-run')
        for name in (*dependencies, 'systemd-inhibit'):
            if not shutil.which(name):
                raise RuntimeError(f"Missing runtime dependency: {name}")
        if backend == 'hyprland':
            run('python3', '-c', 'import gi; gi.require_version("Gtk", "3.0"); gi.require_version("WebKit2", "4.1"); from gi.repository import Gtk, WebKit2')
        else:
            run('python3', '-c', 'from PIL import Image')
        if monitor and backend == "hyprland":
            monitors = json.loads(run('hyprctl', '-j', 'monitors', capture_output=True).stdout)
            if monitor not in {m['name'] for m in monitors}:
                raise RuntimeError(f"Monitor is not connected: {monitor}")
        if not previous and not adopt_legacy:
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', port))
        active = run('systemctl', '--user', 'list-units', '--state=active,activating', '--no-legend', 'agent-desktop-*.service', 'pm-agent-desktop-*.service', capture_output=True).stdout
        if active.strip():
            raise RuntimeError("Release active agent desktops before updating their runtime")
        if backend == "hyprland" and (previous or adopt_legacy):
            require_closed_viewer(legacy=bool(adopt_legacy))
        if 'hypr-desktop.service' in Path('/proc/self/cgroup').read_text():
            raise RuntimeError("Run the installer from a terminal outside hypr-desktop.service")
        errors = run('hyprctl', 'configerrors', capture_output=True).stdout.strip() if backend == 'hyprland' else ''
        if errors:
            raise RuntimeError(f"Fix existing Hyprland configuration errors first: {errors}")
    root.mkdir(parents=True, exist_ok=True)
    staged = Path(tempfile.mkdtemp(prefix='package-', dir=root))
    backup = root / f"previous-{secrets.token_hex(4)}"
    saved = {path: path.read_bytes() if path.exists() and not path.is_symlink() else None for path in files}
    added_links = []
    units = ['hypr-desktop.service'] + (['agent-desktops-watch.service'] if backend == 'hyprland' else [])
    was_active = {}
    was_enabled = {}
    token_created = False
    swapped = False
    try:
        for name in ('bin', 'config', 'mcp', 'app', 'shared', 'skill', 'docs'):
            shutil.copytree(source / name, staged / name, ignore=shutil.ignore_patterns('node_modules', '__pycache__'))
        for name in ('README.md', 'LICENSE', 'package.json', 'package-lock.json', 'install.py'):
            shutil.copy2(source / name, staged / name)
        packaged = (source / '.packaged').is_file()
        shutil.copytree(source / 'native', staged / 'native',
                        ignore=shutil.ignore_patterns('__pycache__') if packaged else
                        shutil.ignore_patterns('bin', 'omabox-keyboard', 'omabox-pointer', 'omabox-still', '*-client-protocol.h', '*-protocol.c'))
        if backend == 'hyprland' and not packaged:
            (staged / 'scripts').mkdir()
            shutil.copy2(source / 'scripts/build-native.sh', staged / 'scripts/build-native.sh')
            run('bash', str(staged / 'scripts/build-native.sh'), cwd=staged)
        if backend == 'hyprland':
            for helper in ('keyboard', 'pointer', 'still'):
                binary = staged / f'native/bin/agent-desktop-{helper}'
                if not binary.is_file() or binary.is_symlink() or not os.access(binary, os.X_OK):
                    raise RuntimeError(f'Missing native helper: {binary.name}')
        if (source / '.packaged').is_file():
            shutil.copytree(source / 'node_modules', staged / 'node_modules', symlinks=True)
        else:
            run('npm', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', cwd=staged)
        if adopt_legacy:
            rollback = state / f'legacy-installation-{secrets.token_hex(4)}.json'
            with open(rollback, 'x', opener=lambda path, flags: os.open(path, flags, 0o600)) as handle:
                json.dump({'files': {str(path): content.decode() if content is not None else None for path, content in saved.items()},
                           'links': {str(path): str(target) for path, target in adopted.items()}}, handle, indent=2)
        if start:
            for unit in units:
                was_enabled[unit] = subprocess.run(['systemctl', '--user', 'is-enabled', '--quiet', unit]).returncode == 0
                was_active[unit] = subprocess.run(['systemctl', '--user', 'is-active', '--quiet', unit]).returncode == 0
            for unit in reversed(units):
                if was_active[unit]:
                    run('systemctl', '--user', 'stop', unit)
        if runtime.exists():
            runtime.rename(backup)
        staged.rename(runtime)
        swapped = True
        state.mkdir(parents=True, exist_ok=True, mode=0o700)
        state.chmod(0o700)
        token = state / 'token'
        if not token.exists():
            fd = os.open(token, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as f:
                f.write(secrets.token_hex(32) + '\n')
            token_created = True
        for path in adopted:
            path.unlink()
        for path, content in files.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        for link, target in links.items():
            link.parent.mkdir(parents=True, exist_ok=True)
            if not link.is_symlink():
                link.symlink_to(target)
                added_links.append(link)
        if original_config is not None and HOOK not in original_config.splitlines():
            config_target.write_text(original_config + ('\n' if not original_config.endswith('\n') else '') + '\n' + HOOK + '\n')
        if start:
            if backend == 'hyprland':
                run('hyprctl', 'reload')
            errors = run('hyprctl', 'configerrors', capture_output=True).stdout.strip() if backend == 'hyprland' else ''
            if errors:
                raise RuntimeError(f"Hyprland rejected the rule: {errors}")
            run('systemctl', '--user', 'daemon-reload')
            run('systemctl', '--user', 'enable', '--now', 'hypr-desktop.service')
            for attempt in range(20):
                status = subprocess.run([str(runtime / 'bin/agent-desktop'), 'tool', 'status', '{}'], capture_output=True, text=True, timeout=10)
                if status.returncode == 0:
                    break
                time.sleep(.5)
            else:
                raise RuntimeError(f"MCP status failed: {status.stderr}")
            first_activation = not adopt_legacy and (not previous or previous.get('removed') or not previous.get('activated', True))
            if backend == 'hyprland' and (first_activation or was_enabled.get('agent-desktops-watch.service')):
                run('systemctl', '--user', 'enable', '--now', 'agent-desktops-watch.service')
        manifest_temp = manifest.with_suffix('.tmp')
        manifest_temp.write_text(json.dumps({
            'runtime': str(runtime),
            'backend': backend,
            'port': port,
            'legacy_environment': environment,
            'skip_skills': skip_skills,
            'skip_command_links': skip_command_links,
            'version': json.loads((source / 'package.json').read_text())['version'],
            'activated': start or previous.get('activated', False),
            'source': str(source),
            'revision': (source / '.source-revision').read_text().strip() if (source / '.source-revision').is_file() else None,
            'files': {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in files},
        }, indent=2) + '\n')
        manifest_temp.replace(manifest)
    except Exception:
        if swapped:
            if start:
                for unit in reversed(units):
                    subprocess.run(['systemctl', '--user', 'stop', unit], check=False)
                    if not was_enabled.get(unit):
                        subprocess.run(['systemctl', '--user', 'disable', unit], check=False)
            for path, content in saved.items():
                if content is None:
                    path.unlink(missing_ok=True)
                else:
                    path.write_bytes(content)
            if token_created:
                (state / 'token').unlink()
            manifest.with_suffix('.tmp').unlink(missing_ok=True)
            if not previous and state.exists() and not any(state.iterdir()):
                state.rmdir()
            for link in added_links:
                link.unlink()
            for path, target in adopted.items():
                path.unlink(missing_ok=True)
                path.symlink_to(target)
            if original_config is not None:
                config_target.write_text(original_config)
            # Keep the failed runtime for diagnosis; restore the previous copy.
            runtime.rename(root / f"failed-{secrets.token_hex(4)}")
            if backup.exists():
                backup.rename(runtime)
            if start:
                if backend == 'hyprland':
                    subprocess.run(['hyprctl', 'reload'], check=False)
                subprocess.run(['systemctl', '--user', 'daemon-reload'], check=False)
        # A failure can happen after stopping services but before completing
        # the directory swap. Restore that earlier runtime and service state too.
        if backup.exists() and not runtime.exists():
            backup.rename(runtime)
        if start:
            for unit in units:
                if was_active.get(unit):
                    subprocess.run(['systemctl', '--user', 'start', unit], check=False)
        raise
    finally:
        if staged.exists():
            shutil.rmtree(staged)
    if backup.exists():
        print(f"Previous runtime retained at {backup}")
    print('Agent desktop installed' if start else 'Files installed; service and Hyprland reload skipped (--no-start)')
    print(f'Native MCP registration examples: {source / "README.md"}')
    print('The bundled skill can use agent-desktop tool immediately; restart agents to discover the skill.')


def require_closed_viewer(legacy=False):
    for name in (['org.omarchy.AgentDesktops', 'us.pmserver.AgentDesktops'] if legacy else ['org.omarchy.AgentDesktops']):
        owner = run('gdbus', 'call', '--session', '--dest', 'org.freedesktop.DBus',
                '--object-path', '/org/freedesktop/DBus', '--method',
                'org.freedesktop.DBus.NameHasOwner', name, capture_output=True).stdout
        if owner.strip() == '(true,)':
            raise RuntimeError('Close Agent Desktops before updating or removing its runtime')


def uninstall(home, start=True):
    state = home / '.local/share/hypr-desktop'
    manifest = state / 'installation.json'
    if not manifest.is_file():
        raise RuntimeError('No managed installation found; nothing was removed')
    previous = json.loads(manifest.read_text())
    if previous.get('removed') is True:
        print('Agent Desktops is already removed. Retained data was preserved.')
        return
    runtime = home / '.local/share/agent-desktop/package'
    if previous.get('runtime') != str(runtime) or runtime.is_symlink():
        raise RuntimeError('Unrecognized runtime; nothing was removed')
    backend = previous.get('backend', 'hyprland')
    expected = configuration(home, runtime, '/usr/bin/node', 7873, None, backend)
    if set(previous.get('files', {})) != {str(path) for path in expected}:
        raise RuntimeError('Unrecognized installation manifest; nothing was removed')
    for path in expected:
        check_owned(path, previous['files'])
    links = installation_links(home, runtime, previous.get('skip_skills', False), backend, previous.get('skip_command_links', False))
    for link, target in links.items():
        if (link.exists() or link.is_symlink()) and (not link.is_symlink() or link.readlink() != target):
            raise RuntimeError(f'Existing installation at {link}; nothing was removed')
    if start:
        if backend == "hyprland":
            require_closed_viewer()
        active = run('systemctl', '--user', 'list-units', '--state=active,activating', '--no-legend',
                     'agent-desktop-*.service', 'pm-agent-desktop-*.service', capture_output=True).stdout
        if active.strip():
            raise RuntimeError('Release active agent desktops before removing the runtime')
        for unit in (['agent-desktops-watch.service'] if backend == 'hyprland' else []) + ['hypr-desktop.service']:
            run('systemctl', '--user', 'disable', '--now', unit)
    config = home / '.config/hypr/hyprland.lua'
    if backend == "hyprland" and config.is_file():
        target = config.resolve()
        target.write_text(''.join(line for line in target.read_text().splitlines(keepends=True)
                                  if line.strip() != HOOK))
    for path in expected:
        path.unlink(missing_ok=True)
    for link in links:
        link.unlink(missing_ok=True)
    removed = {**previous, 'files': {}, 'removed': True}
    temporary = manifest.with_suffix('.tmp')
    temporary.write_text(json.dumps(removed, indent=2) + '\n')
    temporary.replace(manifest)
    if runtime.exists():
        shutil.rmtree(runtime)
    if start:
        run('systemctl', '--user', 'daemon-reload')
        if backend == 'hyprland':
            run('hyprctl', 'reload')
        errors = run('hyprctl', 'configerrors', capture_output=True).stdout.strip() if backend == 'hyprland' else ''
        if errors:
            raise RuntimeError(f'Runtime removed, but Hyprland reports configuration errors: {errors}')
    print('Agent Desktops removed. Tokens, profiles, settings and retained runtime backups were preserved.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--remove', action='store_true', help='remove managed files and services, preserving profiles, tokens and settings')
    parser.add_argument('--monitor', help='Hyprland output name; place the native overview here without initial focus')
    parser.add_argument('--backend', choices=['hyprland', 'xvfb'], help='local desktop backend; preserved on updates')
    parser.add_argument('--adopt-legacy', type=Path, help='explicitly adopt an installation from this legacy source root')
    parser.add_argument('--skip-skills', action='store_true', default=None, help='leave skill registration to an external integration')
    parser.add_argument('--skip-command-links', action='store_true', default=None, help='leave command wrappers to an external integration')
    parser.add_argument('--port', type=int, help='loopback port; preserve the installed port when omitted')
    parser.add_argument('--no-start', action='store_true', help='install files without reloading Hyprland or enabling/starting the service')
    args = parser.parse_args()
    if args.port is not None and not 1024 <= args.port <= 65535:
        parser.error('port must be between 1024 and 65535')
    if args.monitor and not all(c.isalnum() or c in '-_.' for c in args.monitor):
        parser.error('monitor must be an output name such as DP-1')
    try:
        if args.remove:
            uninstall(Path.home(), start=not args.no_start)
        else:
            install(Path.home(), SOURCE, args.port, args.monitor, not args.no_start, args.backend, args.adopt_legacy, args.skip_skills, args.skip_command_links)
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f'agent-desktop: {error}\n')


if __name__ == '__main__':
    main()
