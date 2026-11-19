import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import * as installedCore from "@earendil-works/pi-agent-core";

test("the mobile bundle retains every Core export, executes tools and remembers the previous turn", async () => {
  const requests = [];
  const deltas = [];
  const errors = [];
  const bridge = {
    ready() {}, delta: text => deltas.push(text), finished: error => errors.push(error),
    request(id, body) {
      requests.push(JSON.parse(body));
      queueMicrotask(() => {
        const deliver = (type, data) => browser.PiggyAgent.network(id, type, data);
        deliver("headers");
        const chunk = {choices:[{index:0, delta:{content:"OK"}, finish_reason:"stop"}]};
        deliver("chunk", "data: " + JSON.stringify(chunk) + "\n\ndata: [DONE]\n\n");
        deliver("end");
      });
    },
  };
  const browser = { PiggyNative: bridge, performance, TextEncoder, TextDecoder, Response, Headers,
    ReadableStream, AbortController, AbortSignal, URL, Request, setTimeout, clearTimeout,
    fetch, crypto: globalThis.crypto, structuredClone, queueMicrotask, URLSearchParams,
    FormData, Blob, Buffer: undefined, console };
  const bundle = new URL("../android/app/build/generated/piggy/assets/piggy.js", import.meta.url);
  runInNewContext(await readFile(bundle, "utf8"), browser);
  assert.deepEqual(Object.keys(browser.PiAgentCore).sort(), Object.keys(installedCore).sort());
  const tool = {name:"double", description:"Double a number", parameters:{
    type:"object", properties:{n:{type:"number"}}, required:["n"],
  }, execute:async (_id, {n}) => ({content:[{type:"text",text:String(n * 2)}],details:{}})};
  const result = await browser.PiAgentCore.runToolCall({type:"toolCall", id:"number", name:"double", arguments:{n:6}},
    {tools:[tool], context:{messages:[]}, assistantMessage:{role:"assistant",content:[]}});
  assert.equal(result.result.content[0].text, "12");
  await browser.PiggyAgent.prompt("first message");
  await browser.PiggyAgent.prompt("next");
  assert.deepEqual(errors, ["", ""]);
  assert.deepEqual(deltas, ["OK", "OK"]);
  assert.match(JSON.stringify(requests[1].messages), /first message/);
  browser.PiggyAgent.reset();
  await browser.PiggyAgent.prompt("new");
  assert.doesNotMatch(JSON.stringify(requests[2].messages), /first message/);
});
