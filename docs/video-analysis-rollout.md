# Chuck Inbox — video analysis rollout

Status: design and integration preparation; NOT deployed.

## Existing pipeline
Telegram webhook -> Telegram getFile -> Resend -> Gmail. Current code attaches files up to 20 MiB; Gmail connector does not expose MP4 content to the assistant.

## Proposed pipeline
1. Keep existing webhook and Gmail delivery unchanged, including acknowledgement behavior.
2. On Telegram messages with Instagram/YouTube URLs or attached videos, enqueue a separate asynchronous processing job with a deduplication key (Telegram chat/message ID or canonical media URL).
3. Download public media using a dedicated isolated worker with yt-dlp (pinned version), not a Vercel serverless webhook. For inaccessible/private content, record an explicit error; never require user's personal Instagram cookies.
4. Validate URL host against allowlist (instagram.com, www.instagram.com, youtube.com, www.youtube.com, youtu.be), redirects, media size, duration, and MIME. Reject internal/private IPs and arbitrary URLs. Rate limit and cap spending.
5. Store media privately with short retention; generate a transcript with timestamps, a bounded set of frames, OCR/visual scene descriptions, original URL and source metadata.
6. Send a separate Resend message tagged [Chuck Inbox Analysis], with transcript, scene-by-scene descriptions, confidence and errors, and original URL. No assertion that video was reviewed if extraction fails.
7. Preserve normal email even when analysis worker fails. Do not acknowledge analysis as complete until its job actually finishes.

## Rollout checks
- Test a public Instagram video, public YouTube video, image carousel, and an attached MP4.
- Test duplicate links, private post, invalid URL, large file, timeout, retry, worker outage and Resend failure.
- Confirm speech, onscreen text and scene descriptions against actual source.
- Establish per-video API cost and monthly cap before enabling paid services.
- Deploy to preview first, then production only after user reviews cost and test results.

## Operational note
Vercel access to team chuck20 currently returns 403 to the connector. GitHub branch can be prepared independently. The current source contains no video analysis worker and no reliable automatic URL-to-video extractor.
