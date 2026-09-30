from services.settings import settings, KEYS
from services.transfer_service import ice_servers
from fastapi.testclient import TestClient
from signaling.server import app

def test_cloud_secrets_and_environment_precedence(monkeypatch):
    for key in KEYS:
        monkeypatch.delenv(key, raising=False)
    config = settings({'SIGNALING_URL': 'wss://backend.example.com/ws', 'TURN_URL': 'turn:relay.example.com', 'TURN_USERNAME': 'user', 'TURN_PASSWORD': 'test-only'})
    assert config['SIGNALING_URL'] == 'wss://backend.example.com/ws'
    assert ice_servers(config)[1]['credential'] == 'test-only'
    monkeypatch.setenv('SIGNALING_URL', 'wss://override.example.com/ws')
    assert settings({'SIGNALING_URL': 'wss://other.example.com/ws'})['SIGNALING_URL'] == 'wss://override.example.com/ws'

def test_cloud_origin_with_trailing_slash_and_standalone_host(monkeypatch):
    monkeypatch.setenv('ALLOWED_ORIGINS', ' https://example.streamlit.app/ ')
    monkeypatch.setenv('RENDER_EXTERNAL_URL', 'https://backend.example.com')
    with TestClient(app) as client:
        for origin in ('https://example.streamlit.app', 'https://backend.example.com'):
            with client.websocket_connect('/ws', headers={'origin': origin}) as socket:
                socket.send_json({'type': 'create'})
                assert socket.receive_json()['type'] == 'created'
