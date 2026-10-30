import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.EGO_API_BASE_URL || "http://127.0.0.1:8765";
function readDotEnv(name) {
  if (process.env[name]) return process.env[name];
  try {
    const file = fs.readFileSync(path.join(here, ".env"), "utf8");
    const line = file.split(/\r?\n/).find(item => item.trim().startsWith(name + "="));
    return line ? line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "") : "";
  } catch {
    return "";
  }
}
const API_KEY = readDotEnv("EGO_API_KEY");
const authHeaders = (extra = {}) => {
  const headers = { ...extra };
  if (API_KEY) headers.Authorization = "Bearer " + API_KEY;
  return headers;
};
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
async function postJson(body, headers = authHeaders({ "Content-Type": "application/json" })) {
  return fetch(BASE_URL + "/v1/chat/completions", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(180000)
  });
}

console.log("Ego ChatGPT API integration tests: " + BASE_URL);
await test("health endpoint reports ready", async () => {
  const response = await fetch(BASE_URL + "/health", { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.status, "ready");
  assert.equal(typeof data.authEnabled, "boolean");
  console.log("  health=" + JSON.stringify(data));
});
await test("model list returns a non-empty list", async () => {
  const response = await fetch(BASE_URL + "/v1/models", { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(Array.isArray(data.data) && data.data.length > 0);
});
await test("remote web origins are rejected", async () => {
  const response = await fetch(BASE_URL + "/health", {
    headers: { Origin: "https://untrusted.example" },
    signal: AbortSignal.timeout(5000)
  });
  assert.equal(response.status, 403);
});
if (API_KEY) {
  await test("chat endpoint rejects requests without an API key", async () => {
    const response = await postJson({ messages: [{ role: "user", content: "should not run" }] }, { "Content-Type": "application/json" });
    assert.equal(response.status, 401);
  });
}
await test("empty messages are rejected with HTTP 400", async () => {
  const response = await postJson({ messages: [] });
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.equal(data.error.type, "invalid_request_error");
});
await test("image input is rejected explicitly rather than stringified", async () => {
  const response = await postJson({
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.invalid/image.png" } }] }]
  });
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.match(data.error.message, /图片消息/);
});
await test("non-stream chat completion returns expected content", async () => {
  const response = await postJson({
    model: "chatgpt-plus",
    messages: [{ role: "user", content: "请只回复这几个字：API测试成功" }],
    stream: false
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || "";
  console.log("  reply=" + JSON.stringify(content));
  assert.ok(content.includes("API测试成功"), "reply did not contain the expected marker");
});
await test("stream=true returns the complete Unicode response once", async () => {
  const response = await postJson({
    model: "chatgpt-plus",
    messages: [{ role: "user", content: "请只回复这几个字：流式测试成功" }],
    stream: true
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /application\/json/i);
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || "";
  console.log("  complete reply=" + JSON.stringify(content));
  assert.ok(content.includes("流式测试成功"), "response did not contain the expected marker");
});

console.log("Summary: " + (failures === 0 ? "ALL TESTS PASSED" : failures + " TEST(S) FAILED"));
if (failures > 0) process.exitCode = 1;
