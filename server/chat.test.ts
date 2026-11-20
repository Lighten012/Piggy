import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

for (const worker of [false, true]) test(
  (worker ? "private Pi worker" : "standalone admin") + " streams replies and preserves successful history", async t => {
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
  const child = spawn(process.execPath, [worker ? process.env.PIGGY_TEST_BUNDLE || "server.ts" : "server.ts"], {
    env: { ...process.env, PIGGY_ADMIN_PASSWORD: "fixture-password", PIGGY_WORKER_TOKEN: worker ? "fixture-worker" : "", HOST: "127.0.0.1", PI_API_KEY: "", PI_MODEL: "gpt-4.1-mini", PORT: "0",
      PI_LOCAL_FIXTURE_PORT: String((fixture.address() as AddressInfo).port) },
    stdio: ["ignore", "pipe", "ignore"],
  });
  t.after(() => child.kill());
  const [line] = await once(child.stdout, "data");
  const port = String(line).match(/port (\d+)/)?.[1];
  assert.ok(port);
  const base = "http://127.0.0.1:" + port;
  const headers = { "x-piggy-owner": "admin", authorization: worker ? "Bearer fixture-worker" : "Basic " + Buffer.from("piggy:fixture-password").toString("base64"),
    "content-type": "application/json", origin: base};
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await fetch(base + "/chat", {method: "POST"})).status, 401);
  const page = await fetch(base, { headers });
  assert.equal(page.status, worker ? 404 : 200);
  if (!worker) assert.match(await page.text(), /<textarea/);
  assert.equal((await fetch(base + "/chat", {method: "POST",
    headers: {...headers, origin: "https://another.example"}, body: "{}"})).status, 403);
  async function send(text: string, session?: string) {
    const res = await fetch("http://127.0.0.1:" + port + "/chat", {
      method: "POST", headers,
      body: JSON.stringify({ text, session }),
    });
    return (await res.text()).trim().split("\n").map(line => JSON.parse(line));
  }
  const first = await send("one");
  assert.equal(first[0].delta, "OK");
  const id = first.at(-1).session;
  assert.ok(id);
  if (worker) {
    const other = await fetch(base + "/chat", {method:"POST",
      headers:{...headers, "x-piggy-owner":"device-" + "a".repeat(64)},
      body:JSON.stringify({text:"another owner", session:id})});
    assert.equal(other.status,410);
  }
  assert.ok((await send("failed", id)).at(-1).error);
  assert.equal((await send("two", id)).at(-1).session, id);
  assert.deepEqual(histories[2], ["one", "two"]);
});
