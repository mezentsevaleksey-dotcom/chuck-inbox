import datetime as dt
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from video_common import VideoError, canonical_url, extract_urls, identity
from analyze_video import check_remote_url, frame_times, download_error_code
from inbox_worker import (Resend, Bridge, SENDER, RESULT_PREFIX, SOURCE_PREFIX, child_env,
                          pending, process_job, timestamp)

NOW = dt.datetime(2026, 11, 22, 12, tzinfo=dt.timezone.utc)
URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'


def email(i=1, subject=None, age=1, recipient='owner@example.org', event='delivered'):
    return {'id': f'00000000-0000-0000-0000-{i:012d}', 'subject': subject or SOURCE_PREFIX+'package',
            'created_at': (NOW-dt.timedelta(hours=age)).isoformat(), 'from': SENDER,
            'to': [recipient], 'last_event': event}


class FakeResend:
    recipient = 'owner@example.org'
    def __init__(self, rows, bodies=None):
        self.rows, self.bodies, self.reads = rows, bodies or {}, []
    def recent(self, cutoff):
        return [r for r in self.rows if timestamp(r['created_at']) >= cutoff]
    def request(self, path):
        self.reads.append(path)
        return {'text': self.bodies.get(path.split('/')[-1],
                                       'Chuck Inbox - context package item\n\nText/caption:\n'+URL)}


class URLTests(unittest.TestCase):
    def test_youtube_aliases_and_tracking_deduplicate(self):
        for u in ['https://youtu.be/jNQXAC9IVRw?si=x', 'https://m.youtube.com/shorts/jNQXAC9IVRw',
                  URL+'&list=abc', 'https://www.youtube.com/embed/jNQXAC9IVRw?t=2']:
            self.assertEqual(canonical_url(u), URL)
            self.assertEqual(identity(u), identity(URL))

    def test_instagram_aliases(self):
        for p in ['p', 'reel', 'reels', 'tv']:
            self.assertEqual(canonical_url('https://www.instagram.com/'+p+'/ABC_123/?igsh=x'),
                             'https://www.instagram.com/p/ABC_123/')

    def test_reject_unsafe_and_nonmedia_urls(self):
        bad = ['http://www.youtube.com/watch?v=jNQXAC9IVRw',
               'https://www.youtube.com.evil.org/watch?v=jNQXAC9IVRw',
               'https://user:pass@youtube.com/watch?v=jNQXAC9IVRw',
               'https://youtube.com:443/watch?v=jNQXAC9IVRw',
               'https://youtube.com/redirect?q=https://127.0.0.1',
               'file:///etc/passwd', 'https://127.0.0.1/', 'https://[::1]/',
               URL+'&v=aaaaaaaaaaa', 'https://instagram.com/accounts/login/',
               'https://instagram.com/p/abc/../../x', 'https://instagram.com/p/ABCDE/%0a',
               'https://youtube.com/watch?v=jNQXAC9IVRw\n&x=y']
        for u in bad:
            with self.subTest(u=u), self.assertRaises(VideoError):
                canonical_url(u)

    def test_extract_and_punctuation(self):
        self.assertEqual(extract_urls(f'({URL}), https://youtu.be/jNQXAC9IVRw?si=tracking. https://example.org/'), [URL])

    def test_redirect_domains_and_private_addresses(self):
        public = lambda *a, **kw: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('8.8.8.8',443))]
        check_remote_url('https://r1.googlevideo.com/videoplayback',public)
        for u in ['http://r1.googlevideo.com/x','https://127.0.0.1/x','https://googlevideo.com.evil.org/x',
                  'https://www.youtube.com:8080/x', 'file:///etc/passwd']:
            with self.assertRaises(VideoError): check_remote_url(u,public)
        for address in ['127.0.0.1','10.0.0.1','169.254.169.254','::1','192.168.1.1']:
            private = lambda *a, **kw: [(socket.AF_INET, socket.SOCK_STREAM,6,'',(address,443))]
            with self.assertRaises(VideoError): check_remote_url('https://www.youtube.com/x',private)

    def test_frame_sampling(self):
        times = frame_times(19)
        self.assertEqual(len(times),6)
        self.assertGreater(times[0],0)
        self.assertLess(times[-1],19)
        for duration in [0,float('nan'),float('inf'),-1]:
            with self.assertRaises(VideoError): frame_times(duration)

    def test_dns_failure_is_fixed_retryable_code(self):
        def unavailable(*a, **kw):
            raise socket.gaierror('private diagnostic')
        with self.assertRaisesRegex(VideoError, '^download_network_error$'):
            check_remote_url('https://www.youtube.com/x', unavailable)

    def test_download_diagnostics_are_redacted(self):
        self.assertEqual(download_error_code('Sign in to confirm at https://private/link'), 'source_auth_required')
        self.assertEqual(download_error_code('Requested format is not available https://private/link'), 'source_format_unavailable')
        self.assertEqual(download_error_code('HTTP Error 503 private'), 'download_network_error')
        self.assertEqual(download_error_code('HTTP Error 403 private'), 'source_http_403')
        self.assertEqual(download_error_code('HTTP Error 429 private'), 'source_rate_limited')


class InboxTests(unittest.TestCase):
    def plan(self, client, start=None):
        return pending(client,NOW,start or NOW-dt.timedelta(hours=20))

    def test_only_our_original_emails(self):
        wrong = email(2,recipient='other@example.org')
        result = email(3,subject=RESULT_PREFIX+'f'*64)
        arbitrary = email(4,subject='Unrelated email')
        forged = email(5)
        forged['from']='Other <other@example.org>'
        client = FakeResend([email(),wrong,result,arbitrary,forged])
        self.assertEqual(len(self.plan(client)),1)
        self.assertEqual(len(client.reads),1)

    def test_completed_alias_skipped(self):
        client = FakeResend([email(),email(2,subject=RESULT_PREFIX+identity(URL),age=.5)])
        self.assertEqual(self.plan(client),[])

    def test_only_verified_platforms_can_be_enabled(self):
        row=email()
        client=FakeResend([row],{row['id']:'Chuck Inbox - context package item\n\nText/caption:\n'+URL+'\nhttps://www.instagram.com/reel/DWuGIV2iTcr/'})
        jobs=pending(client,NOW,NOW-dt.timedelta(hours=20),('instagram',))
        self.assertEqual([j['url'] for j in jobs],['https://www.instagram.com/p/DWuGIV2iTcr/'])

    def test_bounced_analysis_is_failure(self):
        client = FakeResend([email(),email(2,subject=RESULT_PREFIX+identity(URL),event='bounced')])
        with self.assertRaisesRegex(VideoError,'delivery_failed'): self.plan(client)

    def test_start_and_lookback_skip_old_links(self):
        self.assertEqual(self.plan(FakeResend([email(age=21)])),[])
        self.assertEqual(self.plan(FakeResend([email(age=2)]),NOW-dt.timedelta(hours=1)),[])

    def test_ignore_quoted_reply(self):
        row = email()
        body = 'Chuck Inbox - context package item\nReply to: '+URL+'\n\nText/caption:\nthanks'
        self.assertEqual(self.plan(FakeResend([row],{row['id']:body})),[])

    def test_ignore_nonpackage(self):
        row = email()
        self.assertEqual(self.plan(FakeResend([row],{row['id']:'malformed '+URL})),[])

    def test_one_job_per_run_oldest_first(self):
        old = email(1,age=5)
        new = email(2,age=1)
        jobs = self.plan(FakeResend([new,old]))
        self.assertEqual(len(jobs),1)
        self.assertEqual(jobs[0]['source_id'],old['id'])

    def test_daily_analysis_cap(self):
        rows = [email(i+2,subject=RESULT_PREFIX+str(i)) for i in range(10)] + [email()]
        self.assertEqual(self.plan(FakeResend(rows)),[])

    def test_existing_mail_has_priority(self):
        self.assertEqual(self.plan(FakeResend([email(i,subject='any') for i in range(90)])),[])

    def test_subprocess_has_no_secrets(self):
        with patch.dict(os.environ,{'RESEND_API_KEY':'secret','CHUCK_INBOX_EMAIL':'owner@example.org',
                                    'GITHUB_TOKEN':'secret','OPENAI_API_KEY':'secret',
                                    'ACTIONS_ID_TOKEN_REQUEST_TOKEN':'secret','ACTIONS_ID_TOKEN_REQUEST_URL':'private'},clear=True):
            env=child_env()
        self.assertFalse(any(k in env for k in ['RESEND_API_KEY','GITHUB_TOKEN','OPENAI_API_KEY','CHUCK_INBOX_EMAIL',
                                               'ACTIONS_ID_TOKEN_REQUEST_TOKEN','ACTIONS_ID_TOKEN_REQUEST_URL']))

    def test_bridge_rejects_identity_token_redirection(self):
        client=Bridge()
        for endpoint in ['http://token.actions.githubusercontent.com/x','https://attacker.example/x',
                         'https://user:password@token.actions.githubusercontent.com/x']:
            with patch.dict(os.environ,{'ACTIONS_ID_TOKEN_REQUEST_URL':endpoint,'ACTIONS_ID_TOKEN_REQUEST_TOKEN':'private'}):
                with self.assertRaisesRegex(VideoError,'github_identity_unavailable'): client.oidc()

    def test_bridge_delivery_checks_actual_status(self):
        client=Bridge()
        with patch.object(client,'call',side_effect=[{'status':'sent'},{'status':'delivered'}]), patch('inbox_worker.time.sleep'):
            client.verify_delivery('test')
        with patch.object(client,'call',return_value={'status':'bounced'}):
            with self.assertRaisesRegex(VideoError,'delivery_failed'): client.verify_delivery('test')

    def test_pagination(self):
        with patch.dict(os.environ,{'RESEND_API_KEY':'test','CHUCK_INBOX_EMAIL':'owner@example.org'}):
            client=Resend()
        pages=[{'data':[email(2)],'has_more':True},{'data':[email(1,age=5)],'has_more':False}]
        with patch.object(client,'request',side_effect=pages) as request:
            self.assertEqual(len(client.recent(NOW-dt.timedelta(hours=10))),2)
            self.assertIn('after=',request.call_args_list[1].args[0])

    def test_incomplete_history_fails_closed(self):
        with patch.dict(os.environ,{'RESEND_API_KEY':'test','CHUCK_INBOX_EMAIL':'owner@example.org'}):
            client=Resend()
        with patch.object(client,'request',return_value={'data':[],'has_more':True}):
            with self.assertRaises(VideoError): client.recent(NOW)

    def test_send_uses_stable_idempotency(self):
        with patch.dict(os.environ,{'RESEND_API_KEY':'test','CHUCK_INBOX_EMAIL':'owner@example.org'}):
            client=Resend()
        with patch.object(client,'request',return_value={'id':'accepted'}) as request:
            self.assertEqual(client.deliver({'url':URL,'source_id':'source'},'report'),'accepted')
            args=request.call_args.args
            self.assertEqual(args[2],'chuck-video-v2-'+identity(URL))
            self.assertEqual(args[1]['to'],['owner@example.org'])
            self.assertTrue(args[1]['subject'].startswith(RESULT_PREFIX))

    def test_worker_failure_never_emails_fake_analysis(self):
        client=FakeResend([])
        with patch('inbox_worker.subprocess.run') as runner:
            runner.return_value.returncode=1
            with self.assertRaisesRegex(VideoError,'worker_failed'):
                process_job(client,{'url':URL,'source_id':'source'})

    def test_integration_test_requires_an_actual_analysis(self):
        def unavailable(args, **kwargs):
            Path(args[-1], 'report.json').write_text(json.dumps({'status':'unavailable','text':'Blocked'}))
            from types import SimpleNamespace
            return SimpleNamespace(returncode=0)
        with patch('inbox_worker.subprocess.run', side_effect=unavailable):
            with self.assertRaisesRegex(VideoError,'integration_test_incomplete'):
                process_job(FakeResend([]),{'url':URL,'source_id':'source','test_fixture':True})

    def test_timezone_required(self):
        with self.assertRaises(VideoError): timestamp('2026-11-22T12:00:00')
        self.assertEqual(timestamp('2026-11-22 12:00:00+00'),NOW)


if __name__=='__main__': unittest.main()
