import assert from "node:assert/strict";

const project = "D:/Projects/ego-chatgpt-api";
process.env.EGO_API_PORT = "8767";
process.env.EGO_API_KEY = "mock-test-secret";
process.env.EGO_API_LOG_FILE = project + "/mock-test.log";
process.env.EGO_TASK_SPACE_ID = "Mock-Bridge-Test";

let currentPrompt = "";
let navigationCount = 0;
let statusChecks = 0;
let domExtractionCalls = 0;

const page = {
  label: "p1",
  goto: async (url) => { navigationCount++; return { url }; },
  url: async () => "https://chatgpt.com/",
  title: async () => "Mock ChatGPT",
  waitForTimeout: async () => {},
  waitForSelector: async () => true,
  click: async () => true,
  close: async () => {},
  snapshot: async () => 'button "编辑消息"\nparagraph\ntext "MOCK_REPLY"\nbutton "重新生成回答"',
  keyboard: {
    press: async () => {},
    insertText: async (text) => { currentPrompt = text; }
  },
  evaluate: async (fn) => {
    const src = String(fn);
    if (src.includes("() => 1")) return 1;
    if (src.includes("cloudflare_challenge")) return false;
    if (src.includes("data-message-author-role")) {
      domExtractionCalls++;
      const text = "MOCK_REPLY_FROM_DOM\n\nSECOND_PARAGRAPH";
      return { assistantCount: 1, source: ".markdown", chars: text.length, text, messageId: "mock-assistant" };
    }
    if (src.includes("const btn = document.querySelector")) return true;
    if (src.includes("const buttons = Array.from(document.querySelectorAll('button'))")) return null;
    if (src.includes("const stop = document.querySelector")) {
      statusChecks++;
      return statusChecks % 2 === 1
        ? { generating: true, regen: false }
        : { generating: false, regen: true };
    }
    return null;
  }
};

const task = {
  spaceId: "Mock-Bridge-Test",
  name: "Mock-Bridge-Test",
  pages: async () => [page],
  page: (label) => label === "p1" ? page : undefined,
  newPage: async () => page
};
globalThis.taskSpace = async () => task;

const { server } = await import("./server.mjs?mock-integration=1");
const base = "http://127.0.0.1:8767";
const headers = { "Content-Type": "application/json", Authorization: "Bearer mock-test-secret" };
const expectedReply = "MOCK_REPLY_FROM_DOM\n\nSECOND_PARAGRAPH";
let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log("PASS " + name);
  } catch (error) {
    failures++;
    console.error("FAIL " + name + ": " + (error?.stack || error));
  }
}

async function post(body, extraHeaders = headers) {
  return fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: extraHeaders,
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
}

async function readSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let doneToken = false;
  while (true) {
    const part = await reader.read();
    buffer += decoder.decode(part.value || new Uint8Array(), { stream: !part.done });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of event.split(/\r?\n/)) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6);
        if (payload === "[DONE]") { doneToken = true; continue; }
        const chunk = JSON.parse(payload);
        text += chunk?.choices?.[0]?.delta?.content || "";
      }
    }
    if (part.done) break;
  }
  return { text, doneToken };
}

const deadline = Date.now() + 10000;
let ready = false;
while (Date.now() < deadline) {
  try {
    const response = await fetch(base + "/health", { signal: AbortSignal.timeout(1000) });
    const data = await response.json();
    if (data.status === "ready") { ready = true; break; }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 100));
}
if (!ready) throw new Error("Mock server did not become ready.");

await test("health and model list are available", async () => {
  const health = await (await fetch(base + "/health")).json();
  assert.equal(health.status, "ready");
  assert.equal(health.authEnabled, true);
  const models = await (await fetch(base + "/v1/models")).json();
  assert.ok(models.data.length >= 1);
});

await test("API key is enforced on chat requests", async () => {
  const response = await post({ messages: [{ role: "user", content: "blocked" }] }, { "Content-Type": "application/json" });
  assert.equal(response.status, 401);
});

await test("non-local origins are blocked", async () => {
  const response = await fetch(base + "/health", { headers: { Origin: "https://untrusted.example" } });
  assert.equal(response.status, 403);
});

await test("invalid and image messages fail before browser execution", async () => {
  const empty = await post({ messages: [] });
  assert.equal(empty.status, 400);
  const image = await post({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.invalid/a.png" } }] }] });
  assert.equal(image.status, 400);
  assert.match((await image.json()).error.message, /图片消息/);
});

await test("non-stream completion prefers full assistant DOM content", async () => {
  const response = await post({ model: "chatgpt-plus", messages: [{ role: "user", content: "Say mock" }], stream: false });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.choices[0].message.content, expectedReply);
  assert.ok(domExtractionCalls > 0, "expected assistant DOM extraction to run");
  assert.equal(currentPrompt, "Say mock");
});

await test("conversation history is included and a fresh page navigation is requested", async () => {
  const response = await post({
    messages: [
      { role: "system", content: "Be concise" },
      { role: "user", content: "Question one" },
      { role: "assistant", content: "Answer one" },
      { role: "user", content: "Question two" }
    ]
  });
  assert.equal(response.status, 200);
  assert.match(currentPrompt, /系统指令/);
  assert.match(currentPrompt, /Question one/);
  assert.match(currentPrompt, /Answer one/);
  assert.match(currentPrompt, /Question two/);
  assert.ok(navigationCount >= 3, "expected initialization plus a fresh conversation for each request");
});

await test("SSE output preserves the full assistant DOM content and ends with DONE", async () => {
  const response = await post({ messages: [{ role: "user", content: "stream test" }], stream: true });
  assert.equal(response.status, 200);
  const result = await readSse(response);
  assert.equal(result.text, expectedReply);
  assert.equal(result.doneToken, true);
});

await test("oversized request returns HTTP 413", async () => {
  const body = JSON.stringify({ messages: [{ role: "user", content: "x".repeat(2 * 1024 * 1024 + 100) }] });
  const response = await post(body);
  assert.equal(response.status, 413);
});

try {
  await fetch(base + "/shutdown", { method: "POST", headers: { Authorization: "Bearer mock-test-secret" } });
} catch {}
await new Promise(resolve => setTimeout(resolve, 250));
console.log("Mock integration summary: " + (failures === 0 ? "ALL PASSED" : failures + " FAILED"));
if (failures > 0) process.exitCode = 1;
