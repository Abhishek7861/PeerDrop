from datetime import datetime, timedelta, timezone
import pytest
from fastapi.testclient import TestClient
from signaling.server import app, manager
from signaling.rooms import RoomManager

HEADERS = {'origin': 'http://localhost:8501'}

def test_room_expiry_and_duplicate():
    rooms = RoomManager()
    room = rooms.create(object())
    assert len(room.room_code) == 6
    rooms.join(room.room_code, object())
    with pytest.raises(ValueError):
        rooms.join(room.room_code, object())
    expired = rooms.create(object())
    expired.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    with pytest.raises(ValueError):
        rooms.join(expired.room_code, object())

def test_signaling_round_trip_and_disconnect():
    with TestClient(app) as client:
        with client.websocket_connect('/ws', headers=HEADERS) as sender:
            sender.send_json({'type': 'create'})
            code = sender.receive_json()['code']
            with client.websocket_connect('/ws', headers=HEADERS) as receiver:
                receiver.send_json({'type': 'join', 'code': code})
                assert receiver.receive_json()['type'] == 'joined'
                assert sender.receive_json()['type'] == 'peer_joined'
                sender.send_json({'type': 'offer', 'sdp': 'test-offer'})
                assert receiver.receive_json() == {'type': 'offer', 'sdp': 'test-offer'}
                receiver.send_json({'type': 'answer', 'sdp': 'test-answer'})
                assert sender.receive_json()['sdp'] == 'test-answer'
                receiver.send_json({'type': 'ice', 'candidate': {'candidate': 'candidate:test'}})
                assert sender.receive_json()['type'] == 'ice'
            assert sender.receive_json()['type'] == 'peer_left'
    assert code not in manager.rooms

def test_binary_and_unknown_messages_rejected():
    with TestClient(app) as client:
        for binary in (True, False):
            with client.websocket_connect('/ws', headers=HEADERS) as socket:
                if binary:
                    socket.send_bytes(b'file data')
                else:
                    socket.send_json({'type': 'FILE_OFFER'})
                assert socket.receive_json()['type'] == 'error'

def test_duplicate_receiver_does_not_remove_room():
    with TestClient(app) as client:
        with client.websocket_connect('/ws', headers=HEADERS) as a:
            a.send_json({'type': 'create'})
            code = a.receive_json()['code']
            with client.websocket_connect('/ws', headers=HEADERS) as b:
                b.send_json({'type': 'join', 'code': code})
                b.receive_json()
                a.receive_json()
                with client.websocket_connect('/ws', headers=HEADERS) as c:
                    c.send_json({'type': 'join', 'code': code})
                    assert c.receive_json()['type'] == 'error'
                assert code in manager.rooms
