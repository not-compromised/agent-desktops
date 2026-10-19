---
name: agent-desktop
description: Use before browser or GUI work in an agent desktop.
---

# Agent desktop

Use the `hypr-desktop` MCP tools when available. Otherwise call the same tools through `agent-desktop tool NAME 'JSON_ARGUMENTS'`. The helper reads the local endpoint and token; do not print credentials or build a separate client.

Each claim starts a background desktop using the configured Hyprland or Xvfb backend. The first active batch opens the borderless **Agent Desktops** viewer automatically; additional claims do not reopen or refocus it. Models use ordinary claim/release calls and do not launch the viewer or move user windows. The viewer displays up to eight screens per page with session names, favicons, host labels, and status. Closing it leaves desktops running. Empty fleets display **No active desktops**. Tell the user before claiming; the server also sends desktop notifications. This separates GUI input and browser profiles, not filesystem permissions or arbitrary shell access.

## Open an app

1. Call `claim` with an `owner` describing the task.
2. Use the exact `structuredContent.handle` on every subsequent call. A desktop number is not a handle. Tell the user which desktop opened.
3. Call `open` with that handle and a command array. Use Brave or Chromium for browser tasks; `open` assigns a separate browser profile.
4. Call `observe` and inspect the image. If loading, call `wait` briefly and observe again. A successful launch does not prove the app loaded.

```sh
agent-desktop tool claim '{"owner":"check the settings page"}'
agent-desktop tool open '{"handle":"RETURNED_HANDLE","command":["brave","https://example.com"]}'
agent-desktop tool observe '{"handle":"RETURNED_HANDLE","scale":0.5}'
```

Replace `RETURNED_HANDLE` with the returned value. The shell helper saves screenshots to a private temporary directory and prints the image path. Open that image before interacting.

If authentication is required, ask the user to open **Agent Desktops**, select **Take control** on this screen, and log in. **Escape** returns to watch mode. Verified T3 conversations provide a **Chat** button that opens their related desktops beside a paginated Markdown conversation; replies stay in the original thread. Configured fleets group only verified ownership, never matching titles. The optional private website provides the same grouping with built-in chat. Do not copy cookies or credentials from their usual browser profile.

## Interact

| Tool | Arguments after `handle` | Effect |
|---|---|---|
| `observe` | optional `scale`, `window_id`, `frames`, `interval_ms`; or `mode:"accessibility"` | Screenshot or bounded motion burst; read-only accessibility query |
| `click` | `frame_id`, `x`, `y`, optional `button` | Click a visible target |
| `move` | `frame_id`, `x`, `y` | Move the cursor |
| `scroll` | `frame_id`, `x`, `y`, `dy` | Scroll at a visible position |
| `type` | `text` | Type into the focused field |
| `key` | `combo`, e.g. `ctrl+l` or `Return` | Press a key combination |
| `drag` | `frame_id`, `x`, `y`, `to_x`, `to_y`, optional `duration_ms` | Drag between observed points, then release the button |
| `windows` | none | Inspect mapped windows and opaque `window_id` references |
| `window` | `frame_id`, `window_id`, `action` | Focus, close, move/resize or set fullscreen, then verify the result |
| `held_input` | `keys`, `buttons`, optional `frame_id`, `timeout_ms` | Replace held input; empty arrays release everything |
| `wait` | `ms`, maximum 30000; optional `mode`, `quiet_ms` | Default waits for visible stillness; `change` waits for a change, `settle` for change then stillness, `sleep` for a fixed delay |
| `run` | `command`, optional `timeout_ms` | Run a shell command inside the desktop |
| `keep_open` | `minutes`, 1–1440 or 0 to cancel | Set a bounded intentional wait |

Coordinates always use 2560×1440 pixels. Multiply coordinates seen in a half-scale screenshot by two. Coordinate tools require the latest `frame_id`; observe again after navigation, scrolling or other visual changes. Never guess a target you have not seen.

For window captures, motion evidence, accessibility or held input, read [desktop tools](../docs/desktop-tools.md) before using those options.

Launch apps with `open`, not `run`. In particular, browsers can hand a new launch to an existing browser on the user's real desktop unless `open` supplies the separate profile. Do not use bare `agent-desktop start`, `env`, `run`, `wtype` or real-session Hyprland dispatches to bypass ownership.

## Cleanup and errors

Release every desktop you claimed after saving task outputs, including on failure:

```sh
agent-desktop tool release '{"handle":"RETURNED_HANDLE"}'
agent-desktop tool status '{}'
```

Release stops that desktop and its managed apps, and releases its idle/suspend inhibition. Opened chats stay bound to their original thread after desktop closure. Never release someone else's handle or use `stop all`. Commands and deliberate human input renew the idle deadline. Observation, `windows`, `wait`, and passive watching do not. The default idle limit is 30 minutes and can be changed in Settings. For an intentional wait, use `keep_open` with a bounded number of minutes and retain its handle; release still closes it immediately. Use the viewer countdown or tool metadata for the actual deadline.

A tool error or nonzero exit means failure. An expired handle cannot be revived; claim again only if work remains. If release fails, retain the handle and retry once after inspecting the error, then report any remaining desktop. An unreachable endpoint is not permission to start a competing server. Inspect `journalctl --user -u hypr-desktop` and ask the user to check setup if necessary.

Hyprland desktops start muted. The viewer audio control changes only that desktop, including native PipeWire JACK audio; it does not mute normal desktop sounds. Xvfb has no audio control.

These tools capture the agent desktop only. Capturing or controlling the user's real screen is a separate task and requires their authorization.
