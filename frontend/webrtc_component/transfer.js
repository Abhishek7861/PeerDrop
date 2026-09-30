import { SHA256, hashFile } from "./hash.js";
export const CHUNK_SIZE = 262144;
const HEADER = 32,
  MEMORY_LIMIT = 64 * 1024 * 1024;
const idBytes = (id) =>
  Uint8Array.from(id.match(/../g), (h) => parseInt(h, 16));
export function frame(id, index, offset, data) {
  const packet = new Uint8Array(HEADER + data.byteLength);
  packet.set(idBytes(id));
  const view = new DataView(packet.buffer);
  view.setUint32(16, index);
  view.setBigUint64(20, BigInt(offset));
  view.setUint32(28, data.byteLength);
  packet.set(new Uint8Array(data), HEADER);
  return packet;
}
export function unframe(buffer) {
  if (buffer.byteLength < HEADER) throw Error("Incomplete chunk header.");
  const view = new DataView(buffer);
  const size = view.getUint32(28);
  if (size !== buffer.byteLength - HEADER) throw Error("Invalid chunk length.");
  return {
    id: Array.from(new Uint8Array(buffer, 0, 16), (v) =>
      v.toString(16).padStart(2, "0"),
    ).join(""),
    index: view.getUint32(16),
    offset: Number(view.getBigUint64(20)),
    data: new Uint8Array(buffer, HEADER),
  };
}
export function drain(channel) {
  if (channel.readyState !== "open")
    return Promise.reject(Error("Data channel closed."));
  if (channel.bufferedAmount <= 1048576) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer;
    const clear = () => {
      clearTimeout(timer);
      channel.removeEventListener("bufferedamountlow", low);
      channel.removeEventListener("close", closed);
    };
    const low = () => {
      clear();
      resolve();
    };
    const closed = () => {
      clear();
      reject(Error("Data channel closed."));
    };
    channel.addEventListener("bufferedamountlow", low);
    channel.addEventListener("close", closed);
    timer = setTimeout(() => {
      clear();
      reject(Error("Transfer buffer timed out."));
    }, 30000);
    if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) low();
  });
}
export class Transfer {
  constructor(channel, callbacks, maxMessageSize = 65536) {
    this.channel = channel;
    this.cb = callbacks;
    this.chunkSize = Math.min(
      CHUNK_SIZE,
      (maxMessageSize || CHUNK_SIZE + HEADER) - HEADER,
    );
    if (this.chunkSize < 1024)
      throw Error("Negotiated WebRTC message size is too small.");
    channel.bufferedAmountLowThreshold = 262144;
    this.offset = 0;
    this.index = 0;
    this.done = false;
    this.stopped = false;
    this.parts = [];
    this.queue = Promise.resolve();
    channel.onmessage = (e) => {
      this.queue = this.queue
        .then(() => this.message(e.data))
        .catch((err) => this.fail(err));
    };
  }
  control(type, extra = {}) {
    this.channel.send(
      JSON.stringify({ type, file_id: this.offer?.file_id, ...extra }),
    );
  }
  async prepare(file) {
    this.file = file;
    this.cb.status("Calculating checksum…");
    const sha256 = await hashFile(file, (n) => this.cb.hash(n, file.size));
    if (this.stopped) return;
    this.offer = {
      type: "FILE_OFFER",
      file_id: Array.from(crypto.getRandomValues(new Uint8Array(16)), (v) =>
        v.toString(16).padStart(2, "0"),
      ).join(""),
      name: file.name,
      size: file.size,
      mime_type: file.type || "application/octet-stream",
      chunk_size: this.chunkSize,
      sha256,
    };
    this.channel.send(JSON.stringify(this.offer));
    this.cb.status("Waiting for receiver to accept");
  }
  async accept(inMemory = false) {
    if (this.accepted || !this.offer) return;
    let writer = null;
    if (!inMemory && window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({
        suggestedName: this.offer.name,
      });
      writer = await handle.createWritable();
    } else if (this.offer.size > MEMORY_LIMIT) {
      throw Error(
        "Files over 64 MiB require Chrome or Edge with the full-page transfer view on localhost or HTTPS.",
      );
    }
    if (this.stopped) {
      await writer?.abort();
      return;
    }
    this.writer = writer;
    this.accepted = true;
    this.hash = new SHA256();
    this.started = performance.now();
    this.cb.started();
    this.control("FILE_ACCEPT");
  }
  async message(raw) {
    if (this.stopped) return;
    if (typeof raw !== "string") {
      if (!this.accepted || this.done) throw Error("Unexpected file data.");
      const part = unframe(raw);
      if (
        part.id !== this.offer.file_id ||
        part.index !== this.index ||
        part.offset !== this.offset ||
        part.data.length > this.offer.chunk_size ||
        this.offset + part.data.length > this.offer.size
      )
        throw Error("Invalid or out-of-order chunk.");
      this.hash.update(part.data);
      if (this.writer) await this.writer.write(part.data);
      else this.parts.push(part.data);
      this.offset += part.data.length;
      this.index++;
      this.cb.progress(this.offset, this.offer.size);
      this.control("ACK", { offset: this.offset });
      return;
    }
    const msg = JSON.parse(raw);
    if (msg.type === "FILE_OFFER") {
      if (this.offer || this.file) throw Error("Unexpected file offer.");
      if (
        !/^[a-f0-9]{32}$/.test(msg.file_id) ||
        !/^[a-f0-9]{64}$/.test(msg.sha256) ||
        typeof msg.name !== "string" ||
        msg.name.length > 1024 ||
        !Number.isSafeInteger(msg.size) ||
        msg.size < 0 ||
        !Number.isInteger(msg.chunk_size) ||
        msg.chunk_size < 1 ||
        msg.chunk_size > CHUNK_SIZE
      )
        throw Error("Invalid file metadata.");
      this.offer = msg;
      this.cb.offer(msg);
      return;
    }
    if (!this.offer || msg.file_id !== this.offer.file_id)
      throw Error("Invalid transfer identifier.");
    if (msg.type === "FILE_ACCEPT" && this.file && !this.sending) {
      this.sending = true;
      this.cb.started();
      this.sendFile().catch((e) => this.fail(e));
    } else if (msg.type === "ACK" && this.waitAck) {
      if (msg.offset !== this.expectedAck)
        throw Error("Invalid receiver acknowledgment.");
      this.waitAck();
    } else if (msg.type === "FILE_COMPLETE" && this.accepted && !this.done) {
      if (
        this.offset !== this.offer.size ||
        this.hash.hex() !== this.offer.sha256
      )
        throw Error("Checksum mismatch. File was not saved.");
      if (this.writer) await this.writer.close();
      else {
        this.url = URL.createObjectURL(
          new Blob(this.parts, { type: "application/octet-stream" }),
        );
        this.cb.download(this.url, this.offer.name);
        this.parts = [];
      }
      this.done = true;
      this.control("FILE_VERIFIED");
      this.cb.complete();
    } else if (msg.type === "FILE_VERIFIED" && this.file && this.sentComplete) {
      clearTimeout(this.verifyTimer);
      this.done = true;
      this.cb.complete();
    } else if (msg.type === "CANCEL")
      throw Error("The other person canceled the transfer.");
    else throw Error("Unexpected transfer message.");
  }
  async sendFile() {
    let offset = 0,
      index = 0;
    while (offset < this.file.size) {
      if (this.stopped) throw Error("Transfer canceled.");
      await drain(this.channel);
      const data = await this.file
        .slice(offset, offset + this.chunkSize)
        .arrayBuffer();
      if (this.stopped) throw Error("Transfer canceled.");
      const next = offset + data.byteLength;
      // Acknowledgment follows the receiver's disk write, bounding its async queue.
      await new Promise((resolve, reject) => {
        this.expectedAck = next;
        this.ackReject = reject;
        this.ackTimer = setTimeout(() => {
          this.waitAck = null;
          reject(Error("Receiver stopped responding."));
        }, 60000);
        this.waitAck = () => {
          clearTimeout(this.ackTimer);
          this.waitAck = null;
          this.ackReject = null;
          resolve();
        };
        try {
          this.channel.send(frame(this.offer.file_id, index, offset, data));
        } catch (e) {
          clearTimeout(this.ackTimer);
          this.waitAck = null;
          reject(e);
        }
      });
      offset = next;
      index++;
      this.cb.progress(offset, this.file.size);
    }
    this.sentComplete = true;
    this.control("FILE_COMPLETE");
    this.cb.status("All bytes sent · waiting for verification");
    this.verifyTimer = setTimeout(
      () => this.fail(Error("Receiver verification timed out.")),
      60000,
    );
  }
  fail(error) {
    if (this.stopped || this.done) return;
    this.stop();
    this.cb.error(error);
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.ackTimer);
    clearTimeout(this.verifyTimer);
    this.ackReject?.(Error("Transfer stopped."));
    this.writer?.abort().catch(() => {});
    this.parts = [];
    if (this.url) URL.revokeObjectURL(this.url);
  }
}
