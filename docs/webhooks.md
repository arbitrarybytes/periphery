# FlowState: Local Webhook Integrations

FlowState runs a local HTTP server on `http://localhost:49123`. This is the easiest and most secure way to integrate your local developer tools with FlowState. Because the server is bound to `localhost`, external computers on the network cannot trigger it—only scripts running on your machine.

You can trigger a visual cue by sending a simple HTTP POST request.

## The Payload Structure

```json
{
  "cue": "glow-pulse", // Options: "cue-glow", "glow-bottom", "glow-pulse", "comet"
  "color": "rgba(255, 0, 0, 0.8)", // Any valid CSS color
  "msg": "Deployment failed!" // The Kinetic Typography message
}
```

---

## Common Integrations

### 1. Git Hooks (e.g., `pre-push` or `post-commit`)
You can use FlowState to notify you when a long `git push` finishes, or if a pre-commit linting hook fails.

Create or edit the file `.git/hooks/post-commit`:
```bash
#!/bin/bash
# Your normal commit logic here...

# Notify FlowState
curl -X POST http://localhost:49123/notify \
     -H "Content-Type: application/json" \
     -d '{"cue":"glow-bottom", "color":"rgba(0, 255, 100, 0.6)", "msg":"Git Commit Successful"}'
```
*Don't forget to make the hook executable: `chmod +x .git/hooks/post-commit`*

### 2. NPM / Node.js Scripts
You can integrate FlowState directly into your `package.json` to let you know when a massive Webpack build finishes or when your test suite fails.

In `package.json`:
```json
{
  "scripts": {
    "build": "webpack --mode production && npm run notify:success || npm run notify:fail",
    "notify:success": "curl -X POST http://localhost:49123/notify -H \"Content-Type: application/json\" -d '{\"cue\":\"glow-pulse\", \"color\":\"rgba(0, 255, 0, 0.8)\", \"msg\":\"Build Success\"}'",
    "notify:fail": "curl -X POST http://localhost:49123/notify -H \"Content-Type: application/json\" -d '{\"cue\":\"glow-bottom\", \"color\":\"rgba(255, 0, 0, 0.8)\", \"msg\":\"Build Failed!\"}'"
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

Invoke-RestMethod -Uri "http://localhost:49123/notify" -Method Post -Body $body -ContentType "application/json"
```

### 4. Python Scripts (Machine Learning, Data pipelines)
For data scientists running 3-hour long ML training models locally, you can add this to the end of your script so you can minimize the terminal and keep working.

```python
import requests

def notify_flowstate(message, color="rgba(0, 255, 0, 0.8)"):
    try:
        requests.post("http://localhost:49123/notify", json={
            "cue": "glow-pulse",
            "color": color,
            "msg": message
        })
    except Exception:
        pass # Ignore if FlowState is not running

# ... your long training loop ...
notify_flowstate("Model Training Complete!")
```
