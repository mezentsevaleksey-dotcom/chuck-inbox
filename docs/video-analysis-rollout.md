# Chuck Inbox automatic video analysis

## Architecture

The existing `api/webhook.js` and `api/emailBridge.js` are unchanged. Telegram
continues sending the original messages and attachments to Gmail using Resend.
A separate GitHub Actions workflow polls **sent** Resend messages and processes
only the exact `[Chuck Inbox] ` prefix, sender and configured recipient. It reads
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

1. Confirm the existing Resend key can **list/retrieve** sent messages as well as
   send. Sending-only keys are insufficient. Do not replace or rotate the working
   production key as part of this setup. Owner authorization is required for a
   separate key if no suitable existing key is available.
2. Set GitHub Actions secrets `RESEND_API_KEY` and `CHUCK_INBOX_EMAIL` to the
   existing service configuration. Never put them in commits, PR text or logs.
   `OPENAI_API_KEY`, Telegram credentials and Gmail account access are not needed.
3. Complete the public-video smoke test and a real test delivery before enabling.
   Check that Resend reports `delivered`, not merely `accepted`.
4. Merge PR #1 after checks. Workflow dispatch and scheduled workflows must be on
   `main`. Deploying this PR does not change any Vercel API handler.
5. Set repository variable `VIDEO_ANALYSIS_START_AT` to the activation timestamp
   with explicit timezone, for example `2026-11-23T00:00:00+03:00` (choose the actual
   activation time). This prevents surprise processing of old messages.
6. Run `Chuck Inbox automatic video analysis` with `mode=check`, then `mode=inbox`
   on one newly forwarded public video. Inspect the resulting email.
7. Set `VIDEO_ANALYSIS_ENABLED=true`. Polling runs at minutes 17 and 47 each hour;
   GitHub may delay scheduled runs. Set it to `false` to stop analysis immediately.
   Telegram → Gmail remains independent.

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
- Secrets are only passed to the email parent process. Media and models run in a
  subprocess with a minimal environment. Logs contain only counts/fixed codes.
  No video, transcript, frames, email address or input links go to public artifacts
  or caches. Temporary media are deleted after processing and on runner teardown.
- URL hosts, paths, credentials, ports, redirects and public IP destinations are
  checked. Only the YouTube and Instagram extractors are enabled, with bounded
  size/duration/time. CDN requests are restricted to the platforms' hostnames.

## Verification

```
python -m unittest discover -s tests -v
node --test tests/webhook.test.mjs
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
manually after it is registered on the default branch. Production secret values
are restricted to `main`; the trusted branch's configuration audit prints only
boolean presence checks, never values.

## Official references

- https://resend.com/docs/api-reference/emails/list-emails
- https://resend.com/docs/api-reference/emails/retrieve-email
- https://docs.github.com/en/billing/concepts/product-billing/github-actions
- https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26
- https://github.com/SYSTRAN/faster-whisper
- https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct

## Session verification record (2026-11-22)

**Not activated. PR #1 remains draft.**

- No previous Actions runs existed at the start. Real CI runs are now recorded.
- Latest local validation: 23 Python tests + 4 Node forwarding regression tests
  passed; installed dependency consistency check passed. The same regression
  suite passes on GitHub-hosted Ubuntu runners.
- Vercel preview build succeeds. All `api/*` handlers and `package.json` are
  byte-for-byte unchanged relative to `main`.
- Actions configuration audit returned `HAS_RESEND_API_KEY=false`,
  `HAS_CHUCK_INBOX_EMAIL=false`, `HAS_START_AT=false`, `ENABLED=false`.
  These secrets/variables are unavailable to the workflow. This does not inventory
  any separately protected GitHub environments.
- Vercel team `chuck20` returns 403 and needs owner team authorization to inspect
  the existing environment. No key was created, replaced, exposed or rotated.
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

Before activation: authorize configuration access, verify the existing Resend
key's read/send scopes, resolve source access on an authorized runner, pass a real
platform smoke test and confirm delivery of the resulting email. Do not claim the
system is fully operational until those checks actually pass.
