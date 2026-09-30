from dataclasses import dataclass

@dataclass(frozen=True)
class FileOffer:
    file_id: str
    name: str
    size: int
    mime_type: str
    chunk_size: int
    sha256: str
