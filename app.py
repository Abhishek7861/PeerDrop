from pathlib import Path
import streamlit as st
import streamlit.components.v1 as components
from services.settings import settings
from services.transfer_service import ice_servers

st.set_page_config(page_title='PeerDrop · Direct file transfer', page_icon='↗', layout='centered')
st.markdown('<style>.block-container{padding-top:1rem}header{visibility:hidden}</style>', unsafe_allow_html=True)
try:
    cloud_secrets = st.secrets.to_dict()
except FileNotFoundError:
    cloud_secrets = {}
config = settings(cloud_secrets)
component = components.declare_component(
    'peerdrop', path=str(Path(__file__).parent / 'frontend/webrtc_component')
)
component(
    ice_servers=ice_servers(config),
    signaling_url=config['SIGNALING_URL'],
    public_url=config['PUBLIC_APP_URL'],
    room=st.query_params.get('room', ''),
    key='peerdrop',
)
st.caption('For large-file saving, use Chrome or Edge on localhost or HTTPS. If the embedded browser cannot open a save picker, use the full-page transfer link inside the app.')
