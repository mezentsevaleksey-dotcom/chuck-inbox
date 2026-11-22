"""An unavailable source is a failed smoke test, never a green download test."""
import json
from pathlib import Path
import sys

report = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
assert report['status'] == 'complete', 'Public media was not processed: ' + report.get('code', 'unknown')
assert 15 <= report['duration'] <= 25, 'Unexpected fixture duration'
assert report['frames'] == 6, 'Missing real sampled frames'
transcript = ' '.join(s['text'] for s in report['transcript']).lower()
assert 'elephant' in transcript and ('trunk' in transcript or 'nose' in transcript), 'Speech content not verified'
assert len(report['text']) > 500, 'Missing analysis'
print('Real public video: download, 6 frames, elephant/trunk speech and local model analysis verified.')
