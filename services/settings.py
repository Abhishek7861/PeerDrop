"""Read configuration without coupling the signaling server to Streamlit."""
import os
from collections.abc import Mapping

KEYS = ('SIGNALING_URL', 'PUBLIC_APP_URL', 'STUN_URL', 'TURN_URL', 'TURN_USERNAME', 'TURN_PASSWORD')

def settings(secrets: Mapping | None = None) -> dict[str, str]:
    """Environment overrides root-level Streamlit Cloud secrets."""
    source = secrets if secrets is not None else {}
    return {key: str(os.environ.get(key, source.get(key, ''))).strip() for key in KEYS}
