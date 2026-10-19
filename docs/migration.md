# Fleet source migration

The standalone repository owns the desktop runtime, MCP, native viewer, browser dashboard, launcher, bundled skill, tests, and installer. Private integrations own host inventory, wake policy, gateway configuration, provider registration, and a pinned upstream revision.

## Activation order

1. Review and merge the standalone change. Its public Actions workflow runs `scripts/check.sh`.
2. Stage that exact revision through the private integration.
3. Release active desktops and close viewers on each target machine. The installer refuses an active runtime.
4. Activate the public package with the matching Hyprland or Xvfb backend. Adopt the legacy installation explicitly on the first activation. Verify status and installed revision, then exercise claim, open, observe, input, audio where supported, and release.
5. After every machine uses the public package, remove the legacy product trees and tests from the private repository. Keep only fleet adapters and integration tests.

The pending legacy audio follow-up is superseded by this repository's audio implementation. It must remain excluded from the legacy CI/merge queue.

## Preserved behavior

The migration retains standalone conversation verification, sanitized Markdown, signed chat routing, custom local ports, strict remote URLs, and explicit web-dashboard opt-in. Fleet additions include Xvfb, desktop preferences, deadlines and bounded waits, deliberate-input renewal, clipboard/fullscreen controls, stream handoff, notifications, local discovery during hub outages, and desktop-specific PipeWire/JACK audio.

Ordinary desktop audio stays independent. JACK restoration consumes saved routes after unmute so later application routing changes are respected. Partial disconnect failures retain every pending route for a safe retry.

## Data and rollback

Tokens, leases, browser profiles, and settings stay in their existing locations. The installer replaces only its package subdirectory, preserving unrelated contents of the parent directory. Source staging preserves the user's checkout branch and working tree.

Adoption verifies the legacy entry point and recognized links before changing anything. A private rollback record retains the old service files and link targets. The legacy source remains available until all hosts are activated. Dependency staging precedes service shutdown. Activation failure restores the prior runtime, configuration, links, and service activity. Modified or foreign files require explicit reconciliation. Legacy service environment values are retained across updates; an omitted port preserves the installed port. Custom state directories are refused before changes.

## Verification limits

`scripts/check.sh` exercises Node and Python behavior, browser transport fixtures, installer transactions, syntax, desktop entry validation, and the dependency audit. Browser fixtures prove UI behavior, not a running compositor. The optional native GUI suite requires an owned agent desktop. `node mcp/scripts/verify-audio.mjs [OpenAL-library]` tests real silent JACK devices without playing music. Live installation and client verification remain separate release steps.
