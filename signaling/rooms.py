"""Ephemeral room registry; run exactly one signaling worker."""
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import secrets
from typing import Any

TTL = timedelta(minutes=15)
ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

@dataclass
class Room:
    room_code: str
    sender: Any
    receiver: Any = None
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    expires_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc) + TTL)
    status: str = 'WAITING'

class RoomManager:
    def __init__(self) -> None:
        self.rooms: dict[str, Room] = {}

    def create(self, sender: Any) -> Room:
        if len(self.rooms) >= 1000:
            raise ValueError('Room capacity reached. Try again later.')
        while True:
            code = ''.join(secrets.choice(ALPHABET) for _ in range(6))
            if code not in self.rooms:
                break
        room = Room(code, sender)
        self.rooms[code] = room
        return room

    def join(self, code: str, receiver: Any) -> Room:
        room = self.rooms.get(code)
        if not room or (room.status == 'WAITING' and room.expires_at <= datetime.now(timezone.utc)):
            raise ValueError('Room not found or expired. Ask the sender for a new code.')
        if room.receiver is not None:
            raise ValueError('This room already has a receiver.')
        room.receiver = receiver
        room.status = 'CONNECTING'
        return room
