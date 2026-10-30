import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { BaseProvider } from "./base.mjs";

export function normalizeSunoModel(model) {
  const m = String(model || "").toLowerCase().trim();
  if (m === "v4" || m === "suno-v4" || m === "chirp-v4") return "chirp-v4";
  if (m === "v3" || m === "suno-v3" || m === "chirp-v3-0" || m === "v3.0") return "chirp-v3-0";
  return "chirp-v3-5";
}

export class SunoProvider extends BaseProvider {
  constructor(options = {}) {
    super("suno", "Suno Music Bridge", options);
    this.rootDir = options.rootDir || process.cwd();
    this.targetUrl = process.env.EGO_SUNO_URL || "https://suno.com/create?wid=default";
    this.globalTask = null;
    this.globalPage = null;
  }

  async init() {
    try {
      this.isReady = false;
      let spaceId = (process.env.EGO_SUNO_TASK_SPACE_ID || "").trim();
      const spaceIdFile = path.join(this.rootDir, ".ego-suno-space-id");
      if (!spaceId) {
        try { spaceId = fs.readFileSync(spaceIdFile, "utf8").trim(); } catch {}
      }
      if (!spaceId) {
        spaceId = "Suno-Bridge-" + Date.now().toString(36);
        try { fs.writeFileSync(spaceIdFile, spaceId, "utf8"); } catch {}
      }
      this.log(`正在建立常驻任务空间: ${spaceId} ...`);

      const taskSpaceFn = typeof taskSpace !== "undefined" ? taskSpace : globalThis.taskSpace;
      if (!taskSpaceFn) {
        throw new Error("ego-browser taskSpace API 不可用，请确保通过 ego-browser nodejs 运行。");
      }

      try {
        this.globalTask = await taskSpaceFn(spaceId);
      } catch (spaceError) {
        if (!process.env.EGO_SUNO_TASK_SPACE_ID && /Task space does not exist|belongs to the user|EPERM/i.test(spaceError.message || "")) {
          const claimMatch = (spaceError.message || "").match(/claimTaskSpace\((\d+)\)/);
          const claimFn = typeof claimTaskSpace !== "undefined" ? claimTaskSpace : globalThis.claimTaskSpace;
          if (claimMatch && claimFn) {
            try {
              this.log(`正在恢复用户态任务空间 (id: ${claimMatch[1]})...`);
              this.globalTask = await claimFn(Number(claimMatch[1]));
            } catch (claimErr) {}
          }
          if (!this.globalTask) {
            spaceId = "Suno-Bridge-" + Date.now().toString(36);
            fs.writeFileSync(spaceIdFile, spaceId, "utf8");
            this.log("Saved task space reset; created replacement: " + spaceId);
            this.globalTask = await taskSpaceFn(spaceId);
          }
        } else {
          throw spaceError;
        }
      }

      const existingPages = await this.globalTask.pages();
      this.globalPage = existingPages.find(page => page.label === "p1") || existingPages[0] || await this.globalTask.newPage();

      this.log(`导航至 ${this.targetUrl} ...`);
      await this.globalPage.goto(this.targetUrl, { timeout: 45000, waitUntil: "domcontentloaded" });

      this.log("等待 Suno 页面与 Clerk 会话初始化 (5秒)...");
      await this.globalPage.waitForTimeout(5000);

      // 诊断会话状态（检测登录与 Clerk 状态）
      const sessionInfo = await this.globalPage.evaluate(async () => {
        let hasClerk = false;
        let isSignedIn = false;
        let tokenSnippet = "";
        try {
          if (window.Clerk) {
            hasClerk = true;
            if (window.Clerk.session) {
              isSignedIn = true;
              const token = await window.Clerk.session.getToken();
              if (token) tokenSnippet = token.slice(0, 10) + "...";
            }
          }
        } catch (e) {}
        return {
          hasClerk,
          isSignedIn,
          tokenSnippet,
          title: document.title,
          url: window.location.href
        };
      });

      const info = sessionInfo || {};
      this.log(`页面就绪: title="${info.title || ""}", clerk=${Boolean(info.hasClerk)}, signedIn=${Boolean(info.isSignedIn)}`);
      if (!info.isSignedIn) {
        this.log("【注意】当前 Suno 页面似乎尚未登录或未取得 Clerk 会话，请确保已在浏览器窗口中登录 Suno 账号。");
      }

      this.isReady = true;
      this.initError = null;
      this.log("Suno 常驻会话已完全就绪，开始接客！");
    } catch (err) {
      this.log(`会话初始化失败: ${err.message}`);
      this.initError = err.message;
      this.isReady = false;
    }
  }

  async ensureReady() {
    if (this.globalPage && this.isReady) {
      try {
        await this.globalPage.evaluate(() => 1);
        return;
      } catch (err) {
        this.log(`现有会话已失效，正在自动拉起新会话... (${err.message})`);
      }
    }
    await this.init();
    if (!this.isReady) {
      throw new Error("Suno 会话无法就绪: " + (this.initError || "未知异常"));
    }
  }

  /**
   * 核心音乐生成调度（支持简易模式与自定义模式，内置浏览器原生 Fetch 与 UI 自动化后备）
   */
  async generateSong(options = {}) {
    await this.ensureReady();

    const {
      prompt,
      tags = "",
      title = "",
      make_instrumental = false,
      model = "chirp-v3-5",
      wait_audio = false,
      timeout_ms = 120000,
      continue_clip_id = null,
      continue_at = null
    } = options;

    if (!prompt && !tags && !title) {
      throw new Error("生成参数无效：prompt (提示词/歌词) 不能为空。");
    }

    const mv = normalizeSunoModel(model);
    const isCustom = Boolean(tags || title || options.is_custom);
    this.log(`发起生成请求: model=${mv}, custom=${isCustom}, instrumental=${make_instrumental}, wait_audio=${wait_audio}`);

    const payload = {
      make_instrumental: Boolean(make_instrumental),
      mv,
      prompt: prompt || "",
      generation_type: "TEXT",
      continue_clip_id: continue_clip_id || null,
      continue_at: continue_at || null
    };

    if (isCustom) {
      payload.tags = String(tags || "");
      payload.title = String(title || "");
    } else {
      payload.gpt_description_prompt = String(prompt || "");
      payload.prompt = "";
    }

    // 优先：利用页面当前已授权的 Clerk Session 执行 in-page fetch
    let generateResult = null;
    try {
      generateResult = await this.globalPage.evaluate(async (bodyData) => {
        let token = null;
        try {
          if (window.Clerk && window.Clerk.session) {
            token = await window.Clerk.session.getToken();
          }
        } catch (e) {}

        const headers = {
          "Content-Type": "text/plain;charset=UTF-8"
        };
        if (token) {
          headers["Authorization"] = `Bearer ${token}`;
        }

        const candidates = [
          "https://studio-api.prod.suno.com/api/generate/v2/",
          "https://studio-api.suno.ai/api/generate/v2/",
          "/api/generate/v2/"
        ];

        let lastErr = null;
        for (const endpoint of candidates) {
          try {
            const res = await fetch(endpoint, {
              method: "POST",
              headers,
              credentials: "include",
              body: JSON.stringify(bodyData)
            });
            if (res.ok) {
              const data = await res.json();
              return { success: true, endpoint, data };
            }
            const errorText = await res.text();
            lastErr = `Endpoint ${endpoint} returned ${res.status}: ${errorText}`;
            if (res.status === 401 || res.status === 402 || res.status === 400) {
              return { success: false, status: res.status, error: errorText };
            }
          } catch (e) {
            lastErr = e.message;
          }
        }
        return { success: false, error: lastErr || "All generate endpoints unreachable" };
      }, payload);
    } catch (evalErr) {
      this.log(`In-page 接口调用异常: ${evalErr.message}，尝试通过 UI 自动化后备处理...`);
    }

    let clips = [];
    if (generateResult && generateResult.success && generateResult.data) {
      this.log(`In-page 接口成功生成 (${generateResult.endpoint})`);
      clips = Array.isArray(generateResult.data.clips) ? generateResult.data.clips : [generateResult.data];
    } else {
      const errReason = generateResult?.error || "In-page fetch returned unsuccessful";
      this.log(`In-page 接口未能直接完成 (${errReason})，启动 UI 交互后备方案...`);
      clips = await this.generateViaUi(options);
    }

    if (!Array.isArray(clips) || clips.length === 0) {
      throw new Error("生成任务已提交，但未能提取到有效的 Clips 列表。");
    }

    // 若调用方指定等待音频生成完成（wait_audio: true）
    if (wait_audio) {
      const clipIds = clips.map(c => c.id).filter(Boolean);
      if (clipIds.length > 0) {
        this.log(`正在等待音频渲染就绪 (clipIds: ${clipIds.join(", ")})...`);
        clips = await this.pollUntilReady(clipIds, timeout_ms);
      }
    }

    // 若指定本地下载（download_local: true）
    if (options.download_local && Array.isArray(clips)) {
      for (const clip of clips) {
        if (clip.id) {
          try {
            clip.local_path = await this.downloadAudioFile(clip.id, null, clip.title);
          } catch (e) {
            this.log(`自动下载本地音频失败 (${clip.id}): ${e.message}`);
          }
        }
      }
    }

    return clips;
  }

  /**
   * 通过页面播放器 MediaSource 管道抓取已解密的完整音频流
   */
  async captureAudioFromPage(clipId, destDir = null, title = "") {
    await this.ensureReady();
    const dir = destDir || path.join(this.rootDir, "downloads");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const cleanTitle = (title || "suno-song").replace(/[\\/:*?"<>|]/g, "_").slice(0, 30);
    const m4aPath = path.join(dir, `${cleanTitle}-${clipId.slice(0, 8)}.m4a`);
    const mp3Path = path.join(dir, `${cleanTitle}-${clipId.slice(0, 8)}.mp3`);

    // 检查本地是否已有有效的 mp3 或 m4a
    if (fs.existsSync(mp3Path) && fs.statSync(mp3Path).size > 1024) {
      return mp3Path;
    }
    if (fs.existsSync(m4aPath) && fs.statSync(m4aPath).size > 1024) {
      try {
        const header = fs.readFileSync(m4aPath).slice(4, 8).toString("utf8");
        if (header === "ftyp") return m4aPath;
      } catch (e) {}
    }

    this.log(`正在通过浏览器提取已解密音频流 (${clipId})...`);
    const songUrl = `https://suno.com/song/${clipId}`;
    await this.globalPage.goto(songUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await this.globalPage.waitForTimeout(3000);

    // 注入 MediaSource 管道监听器
    await this.globalPage.evaluate(() => {
      window.__audioChunks = [];
      if (window.MediaSource) {
        const origAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
        MediaSource.prototype.addSourceBuffer = function(mimeType) {
          const sb = origAddSourceBuffer.apply(this, arguments);
          const origAppend = sb.appendBuffer;
          sb.appendBuffer = function(buf) {
            if (buf) {
              const u8 = new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer, buf.byteOffset || 0, buf.byteLength);
              window.__audioChunks.push(Array.from(u8));
            }
            return origAppend.apply(this, arguments);
          };
          return sb;
        };
      }
    });

    // 触发播放
    await this.globalPage.evaluate(() => {
      const btn = document.querySelector('button[aria-label*="播放" i], button[aria-label*="Play" i]');
      if (btn) btn.click();
    });

    // 轮询等待音频分块缓冲完成
    let chunks = [];
    for (let i = 0; i < 15; i++) {
      await this.globalPage.waitForTimeout(1000);
      chunks = await this.globalPage.evaluate(() => window.__audioChunks || []);
      if (chunks.length >= 10) break;
    }

    if (!Array.isArray(chunks) || chunks.length === 0) {
      throw new Error("未能从播放器抓取到有效音频分块");
    }

    const merged = Buffer.concat(chunks.map(c => Buffer.from(c)));
    fs.writeFileSync(m4aPath, merged);
    this.log(`解密音频提取成功: ${m4aPath} (${merged.length} 字节)`);

    // 尝试转码为通用 MP3
    try {
      execSync(`ffmpeg.exe -y -i "${m4aPath}" -c:a libmp3lame -q:a 2 "${mp3Path}"`, { stdio: "ignore" });
      if (fs.existsSync(mp3Path) && fs.statSync(mp3Path).size > 1024) {
        this.log(`已成功转码为通用 MP3: ${mp3Path} (${fs.statSync(mp3Path).size} 字节)`);
        return mp3Path;
      }
    } catch (e) {
      this.log(`FFmpeg 转码略过: ${e.message}`);
    }

    return m4aPath;
  }

  /**
   * 下载音频文件到本地目录
   */
  async downloadAudioFile(clipId, destDir = null, title = "") {
    const dir = destDir || path.join(this.rootDir, "downloads");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const cleanTitle = (title || "suno-song").replace(/[\\/:*?"<>|]/g, "_").slice(0, 30);
    const m4aPath = path.join(dir, `${cleanTitle}-${clipId.slice(0, 8)}.m4a`);
    const mp3Path = path.join(dir, `${cleanTitle}-${clipId.slice(0, 8)}.mp3`);

    // 若本地已有 MP3 或有效 M4A，直接返回
    if (fs.existsSync(mp3Path) && fs.statSync(mp3Path).size > 1024) {
      return mp3Path;
    }
    if (fs.existsSync(m4aPath) && fs.statSync(m4aPath).size > 1024) {
      try {
        const header = fs.readFileSync(m4aPath).slice(4, 8).toString("utf8");
        if (header === "ftyp") return m4aPath;
      } catch (e) {}
    }

    // 优先通过浏览器抓取已解密真实音频流
    if (this.globalPage && typeof this.globalPage.evaluate === "function") {
      try {
        return await this.captureAudioFromPage(clipId, dir, title);
      } catch (err) {
        this.log(`浏览器提取音频失败 (${err.message})，尝试后备方案...`);
      }
    }

    // 后备：直接从 CloudFront 下载
    const cdnUrl = `https://d2lwuy8qc234o3.cloudfront.net/1/clip/${clipId}.m4a`;
    const res = await fetch(cdnUrl);
    if (!res.ok) {
      throw new Error(`CloudFront 下载失败 HTTP ${res.status}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    fs.writeFileSync(m4aPath, Buffer.from(arrayBuffer));
    this.log(`音频文件下载成功: ${m4aPath} (${fs.statSync(m4aPath).size} 字节)`);
    return m4aPath;
  }

  /**
   * UI 自动化后备实现：在页面中定位表单控件并触发生成
   */
  async generateViaUi(options) {
    const { prompt, tags, title, make_instrumental, is_custom } = options;
    this.log("正在执行 UI 交互生成流程...");

    // 1. 确保在创作页面
    const currentUrl = await this.globalPage.url();
    if (!currentUrl.includes("/create")) {
      await this.globalPage.goto(this.targetUrl, { timeout: 30000, waitUntil: "domcontentloaded" });
      await this.globalPage.waitForTimeout(3000);
    }

    // 2. 模式检测与表单填写
    const needsCustom = Boolean(tags || title || is_custom);
    if (needsCustom) {
      // 尝试点击“高级”Tab
      await this.globalPage.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('[role="tab"], button'));
        const advTab = tabs.find(t => (t.innerText || "").trim() === "高级" || (t.innerText || "").trim().includes("Custom"));
        if (advTab) advTab.click();
      });
      await this.globalPage.waitForTimeout(500);
    } else {
      // 确保在“简单”模式
      await this.globalPage.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('[role="tab"], button'));
        const simpleTab = tabs.find(t => (t.innerText || "").trim() === "简单" || (t.innerText || "").trim().includes("Simple"));
        if (simpleTab) simpleTab.click();
      });
      await this.globalPage.waitForTimeout(500);
    }

    // 3. 聚焦输入框并键入提示词
    try {
      await this.globalPage.click('textarea');
      await this.globalPage.waitForTimeout(200);
      await this.globalPage.keyboard.press("Control+A");
      await this.globalPage.keyboard.press("Backspace");
      await this.globalPage.waitForTimeout(100);
      await this.globalPage.keyboard.insertText(prompt || "");
      await this.globalPage.waitForTimeout(500);
    } catch (e) {
      this.log("按键输入降级为 DOM 赋值: " + e.message);
      await this.globalPage.evaluate((val) => {
        const ta = document.querySelector('textarea');
        if (ta) {
          ta.value = val;
          ta.dispatchEvent(new Event("input", { bubbles: true }));
          ta.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }, prompt || "");
    }

    // 4. 定位并点击“创建歌曲”按钮
    this.log("正在触发‘创建歌曲’按钮...");
    let clickSuccess = false;
    try {
      const btnInfo = await this.globalPage.evaluate(() => {
        const btn = document.querySelector('button[aria-label="创建歌曲"], button[aria-label*="创建" i], button[aria-label*="Create" i], button.hxc-btn-variant-aura');
        if (!btn) return null;
        const rect = btn.getBoundingClientRect();
        return {
          found: true,
          disabled: btn.disabled,
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2
        };
      });

      if (btnInfo && !btnInfo.disabled) {
        if (this.globalPage.mouse && typeof this.globalPage.mouse.click === "function") {
          await this.globalPage.mouse.click(btnInfo.x, btnInfo.y);
          clickSuccess = true;
        } else {
          await this.globalPage.click('button[aria-label="创建歌曲"], button.hxc-btn-variant-aura');
          clickSuccess = true;
        }
      }
    } catch (btnErr) {
      this.log("鼠标点击异常，尝试 DOM click: " + btnErr.message);
    }

    if (!clickSuccess) {
      clickSuccess = await this.globalPage.evaluate(() => {
        const btn = document.querySelector('button[aria-label="创建歌曲"], button[aria-label*="创建" i], button[aria-label*="Create" i], button.hxc-btn-variant-aura');
        if (btn && !btn.disabled) {
          btn.click();
          return true;
        }
        return false;
      });
    }

    if (!clickSuccess) {
      throw new Error("UI 自动化未能找到可点击的“创建歌曲”或“Create”按钮。");
    }

    this.log("已点击创建按钮，等待片段生成入库 (6秒)...");
    await this.globalPage.waitForTimeout(6000);

    // 5. 提取页面最新的歌曲信息
    let domClips = [];
    try {
      domClips = await this.globalPage.evaluate((meta) => {
        const anchors = Array.from(document.querySelectorAll('a[href*="/song/"]'));
        const results = [];
        const seen = new Set();
        for (const a of anchors) {
          const href = a.href;
          const id = href.split("/song/")[1];
          if (!id || seen.has(id)) continue;
          seen.add(id);

          const title = (a.innerText || a.textContent || "").trim();
          let parent = a;
          for (let i = 0; i < 4; i++) {
            if (parent.parentElement) parent = parent.parentElement;
          }
          const img = parent.querySelector("img");
          const timeEl = Array.from(parent.querySelectorAll("*")).find(el => /^\d+:\d+$/.test((el.innerText || "").trim()));

          const audioDirectUrl = `https://d2lwuy8qc234o3.cloudfront.net/1/clip/${id}.m4a`;
          results.push({
            id,
            title: title || "Generated Song",
            song_url: href,
            audio_url: audioDirectUrl,
            download_url: `/v1/suno/download/${id}`,
            image_url: img ? img.src : `https://cdn2.suno.ai/image_${id}.jpeg`,
            status: timeEl ? "complete" : "submitted",
            duration: timeEl ? timeEl.innerText.trim() : null,
            metadata: { prompt: meta.prompt, tags: meta.tags, type: "gen" }
          });
          if (results.length >= 2) break;
        }
        return results;
      }, { prompt: prompt || "", tags: tags || "" });
    } catch (extractErr) {
      this.log("DOM Clips 提取异常: " + extractErr.message);
    }

    if (Array.isArray(domClips) && domClips.length > 0) {
      this.log(`成功提取到最新创作片段: ${domClips.map(c => `[${c.title}](${c.id})`).join(", ")}`);
      return domClips;
    }

    return [{
      id: "suno-clip-" + Date.now().toString(36),
      title: title || "Generated Song",
      status: "submitted",
      metadata: { prompt, tags, type: "gen" }
    }];
  }

  /**
   * 查询 Clips 状态与元数据（支持多 clipId 查询）
   */
  async getFeed(clipIds = []) {
    await this.ensureReady();
    const ids = Array.isArray(clipIds)
      ? clipIds.filter(Boolean)
      : String(clipIds || "").split(",").map(s => s.trim()).filter(Boolean);

    const result = await this.globalPage.evaluate(async (queryIds) => {
      let token = null;
      try {
        if (window.Clerk && window.Clerk.session) {
          token = await window.Clerk.session.getToken();
        }
      } catch (e) {}

      const headers = token ? { "Authorization": `Bearer ${token}` } : {};
      const qs = queryIds.length > 0 ? `?ids=${encodeURIComponent(queryIds.join(","))}` : "";
      const candidates = [
        `https://studio-api.prod.suno.com/api/feed/${qs}`,
        `https://studio-api.suno.ai/api/feed/${qs}`,
        `/api/feed/${qs}`
      ];

      for (const endpoint of candidates) {
        try {
          const res = await fetch(endpoint, { headers, credentials: "include" });
          if (res.ok) {
            const data = await res.json();
            return { success: true, data };
          }
        } catch (e) {}
      }
      return { success: false, error: "Feed endpoint unreachable" };
    }, ids);

    if (result && result.success && Array.isArray(result.data)) {
      return result.data;
    }
    return [];
  }

  async getClipsFromDom(clipIds = []) {
    try {
      return await this.globalPage.evaluate((ids) => {
        const results = [];
        for (const id of ids) {
          const a = document.querySelector(`a[href*="/song/${id}"]`);
          if (!a) continue;
          let curr = a;
          for (let i = 0; i < 6; i++) {
            if (curr.parentElement) curr = curr.parentElement;
          }
          const timeEl = Array.from(curr.querySelectorAll("*")).find(el => /^\d+:\d+$/.test((el.innerText || "").trim()));
          const img = curr.querySelector("img");
          const cleanTitle = (a.innerText || a.textContent || "").trim() || "Generated Song";
          const audioDirectUrl = `https://d2lwuy8qc234o3.cloudfront.net/1/clip/${id}.m4a`;
          results.push({
            id,
            title: cleanTitle,
            song_url: a.href,
            audio_url: audioDirectUrl,
            download_url: `/v1/suno/download/${id}`,
            image_url: img ? img.src : `https://cdn2.suno.ai/image_${id}.jpeg`,
            status: timeEl ? "complete" : "submitted",
            duration: timeEl ? timeEl.innerText.trim() : null
          });
        }
        return results;
      }, clipIds);
    } catch (e) {
      return [];
    }
  }

  /**
   * 轮询查询直到指定 Clips 渲染完成或超时
   */
  async pollUntilReady(clipIds, timeoutMs = 120000) {
    const startTime = Date.now();
    let resultList = null;

    while (Date.now() - startTime < timeoutMs) {
      await this.globalPage.waitForTimeout(3000);
      const list = await this.getFeed(clipIds);
      if (Array.isArray(list) && list.length > 0) {
        const allDone = list.every(item => item.status === "complete" || item.status === "error" || (item.audio_url && item.status === "streaming"));
        if (allDone) {
          this.log(`所有 Clips 渲染完成！(数量: ${list.length})`);
          resultList = list;
          break;
        }
      }

      // DOM 辅助检测渲染进度
      const domStatus = await this.getClipsFromDom(clipIds);
      if (domStatus.length >= clipIds.length && domStatus.length > 0) {
        const allDone = domStatus.every(d => d.duration || d.status === "complete");
        if (allDone) {
          this.log(`DOM 检测到所有片段渲染完成！(数量: ${domStatus.length})`);
          resultList = domStatus;
          break;
        }
      }
    }

    if (!resultList) {
      this.log(`轮询等待超时 (${timeoutMs}ms)，返回当前最新状态。`);
      const feed = await this.getFeed(clipIds);
      if (Array.isArray(feed) && feed.length > 0) resultList = feed;
      else {
        const domFinal = await this.getClipsFromDom(clipIds);
        if (Array.isArray(domFinal) && domFinal.length > 0) resultList = domFinal;
        else resultList = clipIds.map(id => ({ id, status: "submitted" }));
      }
    }

    return resultList.map(item => {
      const id = item.id;
      const cdnAudio = id ? `https://d2lwuy8qc234o3.cloudfront.net/1/clip/${id}.m4a` : "";
      return {
        ...item,
        song_url: item.song_url || (id ? `https://suno.com/song/${id}` : null),
        download_url: item.download_url || (id ? `/v1/suno/download/${id}` : null),
        audio_url: (item.audio_url && !item.audio_url.includes("/song/")) ? item.audio_url : cdnAudio
      };
    });
  }

  /**
   * 查询当前账号剩余额度与套餐信息
   */
  async getCredits() {
    await this.ensureReady();
    const result = await this.globalPage.evaluate(async () => {
      let token = null;
      try {
        if (window.Clerk && window.Clerk.session) {
          token = await window.Clerk.session.getToken();
        }
      } catch (e) {}

      const headers = token ? { "Authorization": `Bearer ${token}` } : {};
      const candidates = [
        "https://studio-api.prod.suno.com/api/billing/info/",
        "https://studio-api.suno.ai/api/billing/info/",
        "/api/billing/info/"
      ];

      for (const endpoint of candidates) {
        try {
          const res = await fetch(endpoint, { headers, credentials: "include" });
          if (res.ok) {
            const data = await res.json();
            return { success: true, data };
          }
        } catch (e) {}
      }
      return { success: false, error: "Billing info endpoint unreachable" };
    });

    if (result && result.success && result.data) {
      return result.data;
    }
    return {
      total_credits_left: null,
      message: "未能获取到额度信息，请确认 Suno 已登录"
    };
  }

  getModels() {
    return [
      { id: "suno-v4", object: "model", created: 1715367049, owned_by: "suno" },
      { id: "suno-v3.5", object: "model", created: 1715367049, owned_by: "suno" },
      { id: "suno-v3", object: "model", created: 1715367049, owned_by: "suno" },
      { id: "chirp-v4", object: "model", created: 1715367049, owned_by: "suno" },
      { id: "chirp-v3-5", object: "model", created: 1715367049, owned_by: "suno" }
    ];
  }

  async close() {
    try {
      if (this.globalPage && typeof this.globalPage.close === "function") {
        await this.globalPage.close();
      }
    } catch (err) {
      this.log("页面关闭提示: " + err.message);
    }
  }
}
