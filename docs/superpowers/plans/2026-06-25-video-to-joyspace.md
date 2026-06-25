# Video To JoySpace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the proven `video-to-feishu` pipeline into a `video-to-joyspace` skill whose `write` step produces a local `final_markdown.md` (image/video upload commented out), verifiable end-to-end on a local desktop video.

**Architecture:** A single Node.js CLI script `scripts/video_to_joyspace.js` with `--step`-driven steps (check → download → transcribe → write-paragraphs → polish → frames → write). The script is a surgical port of `video-to-feishu/scripts/video_to_feishu.js`: retain download/transcribe/frames verbatim, strip all Feishu API/token/media-upload/bitable code, and rewrite `stepWrite` to assemble Markdown locally. A small local-file path is added to `download` so a desktop `.mp4` can drive verification.

**Tech Stack:** Node.js (`child_process`, `fs`, `path`, `stream`), `ffmpeg`, `whisper`/`faster-whisper`, `python3`, `yt-dlp`. Tests use `node:assert` in throwaway scripts (no framework).

## Global Constraints

- Skill name: `video-to-joyspace` (directory already exists with SKILL.md, references/joyspace_api.md, agents/openai.yaml, scripts/douyin_video_parser.py already written/copied).
- The script must NOT contain any Feishu credential handling, token fetching, block writing, media upload, owner transfer, or bitable logging.
- JoySpace is never contacted by the script. The `write` step writes `$WORK/final_markdown.md` only.
- The original-video upload (`FILE`) and per-paragraph screenshot upload (`IMG`) call sites must remain as commented blocks preserving the file paths (for future restoration), not deleted silently.
- Screenshots are still generated and kept in `$WORK/frames/`.
- Match the existing feishu script's style: same header-comment density, `getArg`/`hasFlag` arg parsing, `loadDotEnv`, workdir auto-detection, `console.log` step banners.
- Verification target video: `/Users/lizhenhua.81/Desktop/主动添加好友.mp4` (local file, 66 MB).
- Today's date for any timestamps in commits/messages: 2026-06-25.

---

### Task 1: Scaffold the script and strip Feishu-specific code

**Files:**
- Create: `video-to-joyspace/scripts/video_to_joyspace.js` (from a copy of `video-to-feishu/scripts/video_to_feishu.js`)
- Reference: `video-to-feishu/scripts/video_to_feishu.js`

**Interfaces:**
- Consumes: the existing feishu script as the source of proven logic.
- Produces: a runnable `video_to_joyspace.js` that still contains Feishu call sites (removed in later tasks) but compiles and passes `node -c`. Later tasks depend on this file existing.

- [ ] **Step 1: Copy the feishu script as the starting point**

```bash
cp video-to-feishu/scripts/video_to_feishu.js video-to-joyspace/scripts/video_to_joyspace.js
```

- [ ] **Step 2: Update the file header comment**

Replace the header block (lines 2–44 in the feishu original) so it describes JoySpace and drops Feishu credential docs. Use this exact replacement for the `/** ... */` block at the top:

```js
/**
 * 多平台视频 → JoySpace 文档 核心脚本
 *
 * 移植自 video-to_feishu.js，移除飞书 API / 凭证 / 媒体上传 / 多维表格逻辑。
 * write 步骤改为组装 final_markdown.md（图片/视频上传已注释，JoySpace 暂不支持）。
 * 由主 AI 读取 final_markdown.md 后通过 MCP create_doc_routing 创建 JoySpace 文档。
 *
 * 整体流程：
 *   check → download → transcribe → analyze(AI) → frames → write
 *
 * 用法（分步，必须用同一 --work-dir 共享中间文件）：
 *   WORK=/tmp/video_to_joyspace_task
 *   node scripts/video_to_joyspace.js --step check
 *   node scripts/video_to_joyspace.js --step download   --url "<链接或本地文件路径>" --work-dir $WORK
 *   node scripts/video_to_joyspace.js --step transcribe                            --work-dir $WORK
 *   node scripts/video_to_joyspace.js --step analyze                               --work-dir $WORK
 *   node scripts/video_to_joyspace.js --step write-paragraphs --file $WORK/paragraphs.json --work-dir $WORK
 *   node scripts/video_to_joyspace.js --step frames                                --work-dir $WORK
 *   node scripts/video_to_joyspace.js --step write      --title "标题"             --work-dir $WORK
 *
 * 可选配置：
 *   OPENAI_API_KEY           本地 whisper 不可用时的备用 Whisper API
 *   YTDLP_COOKIES            yt-dlp cookies.txt 路径
 *   YTDLP_COOKIES_FROM_BROWSER  从浏览器读取 cookies，例如 chrome
 *   TRANSCRIBE_CHUNK_SEC     转录分段阈值（秒，默认 600）
 */
```

- [ ] **Step 3: Remove Feishu credential config constants**

Delete these four constant definitions (feishu original lines 87–93):

```js
const APP_ID        = getArg('--app-id')       || process.env.FEISHU_APP_ID     || dotenv.FEISHU_APP_ID;
const APP_SECRET    = getArg('--app-secret')   || process.env.FEISHU_APP_SECRET || dotenv.FEISHU_APP_SECRET;
const FEISHU_MEMBER_OPENID = getArg('--member-openid')
  || process.env.FEISHU_MEMBER_OPENID
  || process.env.FEISHU_MEMBER_ID
  || dotenv.FEISHU_MEMBER_OPENID
  || dotenv.FEISHU_MEMBER_ID;
```

Keep `OPENAI_KEY`, `YTDLP_COOKIES`, `YTDLP_COOKIES_FROM_BROWSER`, `BROWSER_UA`, `YTDLP_UA` and everything below them unchanged.

- [ ] **Step 4: Remove every Feishu-specific function definition**

Delete the complete bodies of these functions (find each by its `function`/`async function` line and delete through its closing brace):

- `getFeishuToken`
- `fetchWithRetry`
- `checkFeishuCredentials`
- `writeMarkdown`
- `parseBold`
- `addBlock`
- `P`, `H1`, `H2`, `BR` (the block-helper variants that call addBlock)
- `writeSemanticSection`
- `multipartBody`
- `uploadMediaDirect`
- `uploadMediaInParts`
- `uploadMediaToBlock`
- `IMG`
- `FILE`
- `transferDocOwner`
- `stepLogToBitable`

After deletion, verify no Feishu references remain in a function body:

```bash
cd video-to-joyspace/scripts
grep -nE "getFeishuToken|fetchWithRetry|checkFeishuCredentials|writeMarkdown|parseBold|addBlock|writeSemanticSection|multipartBody|uploadMedia|transferDocOwner|stepLogToBitable|\bIMG\(|\bFILE\(|\\bP\(|\\bH1\(|\\bH2\(|\\bBR\(" video_to_joyspace.js
```

Expected: output is empty (every match was inside a deleted function body). If any match appears in `stepWrite`, `stepCheck`, or `main` (the call sites), leave those for Tasks 2–4 — they will be rewritten/removed there. Note any stray references to fix in those tasks.

- [ ] **Step 5: Confirm the script still parses**

Run: `node -c video_to_joyspace.js`
Expected: no syntax errors. (It will not run end-to-end yet — `stepWrite`/`stepCheck`/`main` still reference removed functions, fixed in Tasks 2–4. `node -c` only checks syntax.)

- [ ] **Step 6: Commit**

```bash
git add video-to-joyspace/scripts/video_to_joyspace.js
git commit -m "Scaffold video-to-joyspace script from feishu, strip Feishu functions"
```

---

### Task 2: Add local-file detection and download

**Files:**
- Modify: `video-to-joyspace/scripts/video_to_joyspace.js` (`detectPlatform` ~line 263, `stepDownload` ~line 1054)
- Test: `video-to-joyspace/scripts/test_detect_local.js` (throwaway, not committed)

**Interfaces:**
- Consumes: `extractFirstUrl`, `fs`, `path` (already imported/defined in the script).
- Produces: `detectPlatform(input)` returns `{ key: 'local', label: '本地文件', url: <abs path> }` for an existing local file; `stepDownload` copies a local file to `$WORK/video.mp4` and writes `video_meta.json` with `platform: 'local'`.

- [ ] **Step 1: Write the failing test for local-file detection**

Create `video-to-joyspace/scripts/test_detect_local.js`:

```js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Load the script's functions by requiring it as a module is not possible (it runs main()).
// Instead, re-implement a thin test by sourcing detectPlatform via eval of the function source.
const src = fs.readFileSync(path.join(__dirname, 'video_to_joyspace.js'), 'utf-8');
const m = src.match(/function detectPlatform\(input\) \{[\s\S]*?\n\}/);
assert(m, 'detectPlatform not found in script');
const extractFn = src.match(/function extractFirstUrl[\s\S]*?\n\}/);
const sandbox = { fs, path };
const wrapped = `${extractFn ? extractFn[0] : ''}${m[0]}`;
eval(wrapped); // defines detectPlatform (and extractFirstUrl) in this scope

// local file
const tmp = path.join(os.tmpdir(), 'vtj_test_local.mp4');
fs.writeFileSync(tmp, 'x');
const r1 = detectPlatform(tmp);
assert.strictEqual(r1.key, 'local', `expected local, got ${r1.key}`);
assert.strictEqual(r1.url, tmp);

// platform URL must NOT be treated as local
const r2 = detectPlatform('https://v.douyin.com/abc123/');
assert.strictEqual(r2.key, 'douyin', `expected douyin, got ${r2.key}`);

fs.unlinkSync(tmp);
console.log('OK: detectPlatform local + douyin');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node video-to-joyspace/scripts/test_detect_local.js`
Expected: FAIL — `detectPlatform` returns `{ key: 'other' }` for the local file (current feishu logic has no `local` branch), so `assert.strictEqual(r1.key, 'local')` throws.

- [ ] **Step 3: Add the `local` branch to `detectPlatform`**

In `detectPlatform`, insert a local-file check **before** the final `return { key: 'other', ... }` (so platform regexes are evaluated first for URLs, then local path, then `other`). Replace the trailing `return { key: 'other', label: '其他', url };` with:

```js
  // 本地文件：URL 不可能是真实路径，放在平台正则之后、other 之前
  try {
    if (fs.existsSync(url) && fs.statSync(url).isFile()) {
      return { key: 'local', label: '本地文件', url };
    }
  } catch {}
  return { key: 'other', label: '其他', url };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node video-to-joyspace/scripts/test_detect_local.js`
Expected: `OK: detectPlatform local + douyin`

- [ ] **Step 5: Add the `local` branch to `stepDownload`**

In `stepDownload`, insert a local-file branch immediately after `const platform = detectPlatform(url);` and before the `if (platform.key === 'douyin')` check:

```js
  if (platform.key === 'local') {
    const srcPath = path.resolve(platform.url);
    if (!fs.existsSync(srcPath)) {
      console.error('❌ 本地文件不存在:', srcPath);
      process.exit(1);
    }
    fs.copyFileSync(srcPath, VIDEO_PATH);
    // 推断标题（文件名去扩展名）
    const baseTitle = path.basename(srcPath, path.extname(srcPath));
    fs.writeFileSync(
      path.join(WORK_DIR, 'video_meta.json'),
      JSON.stringify({
        platform: '本地文件',
        platform_key: 'local',
        title: baseTitle,
        author: '',
        duration: '',
        url: srcPath,
      }, null, 2),
      'utf-8'
    );
    console.log(`  ✅ 已复制本地视频到工作目录: ${VIDEO_PATH}`);
    return VIDEO_PATH;
  }
```

> Note: `VIDEO_PATH` and `WORK_DIR` are existing constants in the script (defined near the workdir logic, ~line 160+). If `VIDEO_PATH` is named differently, use whatever constant the douyin/yt-dlp branches write to — match the surrounding code. Verify with: `grep -n "VIDEO_PATH\s*=" video-to-joyspace/scripts/video_to_joyspace.js`.

- [ ] **Step 6: Syntax check and clean up the test**

Run: `node -c video-to-joyspace/scripts/video_to_joyspace.js`
Expected: no errors.

Delete the throwaway test (do not commit it):

```bash
rm video-to-joyspace/scripts/test_detect_local.js
```

- [ ] **Step 7: Commit**

```bash
git add video-to-joyspace/scripts/video_to_joyspace.js
git commit -m "Add local-file detection and download to video-to-joyspace"
```

---

### Task 3: Rewrite `stepWrite` to assemble `final_markdown.md`

**Files:**
- Modify: `video-to-joyspace/scripts/video_to_joyspace.js` (`stepWrite` ~line 2092)
- Test: `video-to-joyspace/scripts/test_build_markdown.js` (throwaway, not committed)

**Interfaces:**
- Consumes: `paragraphs.json` shape `{ start, end, text, summary, screenshot_at, frame_path }`; `resolveVideoPath(paragraphsPath)` (retained helper) returns the `video.mp4` path.
- Produces: `stepWrite(paragraphsPath, title)` writes `$WORK/final_markdown.md` and returns its path. Pure helper `buildMarkdown(paragraphs, title, sourceVideoPath)` returns the Markdown string (testable in isolation).

- [ ] **Step 1: Write the failing test for `buildMarkdown`**

Create `video-to-joyspace/scripts/test_build_markdown.js`:

```js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'video_to_joyspace.js'), 'utf-8');
const m = src.match(/function buildMarkdown\(paragraphs, title, sourceVideoPath\) \{[\s\S]*?\n\}/);
assert(m, 'buildMarkdown not found — implement it first');
eval(m[0]);

const paragraphs = [
  { summary: '第一段摘要', text: '第一段正文。', frame_path: '/tmp/frames/1.jpg' },
  { summary: '', text: '第二段正文，无摘要。', frame_path: null },
];
const md = buildMarkdown(paragraphs, '我的标题', '/tmp/video.mp4');

// H1 标题
assert(md.startsWith('# 我的标题\n\n'), 'missing H1 title');

// 第一段：H2 用 summary
assert(md.includes('## 第一段摘要\n\n第一段正文。\n\n'), 'missing section 1');

// 第二段：summary 为空时回退到 "段落 N"
assert(md.includes('## 段落 2\n\n第二段正文，无摘要。\n\n'), 'missing section 2 with fallback title');

// 原视频上传注释（保留路径）
assert(md.includes('JoySpace 暂不支持上传本地视频'), 'missing video upload comment');
assert(md.includes('/tmp/video.mp4'), 'missing video path in comment');

// 截图上传注释（保留路径）
assert(md.includes('JoySpace 暂不支持上传图片'), 'missing image upload comment');
assert(md.includes('/tmp/frames/1.jpg'), 'missing frame path in comment');

console.log('OK: buildMarkdown');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node video-to-joyspace/scripts/test_build_markdown.js`
Expected: FAIL — `buildMarkdown not found — implement it first`.

- [ ] **Step 3: Implement `buildMarkdown` (pure function)**

Add this function just above `stepWrite`:

```js
/**
 * 将 paragraphs.json 组装为 JoySpace 文档的 Markdown 文本。
 * 图片/视频上传已注释（JoySpace 暂不支持），但保留文件路径以便未来恢复。
 */
function buildMarkdown(paragraphs, title, sourceVideoPath) {
  let md = `# ${title}\n\n`;

  // ── 原视频上传（文档开头）— JoySpace 暂不支持，注释保留路径 ──
  md += `<!-- JoySpace 暂不支持上传本地视频到文档 — 原视频路径: ${sourceVideoPath || '(未找到)'} -->\n\n`;

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    const sectionTitle = (p.summary && p.summary.trim())
      || (p.title && p.title.trim())
      || `段落 ${i + 1}`;
    const sectionBody = (p.text || p.content || '').trim();
    md += `## ${sectionTitle}\n\n${sectionBody}\n\n`;

    // ── 截图上传 — JoySpace 暂不支持，注释保留路径 ──
    if (p.frame_path) {
      md += `<!-- JoySpace 暂不支持上传图片到文档 — 截图: ${p.frame_path} -->\n\n`;
    }
  }
  return md;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node video-to-joyspace/scripts/test_build_markdown.js`
Expected: `OK: buildMarkdown`

- [ ] **Step 5: Rewrite `stepWrite` to use it**

Replace the entire body of `stepWrite(paragraphsPath, title)` with:

```js
async function stepWrite(paragraphsPath, title) {
  console.log('\n📝 [Step 5] 组装 final_markdown.md ...');

  const paragraphs = JSON.parse(fs.readFileSync(paragraphsPath, 'utf-8'));
  console.log(`  段落数：${paragraphs.length}，含截图：${paragraphs.filter(p => p.frame_path).length} 张`);

  const sourceVideoPath = resolveVideoPath(paragraphsPath);
  const md = buildMarkdown(paragraphs, title, sourceVideoPath);
  const outPath = path.join(WORK_DIR, 'final_markdown.md');
  fs.writeFileSync(outPath, md, 'utf-8');

  console.log(`  ✅ 已生成: ${outPath}`);
  console.log('  ℹ️  下一步：主 AI 读取该文件，调用 MCP create_doc_routing 创建 JoySpace 文档');
  return outPath;
}
```

- [ ] **Step 6: Remove the `log` step and bitable calls from `main`**

In `main()`:
- Delete the `else if (STEP === 'log') { ... }` branch entirely.
- In the `IS_FULL || STEP === 'all'` branch, the `const docUrl = await stepWrite(...)` line and `console.log('\n✅ 完整流程结束！', docUrl)` may stay (stepWrite now returns the markdown path). Remove any `await stepLogToBitable(...)` call if present in that branch.
- In the step-`write` branch, `await stepWrite(pPath, DOC_TITLE)` stays (returns the path).

- [ ] **Step 7: Update the help text (the final `else` branch in `main`)**

Replace the help banner and env-var list so they describe JoySpace and omit Feishu/bitable vars. Change the version line to:

```js
    console.log(`
多平台视频 → JoySpace 文档（抖音/快手内置解析 + yt-dlp 多平台下载；写入本地 final_markdown.md）

环境检测（推荐先运行）：
  node scripts/video_to_joyspace.js --step check

流程（按顺序，--work-dir 共享同一目录）：
  WORK=/tmp/video_to_joyspace_task

  1. 下载视频（支持本地文件路径或平台链接/分享文案）
     node scripts/video_to_joyspace.js --step download --url "<链接或本地路径>" --work-dir $WORK

  2. 本地 Whisper 转录
     node scripts/video_to_joyspace.js --step transcribe --work-dir $WORK

  3. AI 语义分析（主 AI 读 segments.json 后写入 paragraphs.json）
     node scripts/video_to_joyspace.js --step analyze --work-dir $WORK
     node scripts/video_to_joyspace.js --step write-paragraphs --file $WORK/paragraphs.json --work-dir $WORK

  4. 精准截帧
     node scripts/video_to_joyspace.js --step frames --work-dir $WORK

  4.5 [可选] AI 文字优化
     node scripts/video_to_joyspace.js --step polish --work-dir $WORK

  5. 组装 final_markdown.md（脚本到此为止；由主 AI 调 MCP create_doc_routing 创建 JoySpace 文档）
     node scripts/video_to_joyspace.js --step write --title "视频标题" --work-dir $WORK

环境变量：
  OPENAI_API_KEY            本地 whisper 不可用时的备用 Whisper API
  YTDLP_COOKIES             yt-dlp cookies.txt 路径
  YTDLP_COOKIES_FROM_BROWSER  从浏览器读取 cookies，例如 chrome
  TRANSCRIBE_CHUNK_SEC      转录分段阈值（秒，默认 600）
  CLEAN_OLD_WORK_DIRS       新任务启动时是否清理旧 /tmp/douyin_task_* 目录（默认 1）
    `);
```

- [ ] **Step 8: Syntax check, clean up test, commit**

Run: `node -c video-to-joyspace/scripts/video_to_joyspace.js` → no errors.
Run: `node video-to-joyspace/scripts/test_build_markdown.js` → `OK: buildMarkdown`.

```bash
rm video-to-joyspace/scripts/test_build_markdown.js
git add video-to-joyspace/scripts/video_to_joyspace.js
git commit -m "Rewrite stepWrite to assemble final_markdown.md; drop log/bitable steps"
```

---

### Task 4: Trim `stepCheck` to drop Feishu credentials and bitable

**Files:**
- Modify: `video-to-joyspace/scripts/video_to_joyspace.js` (`stepCheck` ~line 958)

**Interfaces:**
- Consumes: `checkDependencies`, `OPENAI_KEY`, `TRANSCRIBE_CHUNK_SEC`, `dotenv` (all retained).
- Produces: `stepCheck` reports dependency status, OpenAI config, and chunk-sec only — no Feishu credential or bitable sections.

- [ ] **Step 1: Remove the Feishu credential status block**

Delete the entire `// 检查凭证状态` block (feishu original lines 962–982), which prints `FEISHU_APP_ID` / `APP_SECRET` / `FEISHU_MEMBER_OPENID` status. It starts at `console.log('\n── 飞书凭证状态 ──');` and ends before `console.log('\n── OpenAI 配置状态 ──');`.

- [ ] **Step 2: Remove the bitable config block**

Delete the entire `// 检查多维表格配置` block (feishu original lines 991–1011), starting at `const bitableToken = ...` / `console.log('\n── 多维表格配置（可选） ──');` and ending before `// 显示当前分段时长配置`.

- [ ] **Step 3: Keep the OpenAI and chunk-sec sections unchanged**

Do not modify the `── OpenAI 配置状态 ──` block (984–989) or the `── 分段时长配置 ──` block (1013–1046). These are credential-free and correct as-is.

- [ ] **Step 4: Verify no Feishu/bitable references remain anywhere in the file**

Run:
```bash
grep -nE "FEISHU|APP_ID|APP_SECRET|MEMBER_OPENID|BITABLE|bitable|飞书|多维表格|getFeishuToken|transferDocOwner" video-to-joyspace/scripts/video_to_joyspace.js
```
Expected: empty output. (If matches remain, they are leftover references — delete those lines.)

- [ ] **Step 5: Syntax check and commit**

Run: `node -c video-to-joyspace/scripts/video_to_joyspace.js` → no errors.

```bash
git add video-to-joyspace/scripts/video_to_joyspace.js
git commit -m "Trim stepCheck: drop Feishu credentials and bitable sections"
```

---

### Task 5: End-to-end verification on the local desktop video

**Files:**
- No file changes (verification only). The pipeline writes to `/tmp/video_to_joyspace_task`.

**Interfaces:**
- Consumes: the completed `video_to_joyspace.js` and the local video `/Users/lizhenhua.81/Desktop/主动添加好友.mp4`.
- Produces: evidence that the full pipeline runs and `final_markdown.md` has the expected structure.

- [ ] **Step 1: Run environment check**

```bash
cd /Users/lizhenhua.81/GithubStudy/my-skills/video-to-joyspace
node scripts/video_to_joyspace.js --step check
```
Expected: dependency status printed; no Feishu/bitable sections; exits 0 (or pauses for chunk-sec config if unset — if it pauses, re-run with `--transcribe-chunk-sec 600`).

- [ ] **Step 2: Download (local file copy)**

```bash
WORK=/tmp/video_to_joyspace_task
node scripts/video_to_joyspace.js --step download \
  --url "/Users/lizhenhua.81/Desktop/主动添加好友.mp4" \
  --work-dir "$WORK" --no-cleanup-old
```
Expected: `✅ 已复制本地视频到工作目录: /tmp/video_to_joyspace_task/video.mp4`; `video_meta.json` written with `platform_key: 'local'`.
Verify: `cat "$WORK/video_meta.json"` shows `"platform_key": "local"`.

- [ ] **Step 3: Transcribe**

```bash
node scripts/video_to_joyspace.js --step transcribe --work-dir "$WORK" --no-cleanup-old
```
Expected: `segments.json` produced in `$WORK`. (Local whisper; may take several minutes for 66 MB. If whisper missing, the script prints install guidance — install `faster-whisper`/`whisper` and rerun.)

- [ ] **Step 4: AI semantic analysis (manual gate)**

```bash
node scripts/video_to_joyspace.js --step analyze --work-dir "$WORK" --no-cleanup-old
```
Expected: prints transcript; pauses for the main AI to write `paragraphs.json`. As the executing agent, read the printed transcript, create 5–10 semantic paragraphs following the SKILL.md `paragraphs.json` schema, write `$WORK/paragraphs.json`, then run:
```bash
node scripts/video_to_joyspace.js --step write-paragraphs --file "$WORK/paragraphs.json" --work-dir "$WORK" --no-cleanup-old
```

- [ ] **Step 5: Frames**

```bash
node scripts/video_to_joyspace.js --step frames --work-dir "$WORK" --no-cleanup-old
```
Expected: `$WORK/frames/*.jpg` created, one per paragraph that has `screenshot_at`.

- [ ] **Step 6: Write — assemble final_markdown.md**

```bash
node scripts/video_to_joyspace.js --step write --title "主动添加好友" --work-dir "$WORK" --no-cleanup-old
```
Expected: `✅ 已生成: /tmp/video_to_joyspace_task/final_markdown.md`.

- [ ] **Step 7: Assert the output structure**

Run this verification block:
```bash
MD=/tmp/video_to_joyspace_task/final_markdown.md
test -f "$MD" && echo "PASS: file exists" || echo "FAIL: file missing"
head -1 "$MD" | grep -q "^# 主动添加好友$" && echo "PASS: H1 title" || echo "FAIL: H1 title"
grep -q "## " "$MD" && echo "PASS: has H2 sections" || echo "FAIL: no H2 sections"
grep -q "JoySpace 暂不支持上传本地视频" "$MD" && echo "PASS: video upload commented" || echo "FAIL: video comment missing"
grep -q "JoySpace 暂不支持上传图片" "$MD" && echo "PASS: image upload commented" || echo "FAIL: image comment missing"
grep -c "^## " "$MD"   # prints section count; expect 5-10
```
Expected: all `PASS`; section count 5–10.

- [ ] **Step 8: Report and (optional) create the live JoySpace doc**

Report the verification results (which steps passed, section count). Since the JoySpace MCP write path needs no credentials and was already verified working this session, optionally read `$WORK/final_markdown.md` and call MCP `create_doc_routing` with `title="主动添加好友"`, `team_id="root"`, `folder_id="root"`, `content=<file contents>`, then report `https://joyspace.jd.com/pages/{page_id}`. This is optional and not part of the script.

- [ ] **Step 9: Final commit (skill metadata if anything changed)**

If SKILL.md / references need touch-ups discovered during verification, commit them:
```bash
git add video-to-joyspace
git commit -m "Verify video-to-joyspace end-to-end on local video"
```
Otherwise no commit needed (script changes were committed in Tasks 1–4).
