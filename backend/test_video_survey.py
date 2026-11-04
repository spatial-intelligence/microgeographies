import json
import os
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image
import da3
import server
from test_da3 import _push_env


def test_video_only_upload_returns_local_cloud_and_source_frames():
    def extract(path, directory, **kwargs):
        assert open(path, 'rb').read() == b'video-stub'
        assert kwargs['max_frames'] == 250
        frames = []
        for i in range(2):
            filename = os.path.join(directory, f'frame{i}.png')
            Image.new('RGB', (32, 24), (120, 80, 40)).save(filename)
            frames.append({'name': f'frame{i}.png', 'path': filename, 'time_s': i * .5})
        return frames
    with _push_env(MOCK_DA3='1'), patch.object(da3, 'extract_frames', side_effect=extract), patch.object(server, 'detect_concepts_no_depth', return_value=({}, {})) as detect:
        response = TestClient(server.app).post('/api/video-cloud',
            files={'video': ('office.mp4', b'video-stub', 'video/mp4')},
            data={'max_points': '1000', 'max_frames': '250', 'concepts': '["printer"]', 'detector': 'api', 'sam_token': 'fixture-key'})
    detect.assert_called_once()
    assert detect.call_args.args[1:] == (['printer'], 'api', 'fixture-key')
    messages = [json.loads(line) for line in response.text.splitlines() if line]
    result = next(m['data'] for m in messages if m['type'] == 'result')
    assert 'error' not in result, result
    assert result['total_points'] > 0
    assert not result['georeference']['available']
    assert result['location'] is None
    assert len(result['source_frames']) == len(result['cameras']) == 2
    assert result['source_frames'][1]['time_s'] == .5
    assert result['source_frames'][0]['url'].startswith('data:image/jpeg;base64,')
    assert len(result['source_frames'][0]['depth']) == 1024
