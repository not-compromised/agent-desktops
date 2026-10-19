# Native helper provenance

The keyboard, pointer and visual wait helpers come from Diogo Chaves' MIT-licensed omabox at commit `3f6c2ada7ecc2cb1c582da67d8ac1183e52a01d0`.

https://github.com/diogochaves/omabox/tree/3f6c2ada7ecc2cb1c582da67d8ac1183e52a01d0/tools

`LICENSE.omabox` preserves its copyright and permission notice. The vendored Wayland protocol XML files retain their individual copyright and license notices.

Local adaptations replace the omabox mount namespace check with an Agent Desktops endpoint check. The helpers require an explicit numeric desktop, the exact matching Wayland alias, a user-owned runtime and socket, matching launcher metadata and the expected compositor instance. They connect a concrete socket FD, check its peer UID, then recheck the socket inode and generation before sending any Wayland requests. A changed alias cannot retarget an existing connection. They refuse inherited `WAYLAND_SOCKET` connections. The MCP remains responsible for lease, generation, frame validation and serialized input.

Persistent keyboard holders and idle pointer holders are removed. All input belongs to one invocation; pointer down/move/up sequences remain available for bounded drags. Keyboard combos, text, layout selection, stdin text and per-invocation modifiers retain the upstream implementation.

Build with `scripts/build-native.sh`. Outputs are `native/bin/agent-desktop-keyboard`, `agent-desktop-pointer`, and `agent-desktop-still`. Requires a C compiler, make, pkg-config, wayland-scanner, wayland-client and xkbcommon development files. No helper runs during the build.
