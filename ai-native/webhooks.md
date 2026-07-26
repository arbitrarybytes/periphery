# Periphery: Local Webhook Integrations

Periphery runs a local HTTP server on `http://127.0.0.1:49123`. This is the easiest way to integrate your local developer tools with Periphery.

You can trigger a visual cue by sending a simple HTTP POST request.

## Threat Model

The receiver is unauthenticated, so it is locked down by construction rather than by credentials:

*   **Loopback bind.** The socket is bound to `127.0.0.1`, not `0.0.0.0`, so other machines on the network cannot reach it.
*   **No CORS headers.** Local scripts and CLI tools are unaffected by CORS; sending permissive CORS headers would instead let any web page you visit drive your overlay.
*   **Origin rejection.** Requests carrying an `Origin` header are refused, because local tooling never sends one and browsers always do.
*   **Host checking.** Requests whose `Host` is not a loopback name are refused, which blocks DNS-rebinding attacks.
*   **Allowlisted fields.** `cue` and `icon` must be names the build knows; `color` must parse as an exact hex/`rgb()`/`rgba()` literal or a colour keyword; `msg` is capped at 160 characters. Anything else is dropped, and an unknown `cue` returns `400`. Bodies over 8 KB are refused.

Any process running as your user can still post cues. Treat the endpoint as an "anything on this machine can draw on my screen" surface, not as a security boundary between local programs.

## The Payload Structure

```json
{
  "cue": "glow-pulse",
  "color": "rgba(255, 0, 0, 0.8)",
  "msg": "Deployment failed!",
  "icon": "alert"
}
```

| Field    | Required | Accepted values |
| -------- | -------- | --------------- |
| `cue`    | yes      | `glow`, `glow-bottom`, `glow-pulse`, `glow-agent`, `comet` |
| `color`  | no       | `#rgb` / `#rrggbb` / `#rrggbbaa`, `rgb(...)`, `rgba(...)`, or a colour keyword |
| `msg`    | no       | Text for the kinetic-typography pill, up to 160 characters |
| `icon`   | no       | `gitlab`, `github`, `outlook`, `calendar`, `pomodoro`, `alert`, `agent` — bundled icons only, **not** a URL |
| `urgent` | no       | `true` to deliver at the highest attention tier: pierces focus mode and skips the typing-pause hold. Use sparingly. |

`glow-agent` is the persistent corner beacon built for coding agents: it stays
on screen until the user is back at the keyboard, then replays its message
once. See [agents.md](agents.md) — and prefer the `periphery` CLI or the MCP
server over hand-rolled requests for that use case.

`GET /health` returns the exact lists the running build accepts.

Responses are `200` on success, `400` for an unknown cue or a malformed body, and `403` for a request that fails the origin/host checks.

## Delivery Semantics

A `200` means the cue was **accepted**, not that it is on screen yet. Webhook cues go through the same attention-aware delivery as every other source:

*   While focus mode is on (Focus Assist, presentation mode, the tray toggle, or — when enabled — Teams presence), non-urgent cues (`glow`, `glow-pulse`, `glow-bottom`, `glow-agent`) are held and appear only in the summary (and the digest panel) when focus ends. A `comet` always shows immediately.
*   While the user is actively typing, non-urgent cues wait for the next typing pause (up to 90 seconds) before appearing. `glow-agent` skips this hold — it persists anyway, so there is nothing to time.

If your integration needs a cue to punch through no matter what — a Sev-1 page, a failed deploy gate — send `"cue": "comet"` or add `"urgent": true` to any cue.

---

## Common Integrations

### 1. Git Hooks (e.g. `pre-push` or `post-commit`)
You can use Periphery to notify you when a long `git push` finishes, or if a pre-commit linting hook fails.

Create or edit the file `.git/hooks/post-commit`:
```bash
#!/bin/bash
# Your normal commit logic here...

# Notify Periphery
curl -X POST http://127.0.0.1:49123/notify \
     -H "Content-Type: application/json" \
     -d '{"cue":"glow-bottom", "color":"rgba(0, 255, 100, 0.6)", "msg":"Git Commit Successful"}'
```
*Don't forget to make the hook executable: `chmod +x .git/hooks/post-commit`*

### 2. NPM / Node.js Scripts
You can integrate Periphery directly into your `package.json` to let you know when a massive Webpack build finishes or when your test suite fails.

In `package.json`:
```json
{
  "scripts": {
    "build": "webpack --mode production && npm run notify:success || npm run notify:fail",
    "notify:success": "curl -X POST http://127.0.0.1:49123/notify -H \"Content-Type: application/json\" -d '{\"cue\":\"glow-pulse\", \"color\":\"rgba(0, 255, 0, 0.8)\", \"msg\":\"Build Success\"}'",
    "notify:fail": "curl -X POST http://127.0.0.1:49123/notify -H \"Content-Type: application/json\" -d '{\"cue\":\"glow-bottom\", \"color\":\"rgba(255, 0, 0, 0.8)\", \"msg\":\"Build Failed!\", \"icon\":\"alert\"}'"
  }
}
```

### 3. PowerShell (Windows Task Scheduler)
If you are on Windows, you can use PowerShell to trigger notifications. This is perfect for background Cron Jobs or Task Scheduler scripts.

```powershell
$body = @{
    cue = "comet"
    color = "rgba(0, 150, 255, 0.9)"
    msg = "Nightly Backup Completed"
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://127.0.0.1:49123/notify" -Method Post -Body $body -ContentType "application/json"
```

### 4. Python Scripts (Machine Learning, Data pipelines)
For data scientists running 3-hour long ML training models locally, you can add this to the end of your script so you can minimize the terminal and keep working.

```python
import requests

def notify_periphery(message, color="rgba(0, 255, 0, 0.8)"):
    try:
        requests.post("http://127.0.0.1:49123/notify", json={
            "cue": "glow-pulse",
            "color": color,
            "msg": message
        }, timeout=2)
    except Exception:
        pass  # Ignore if Periphery is not running

# ... your long training loop ...
notify_periphery("Model Training Complete!")
```
