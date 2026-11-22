# Chuck Inbox

Personal Telegram inbox and assistant. Existing Telegram → Gmail forwarding is
implemented by `api/webhook.js` and `api/emailBridge.js`.

Merged PR #1 adds an isolated video-analysis worker that reads already-sent Chuck Inbox
emails through a GitHub OIDC-authenticated Vercel endpoint. Existing mail secrets
stay in Vercel. It extracts public YouTube/Instagram media, samples frames, transcribes
speech and runs local CPU models without a paid inference API.

**Rollout status: not activated.** Production OIDC access and technical email
delivery are verified. Instagram has passed real download/probe; full analysis
and result delivery are being checked. YouTube remains gated off because the
platform requested authorization on the GitHub runner.
See [setup, verification, limits and rollback](docs/video-analysis-rollout.md).

Run the offline regression suite with:

```sh
python -m unittest discover -s tests -v
node --test tests/*.test.mjs
```
