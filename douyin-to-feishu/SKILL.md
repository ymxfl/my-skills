---
name: douyin-to-feishu
description: 将抖音视频转换为飞书文档。自动完成：视频下载（内置无水印解析，无需 yt-dlp）→ 本地 faster-whisper 转录（带时间戳）→ 主AI语义分析（读取转录文本，划分段落+决定截图时间点）→ 精准截帧 → [可选] AI文字优化（修正转录错误） → 内容写入飞书文档（截图与文案语义匹配交织穿插）→ 自动记录到飞书多维表格（转换日志）。支持依赖自检引导和飞书凭证缺失提示。触发词：抖音转飞书、douyin to feishu、视频转飞书文档、抖音视频提取文案。
---

# 抖音视频 → 飞书文档（v4.1）

## 整体流程

```
0. 依赖检测       → 检查 ffmpeg / python3 / faster-whisper 等工具，缺少时输出安装指引
1. 授权检测       → 检查飞书 App ID / Secret，缺少则输出设置引导（支持对话框输入）
2. 视频下载       → 内置 douyin_parser.py（无需 yt-dlp），三方案 Fallback，无水印
3. 本地转录       → ffmpeg 提取音频 → 本地 faster-whisper（small 模型，中文）
                    优先用本地，无本地 faster-whisper 时回退到 whisper CLI，再回退 OpenAI Whisper API
                    输出：segments.json（每句话含 start/end/text）
4. AI 语义分析    → 主 AI（当前会话的 AI）直接读取 segments.json 全文
                    · 按语义合并为有意义的段落
                    · 为每段决定最佳截图时间点
                    · 提炼每段摘要（10~20 字）
                    · 主 AI 直接写入 paragraphs.json 文件（推荐），再执行 write-paragraphs --file
                    ⚠️ 此步骤不调用任何外部 LLM API
5. 精准截帧       → 只截 AI 指定的时间点，不生成候选帧池
5.5 [可选] AI 文字优化 → 主 AI 修正 Whisper 转录错误（同音字、专有名词、错别字）
6. 写入飞书       → 段落标题（摘要）+ 正文 + 对应截图（不再追加末尾总结章节）
7. 记录到多维表格 → 自动写入飞书多维表格（需配置 BITABLE_APP_TOKEN / BITABLE_TABLE_ID）
                    字段：视频标题、原视频地址、原作者、视频平台、视频类型、
                          视频时长、飞书文档地址、段落数、截图数、转录方式、
                          转换状态、转换时间、备注
```

---

## STEP 0：依赖检测（首次使用必须运行）

```bash
node scripts/douyin_to_feishu.js --step check
```

脚本会自动检测：
- `ffmpeg`（音频提取、截帧）
- `python3` + `requests` 库（视频下载）
- `faster-whisper`（本地转录，推荐）
- 飞书凭证状态（FEISHU_APP_ID / FEISHU_APP_SECRET）
- OpenAI API Key 状态（可选，本地转录不可用时备用）

### 缺少依赖时

脚本会输出精确的安装命令，例如：

| 缺少的工具 | 安装命令 |
|---|---|
| ffmpeg | `brew install ffmpeg`（macOS）/ `sudo apt install ffmpeg`（Linux）|
| python3 | `brew install python3` |
| requests | `pip3 install requests` |
| faster-whisper | `pip3 install faster-whisper` |

---

## STEP 1：飞书授权检测

**运行授权检测脚本**：

```bash
node scripts/check_feishu_auth.js
```

### 已配置凭证时
输出 `✅ 飞书授权有效`，直接进入下一步。

### 未配置凭证时

脚本会输出详细引导。支持以下方式配置：

**方式 A：在对话框直接告知 AI（最简单）**
直接在对话中说：
> 我的飞书 App ID 是 `cli_xxx`，App Secret 是 `yyy`

**方式 B：设置环境变量**
```bash
export FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
export FEISHU_APP_SECRET=your_app_secret
```

**方式 C：写入 .env 文件（永久）**
可将 `.env` 放在 **skill 根目录**（与 `SKILL.md` 同级）或 shell 当前工作目录；两处都存在时，**工作目录中的变量覆盖 skill 根目录**。
```
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=your_app_secret
```

**方式 D：命令行参数**
在每次调用脚本时追加：`--app-id cli_xxx --app-secret yyy`

---

**还没有飞书应用？按以下步骤创建：**

**第一步：创建飞书自建应用**
打开 → https://open.feishu.cn/app
点击「创建企业自建应用」，填写应用名称（例如"视频文档助手"）

**第二步：获取 App ID 和 App Secret**
进入应用 →「凭证与基础信息」→ 复制：
- `App ID`（格式：`cli_xxxxxxxxxxxxxxxx`）
- `App Secret`

**第三步：开通必要权限**
进入「权限管理」→ 搜索并开启以下权限：
| 权限标识 | 用途 |
|---|---|
| `docx:document` | 创建和读写飞书文档 |
| `docx:document:readonly` | 读取文档内容 |
| `drive:drive` | 上传图片到云空间 |
| `drive:file` | 管理文件 |
| `bitable:record` | 读写多维表格记录（记录转换日志时需要） |
| `bitable:record:readonly` | 读取多维表格记录 |

**第四步：发布应用**
进入「版本管理与发布」→ 创建版本 → 申请发布（企业管理员审核）。
> 个人测试可使用开发者调试模式，无需审核。

---

## 多维表格转换记录（可选）

每次完成视频 → 飞书文档后，脚本可自动将转换结果写入飞书多维表格，形成转换日志。

**已知问题与自动处理：**

| 问题 | 原因 | 处理方式 |
|---|---|---|
| 多维表格首次打开有若干空行 | 飞书新建表格自动生成默认空行（通常 3~10 行） | **自动处理**：每次 `--step log` 写入前，脚本会检测全字段为 null 的行并批量删除 |
| 同一视频重复记录 | 多次执行 `--step write` 或 `--step log` | **自动处理**：写入前按「视频标题 + 飞书文档地址」查重，重复时跳过并提示 |
| 数字字段写入了字符串 | 手动调用脚本时传参类型错误 | **自动处理**：`段落数`/`截图数` 写入时强制 `Number()` 转换 |

**配置方式：**

```bash
# 设置环境变量（推荐，写入 .env 文件长期有效）
export BITABLE_APP_TOKEN=OHIMb0cfuanrlWsh1CBcuC0nnrb    # 多维表格 app_token
export BITABLE_TABLE_ID=tbl8uVi7NtRE3Lv6                 # 数据表 ID
```

或在命令行中临时传入：

```bash
node scripts/douyin_to_feishu.js --step log \
  --bitable-token OHIMb0cfuanrlWsh1CBcuC0nnrb \
  --bitable-table tbl8uVi7NtRE3Lv6 \
  --doc-url "https://my.feishu.cn/docx/xxx" \
  --source-url "https://v.douyin.com/xxx" \
  --author "作者名" --platform 抖音 --video-type 知识讲解
```

**记录字段：**

| 字段 | 类型 | 说明 |
|---|---|---|
| 视频标题 | 文本 | 视频原始标题（自动读取） |
| 原视频地址 | 链接 | 抖音视频 URL |
| 原作者 | 文本 | 视频发布者 |
| 视频平台 | 单选 | 抖音 / B站 / 微信视频号 / 其他 |
| 视频类型 | 单选 | 教程 / 科技 / 知识讲解 / 产品演示 / 生活 / 其他 |
| 视频时长（秒） | 数字 | 视频总时长 |
| 飞书文档地址 | 链接 | 生成的飞书文档 URL |
| 段落数 | 数字 | AI 划分的语义段落数 |
| 截图数 | 数字 | 插入飞书文档的截图数 |
| 转录方式 | 单选 | 本地 Whisper / OpenAI Whisper API |
| 转换状态 | 单选 | 成功 / 失败 / 进行中 |
| 转换时间 | 日期 | 本次转换完成时间（自动填写） |
| 备注 | 文本 | 其他备注 |

> 多维表格地址：https://my.feishu.cn/base/OHIMb0cfuanrlWsh1CBcuC0nnrb

---

## STEP 2：视频下载（内置解析，无需 yt-dlp）

```bash
node scripts/douyin_to_feishu.js --step download --url "<抖音链接>"
```

支持格式：
- `https://v.douyin.com/xxxxx` 短链接
- `https://www.douyin.com/video/xxxxx` 长链接
- 完整分享文案（如 `8.46 复制打开抖音...https://v.douyin.com/xxxxx/...`）

**内置下载原理（三方案 Fallback）：**
1. 方案 A（最优）：解析移动端分享页内嵌 JSON（无需 Cookie/签名）
2. 方案 B：旧版 iesdouyin.com Web API
3. 方案 C：模拟 iOS APP 请求

依赖：`python3` + `pip3 install requests`

---

## STEP 3：音频转录（带时间戳）

```bash
node scripts/douyin_to_feishu.js --step transcribe --video /tmp/douyin_task/video.mp4
```

内部流程：
1. `ffmpeg` 提取音频 → `audio.mp3`
2. 优先使用本地 `whisper`（small 模型，中文，无需联网）
3. 无本地 whisper 时回退 OpenAI Whisper API（需 `OPENAI_API_KEY`）
4. 输出两个文件：
   - `segments.json`：`[{start, end, text}, ...]`
   - `segments.txt`：`[MM:SS-MM:SS] 文案`（便于阅读）

**无本地 whisper 时的提示：**
```
❌ 转录失败：本地 whisper 未安装，且未配置 OPENAI_API_KEY

方式 A：安装本地 whisper（推荐）
  pip3 install openai-whisper

方式 B：配置 OpenAI API Key
  export OPENAI_API_KEY=sk-xxxxxxxx
  或在对话中告知 AI
```

---

## STEP 4：LLM 语义分析（核心步骤 · 主 AI 完成）

```bash
node scripts/douyin_to_feishu.js --step analyze --segments /tmp/douyin_task/segments.json
```

这是 v3/v4 的核心设计：**由运行此 Skill 的主 AI 直接完成语义分析，不调用任何外部 LLM API**。

脚本会打印完整转录文本，主 AI 阅读后：
1. **语义合并**：将零散的 segments 按内容相关性合并为有意义的段落（建议 5~8 段）
2. **截图时间点推荐**：为每段选最能体现核心内容的画面时刻（精确到秒）
3. **摘要提炼**：为每段写 10~20 字摘要（作为飞书文档 H2 标题）

### 写入 paragraphs.json（推荐方式：直接写文件）

**⚠️ 不要用 `--data` 传 JSON 字符串**，Shell 会破坏含中文引号、换行符的 JSON 内容。

**正确做法（两步）**：

**第一步：主 AI 使用文件写工具，直接将 JSON 写入文件**
```
/tmp/douyin_task/paragraphs.json
```

JSON 格式：
```json
[
  {
    "start": 0.0,
    "end": 63.0,
    "text": "完整段落文案...",
    "summary": "段落摘要（10~20字）",
    "screenshot_at": 27.0
  }
]
```

**第二步：执行命令验证文件内容格式正确**
```bash
node scripts/douyin_to_feishu.js --step write-paragraphs --file /tmp/douyin_task/paragraphs.json
```

---

## STEP 4.5（可选）：AI 文字优化

```bash
node scripts/douyin_to_feishu.js --step polish
```

Whisper 转录存在同音字替换等问题（例如 Claude → Cloud、人名识别不准）。此步骤打印所有段落文案，由主 AI 完成以下优化后写回文件：

- 修正同音字替换（Claude、GPT、skill 等专有名词）
- 统一专业术语写法（保持英文原词：skill / hook / gotchas / config.json 等）
- 修正明显错别字
- 适度补全口语省略导致的逻辑断裂

**不改变原意，不润色成"AI 感"文风。**

优化完成后，主 AI 直接将修改后的 paragraphs.json 写回原路径：
```
/tmp/douyin_task/paragraphs.json
```

---

## STEP 5：精准截帧（按 AI 指定时间点）

```bash
node scripts/douyin_to_feishu.js --step frames --video /tmp/douyin_task/video.mp4
```

- 读取 `paragraphs.json` 中每个段落的 `screenshot_at` 字段
- 只截对应时刻的帧，一段一张图
- 截图路径自动写回 `paragraphs.json` 的 `frame_path` 字段

---

## STEP 6：写入飞书文档

```bash
node scripts/douyin_to_feishu.js --step write --title "视频标题"
# 或通过参数传入凭证（若未配置环境变量）
node scripts/douyin_to_feishu.js --step write --title "视频标题" --app-id "cli_xxx" --app-secret "xxx"
```

### 文档结构
- **Markdown H1**：视频标题
- 每个段落：**Markdown H2 摘要（不含时间戳）→ 正文 → 截图**
- **不再**在文档末尾追加「总结」章节

### 飞书文档写入关键经验（避坑）

**图片插入三步法**（必须严格按顺序）：
1. 创建空图片块：`POST /docx/v1/documents/{docId}/blocks/{docId}/children`，`block_type: 27, image: {}`
2. 上传图片：`POST /drive/v1/medias/upload_all`，`parent_type: "docx_image"`，`parent_node: 图片块ID`（**不是文档ID！**）
3. 绑定图片：`PATCH /docx/v1/documents/{docId}/blocks/{blockId}`，body: `{ replace_image: { token: fileToken } }`

**防限流策略**：
- 每次 API 请求前 delay 400ms
- 空响应（限流）时指数退避重试，最多 3 次

**block_type 对照表**：
| 值 | 含义 |
|---|---|
| 2 | 段落（P）|
| 3 | 一级标题（H1）|
| 4 | 二级标题（H2）|
| 27 | 图片 |

---

## 一键完整流程

```bash
node scripts/douyin_to_feishu.js --full \
  --url "<抖音链接>" \
  --title "视频标题"
```

注意：`--full` 模式在 `analyze` 步骤会暂停，等待主 AI 完成语义分析并写入 `paragraphs.json` 后，再继续 `frames` 和 `write` 步骤。

---

## 脚本文件说明

| 文件 | 用途 |
|---|---|
| `scripts/douyin_to_feishu.js` | 核心主脚本（Node.js） |
| `scripts/check_feishu_auth.js` | 飞书授权检测（Node.js） |
| `scripts/douyin_parser.py` | 抖音无水印视频解析下载（Python，来自 douyin-downloader）|

---

## 依赖工具清单

| 工具 | 安装方式 | 必需/可选 | 用途 |
|---|---|---|---|
| `ffmpeg` | `brew install ffmpeg` | **必需** | 音频提取、截帧 |
| `python3` | `brew install python3` | **必需** | 运行 douyin_parser.py |
| `requests`（Python 库）| `pip3 install requests` | **必需** | 抖音视频解析下载 |
| `openai-whisper` | `pip3 install openai-whisper` | **推荐** | 本地转录（优先） |
| Node.js ≥ 18 | `brew install node` | **必需** | 运行脚本 |
| OpenAI API Key | 环境变量 `OPENAI_API_KEY` | 可选 | 无本地 whisper 时备用 |
| 飞书 App ID/Secret | 自建应用获取 | **必需**（写入步骤）| 写入飞书文档 |

---

## 飞书权限清单

| 权限 | 必需 | 用途 |
|---|---|---|
| `docx:document` | ✅ | 创建、读写文档内容 |
| `docx:document:create` | ✅ | 创建新文档 |
| `docx:document.block:convert` | ✅ | 写入 Markdown 转换的 block 内容 |
| `drive:drive` | ✅ | 上传图片到云空间 |
| `drive:file` | ✅ | 文件管理 |
| `docx:document:readonly` | 可选 | 只读验证 |

> **注意**：以上权限均需在飞书开放平台「权限管理」中逐一开通，并**重新发布应用**后才生效。
> 权限缺失会在对应 API 调用时才报错，建议首次使用时一次性全部开通。

---

## 核心设计说明

### 主 AI 直接决策，而非外部 LLM

- **读懂再截图**：AI 读取完整转录文本，理解内容主题和叙事结构后，再决定截哪个时刻
- **精准而非机械**：截图时机选"关键结论/核心演示/重要概念出现的时刻"
- **零外部 LLM 依赖**：转录用本地 whisper，分析由主 AI 完成，只需飞书凭证就能全流程跑通

### 内置下载，无需 yt-dlp

- v4 合并了 `douyin-downloader` skill 的 `douyin_parser.py`
- 支持三方案自动 Fallback，稳定性更高
- `douyin-downloader` skill 保持独立，可继续单独使用

### 凭证安全策略

- 凭证读取优先级：命令行参数 > 环境变量 > `.env` 文件
- 凭证缺失时不静默失败，而是输出详细引导（包括"在对话框告知 AI"的方式）
- `.env` 文件建议添加到 `.gitignore`，避免泄露
