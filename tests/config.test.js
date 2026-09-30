import {test} from 'node:test';
import assert from 'node:assert/strict';
import {signalingUrl,publicUrl} from '../frontend/webrtc_component/config.js';
const cloud='https://example.streamlit.app/component/app.peerdrop/index.html?streamlitUrl=https%3A%2F%2Fexample.streamlit.app%2F';
test('cloud cannot silently fall back to a local signaling port',()=>{
 assert.throws(()=>signalingUrl({},cloud),/not configured/);
 assert.throws(()=>signalingUrl({signaling_url:'ws://example.com/ws'},cloud),/secure/);
 assert.equal(signalingUrl({signaling_url:'wss://backend.example.com/ws'},cloud),'wss://backend.example.com/ws');
});
test('local development preserves signaling default',()=>{
 assert.equal(signalingUrl({},'http://localhost:8501/'),'ws://localhost:8765/ws');
});
test('share links retain public app address without a development port',()=>{
 assert.equal(publicUrl({},cloud),'https://example.streamlit.app/');
 assert.equal(publicUrl({public_url:'https://files.example.com/transfer/?room=ABC123'},cloud),'https://files.example.com/transfer/');
});
