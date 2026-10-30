import assert from "node:assert/strict";
import { normalizeSunoModel } from "./providers/suno.mjs";

const PORT = 8768;
process.env.EGO_API_PORT = String(PORT);
process.env.EGO_API_KEY = "suno-test-secret";
process.env.EGO_PROVIDERS = "chatgpt,suno";
process.env.EGO_TASK_SPACE_ID = "Mock-ChatGPT-Space";
process.env.EGO_SUNO_TASK_SPACE_ID = "Mock-Suno-Space";

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

// 1. 单元逻辑测试：模型名称归一化
await test("normalizeSunoModel maps versions correctly", async () => {
  assert.equal(normalizeSunoModel("v4"), "chirp-v4");
  assert.equal(normalizeSunoModel("suno-v4"), "chirp-v4");
  assert.equal(normalizeSunoModel("chirp-v4"), "chirp-v4");
  assert.equal(normalizeSunoModel("v3"), "chirp-v3-0");
  assert.equal(normalizeSunoModel("suno-v3"), "chirp-v3-0");
  assert.equal(normalizeSunoModel("v3.5"), "chirp-v3-5");
  assert.equal(normalizeSunoModel("suno-v3.5"), "chirp-v3-5");
  assert.equal(normalizeSunoModel("unknown"), "chirp-v3-5");
});

// 2. 模拟浏览器环境准备
let lastEvaluatedBody = null;
let lastEvaluatedEndpoint = null;
const mockClips = [
  {
    id: "clip-001",
    title: "Cyber City",
    audio_url: "https://cdn.example.com/audio1.mp3",
    image_url: "https://cdn.example.com/cover1.jpg",
    status: "complete",
    duration: 180,
    model_name: "chirp-v3-5"
  },
  {
    id: "clip-002",
    title: "Cyber City Part 2",
    audio_url: "https://cdn.example.com/audio2.mp3",
    image_url: "https://cdn.example.com/cover2.jpg",
    status: "complete",
    duration: 195,
    model_name: "chirp-v3-5"
  }
];

const mockPage = {
  label: "p1",
  goto: async (url) => ({ url }),
  url: async () => "https://suno.com/create?wid=default",
  title: async () => "Suno | Create",
  waitForTimeout: async () => {},
  waitForSelector: async () => true,
  click: async () => true,
  close: async () => {},
  evaluate: async (fn, arg) => {
    const src = String(fn);
    if (src.includes("() => 1")) return 1;

    // 检测 sessionInfo
    if (src.includes("hasClerk") && src.includes("isSignedIn")) {
      return {
        hasClerk: true,
        isSignedIn: true,
        tokenSnippet: "mock_jwt_...",
        title: "Suno | Create",
        url: "https://suno.com/create?wid=default"
      };
    }

    // 生成接口
    if (src.includes("/api/generate/v2/")) {
      lastEvaluatedBody = arg;
      return {
        success: true,
        endpoint: "https://studio-api.prod.suno.com/api/generate/v2/",
        data: { clips: mockClips }
      };
    }

    // Feed 查询
    if (src.includes("/api/feed/")) {
      return {
        success: true,
        data: mockClips
      };
    }

    // 额度查询
    if (src.includes("/api/billing/info/")) {
      return {
        success: true,
        data: {
          total_credits_left: 450,
          period: "monthly",
          monthly_limit: 2500,
          monthly_usage: 2050
        }
      };
    }

    return null;
  }
};

const mockTask = {
  spaceId: "Mock-Suno-Space",
  pages: async () => [mockPage],
  page: (label) => mockPage,
  newPage: async () => mockPage
};

globalThis.taskSpace = async (spaceId) => mockTask;

// 3. 载入服务实例并启动
const { server } = await import("./server.mjs?suno-test=1");
const base = `http://127.0.0.1:${PORT}`;
const headers = {
  "Content-Type": "application/json",
  "Authorization": "Bearer suno-test-secret"
};

// 等待就绪
for (let i = 0; i < 40; i++) {
  try {
    const res = await fetch(`${base}/health`);
    const h = await res.json();
    if (h.status === "ready") break;
  } catch (e) {}
  await new Promise(r => setTimeout(r, 100));
}

// 4. 端点测试
await test("GET /health reports both providers ready", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, "ready");
  assert.ok(data.providers.chatgpt);
  assert.ok(data.providers.suno);
  assert.equal(data.providers.suno.ready, true);
});

await test("GET /v1/models includes Suno and ChatGPT models", async () => {
  const res = await fetch(`${base}/v1/models`);
  assert.equal(res.status, 200);
  const data = await res.json();
  const modelIds = data.data.map(m => m.id);
  assert.ok(modelIds.includes("chatgpt-plus"));
  assert.ok(modelIds.includes("suno-v4"));
  assert.ok(modelIds.includes("suno-v3.5"));
});

await test("POST /v1/suno/generate requires API key when configured", async () => {
  const res = await fetch(`${base}/v1/suno/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "cyberpunk synthwave" })
  });
  assert.equal(res.status, 401);
});

await test("POST /v1/suno/generate creates simple song clips", async () => {
  const res = await fetch(`${base}/v1/suno/generate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt: "epic orchestral movie soundtrack",
      make_instrumental: true,
      model: "v3.5"
    })
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.code, 200);
  assert.equal(json.message, "success");
  assert.ok(Array.isArray(json.data) && json.data.length === 2);
  assert.equal(json.data[0].id, "clip-001");
  assert.equal(lastEvaluatedBody.make_instrumental, true);
  assert.equal(lastEvaluatedBody.gpt_description_prompt, "epic orchestral movie soundtrack");
  assert.equal(lastEvaluatedBody.mv, "chirp-v3-5");
});

await test("POST /v1/suno/custom_generate supports lyrics and tags", async () => {
  const res = await fetch(`${base}/v1/suno/custom_generate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt: "[Verse 1]\nNeon lights in the rain",
      tags: "synthwave 80s retro",
      title: "Night Driver",
      make_instrumental: false,
      model: "v4"
    })
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.code, 200);
  assert.equal(lastEvaluatedBody.title, "Night Driver");
  assert.equal(lastEvaluatedBody.tags, "synthwave 80s retro");
  assert.equal(lastEvaluatedBody.prompt, "[Verse 1]\nNeon lights in the rain");
  assert.equal(lastEvaluatedBody.mv, "chirp-v4");
});

await test("GET /v1/suno/feed queries clip statuses", async () => {
  const res = await fetch(`${base}/v1/suno/feed?ids=clip-001,clip-002`, { headers });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.code, 200);
  assert.equal(json.data.length, 2);
  assert.equal(json.data[0].audio_url, "https://cdn.example.com/audio1.mp3");
});

await test("GET /v1/suno/credits returns quota info", async () => {
  const res = await fetch(`${base}/v1/suno/credits`, { headers });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.code, 200);
  assert.equal(json.data.total_credits_left, 450);
});

await test("POST /v1/audio/generations formats response in OpenAI style", async () => {
  const res = await fetch(`${base}/v1/audio/generations`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt: "Lo-fi hip hop beat for studying",
      model: "suno-v3.5"
    })
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(typeof json.created === "number");
  assert.ok(Array.isArray(json.data) && json.data.length === 2);
  assert.equal(json.data[0].id, "clip-001");
  assert.equal(json.data[0].url, "https://cdn.example.com/audio1.mp3");
});

await test("POST /v1/suno/generate rejects empty prompt", async () => {
  const res = await fetch(`${base}/v1/suno/generate`, {
    method: "POST",
    headers,
    body: JSON.stringify({})
  });
  assert.equal(res.status, 500);
  const json = await res.json();
  assert.match(json.error.message, /不能为空/);
});

await test("GET /v1/suno/download serves existing cached audio file", async () => {
  const res = await fetch(`${base}/v1/suno/download/281a067d-82e5-4ff2-86e8-88504a9a748b`, { headers });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^audio\/(mpeg|mp4)$/);
  assert.match(res.headers.get("content-disposition") || "", /attachment;/);
  const blob = await res.arrayBuffer();
  assert.ok(blob.byteLength > 1000);
});

try {
  await fetch(`${base}/shutdown`, { method: "POST", headers });
} catch (e) {}

await new Promise(r => setTimeout(r, 200));
console.log("\n==========================================");
console.log("Suno Bridge Test Summary: " + (failures === 0 ? "ALL PASSED" : `${failures} FAILED`));
console.log("==========================================");
if (failures > 0) process.exitCode = 1;
