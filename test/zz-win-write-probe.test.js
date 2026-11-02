import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, Socket } from "node:net";
import test from "node:test";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("diagnostic: paused loopback write completion", { timeout: 60000 }, async () => {
  for (const mib of [1, 4, 16, 32, 64, 128, 256]) {
    for (const mode of ["paused", "onread", "queued"]) {
      const peers = new Set();
      const server = createServer((socket) => {
        peers.add(socket);
        socket.on("error", () => {});
        socket.once("close", () => peers.delete(socket));
      });
      let peer;
      let callback = false;
      let secondCallback = false;
      const client = new Socket(
        mode === "onread" ? { onread: { buffer: Buffer.alloc(1), callback: () => false } } : {},
      );
      client.on("error", () => {});
      if (mode !== "onread") client.pause();
      try {
        const connectSignal = AbortSignal.timeout(5000);
        server.listen(0, "127.0.0.1");
        await once(server, "listening", { signal: connectSignal });
        const address = server.address();
        assert.ok(address && typeof address === "object");
        const connected = once(client, "connect", { signal: connectSignal });
        client.connect(address.port, "127.0.0.1");
        await connected;
        while (!peer) {
          peer = [...peers].find((socket) => socket.remotePort === client.localPort);
          if (!peer) await once(server, "connection", { signal: connectSignal });
        }
        assert.equal(peer.remotePort, client.localPort);
        peer.write(Buffer.alloc(mib * 1024 * 1024, 97), () => {
          callback = true;
        });
        if (mode === "queued") {
          peer.write(Buffer.from("tail"), () => {
            secondCallback = true;
          });
        }
        const sample = (phase) =>
          console.log(
            "WINPROBE",
            JSON.stringify({
              platform: process.platform,
              node: process.version,
              mib,
              mode,
              phase,
              peerPort: peer.remotePort,
              clientPort: client.localPort,
              callback,
              secondCallback,
              writableLength: peer.writableLength,
              bytesWritten: peer.bytesWritten,
              bytesRead: client.bytesRead,
              paused: client.isPaused(),
              reading: Reflect.get(client, "_handle")?.reading,
            }),
          );
        sample("write");
        await new Promise((resolve) => setImmediate(resolve));
        sample("immediate");
        await delay(100);
        sample("100ms");
        await delay(900);
        sample("1000ms");
      } finally {
        const cleanupSignal = AbortSignal.timeout(5000);
        const serverClosed = once(server, "close", { signal: cleanupSignal });
        const clientClosed = client.closed ? Promise.resolve() : once(client, "close", { signal: cleanupSignal });
        server.close();
        client.destroy();
        for (const socket of peers) socket.destroy();
        await Promise.all([serverClosed, clientClosed]);
      }
    }
  }
});
