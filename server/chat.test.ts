import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

test("streams replies and preserves history across a failed turn", async t => {
  const histories: string[][] = [];
  const fixture = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const messages: { role: string; content: string | { text: string }[] }[] = JSON.parse(body).messages;
    histories.push(messages
      .filter(message => message.role === "user")
      .map(({ content }) => typeof content === "string" ? content : content.map(part => part.text).join("")));
    if (histories.length === 2) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Test failure" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const [delta, finish_reason] of [[{ role: "assistant", content: "OK" }, null], [{}, "stop"]]) {
      const chunk = { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] };
      res.write("data: " + JSON.stringify(chunk) + "\n\n");
    }
    res.end("data: [DONE]\n\n");
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  t.after(() => fixture.close());
  const child = spawn(process.execPath, ["server.ts"], {
    env: { ...process.env, PI_API_KEY: "", PI_MODEL: "gpt-4.1-mini", PORT: "0",
      PI_LOCAL_FIXTURE_PORT: String((fixture.address() as AddressInfo).port) },
    stdio: ["ignore", "pipe", "ignore"],
  });
  t.after(() => child.kill());
  const [line] = await once(child.stdout, "data");
  const port = String(line).match(/port (\d+)/)?.[1];
  assert.ok(port);
  async function send(text: string, session?: string) {
    const res = await fetch("http://127.0.0.1:" + port + "/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, session }),
    });
    return (await res.text()).trim().split("\n").map(line => JSON.parse(line));
  }
  const first = await send("one");
  assert.equal(first[0].delta, "OK");
  const id = first.at(-1).session;
  assert.ok(id);
  assert.ok((await send("failed", id)).at(-1).error);
  assert.equal((await send("two", id)).at(-1).session, id);
  assert.deepEqual(histories[2], ["one", "two"]);
});
