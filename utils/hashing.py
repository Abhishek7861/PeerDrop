"""Reference streaming hash for local validation; never used to upload a file."""
import hashlib
from pathlib import Path

def sha256_file(path: Path, chunk_size: int = 262144) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as source:
        while chunk := source.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()
