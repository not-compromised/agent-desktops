# Integration setup

## Native MCP registration

The CLI fallback and native tools call the same server. For Codex, export the token in the terminal that will launch Codex, then register the endpoint:

```sh
export HYPR_DESKTOP_TOKEN="$(cat "$HOME/.local/share/hypr-desktop/token")"
codex mcp add hypr-desktop --url "$(cat "$HOME/.local/share/hypr-desktop/local-url")" --bearer-token-env-var HYPR_DESKTOP_TOKEN
codex
```

Repeat the export in new terminals, or add that export to your shell's personal startup configuration. The registration contains the environment variable name; the token stays in its private state file.

For Claude Code, its native HTTP registration accepts a header:

```sh
claude mcp add --scope user --transport http hypr-desktop "$(cat "$HOME/.local/share/hypr-desktop/local-url")" --header "Authorization: Bearer $(cat "$HOME/.local/share/hypr-desktop/token")"
```

Claude stores the supplied header in its user configuration. Keep that file private. Restart the CLI after registration. Other MCP clients can use the same URL and bearer header; their configuration formats vary.

## T3 Code

Install and verify the package using the CLI instructions first. T3 uses the agent provider's configuration and skills on the machine running its server. If T3 runs elsewhere, installing this package on your laptop alone does not configure that server. The local-only setup here assumes T3 and Hyprland run under the same user on the same machine.

The shell fallback needs no token environment variable. For Codex's native MCP tools, the T3 server must inherit `HYPR_DESKTOP_TOKEN` when it starts. Export it in the launching shell before starting T3. For a systemd-managed T3 server, generate a private environment file without printing the token:

```sh
(umask 077; printf 'HYPR_DESKTOP_TOKEN=%s\n' "$(cat "$HOME/.local/share/hypr-desktop/token")" > "$HOME/.local/share/hypr-desktop/t3.env")
```

Add `EnvironmentFile=%h/.local/share/hypr-desktop/t3.env` under `[Service]` in a drop-in for your T3 user unit. Restart that unit from a terminal outside the T3 session. Use your actual unit name; do not assume everyone has a `t3code.service`. A desktop-launched T3 app needs the variable in its graphical login environment and a complete app restart.

For T3 installations that set `T3_BOOT_SERVICE_UNIT` and load Bash startup files, this optional line in your own `.bashrc` strips real desktop names from ordinary agent shells:

```sh
[ -n "${T3_BOOT_SERVICE_UNIT:-}" ] && unset WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE
```

Place it before any early return for non-interactive shells. Restart the T3 server after changing its captured shell environment. The MCP still finds the real compositor through systemd's user environment and routes app input into the nested desktop. This opt-in guard is not a sandbox and is not needed for the basic CLI setup.

## Conversation ownership and T3 compatibility

Chat requires orchestration protocol 2, bounded conversation snapshots, paginated conversation history, and WebSocket dispatch supporting `message.dispatch` with `deliveryIntent: auto`. Older versions remain usable for desktops with Chat unavailable. Compatibility follows the protocol contracts rather than an unverified minimum version number.

Ownership reads local `userdata/statev2.sqlite` V2 projections and verifies actual Claude/Codex desktop-claim tool receipts. It never guesses from titles or desktop numbers. Missing, ambiguous, or unsupported records leave the desktop viewable with a reason explaining why Chat is disabled. The app never writes T3's database.

The default T3 base directory is `~/.t3`. The current executable is discovered from the managed runtime's `runtime/service-state.json` and its exact active version. The server origin comes from `userdata/server-runtime.json`, falling back to loopback port 3773. An arbitrary `t3` on PATH is never used because it may be an incompatible older CLI. Desktop-only or custom installations can set `AGENT_DESKTOP_T3_CLI` to the current executable's absolute path; `AGENT_DESKTOP_T3_BASE_DIR` and `AGENT_DESKTOP_T3_URL` override the base directory and local server origin. Configure these in the MCP service environment and restart that service from a terminal outside it.

Opening chat issues a temporary eight-hour session with read/operate scopes; normal shutdown revokes it. Messages preserve the conversation's selected model; the server retains its runtime and interaction settings. Unconfirmed sends reuse their command/message identity. Confirmed receipts retain hashes rather than full prompts. Approvals needing T3's own controls must be handled there.

## Fleet viewing

The default installation needs no network gateway or fleet configuration. To connect machines, first expose each machine's existing loopback MCP service through your own authenticated HTTPS/private-network setup. This installer configures no DNS, VPN, firewall, or proxy. Each peer still requires its own bearer token.

On the machine acting as the hub, create `~/.local/share/hypr-desktop/viewer-peers.json`:

```json
[
  {"id":"desktop-a","url":"https://desktop-a.example.com","tokenFile":"desktop-a-token"},
  {"id":"desktop-b","url":"https://desktop-b.example.com","tokenFile":"desktop-b-token"}
]
```

Transfer the existing peer tokens privately into those files, mode 0600. Relative token paths resolve beside `viewer-peers.json`. Choose unique lowercase host IDs; a hub's own ID is its short hostname. Set `HYPR_DESKTOP_HOSTS` to the comma-separated proxy hostnames accepted by each MCP service. Restart only the MCP service from a terminal outside it. Discovery and streams pass through the hub; browser clients never receive peer tokens.

Use Settings in the native viewer to choose a remote hub and private token file. The legacy `~/.config/agent-desktops/fleet.json` file remains supported when no connection has been saved in Settings:

```json
{"url":"https://desktop-hub.example.com","tokenFile":"/absolute/path/to/private/hub-token"}
```

With the local connection selected, both use the installed local endpoint and token, including a custom port. Configured remote URLs require HTTPS; plain HTTP is accepted only on localhost or 127.0.0.1. Close and reopen the viewer after changing its connection. The watcher reads saved settings on its next poll. Offline hosts do not rearm automatic opening until their known desktops have ended.

## Private web dashboard

The same runtime includes a responsive dashboard with grouped desktops and built-in Markdown chat. It is disabled by default. Enable it only behind your own trusted private gateway by setting `AGENT_DESKTOP_VIEWER_ORIGINS=https://desktops.example.com` and adding that hostname to `HYPR_DESKTOP_HOSTS` in a user service drop-in. Restart the MCP service afterward. The listener remains on loopback.

Anyone allowed through that gateway can watch/control the fleet and continue its verified conversations. The web routes rely on the gateway's access boundary; they have no separate login. Agent and peer routes remain bearer-authenticated. Same-origin writes, signed conversation bindings, sanitized Markdown, and stale-generation checks protect routing inside that boundary. The web dashboard keeps chat beside the selected desktop group on wide screens and uses tabs on phones. Closing a screen preserves its opened chat until dismissed.

