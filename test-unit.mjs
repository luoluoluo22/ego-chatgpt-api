import assert from "node:assert/strict";

process.env.EGO_API_TEST_MODE = "1";
process.env.EGO_API_KEY = "unit-test-secret";
const { server, buildPrompt, messageContentToText } = await import("./server.mjs?unit-test=1");

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

await test("simple user prompt remains unchanged", async () => {
  assert.equal(buildPrompt([{ role: "user", content: "hello" }]), "hello");
});
await test("history includes system, user, and assistant messages", async () => {
  const prompt = buildPrompt([
    { role: "system", content: "Be concise." },
    { role: "user", content: "What is 2+2?" },
    { role: "assistant", content: "4" },
    { role: "user", content: "Explain briefly." }
  ]);
  assert.match(prompt, /系统指令/);
  assert.match(prompt, /What is 2\+2\?/);
  assert.match(prompt, /助手历史回复/);
  assert.match(prompt, /Explain briefly\./);
});
await test("text content blocks are normalized", async () => {
  assert.equal(messageContentToText([{ type: "text", text: "A" }, { type: "input_text", text: "B" }]), "A\nB");
});
await test("image content is explicitly rejected", async () => {
  assert.throws(() => messageContentToText([{ type: "image_url", image_url: { url: "https://example.invalid/a.png" } }]), /图片消息/);
});
await test("messages without a user turn are rejected", async () => {
  assert.throws(() => buildPrompt([{ role: "system", content: "rules" }]), /user 消息/);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
const base = "http://127.0.0.1:" + address.port;
const jsonHeaders = { "Content-Type": "application/json", Authorization: "Bearer unit-test-secret" };

await test("health endpoint reports API key protection in test server", async () => {
  const response = await fetch(base + "/health");
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.authEnabled, true);
  assert.equal(data.status, "initializing");
});
await test("models endpoint remains available", async () => {
  const response = await fetch(base + "/v1/models");
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(Array.isArray(data.data) && data.data.length > 0);
});
await test("non-local browser origins are rejected", async () => {
  const response = await fetch(base + "/health", { headers: { Origin: "https://untrusted.example" } });
  assert.equal(response.status, 403);
});
await test("chat endpoint rejects missing API key", async () => {
  const response = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "must not run" }] })
  });
  assert.equal(response.status, 401);
});
await test("empty messages return HTTP 400 with a valid API key", async () => {
  const response = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ messages: [] })
  });
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.equal(data.error.type, "invalid_request_error");
});
await test("image input returns an explicit unsupported-input error", async () => {
  const response = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.invalid/a.png" } }] }] })
  });
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.match(data.error.message, /图片消息/);
});
await test("oversized request bodies return HTTP 413", async () => {
  const oversized = JSON.stringify({ messages: [{ role: "user", content: "x".repeat(2 * 1024 * 1024 + 100) }] });
  const response = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: jsonHeaders,
    body: oversized
  });
  assert.equal(response.status, 413);
});

await test("suno endpoints reject missing API key", async () => {
  const response = await fetch(base + "/v1/suno/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "test prompt" })
  });
  assert.equal(response.status, 401);
});
await test("models endpoint includes suno models", async () => {
  const response = await fetch(base + "/v1/models");
  assert.equal(response.status, 200);
  const data = await response.json();
  const ids = data.data.map(m => m.id);
  assert.ok(ids.includes("suno-v4"));
  assert.ok(ids.includes("suno-v3.5"));
});

await new Promise(resolve => server.close(resolve));
console.log("Unit/API checks: " + (failures === 0 ? "ALL PASSED" : failures + " FAILED"));
if (failures > 0) process.exitCode = 1;