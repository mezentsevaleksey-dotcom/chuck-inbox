#!/usr/bin/env python3
"""Poll existing Resend deliveries, with no changes to the Telegram webhook.

Email is the private completion ledger. Source URLs, message bodies, recipient
addresses and analysis are never written to Actions logs, caches or artifacts.
"""
import argparse
import base64
import datetime as dt
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from urllib.parse import urlencode

from video_common import VideoError, extract_urls, identity

UTC = dt.timezone.utc
SOURCE_PREFIX = '[Chuck Inbox] '
RESULT_PREFIX = '[Chuck Inbox Analysis] v2 '
SENDER = 'Chuck Inbox <onboarding@resend.dev>'
LOOKBACK_HOURS = 20  # deliberately shorter than Resend's 24-hour idempotency TTL
MAX_ANALYSES_PER_DAY = 10
MAX_TEAM_EMAILS_PER_DAY = 90  # leave headroom for the existing forwarder
MAX_JOBS_PER_RUN = 1


def timestamp(raw):
    try:
        value = dt.datetime.fromisoformat(raw.replace('Z', '+00:00'))
        if value.tzinfo is None:
            raise ValueError()
        return value.astimezone(UTC)
    except (ValueError, TypeError, AttributeError):
        raise VideoError('invalid_timestamp') from None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise VideoError('api_redirect_rejected')


class Resend:
    def __init__(self):
        self.key = os.environ.get('RESEND_API_KEY', '')
        self.recipient = os.environ.get('CHUCK_INBOX_EMAIL', '').strip().lower()
        if not self.key or not re.fullmatch(r'[^\s@,]+@[^\s@,]+\.[^\s@,]+', self.recipient):
            raise VideoError('missing_email_secrets')
        self.opener = urllib.request.build_opener(NoRedirect())
        self.last_request = 0

    def request(self, path, body=None, idem=None):
        if not re.fullmatch(r'/emails(?:/[0-9a-f-]{36})?(?:\?[A-Za-z0-9%=&_-]+)?', path):
            raise VideoError('invalid_api_path')
        encoded = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        headers = {'Authorization': 'Bearer ' + self.key, 'Content-Type': 'application/json'}
        if idem:
            headers['Idempotency-Key'] = idem
        for attempt in range(3):
            time.sleep(max(0, 0.6 - (time.monotonic() - self.last_request)))
            self.last_request = time.monotonic()
            try:
                req = urllib.request.Request('https://api.resend.com' + path, data=encoded, headers=headers)
                with self.opener.open(req, timeout=30) as response:
                    raw = response.read(5 * 1024 * 1024 + 1)
                if len(raw) > 5 * 1024 * 1024:
                    raise VideoError('email_response_too_large')
                return json.loads(raw)
            except urllib.error.HTTPError as error:
                code = error.code
                error.close()
                if code == 403:
                    raise VideoError('resend_read_access_required') from None
                if code in (429, 500, 502, 503, 504) and attempt < 2:
                    time.sleep(2 ** attempt)
                    continue
                raise VideoError('resend_http_' + str(code)) from None
            except (urllib.error.URLError, TimeoutError):
                if attempt == 2:
                    raise VideoError('resend_unavailable') from None
            except (ValueError, KeyError):
                raise VideoError('invalid_resend_response') from None
        raise VideoError('resend_unavailable')

    def recent(self, cutoff):
        rows, cursor = [], None
        # Fail closed if pagination cannot cover the whole window: never infer
        # that a result is absent from an incomplete list.
        for _ in range(50):
            query = {'limit': 100}
            if cursor:
                query['after'] = cursor
            page = self.request('/emails?' + urlencode(query))
            items = page.get('data')
            if not isinstance(items, list):
                raise VideoError('invalid_resend_response')
            rows.extend(item for item in items if timestamp(item['created_at']) >= cutoff)
            if not page.get('has_more'):
                return rows
            if not items:
                raise VideoError('incomplete_email_history')
            # The API returns newest first.
            if min(timestamp(item['created_at']) for item in items) < cutoff:
                return rows
            new_cursor = items[-1]['id']
            if cursor == new_cursor:
                raise VideoError('incomplete_email_history')
            cursor = new_cursor
        raise VideoError('incomplete_email_history')

    def deliver(self, job, report, contact_sheet=None):
        key = identity(job['url'])
        text = ('Chuck Inbox — автоматический разбор\n'
                f"Исходная ссылка: {job['url']}\n"
                f"Исходное письмо: {job['source_id']}\n\n" + report)
        body = {'from': SENDER, 'to': [self.recipient],
                'subject': RESULT_PREFIX + key, 'text': text}
        if contact_sheet and Path(contact_sheet).is_file():
            data = Path(contact_sheet).read_bytes()
            if len(data) > 2 * 1024 * 1024:
                raise VideoError('contact_sheet_too_large')
            body['attachments'] = [{'filename': 'sampled-frames.jpg', 'content': base64.b64encode(data).decode()}]
        result = self.request('/emails', body, 'chuck-video-v2-' + key)
        if not result.get('id'):
            raise VideoError('email_not_accepted')
        return result['id']


def is_ours(row, recipient):
    return (row.get('from') == SENDER and
            [str(x).lower() for x in row.get('to', [])] == [recipient.lower()])


def pending(client, now, start_at):
    cutoff = max(start_at, now - dt.timedelta(hours=LOOKBACK_HOURS))
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    rows = client.recent(min(cutoff, day_start))
    ours = [r for r in rows if is_ours(r, client.recipient)]
    results = [r for r in ours if r.get('subject', '').startswith(RESULT_PREFIX)]
    today = [r for r in rows if timestamp(r['created_at']) >= day_start]
    if len(today) >= MAX_TEAM_EMAILS_PER_DAY or sum(timestamp(r['created_at']) >= day_start for r in results) >= MAX_ANALYSES_PER_DAY:
        return []
    # Accepted/pending deliveries count as complete to avoid repeat sending.
    # Bounces are surfaced as a failure, never silently reported as delivered.
    if any(r.get('last_event') in ('bounced', 'failed', 'suppressed') for r in results):
        raise VideoError('analysis_email_delivery_failed')
    done = {r['subject'][len(RESULT_PREFIX):] for r in results}
    jobs, seen = [], set(done)
    source_rows = sorted((r for r in ours if r.get('subject', '').startswith(SOURCE_PREFIX)
                          and timestamp(r['created_at']) >= cutoff), key=lambda r: r['created_at'])
    for row in source_rows:
        content = client.request('/emails/' + row['id'])
        text = content.get('text') or ''
        if not text.startswith('Chuck Inbox - context package item\n'):
            continue
        # Only the forwarded text/caption. Ignore reply context, sender names and
        # attachment filenames so a quoted older link is not processed as new.
        if '\nText/caption:\n' not in text:
            continue
        caption = text.split('\nText/caption:\n', 1)[1].split('\nFile:', 1)[0]
        for url in extract_urls(caption):
            key = identity(url)
            if key in seen:
                continue
            jobs.append({'url': url, 'source_id': row['id'], 'source_created_at': row['created_at']})
            seen.add(key)
            if len(jobs) >= MAX_JOBS_PER_RUN:
                return jobs
    return jobs


def child_env():
    # Media extraction and model inference never receive email or GitHub secrets.
    allowed = ('PATH', 'HOME', 'TMPDIR', 'LANG', 'SYSTEMROOT', 'HF_HOME', 'LD_LIBRARY_PATH')
    env = {k: os.environ[k] for k in allowed if k in os.environ}
    env.update({'HF_HUB_DISABLE_TELEMETRY': '1', 'DO_NOT_TRACK': '1',
                'TOKENIZERS_PARALLELISM': 'false', 'OMP_NUM_THREADS': '4'})
    return env


def process_job(client, job):
    with tempfile.TemporaryDirectory(prefix='chuck-video-') as folder:
        request = Path(folder) / 'request.json'
        request.write_text(json.dumps(job), encoding='utf-8')
        try:
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('analyze_video.py')),
                                     '--request', str(request), '--output', folder],
                                    env=child_env(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    timeout=35 * 60)
        except subprocess.TimeoutExpired:
            raise VideoError('analysis_timeout') from None
        report_file = Path(folder) / 'report.json'
        if not report_file.is_file():
            raise VideoError('worker_failed')
        report = json.loads(report_file.read_text(encoding='utf-8'))
        if result.returncode or report.get('status') not in ('complete', 'unavailable'):
            raise VideoError('worker_failed')
        client.deliver(job, report['text'], Path(folder) / 'sampled-frames.jpg')
        # Counts/status only: no URLs, transcript, title, user identifiers or keys.
        print('Analysis email accepted by Resend; status=' + report['status'])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['plan', 'run', 'check'])
    parser.add_argument('--plan', type=Path)
    args = parser.parse_args()
    client = Resend()
    if args.command == 'check':
        client.recent(dt.datetime.now(UTC) - dt.timedelta(minutes=5))
        print('Resend list access verified; recipient configured. Send access requires a delivery test.')
        return
    start = timestamp(os.environ.get('VIDEO_ANALYSIS_START_AT', ''))
    if args.command == 'plan':
        jobs = pending(client, dt.datetime.now(UTC), start)
        if not args.plan:
            raise VideoError('plan_path_required')
        args.plan.write_text(json.dumps(jobs), encoding='utf-8')
        args.plan.chmod(0o600)
        if os.environ.get('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
                output.write('has_work=' + ('true' if jobs else 'false') + '\n')
        print('Queued video count: ' + str(len(jobs)))
    else:
        if not args.plan:
            raise VideoError('plan_path_required')
        jobs = json.loads(args.plan.read_text(encoding='utf-8'))
        if len(jobs) > MAX_JOBS_PER_RUN:
            raise VideoError('too_many_jobs')
        try:
            for job in jobs:
                process_job(client, job)
        finally:
            args.plan.unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        main()
    except VideoError as error:
        print('Video inbox stopped: ' + error.code, file=sys.stderr)
        sys.exit(1)
    except Exception:
        print('Video inbox stopped: internal_error (private details suppressed)', file=sys.stderr)
        sys.exit(1)
