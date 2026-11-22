# Chuck Inbox

Personal Telegram inbox and assistant. Existing Telegram → Gmail forwarding is
implemented by `api/webhook.js` and `api/emailBridge.js`.

Merged PR #1 adds an isolated video-analysis worker that reads already-sent Chuck Inbox
emails through a GitHub OIDC-authenticated Vercel endpoint. Existing mail secrets
stay in Vercel. It extracts public YouTube/Instagram media, samples frames, transcribes
speech and runs local CPU models without a paid inference API.

**Rollout status: Instagram active; YouTube not active.** New Instagram video links
forwarded through Chuck Inbox are checked twice an hour. Results include six
sampled frames, a preliminary frame analysis and a separate speech transcript.
The real NASA Instagram test completed and its report/frame attachment arrived in
Gmail. YouTube returned `source_auth_required` on GitHub and remains excluded.
The worker handles videos up to 10 minutes/150 MiB, at most 10 analyses per day.
No paid service was connected; existing Telegram → Gmail forwarding is unchanged.
See [setup, verification, limits and rollback](docs/video-analysis-rollout.md).

Run the offline regression suite with:

```sh
python -m unittest discover -s tests -v
node --test tests/*.test.mjs
```
