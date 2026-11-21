import assert from "node:assert/strict";
import test from "node:test";
import { WebSearch } from "./web-search.ts";

test("renders annotated URLs once, preserves normal Markdown, and ignores unsafe URLs", () => {
  const search = new WebSearch();
  const native = "[官网](https://example.org/doc)";
  const marker = "\uE200cite\uE202turn0search0\uE201";
  const text = native + "🐷" + marker;
  const start = Array.from(native).length+1, end = Array.from(text).length;
  const refs = [
    {url:"https://example.org/doc",start_index:0,end_index:start-1},
    {url:"https://news.test/p(a)",start_index:start,end_index:end},
    {url:"https://news.test/p(a)",start_index:start,end_index:end},
    {url:"javascript:alert(1)",start_index:start,end_index:end},
  ].map(ref => ({type:"url_citation",...ref}));
  const msg = {type:"message",content:[{type:"output_text",text,annotations:refs}]};
  const call = {type:"web_search_call",id:"ws_1",status:"completed"};
  search.observe({type:"response.output_item.done",item:msg});
  search.observe({type:"response.completed",response:{output:[call,msg]}});
  assert.equal(search.used,true);
  assert.equal(search.render(text),native+"🐷 [来源 · news.test](https://news.test/p%28a%29)");
  assert.equal(search.render("ordinary chat"),"ordinary chat");
});
