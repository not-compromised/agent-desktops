# Inspect and control an owned desktop

These tools require the handle returned by `claim`. They operate on that desktop only. Personal-desktop OMCP remains a separate connection with its own permissions.

## Window and motion evidence

`observe` keeps its existing screenshot behavior. Use `window_id` from its structured window list to capture a window's visible desktop rectangle. Overlapping windows remain in the image. Every frame reports its desktop bounds and scale; input coordinates always use the full 2560 by 1440 desktop.

For motion, request an ordered burst:

```json
{"handle":"YOUR_HANDLE","frames":8,"interval_ms":150,"scale":0.5}
```

Each image has a timestamp and bounds. Only the final `frame_id` authorizes input. A burst permits at most 12 frames, five seconds between its first and last scheduled capture, ten seconds total and 16 MiB of encoded images. It fails on cancellation or a moving capture rectangle. It never focuses a window to capture it.

`window` accepts an observed `window_id`, the latest `frame_id`, and an action. Actions are `focus`, `close`, `fullscreen` with `enabled`, or `move_resize` with `x`, `y`, `width` and `height`. Bounds must fit the desktop. The tool waits for the requested result and reports a timeout when the app or window manager refuses. Close requests normal closure, so an unsaved-document prompt can keep the window open.

## Accessibility

Use `observe` with `mode:"accessibility"`. Optional `window_id`, `role`, `name`, `max_nodes` and `max_depth` narrow the result. Names use literal substring matching. Results distinguish an available tree, a partial tree, an unsupported application and an unavailable private session. Queries never create a coordinate frame. Observe pixels before sending input.

Accessibility reads only verified managed apps on the selected desktop's private buses. Password nodes return a protected, redacted placeholder; their descendants are omitted. Text and value interfaces are not read. Applications that expose no accessibility bridge remain usable through screenshots. Apps opened before a controller restart need reopening to establish their managed identity again.

The private session bus does not activate personal-desktop services or host portals. Application features that require a desktop portal may therefore be unavailable inside an agent desktop. Accessibility is enabled on the private bus; its launcher uses an in-memory settings backend and leaves the user's accessibility preferences unchanged.

## Held keys and buttons

`held_input` replaces the complete held state:

```json
{"handle":"YOUR_HANDLE","frame_id":"LATEST_FRAME","keys":["Control_L"],"buttons":["left"],"timeout_ms":3000}
```

Observe or move while that state remains held. Send empty arrays to release everything:

```json
{"handle":"YOUR_HANDLE","keys":[],"buttons":[]}
```

Adding a key or button needs a fresh frame. Removing input stays possible after frame consumption. Keys are individual XKB names, at most 16; buttons are left, middle and right. The independent deadline is at most 30 seconds, and observation never extends it. Explicit release, desktop shutdown and controller disconnect clean up input. Uncertain cleanup stops the owned desktop before reuse.

Ordinary key and pointer operations share the retained devices while input is held. Clicking or dragging with an already held button is refused. Typing while an ordinary key is held is refused; release it first. Text unavailable in the retained keymap returns an explicit error. Existing typing outside a hold retains its UTF-8 behavior.
