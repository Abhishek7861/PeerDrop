"""Real Chromium RTCDataChannel smoke test. Start signaling and Streamlit first."""
import hashlib
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

with sync_playwright() as p, tempfile.TemporaryDirectory() as temp:
    browser = p.chromium.launch()
    context = browser.new_context(accept_downloads=True)
    sender, receiver = context.new_page(), context.new_page()
    errors = []
    for page in (sender, receiver):
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto('http://localhost:8765/transfer/')
    source = Path(temp) / 'smoke.bin'
    source.write_bytes(bytes(range(256)) * 8192)
    sender.locator('#file').set_input_files(source)
    sender.locator('#create').click()
    sender.wait_for_function("document.querySelector('#roomCode').textContent.length === 6")
    code = sender.locator('#roomCode').inner_text()
    receiver.locator('#receiveTab').click()
    receiver.locator('#codeInput').fill(code)
    receiver.locator('#join').click()
    receiver.locator('#acceptDownload').click(timeout=30000)
    sender.wait_for_function("document.querySelector('#status').textContent.includes('Transfer verified')", timeout=60000)
    with receiver.expect_download() as event:
        receiver.locator('#download').click()
    saved = Path(temp) / 'received.bin'
    event.value.save_as(saved)
    assert hashlib.sha256(saved.read_bytes()).digest() == hashlib.sha256(source.read_bytes()).digest()
    streamlit = context.new_page()
    streamlit.goto('http://localhost:8501')
    streamlit.frame_locator('iframe').locator('#create').wait_for(timeout=30000)
    assert not errors, errors
    print('PASS: real WebRTC 2 MiB transfer, downloaded checksum, Streamlit component loading')
    browser.close()
