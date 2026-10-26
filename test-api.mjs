const BASE_URL = "http://127.0.0.1:8765";

async function runTests() {
  console.log("================ 开始 API 接口测试 ================");

  // 1. 测试健康检查
  console.log("\n[Test 1] 测试 GET /health ...");
  const healthResp = await fetch(`${BASE_URL}/health`);
  const healthData = await healthResp.json();
  console.log("Health 结果:", healthData);
  if (healthData.status !== "ready") {
    console.log("服务还在准备中，等待 5 秒...");
    await new Promise(r => setTimeout(r, 5000));
  }

  // 2. 测试模型列表
  console.log("\n[Test 2] 测试 GET /v1/models ...");
  const modelsResp = await fetch(`${BASE_URL}/v1/models`);
  const modelsData = await modelsResp.json();
  console.log(`成功获取模型列表，共 ${modelsData.data.length} 个模型:`);
  modelsData.data.forEach(m => console.log(` - ${m.id}`));

  // 3. 测试 POST /v1/chat/completions (非流式测试)
  console.log("\n[Test 3] 测试 POST /v1/chat/completions (非流式)...");
  const testPrompt = "请只回复五个字：API测试成功";
  console.log(`发送请求: "${testPrompt}"`);
  
  const chatResp = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "你是一个助手" },
        { role: "user", content: testPrompt }
      ],
      stream: false
    })
  });

  const chatData = await chatResp.json();
  console.log("ChatCompletion 响应完整对象:");
  console.log(JSON.stringify(chatData, null, 2));

  const content = chatData?.choices?.[0]?.message?.content;
  console.log("\n>>> 收到助理回答内容:", content);

  if (content && content.includes("API测试成功")) {
    console.log("【SUCCESS】非流式 API 测试完美通过！");
  } else {
    console.log("【INFO】收到内容:", content);
  }

  // 4. 测试 POST /v1/chat/completions (流式测试)
  console.log("\n[Test 4] 测试 POST /v1/chat/completions (流式 stream: true)...");
  const streamPrompt = "请只回复六个字：流式测试成功";
  console.log(`发送流式请求: "${streamPrompt}"`);

  const streamResp = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: streamPrompt }],
      stream: true
    })
  });

  const reader = streamResp.body.getReader();
  const decoder = new TextDecoder();
  let accumulatedStreamText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const textChunk = decoder.decode(value);
    const lines = textChunk.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ") && !line.includes("[DONE]")) {
        try {
          const json = JSON.parse(line.slice(6));
          const delta = json?.choices?.[0]?.delta?.content || "";
          accumulatedStreamText += delta;
        } catch (e) {}
      }
    }
  }

  console.log("\n>>> 收到流式汇总内容:", accumulatedStreamText);
  if (accumulatedStreamText.includes("流式测试成功")) {
    console.log("【SUCCESS】流式 API 测试完美通过！");
  } else {
    console.log("【INFO】流式内容:", accumulatedStreamText);
  }

  console.log("\n================ 所有接口测试执行完毕 ================");
}

runTests().catch(err => {
  console.error("测试发生异常:", err);
  process.exit(1);
});
