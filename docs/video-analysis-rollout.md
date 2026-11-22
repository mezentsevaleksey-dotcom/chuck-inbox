# Chuck Inbox automatic video analysis

## Architecture

The existing `api/webhook.js` and `api/emailBridge.js` are unchanged. Telegram
continues sending the original messages and attachments to Gmail using Resend.
A separate GitHub Actions workflow polls **sent** Resend messages through the new
`api/video-inbox.js` endpoint and processes
only the exact `[Chuck Inbox] ` prefix, sender and configured recipient. The
endpoint checks a short-lived GitHub OIDC token: issuer, RS256 signature, audience,
expiry, immutable repository/owner IDs, public visibility, main branch, exact
workflow path, workflow commit, event and hosted runner. Fork and PR tokens fail.
Resend credentials and the real recipient never leave Vercel. Other email content
is redacted, and results can only be sent to the existing recipient for a verified
source link from a recent original message. This is not a general-purpose mail API. It reads
links only from the original text/caption, not from quoted reply context.

The worker downloads a public YouTube/Instagram video, samples six timestamped
frames, transcribes speech with faster-whisper small, and uses Qwen3-VL-2B locally
on CPU to produce a Russian analysis. A separate `[Chuck Inbox Analysis]` email
contains the original link, source email ID, transcript, analysis and frame sheet.
It explicitly states that only sampled frames were inspected. It never adds tasks.

There are no OpenAI, Anthropic, paid transcription, proxy, scraping or inference
API calls. Resend remains the already-used email service. Standard GitHub-hosted
runners are free for public repositories. No larger runners, paid storage,
Actions artifacts or Actions caches are enabled. The jobs refuse private repos.
Do not change repository visibility or runner class without revisiting cost.

## Configuration and enablement

Existing PR: https://github.com/mezentsevaleksey-dotcom/chuck-inbox/pull/1

1. Owner access to GitHub and Vercel team `chuck20` is now authorized. The existing
   production Resend key and recipient are non-readable Vercel secrets. Do not
   rotate, expose or copy them. No GitHub email secret is needed.
2. Keep repository variable `VIDEO_ANALYSIS_ENABLED=false` until platform and
   delivery tests pass. It is already saved and verified in GitHub settings.
3. Merge PR #1 and deploy the additive OIDC endpoint to test the production-only
   credentials. The original API handlers and package.json remain unchanged.
   The new endpoint returns no data without a valid authorized GitHub identity.
4. Run `Chuck Inbox automatic video analysis` on main with `mode=check`. The
   existing Resend key must support listing/retrieving sent mail. If it is a
   sending-only key, owner authorization for a suitable separate key is needed.
5. Run `mode=delivery-test`. This sends a clearly labelled technical email to the
   existing recipient and checks Resend's delivery status. It is not video evidence.
6. Resolve platform source access and pass an actual public-video smoke test.
7. Set `VIDEO_ANALYSIS_START_AT` to the actual activation timestamp, with explicit
   timezone. Run `mode=inbox` on a newly forwarded video and inspect delivery.
8. Set `VIDEO_ANALYSIS_ENABLED=true` only after the full test passes. Polling runs
   at minutes 17 and 47 each hour; GitHub may delay scheduled runs. Set it to
   `false` to stop analysis. Telegram → Gmail remains independent.

## Bounds and recovery

- Maximum video duration: 10 minutes. Maximum downloaded data: 150 MiB.
- Six sampled frames. Small local models can miss detail, misread text or
  hallucinate; the transcript and frame sheet make the output reviewable.
- One video per scheduled run, at most 10 analysis emails per UTC day. Stop
  analysis when the team's sent-message count reaches 90 in that day, leaving
  headroom for the original forwarding service. Existing plan limits still apply.
- Rolling 20-hour source window. Recent successful result emails are the private
  completion ledger; Resend idempotency keys additionally protect a send retry
  within 24 hours. Tracking parameters and equivalent video URLs deduplicate.
- A worker/Resend failure leaves the original email untouched and is retried at
  the next scheduled run, within the source window. An outage/backlog longer than
  20 hours requires manually re-forwarding the link. This is not an unlimited
  durable queue. Repeated links outside the window can be processed again.
- A public link is not a guarantee that YouTube/Instagram allow a datacenter to
  download it. No account cookies, private-content access, captcha bypasses or
  paid proxies are used. An inaccessible source gets an explicit failure report,
  never a made-up analysis. Image carousels, live streams and direct Telegram MP4
  attachments are not supported by this URL worker; they are still forwarded.
- GitHub OIDC credentials are only available to the email parent process. The
  Resend key and real recipient stay in Vercel. Media and models run in a
  subprocess with a minimal environment. Logs contain only counts/fixed codes.
  No video, transcript, frames, email address or input links go to public artifacts
  or caches. Temporary media are deleted after processing and on runner teardown.
- URL hosts, paths, credentials, ports, redirects and public IP destinations are
  checked. Only the YouTube and Instagram extractors are enabled, with bounded
  size/duration/time. CDN requests are restricted to the platforms' hostnames.

## Verification

```
python -m unittest discover -s tests -v
node --test tests/*.test.mjs
python -m pip install 'torch==2.9.1' 'torchvision==0.24.1' --index-url https://download.pytorch.org/whl/cpu
python -m pip install -r scripts/requirements-video.txt
python scripts/analyze_video.py --url 'https://www.youtube.com/watch?v=jNQXAC9IVRw' --output video-output
python scripts/check_smoke.py video-output/report.json
```

`check_smoke.py` requires real downloaded video, six extracted frames, a speech
transcript mentioning elephants and trunks/noses, and a completed local model
analysis. `unavailable` is a **failed** smoke test, not a success.

The branch can run the public smoke test without secrets when a push commit
message includes `[video-smoke]`. Routine commits do not repeatedly attempt a
platform that requested authorization. The public smoke workflow is also callable
manually after it is registered on the default branch. Only the exact main-branch analysis workflow can use the production
bridge. The trusted branch configuration audit prints variable-presence booleans.

## Official references

- https://resend.com/docs/api-reference/emails/list-emails
- https://resend.com/docs/api-reference/emails/retrieve-email
- https://docs.github.com/en/billing/concepts/product-billing/github-actions
- https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26
- https://github.com/SYSTRAN/faster-whisper
- https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct

## Session verification record (2026-11-22)

**Not activated. Deployment and end-to-end integration checks in progress.**

- No previous Actions runs existed at the start. Real CI runs are now recorded.
- Latest local validation: 25 Python tests + 12 bridge authorization/delivery
  tests + 4 Node forwarding regression tests passed; installed dependency consistency check passed. The same regression
  suite passes on GitHub-hosted Ubuntu runners.
- Vercel preview build succeeds. All original API handlers and `package.json` are
  byte-for-byte unchanged relative to the original main. Only a separate protected
  video endpoint is added.
- GitHub settings confirm no repository/environment secrets. They are no longer
  required for mail access. `VIDEO_ANALYSIS_ENABLED=false` is saved; start unset.
- Owner authorized Vercel team `chuck20`. Existing production email key and address
  exist as non-readable sensitive values. Neither was revealed, replaced or rotated.
- The baseline production `/api/webhook` health check returned HTTP 200, v1.7.
- OIDC bridge checks reject forged/expired/wrong-scope tokens, arbitrary recipients,
  unrelated source links, quoted-only links, old sources and daily quota overflow.
- Real YouTube smoke on the fixed public clip failed with
  `source_auth_required`. It is not a successful download/analysis. Repeated
  attempts stopped. No account cookies or paid proxies were added.
  Evidence: https://github.com/mezentsevaleksey-dotcom/chuck-inbox/actions/runs/45060716601
- Local network cannot resolve YouTube. This is separate from the GitHub runner's
  platform-authorization response.
- Real local vision test: official public Qwen sample `space_woaudio.mp4`,
  36,698,404 bytes, 177.96 seconds, no audio. Extracted six actual frames;
  Qwen3-VL-2B produced a Russian analysis on CPU in 233 seconds including model
  setup. Broad scenes (people on a space station and a control room) matched the
  samples, but fine flag/camera descriptions were imperfect. Output is explicitly
  labelled preliminary machine analysis, with frames attached for verification.
  Source: https://qianwen-res.oss-cn-beijing.aliyuncs.com/Qwen2-VL/space_woaudio.mp4
- Real speech test: OpenAI Whisper's public `tests/jfk.flac` fixture,
  1,152,693 bytes. faster-whisper small recognized English and the expected
  ask/country speech. This exposed an incompatible PyAV 19 API; `av==16.0.1`
  was pinned and the speech test then passed.
  Source: https://github.com/openai/whisper/blob/main/tests/jfk.flac
- Instagram end-to-end download and real Resend email delivery remain unverified.
  Successful local model tests do not prove YouTube/Instagram extraction works.

Before activation: verify the existing Resend
key's read/send scopes through the authorized bridge, resolve source access on an authorized runner, pass a real
platform smoke test and confirm delivery of the resulting email. Do not claim the
system is fully operational until those checks actually pass.
