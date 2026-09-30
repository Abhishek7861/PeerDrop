"""Signaling only: binary frames and file metadata are never forwarded."""
import asyncio
from contextlib import asynccontextmanager, suppress
import json
import os
import sys
from pathlib import Path
import time
from datetime import datetime, timezone
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from signaling.rooms import RoomManager
from services.transfer_service import ice_servers

manager = RoomManager()
MAX_MESSAGE = 65536

async def send(socket: WebSocket, payload: dict) -> None:
    with suppress(RuntimeError, WebSocketDisconnect):
        await socket.send_json(payload)

async def expire_rooms() -> None:
    while True:
        await asyncio.sleep(5)
        for code, room in list(manager.rooms.items()):
            if room.status == 'WAITING' and room.expires_at <= datetime.now(timezone.utc):
                room.status = 'EXPIRED'
                manager.rooms.pop(code, None)
                await send(room.sender, {'type': 'error', 'message': 'Room expired. Create a new room.'})
                await room.sender.close()

@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(expire_rooms())
    yield
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task

app = FastAPI(lifespan=lifespan)

@app.get('/health')
def health() -> dict:
    return {'status': 'ok'}

@app.get('/config')
def config() -> dict:
    return {'ice_servers': ice_servers()}

@app.websocket('/ws')
async def signaling(ws: WebSocket) -> None:
    allowed = os.getenv('ALLOWED_ORIGINS', 'http://localhost:8501,http://127.0.0.1:8501,http://localhost:8765,http://127.0.0.1:8765').split(',')
    if ws.headers.get('origin') not in allowed:
        await ws.close(code=1008)
        return
    await ws.accept()
    room = None
    role = None
    window, count = time.monotonic(), 0
    try:
        while True:
            packet = await asyncio.wait_for(ws.receive(), timeout=120)
            if packet['type'] == 'websocket.disconnect':
                break
            raw = packet.get('text')
            if raw is None or len(raw.encode()) > MAX_MESSAGE:
                raise ValueError('Only bounded JSON signaling messages are allowed.')
            if time.monotonic() - window > 10:
                window, count = time.monotonic(), 0
            count += 1
            if count > 300:
                raise ValueError('Too many signaling messages.')
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise ValueError('Invalid signaling message.')
            kind = data.get('type')
            if kind == 'ping':
                await send(ws, {'type': 'pong'})
                continue
            if kind == 'create' and room is None:
                room, role = manager.create(ws), 'sender'
                await send(ws, {'type': 'created', 'code': room.room_code})
            elif kind == 'join' and room is None:
                code = data.get('code', '')
                if not isinstance(code, str) or len(code) != 6:
                    raise ValueError('Enter a six-character room code.')
                room, role = manager.join(code.upper(), ws), 'receiver'
                await send(ws, {'type': 'joined'})
                await send(room.sender, {'type': 'peer_joined'})
            elif kind in ('offer', 'answer', 'ice') and room:
                if kind in ('offer', 'answer'):
                    if (kind == 'offer') != (role == 'sender') or not isinstance(data.get('sdp'), str):
                        raise ValueError('Invalid SDP message.')
                    payload = {'type': kind, 'sdp': data['sdp']}
                else:
                    candidate = data.get('candidate')
                    if not isinstance(candidate, dict) or not isinstance(candidate.get('candidate'), str):
                        raise ValueError('Invalid ICE candidate.')
                    if any(k not in {'candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment'} for k in candidate):
                        raise ValueError('Invalid ICE fields.')
                    payload = {'type': kind, 'candidate': candidate}
                peer = room.receiver if role == 'sender' else room.sender
                if peer:
                    await send(peer, payload)
            elif kind == 'status' and room and data.get('status') in ('TRANSFERRING', 'COMPLETED', 'FAILED'):
                room.status = data['status']
            else:
                raise ValueError('Unexpected signaling message.')
    except (ValueError, asyncio.TimeoutError):
        await send(ws, {'type': 'error', 'message': 'Invalid request or connection timed out. Reconnect with a fresh room.' if room else 'Room unavailable, expired, or already occupied. Check the code and try again.'})
    except WebSocketDisconnect:
        pass
    finally:
        if room:
            manager.rooms.pop(room.room_code, None)
            peer = room.receiver if role == 'sender' else room.sender
            if peer:
                await send(peer, {'type': 'peer_left'})
        with suppress(RuntimeError):
            await ws.close()

app.mount('/transfer', StaticFiles(directory=Path(__file__).resolve().parents[1] / 'frontend/webrtc_component', html=True), name='transfer')

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host=os.getenv('SIGNAL_HOST', '0.0.0.0'), port=int(os.getenv('SIGNAL_PORT', '8765')), ws_max_size=MAX_MESSAGE)
