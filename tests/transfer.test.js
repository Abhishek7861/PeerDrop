import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { SHA256 } from "../frontend/webrtc_component/hash.js";
import {
  Transfer,
  frame,
  unframe,
  drain,
} from "../frontend/webrtc_component/transfer.js";
globalThis.window = {};
for (const length of [0, 1, 55, 56, 63, 64, 65, 1000, 262144, 1048577])
  test(`incremental SHA-256 ${length} bytes`, () => {
    const bytes = randomBytes(length),
      hash = new SHA256();
    for (let i = 0; i < length; i += 73) hash.update(bytes.subarray(i, i + 73));
    assert.equal(hash.hex(), createHash("sha256").update(bytes).digest("hex"));
  });
test("frame preserves offsets beyond 4 GiB", () => {
  const id = "ab".repeat(16),
    data = new Uint8Array([1, 2, 3]);
  const part = unframe(frame(id, 42, 11 * 1024 ** 3, data).buffer);
  assert.equal(part.offset, 11 * 1024 ** 3);
  assert.equal(part.index, 42);
  assert.equal(part.id, id);
  assert.deepEqual(part.data, data);
  assert.throws(() => unframe(new ArrayBuffer(3)));
});
class Channel extends EventTarget {
  constructor() {
    super();
    this.readyState = "open";
    this.bufferedAmount = 0;
  }
  send(data) {
    const copy =
      typeof data === "string"
        ? data
        : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    queueMicrotask(() => this.peer.onmessage({ data: copy }));
  }
}
function channels() {
  const a = new Channel(),
    b = new Channel();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
const callbacks = {
  status() {},
  hash() {},
  started() {},
  progress() {},
  download() {},
  offer() {},
  complete() {},
  error(e) {
    throw e;
  },
};
for (const size of [0, 500000])
  test(`end-to-end offer, accept, chunks, verify ${size}`, async () => {
    const [a, b] = channels();
    const input = randomBytes(size);
    const file = new Blob([input]);
    file.name = "test.bin";
    let resolve, reject;
    const completion = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    let received = [];
    window.showSaveFilePicker = async () => ({
      createWritable: async () => ({
        write: async (bytes) => {
          await new Promise((r) => setTimeout(r, 1));
          received.push(Buffer.from(bytes));
        },
        close: async () => {},
        abort: async () => {},
      }),
    });
    const receiver = new Transfer(b, {
      ...callbacks,
      offer() {
        receiver.accept().catch(reject);
      },
      error: reject,
    });
    const sender = new Transfer(a, {
      ...callbacks,
      complete: resolve,
      error: reject,
    });
    await sender.prepare(file);
    await completion;
    assert.deepEqual(Buffer.concat(received), input);
    assert.equal(sender.done, true);
    assert.equal(receiver.done, true);
    sender.stop();
    receiver.stop();
  });
test("checksum mismatch aborts disk writer", async () => {
  let aborted = false,
    error;
  window.showSaveFilePicker = async () => ({
    createWritable: async () => ({
      write: async () => {},
      close: async () => {
        throw Error("must not commit");
      },
      abort: async () => {
        aborted = true;
      },
    }),
  });
  const channel = new Channel();
  channel.send = () => {};
  const receiver = new Transfer(channel, {
    ...callbacks,
    error: (e) => (error = e),
  });
  await receiver.message(
    JSON.stringify({
      type: "FILE_OFFER",
      file_id: "aa".repeat(16),
      name: "bad",
      size: 0,
      chunk_size: 1024,
      sha256: "0".repeat(64),
    }),
  );
  await receiver.accept();
  await assert.rejects(
    () =>
      receiver.message(
        JSON.stringify({ type: "FILE_COMPLETE", file_id: "aa".repeat(16) }),
      ),
    /Checksum/,
  );
  receiver.fail(Error("checksum"));
  assert.ok(aborted);
  assert.ok(error);
});
test("backpressure resumes on low watermark", async () => {
  const ch = new Channel();
  ch.bufferedAmount = 2000000;
  ch.bufferedAmountLowThreshold = 262144;
  let resolved = false;
  const promise = drain(ch).then(() => (resolved = true));
  await Promise.resolve();
  assert.equal(resolved, false);
  ch.bufferedAmount = 0;
  ch.dispatchEvent(new Event("bufferedamountlow"));
  await promise;
  assert.ok(resolved);
});
