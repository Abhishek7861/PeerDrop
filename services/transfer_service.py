import os

def ice_servers() -> list[dict]:
    servers = [{'urls': os.getenv('STUN_URL', 'stun:stun.l.google.com:19302')}]
    if os.getenv('TURN_URL'):
        servers.append({'urls': os.environ['TURN_URL'], 'username': os.getenv('TURN_USERNAME', ''), 'credential': os.getenv('TURN_PASSWORD', '')})
    return servers
