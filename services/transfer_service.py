from collections.abc import Mapping
from services.settings import settings


def ice_servers(config: Mapping[str, str] | None = None) -> list[dict]:
    config = settings() if config is None else config
    servers = [{'urls': config.get('STUN_URL') or 'stun:stun.l.google.com:19302'}]
    if config.get('TURN_URL'):
        servers.append({
            'urls': config['TURN_URL'],
            'username': config.get('TURN_USERNAME', ''),
            'credential': config.get('TURN_PASSWORD', ''),
        })
    return servers
