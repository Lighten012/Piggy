const form = document.querySelector("form");
const input = document.querySelector("#message");
const send = document.querySelector("#send");
const reset = document.querySelector("#reset");
const status = document.querySelector("#status");
const messages = document.querySelector("#messages");
const thread = document.querySelector("#thread");
const empty = document.querySelector("#empty");
let session;
let busy = false;

function append(role, text) {
  empty.hidden = true;
  const block = document.createElement("p");
  block.className = "message " + role;
  const label = document.createElement("strong");
  label.textContent = role === "user" ? "你" : "Piggy";
  const content = document.createTextNode(text);
  block.append(label, content);
  messages.append(block);
  thread.scrollTop = thread.scrollHeight;
  return content;
}

reset.onclick = () => {
  session = undefined;
  messages.replaceChildren();
  empty.hidden = false;
  status.textContent = "";
  input.value = "";
  input.focus();
};
input.onkeydown = event => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    if (!busy) form.requestSubmit();
  }
};
form.onsubmit = async event => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || busy) return;
  busy = true;
  send.disabled = reset.disabled = input.readOnly = true;
  input.value = "";
  append("user", text);
  const answer = append("assistant", "");
  status.textContent = "正在回复…";
  try {
    const response = await fetch("/chat", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({text, session}),
    });
    if (!response.ok) throw new Error((await response.json()).error);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let pending = "", done = false;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += chunk.value;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const item = JSON.parse(line);
        if (item.error) throw new Error(item.error);
        if (item.delta) {
          const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
          answer.appendData(item.delta);
          if (nearBottom) thread.scrollTop = thread.scrollHeight;
        }
        if (item.done) { session = item.session; done = true; }
      }
    }
    if (!done) throw new Error("回复中断，请重试");
    status.textContent = "";
  } catch (error) {
    status.textContent = error.message || "发送失败，请重试";
    if (!answer.length) answer.parentNode.remove();
    if (messages.lastElementChild?.classList.contains("user")) messages.lastElementChild.remove();
    empty.hidden = Boolean(messages.childElementCount);
    input.value = text;
  } finally {
    busy = false;
    send.disabled = reset.disabled = input.readOnly = false;
    input.focus();
  }
};
