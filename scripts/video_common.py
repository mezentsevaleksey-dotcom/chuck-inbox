"""Strict media identities shared by the inbox scanner and the isolated worker."""
import hashlib
import re
from urllib.parse import parse_qs, urlsplit

YT_HOSTS = {'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'}
IG_HOSTS = {'instagram.com', 'www.instagram.com', 'm.instagram.com'}
URL_PATTERN = re.compile(r'(?:https?://|www\.)(?:[^\s<>"\u201c\u201d]+)', re.I)


class VideoError(Exception):
    """Only a fixed, non-sensitive error code may be logged by the caller."""
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def canonical_url(raw):
    raw = raw.strip()
    if raw.startswith('www.'):
        raw = 'https://' + raw
    if len(raw) > 2048 or any(ord(c) < 33 for c in raw):
        raise VideoError('invalid_url')
    try:
        u = urlsplit(raw)
        port = u.port
    except ValueError:
        raise VideoError('invalid_url') from None
    if u.scheme != 'https' or u.username or u.password or port is not None:
        raise VideoError('invalid_url')
    host = (u.hostname or '').lower()
    if host in YT_HOSTS:
        if host == 'youtu.be':
            video_id = u.path.removeprefix('/').rstrip('/')
        elif u.path == '/watch':
            ids = parse_qs(u.query).get('v', [])
            video_id = ids[0] if len(ids) == 1 else ''
        else:
            m = re.fullmatch(r'/(?:shorts|embed|live)/([A-Za-z0-9_-]{11})/?', u.path)
            video_id = m[1] if m else ''
        if not re.fullmatch(r'[A-Za-z0-9_-]{11}', video_id):
            raise VideoError('unsupported_url')
        return 'https://www.youtube.com/watch?v=' + video_id
    if host in IG_HOSTS:
        m = re.fullmatch(r'/(?:reel|reels|p|tv)/([A-Za-z0-9_-]{5,30})/?', u.path)
        if not m:
            raise VideoError('unsupported_url')
        # p/reel/tv links with the same shortcode refer to the same post.
        return 'https://www.instagram.com/p/' + m[1] + '/'
    raise VideoError('unsupported_url')


def extract_urls(text):
    found = []
    for raw in URL_PATTERN.findall(text or ''):
        try:
            url = canonical_url(raw.rstrip('.,;:!?)]}\u00bb'))
        except VideoError:
            continue
        if url not in found:
            found.append(url)
    return found


def identity(url):
    return hashlib.sha256(canonical_url(url).encode()).hexdigest()
