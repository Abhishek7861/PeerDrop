// Cloud pages must use an explicitly configured backend; port 8765 is local only.
export function signalingUrl(config, pageUrl) {
  const page = new URL(pageUrl);
  const configured = (config.signaling_url || '').trim();
  if (!configured) {
    if (page.protocol === 'https:') {
      throw Error('Transfers are not configured yet. The app owner needs to deploy the signaling service and set SIGNALING_URL in Streamlit Cloud secrets.');
    }
    return `ws://${page.hostname}:8765/ws`;
  }
  const url = new URL(configured);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw Error('SIGNALING_URL must be a WebSocket address such as wss://your-service.onrender.com/ws.');
  }
  if (page.protocol === 'https:' && url.protocol !== 'wss:') {
    throw Error('This HTTPS app requires a secure wss:// signaling server.');
  }
  return url.href;
}

export function publicUrl(config, pageUrl) {
  const page = new URL(pageUrl);
  const parentUrl = page.searchParams.get('streamlitUrl');
  const url = new URL(config.public_url || parentUrl || page.origin + '/');
  if (!['http:', 'https:'].includes(url.protocol)) throw Error('Invalid public app URL.');
  url.search = '';
  url.hash = '';
  return url.href;
}
