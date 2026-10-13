# Feedback preview correction: 5.0.2 source candidate

Date: 2026-10-13. Implementation base: 96188ae2 (existing codex/nettools-cross-platform-delivery branch). Frozen 5.0.1 production: ac1597a5956386c4f7f5dd101ed9fd247085c4bb. Public 5.0.0 and frozen 5.0.1 assets remain untouched. This is source verification, not package acceptance or release completion.

## Root cause and RED evidence

The actual main/setup/IPC path regenerated the final message from the current OperationLog during Send. Appending `cleaningfiles2` after previewing `scanfiles1` therefore changed the actual JSON HTTP body without another preview. The actual DOM handlers retained stale previews after edits and close/reopen, and accepted Send without preview.

Before production changes, `test/feedback-session.test.cjs` produced 0/5 passes: body differed from preview; no-preview Send succeeded; renderer logs/path/endpoint/text were accepted; duplicate Send read credentials twice; no host authority existed. See [main-red.txt](feedback-502/main-red.txt). The original actual Electron DOM/preload test failed because Send was enabled without preview; see [dom-red.txt](feedback-502/dom-red.txt).

A subsequent actual DOM regression reproduced confirmed delivery being relabeled as failure when auxiliary UI cleanup threw. The corrected error handler only handles rejected Send, and confirmed delivery survives cleanup errors. See [aux-ui-red.txt](feedback-502/aux-ui-red.txt).

Strict cancel-shape follow-up reproduced Date/Map acceptance (6 passes/1 failure) before enforcing plain-record inputs; see [cancel-shape-red.txt](feedback-502/cancel-shape-red.txt). Evidence text normalizes trailing whitespace only.

## Resulting behavior

- The host holds one bounded final-text/form snapshot for five minutes, with a random 128-bit preview ID. It holds no raw log/path proof or renderer-selected endpoint.
- Missing, stale, replaced, changed, cancelled or replayed authority is rejected before the private credential read or transport. Exact form fields and strict cancel arguments are validated; existing local-page/main-frame sender validation remains in force.
- Send consumes authority and sets single-flight state synchronously before its first await. Credential and POST waits cannot change the captured text; new/cleared logs do not alter it. Failure requires a new preview and never automatically retries.
- Message/category/includeLogs edits, modal close, Escape, page teardown and modal removal invalidate UI and host state. Late previews are ignored and only cancel their own token, so they cannot revoke a newer preview. Invalidations preserve the message and explain re-preview.
- Confirmed delivery is independent of usage/settings writes and auxiliary UI cleanup. Existing main Send did not dismiss engagement; this correction adds no such coupling.
- Guard defaults (off, 30 minutes, 1-1440 bounds), five-minute repair timeout/default no action, optional restart and its 60-second cancellation, authorization and long-operation behavior remain unchanged.

## Fresh GREEN verification

Bundled runtime: `/Users/zeen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`, v24.19.0.

- Focused actual main/IPC/session + actual Electron DOM/preload + existing log/feedback regressions: 18/18 pass, 0 failures/cancellations/skips. [focused-green.txt](feedback-502/focused-green.txt)
- Full `node --test test/*.test.cjs`: 259/259 pass, 0 failures/cancellations/skips. [full-green.txt](feedback-502/full-green.txt)
- Existing `.local-tools/powershell/pwsh -NoProfile -NonInteractive -File scripts/test-windows-platform.ps1`: 29 pass, 0 failed, isolated OS fixtures and no real network writes. [windows-green.txt](feedback-502/windows-green.txt)

The actual main fixture executes production Controller initialization, OperationLog, IPC handlers, the feedback gate and real HTTP JSON encoding. Electron lifecycle/native OS actions, private credential lookup and transport are memory fixtures. The actual DOM fixture loads production `ui/index.html`, `ui/app.js` and sandboxed production preload in pinned Electron 44.7.0; it exercises edits, close/reopen, Escape, late replies, failure/re-preview, confirmed-success cleanup and unmount. No real feedback, native helper operation, network configuration or reboot occurred.

All six live version sources are 5.0.2: package.json, build.sh native manifest generation, NetRepairHelper.swift nativeVersion, Windows authorization, Windows network engine/UserAgent and Windows wrapper requests. The packager already derives resource metadata from package.version. pnpm-lock.yaml contains dependency/importer metadata without root version metadata; it is unchanged. Electron 44.7.0, builder 26.15.3 and CI Node 24.21.0 remain locked. Historical fixture versions and frozen wrappers remain unchanged.

## Exact 36 packaged production-file comparison

Compared against frozen ac1597a. Eight of the 36 packaged source/UI/update-script files change; the other 28 remain identical. Native source `src/NetRepairHelper.swift` and manifest generation `build.sh` additionally change only the live version. Tests, current documentation and this evidence are separate from packaged production.

| Production file | Comparison with frozen 5.0.1 |
| --- | --- |
| `package.json` | Changed for feedback or live version |
| `scripts/update-mac.sh` | Identical |
| `scripts/update-win.ps1` | Identical |
| `src/core/controller.cjs` | Identical |
| `src/core/desktop-acceptance.cjs` | Identical |
| `src/core/engagement.cjs` | Identical |
| `src/core/feedback.cjs` | Changed for feedback or live version |
| `src/core/http.cjs` | Identical |
| `src/core/log.cjs` | Identical |
| `src/core/raw-fs.cjs` | Identical |
| `src/core/settings.cjs` | Identical |
| `src/core/update-desktop-acceptance.cjs` | Identical |
| `src/core/update-install.cjs` | Identical |
| `src/core/updater.cjs` | Identical |
| `src/core/watchdog.cjs` | Identical |
| `src/main.cjs` | Changed for feedback or live version |
| `src/platform/common.cjs` | Identical |
| `src/platform/darwin.cjs` | Identical |
| `src/platform/windows-authorization.ps1` | Changed for feedback or live version |
| `src/platform/windows-network.ps1` | Changed for feedback or live version |
| `src/platform/windows.cjs` | Changed for feedback or live version |
| `src/preload.cjs` | Changed for feedback or live version |
| `ui/app.css` | Identical |
| `ui/app.js` | Changed for feedback or live version |
| `ui/assets/icon.icns` | Identical |
| `ui/assets/icon.png` | Identical |
| `ui/assets/img/avatar.png` | Identical |
| `ui/assets/img/qq-group.jpg` | Identical |
| `ui/assets/img/reward-qr.jpg` | Identical |
| `ui/assets/img/sticker-qr.png` | Identical |
| `ui/assets/img/sticker/final.png` | Identical |
| `ui/assets/img/sticker/mascot.png` | Identical |
| `ui/assets/img/sticker/no.png` | Identical |
| `ui/assets/img/sticker/ok.png` | Identical |
| `ui/assets/img/sticker/warn.png` | Identical |
| `ui/index.html` | Identical |

## QUALITY follow-up: unrelated operation busy (same unissued 5.0.2)

At ef347407 the feedback click consumed local preview state before `perform` checked the unrelated global busy flag. During a pending speedtest, Send was skipped but the UI remained disabled while the host authority stayed valid. The production change is one guard in `ui/app.js`: check busy and show the existing wait notice before consuming the local preview. This does not alter the host gate, TTL, sender validation, credentials, transport, version or other operations.

The actual pinned Electron DOM/preload regression first failed at `busy click must preserve usable local preview`; see [busy-red.txt](feedback-502/busy-red.txt). It drives the production WiFi navigation/speedtest handler through an explicitly pending fixture IPC response, then opens feedback and previews. Busy Send invokes no feedback IPC and posts nothing, preserves the host token, local preview, user message and wait notice. After completing the operation and changing the fixture logs, an explicit user click sends exactly the reviewed text; a repeated click creates no duplicate. No automatic send occurs.

Fresh focused regressions pass 18/18 and full bundled Node v24.19.0 regressions pass 259/259, with no failures/cancellations/skips. Evidence: [busy-focused-green.txt](feedback-502/busy-focused-green.txt), [busy-full-green.txt](feedback-502/busy-full-green.txt). The candidate remains unissued 5.0.2 with no packages built, pushed or released. QUALITY recheck remains pending.

## Remaining delivery gates

Independent SPEC then QUALITY review, new 5.0.2 Mac arm64/x64 and Windows x64 six-asset packaging, install/update/rollback verification and first-use/security/real Mac authorization acceptance remain pending. This implementation did not push, build, publish, alter frozen/public packages or take over cleanup Task 4. Existing untracked evidence, including fan-readiness-current-audit-20261013.md, is preserved.
