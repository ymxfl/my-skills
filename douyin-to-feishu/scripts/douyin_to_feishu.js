#!/usr/bin/env node
/**
 * 抖音视频 → 飞书文档 核心脚本 v4
 *
 * 改进（v4）：
 *   - 合并了 douyin-downloader 的能力（douyin_parser.py），不再依赖 yt-dlp
 *   - 启动时自动检测所有依赖工具（ffmpeg / python3 / whisper / Node.js）
 *     若缺失则打印详细安装引导，不静默失败
 *   - 敏感凭证（飞书 App ID/Secret）缺失时打印清晰的设置引导
 *     支持：命令行参数 > 环境变量 > .env 文件 > 对话框输入提示
 *   - 转录优先用本地 whisper（无需 API Key，更快更稳定）
 *   - 语义分析由主 AI 直接完成，不调用外部 LLM API
 *   - 精准截帧：只按 AI 指定时间点截图
 *
 * 整体流程（5 步）：
 *   check → download → transcribe → analyze(AI) → frames → write
 *
 * 用法（全流程）：
 *   node douyin_to_feishu.js --full --url "<抖音链接>" --title "标题"
 *
 * 用法（分步）：
 *   分步执行时必须通过 --work-dir 指定同一工作目录，确保各步共享中间文件。
 *   工作目录会在首次运行时自动创建，无需提前 mkdir。
 *
 *   WORK=/tmp/douyin_task_20260329
 *   node douyin_to_feishu.js --step check
 *   node douyin_to_feishu.js --step download   --url "<链接>"          --work-dir $WORK
 *   node douyin_to_feishu.js --step transcribe                         --work-dir $WORK
 *   node douyin_to_feishu.js --step analyze                            --work-dir $WORK
 *   node douyin_to_feishu.js --step write-paragraphs --file $WORK/paragraphs.json --work-dir $WORK
 *   node douyin_to_feishu.js --step frames                             --work-dir $WORK
 *   node douyin_to_feishu.js --step write      --title "标题"          --work-dir $WORK
 *
 * 凭证（优先级从高到低）：
 *   1. 命令行参数：--app-id cli_xxx --app-secret xxx
 *   2. 环境变量：FEISHU_APP_ID / FEISHU_APP_SECRET
 *   3. 当前目录 .env 文件
 *   4. 若均未配置，脚本会打印设置引导并退出
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ══════════════════════════════════════
//  参数 & 配置
// ══════════════════════════════════════
const args = process.argv.slice(2);
function getArg(name, defaultVal = null) {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : defaultVal;
}
function hasFlag(name) { return args.includes(name); }

function loadDotEnv() {
  const p = path.join(process.cwd(), '.env');
  if (!fs.existsSync(p)) return {};
  const env = {};
  for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
    if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return env;
}
const dotenv = loadDotEnv();

const APP_ID        = getArg('--app-id')       || process.env.FEISHU_APP_ID     || dotenv.FEISHU_APP_ID;
const APP_SECRET    = getArg('--app-secret')   || process.env.FEISHU_APP_SECRET || dotenv.FEISHU_APP_SECRET;
const OPENAI_KEY    = process.env.OPENAI_API_KEY || dotenv.OPENAI_API_KEY;
const STEP          = getArg('--step');
const IS_FULL       = hasFlag('--full');
const DOUYIN_URL    = getArg('--url');
const DOC_TITLE     = getArg('--title',         '抖音视频文案');

// 工作目录：优先用 --work-dir 参数（方便分步执行时共享同一目录）；
// 否则生成带时间戳的唯一目录，避免多任务并发或重复安装时互相覆盖。
// 注意：分步执行时，请在每步都传相同的 --work-dir，或使用 --full 全流程。
const _ts           = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // e.g. 20260329025500
const WORK_DIR      = getArg('--work-dir', `/tmp/douyin_task_${_ts}`);

const VIDEO_PATH    = getArg('--video',        path.join(WORK_DIR, 'video.mp4'));
const SEGMENTS_PATH = getArg('--segments',     path.join(WORK_DIR, 'segments.json'));
const PARAGRAPHS_PATH = getArg('--paragraphs', path.join(WORK_DIR, 'paragraphs.json'));
const FRAMES_DIR    = getArg('--frames',        path.join(WORK_DIR, 'frames'));

// douyin_parser.py 所在目录（和本脚本同目录）
const SCRIPTS_DIR   = path.dirname(path.resolve(__filename));

// ══════════════════════════════════════
//  依赖检测
// ══════════════════════════════════════

/**
 * 检测命令是否存在
 * @param {string} cmd
 * @returns {boolean}
 */
function commandExists(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 运行完整的依赖检测，缺少依赖时打印安装引导
 * @param {boolean} strict - true=缺少必要依赖时直接退出
 * @returns {{ ok: boolean, missing: string[], optional: string[] }}
 */
function checkDependencies(strict = true) {
  const missing = [];
  const optional = [];
  const warnings = [];

  console.log('\n🔍 检测依赖工具...\n');

  // ── 必要依赖 ──────────────────────────────────────
  // Node.js（本脚本运行环境，一定存在，检查版本）
  try {
    const nodeVer = execSync('node --version', { stdio: 'pipe' }).toString().trim();
    const major = parseInt(nodeVer.replace('v', '').split('.')[0]);
    if (major < 18) {
      warnings.push(`Node.js 版本 ${nodeVer} 过低（需要 ≥ v18），请升级：brew install node`);
    } else {
      console.log(`  ✅ Node.js ${nodeVer}`);
    }
  } catch (e) {
    warnings.push('无法检测 Node.js 版本');
  }

  // ffmpeg（音频提取 + 截帧）
  if (commandExists('ffmpeg')) {
    const v = (() => { try { return execSync('ffmpeg -version 2>&1 | head -1', { stdio: 'pipe' }).toString().split('\n')[0].trim(); } catch { return '（版本未知）'; } })();
    console.log(`  ✅ ffmpeg  ${v}`);
  } else {
    missing.push('ffmpeg');
    console.log('  ❌ ffmpeg  未安装');
  }

  // python3（运行 douyin_parser.py 下载视频）
  if (commandExists('python3')) {
    const v = (() => { try { return execSync('python3 --version', { stdio: 'pipe' }).toString().trim(); } catch { return ''; } })();
    console.log(`  ✅ python3  ${v}`);

    // 检查 requests 库
    try {
      execSync('python3 -c "import requests"', { stdio: 'pipe' });
      console.log('  ✅ python3-requests  已安装');
    } catch {
      missing.push('python3-requests');
      console.log('  ❌ python3-requests  未安装');
    }
  } else {
    missing.push('python3');
    console.log('  ❌ python3  未安装');
  }

  // ── 转录依赖（二选一）──────────────────────────────
  const hasLocalWhisper = commandExists('whisper');
  const hasOpenAIKey    = !!(OPENAI_KEY);

  if (hasLocalWhisper) {
    const v = (() => { try { return execSync('whisper --version 2>&1', { stdio: 'pipe' }).toString().trim().split('\n')[0]; } catch { return ''; } })();
    console.log(`  ✅ whisper（本地）  ${v}`);
  } else if (hasOpenAIKey) {
    console.log('  ⚠️  本地 whisper 未安装，将使用 OpenAI Whisper API（需联网）');
    optional.push('whisper');
  } else {
    missing.push('whisper（本地）或 OPENAI_API_KEY');
    console.log('  ❌ whisper  未安装，且未配置 OPENAI_API_KEY');
  }

  // ── 打印汇总 ───────────────────────────────────────
  if (warnings.length > 0) {
    console.log('\n⚠️  警告：');
    warnings.forEach(w => console.log('   ' + w));
  }

  if (missing.length > 0) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  ❌ 以下依赖缺失，请安装后重试：\n');
    if (missing.includes('ffmpeg')) {
      console.log('  【ffmpeg】音视频处理工具');
      console.log('    macOS：  brew install ffmpeg');
      console.log('    Ubuntu： sudo apt install ffmpeg\n');
    }
    if (missing.includes('python3')) {
      console.log('  【python3】Python 运行环境');
      console.log('    macOS：  brew install python3');
      console.log('    Ubuntu： sudo apt install python3 python3-pip\n');
    }
    if (missing.includes('python3-requests')) {
      console.log('  【requests】Python HTTP 库（抖音视频下载依赖）');
      console.log('    pip3 install requests\n');
    }
    if (missing.some(m => m.startsWith('whisper'))) {
      console.log('  【openai-whisper】本地语音转文字（推荐）');
      console.log('    pip3 install openai-whisper');
      console.log('  或者：配置 OpenAI API Key（在线 Whisper API）');
      console.log('    export OPENAI_API_KEY=sk-xxxxxxxx\n');
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    if (strict) {
      console.error('❌ 依赖检测失败，请按上方提示安装依赖后重试');
      process.exit(1);
    }
    return { ok: false, missing, optional };
  }

  console.log('\n✅ 所有必要依赖已就绪！\n');
  return { ok: true, missing: [], optional };
}

/**
 * 检测飞书凭证是否完整，缺失时打印详细设置引导
 * 仅在需要飞书操作（write 步骤）时调用
 */
function checkFeishuCredentials() {
  if (APP_ID && APP_SECRET) return; // 已配置，直接返回

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ❌ 未检测到飞书凭证（FEISHU_APP_ID / FEISHU_APP_SECRET）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

请通过以下任一方式配置凭证：

【方式 A】在对话框直接告知 AI（推荐）
  在对话中说："我的飞书 App ID 是 cli_xxx，App Secret 是 yyy"
  AI 会自动将凭证传给脚本。

【方式 B】设置环境变量（本次终端会话）
  export FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
  export FEISHU_APP_SECRET=your_app_secret

【方式 C】写入 .env 文件（永久）
  在当前目录创建 .env 文件，内容：
    FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
    FEISHU_APP_SECRET=your_app_secret

【方式 D】命令行参数（临时）
  在脚本调用中追加：--app-id cli_xxx --app-secret yyy

─────────────────────────────────────────────
  还没有飞书应用？按以下步骤创建：

  1. 打开 https://open.feishu.cn/app
     点击「创建企业自建应用」

  2. 进入应用 →「凭证与基础信息」→ 复制
     App ID（格式：cli_xxxxxxxxxx）
     App Secret

  3. 进入「权限管理」→ 开启权限：
     docx:document   — 创建/读写飞书文档
     drive:drive     — 上传图片到云空间
     drive:file      — 文件管理

  4. 进入「版本管理与发布」→ 发布应用
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
  process.exit(1);
}

// ══════════════════════════════════════
//  工具函数
// ══════════════════════════════════════
const delay = ms => new Promise(r => setTimeout(r, ms));

function run(cmd, opts = {}) {
  console.log('  $', cmd.substring(0, 120));
  return execSync(cmd, { stdio: 'inherit', ...opts });
}

async function getFeishuToken() {
  checkFeishuCredentials();
  const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET })
  });
  const d = await r.json();
  if (d.code !== 0) { console.error('❌ Token 获取失败:', d.msg); process.exit(1); }
  return d.tenant_access_token;
}

async function fetchWithRetry(url, options, retries = 3) {
  for (let i = 0; i < retries; i++) {
    await delay(450);
    try {
      const r = await fetch(url, options);
      const text = await r.text();
      if (!text || !text.trim()) {
        console.warn(`  ⚠️ 空响应，${i + 1}/${retries} 次重试...`);
        await delay(1200 * (i + 1));
        continue;
      }
      return JSON.parse(text);
    } catch (e) {
      console.warn(`  ⚠️ 请求异常: ${e.message}，${i + 1}/${retries} 次重试...`);
      await delay(1200 * (i + 1));
    }
  }
  throw new Error('所有重试均失败');
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// ── 飞书文档写入辅助 ──
function parseBold(text) {
  return text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map(p =>
    p.startsWith('**') && p.endsWith('**')
      ? { text_run: { content: p.slice(2, -2), text_element_style: { bold: true } } }
      : { text_run: { content: p } }
  );
}

async function addBlock(token, docId, block) {
  const d = await fetchWithRetry(
    `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`,
    {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ children: [block], index: -1 })
    }
  );
  if (d.code !== 0) console.warn('  ❌ 写入失败:', d.code, d.msg);
  return d;
}

const P  = (t, docId, text) => addBlock(t, docId, { block_type: 2, text: { elements: parseBold(text) } });
const H1 = (t, docId, text) => addBlock(t, docId, { block_type: 3, heading1: { elements: parseBold(text) } });
const BR = (t, docId) => P(t, docId, ' ');

async function IMG(token, docId, imgPath) {
  // step1: 创建空图片块
  const r1 = await addBlock(token, docId, { block_type: 27, image: {} });
  if (!r1 || r1.code !== 0) { console.warn('  ❌ 图片块创建失败'); return; }
  const blockId = r1.data.children[0].block_id;

  // step2: 上传图片（parent_node = 图片块ID，不是文档ID！）
  const file = fs.readFileSync(imgPath);
  const filename = path.basename(imgPath);
  const b = 'FB' + Date.now();
  const head = [
    `--${b}\r\nContent-Disposition: form-data; name="file_name"\r\n\r\n${filename}\r\n`,
    `--${b}\r\nContent-Disposition: form-data; name="parent_type"\r\n\r\ndocx_image\r\n`,
    `--${b}\r\nContent-Disposition: form-data; name="parent_node"\r\n\r\n${blockId}\r\n`,
    `--${b}\r\nContent-Disposition: form-data; name="size"\r\n\r\n${file.length}\r\n`,
    `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/jpeg\r\n\r\n`
  ].join('');
  const body = Buffer.concat([Buffer.from(head), file, Buffer.from(`\r\n--${b}--\r\n`)]);

  const r2 = await fetchWithRetry(
    'https://open.feishu.cn/open-apis/drive/v1/medias/upload_all',
    { method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': `multipart/form-data; boundary=${b}` }, body }
  );
  if (!r2 || r2.code !== 0) { console.warn('  ❌ 图片上传失败:', r2?.msg); return; }

  // step3: 绑定图片 token
  const r3 = await fetchWithRetry(
    `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/blocks/${blockId}`,
    { method: 'PATCH', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ replace_image: { token: r2.data.file_token } }) }
  );
  if (!r3 || r3.code !== 0) { console.warn('  ❌ 图片绑定失败:', r3?.msg); return; }
  console.log('  ✅ 图片写入成功:', path.basename(imgPath));
  await delay(300);
}

// ══════════════════════════════════════
//  STEP 0: 依赖检测（可单独运行）
// ══════════════════════════════════════
function stepCheck() {
  console.log('\n🔍 [Step 0] 运行环境 & 依赖检测...');
  const result = checkDependencies(false);

  // 检查凭证状态（非强制，只显示状态）
  console.log('\n── 飞书凭证状态 ──');
  if (APP_ID && APP_SECRET) {
    console.log(`  ✅ FEISHU_APP_ID     已配置（${APP_ID}）`);
    console.log(`  ✅ FEISHU_APP_SECRET 已配置（${APP_SECRET.substring(0, 4)}****）`);
  } else {
    if (!APP_ID) console.log('  ❌ FEISHU_APP_ID     未配置');
    if (!APP_SECRET) console.log('  ❌ FEISHU_APP_SECRET 未配置');
    console.log('\n  → 在对话中告知 AI："我的飞书 App ID 是 cli_xxx，App Secret 是 yyy"');
    console.log('  → 或设置环境变量：export FEISHU_APP_ID=cli_xxx');
  }

  console.log('\n── OpenAI 配置状态 ──');
  if (OPENAI_KEY) {
    console.log(`  ✅ OPENAI_API_KEY    已配置（${OPENAI_KEY.substring(0, 6)}****）`);
  } else {
    console.log('  ℹ️  OPENAI_API_KEY    未配置（本地 whisper 可用时不需要）');
  }

  if (!result.ok) {
    console.log('\n⚠️  请先安装缺失依赖，然后重新运行');
    process.exit(1);
  }
  console.log('\n✅ 环境检测通过，可以开始使用！\n');
}

// ══════════════════════════════════════
//  STEP 1: 下载视频（使用 douyin_parser.py）
// ══════════════════════════════════════
async function stepDownload(url) {
  console.log('\n📥 [Step 1] 下载抖音视频（无水印）...');
  if (!url) { console.error('❌ 请提供 --url 参数'); process.exit(1); }
  fs.mkdirSync(WORK_DIR, { recursive: true });

  const parserPath = path.join(SCRIPTS_DIR, 'douyin_parser.py');
  if (!fs.existsSync(parserPath)) {
    console.error(`❌ 未找到 douyin_parser.py，路径：${parserPath}`);
    console.error('   请确认 skill 完整性，或重新安装 douyin-to-feishu skill');
    process.exit(1);
  }

  // 先检查 python3 和 requests
  if (!commandExists('python3')) {
    console.error('❌ python3 未安装！');
    console.error('   macOS：  brew install python3');
    console.error('   Ubuntu： sudo apt install python3 python3-pip');
    process.exit(1);
  }
  try {
    execSync('python3 -c "import requests"', { stdio: 'pipe' });
  } catch {
    console.error('❌ Python requests 库未安装！');
    console.error('   请运行：pip3 install requests');
    process.exit(1);
  }

  // 使用内嵌 Python 脚本调用 douyin_parser（指定输出路径）
  const outputBase = VIDEO_PATH.replace(/\.mp4$/, '');
  const outputDir  = path.dirname(VIDEO_PATH);
  const outputName = path.basename(outputBase);

  // 写一个临时 Python 调用脚本
  const tmpScript = path.join(WORK_DIR, '_dl_tmp.py');
  const pyCode = `
import sys
sys.path.insert(0, ${JSON.stringify(SCRIPTS_DIR)})
from douyin_parser import parse_video, download_video
import json

url = ${JSON.stringify(url)}
out_dir = ${JSON.stringify(outputDir)}
out_name = ${JSON.stringify(outputName)}

print("[下载] 解析抖音链接...")
info = parse_video(url, verbose=True)
print("[下载] 视频标题:", info['desc'][:60])
saved = download_video(info, output_path=out_name, output_dir=out_dir, verbose=True)
print("SAVED_PATH:" + saved)

# 输出视频元数据，供主脚本使用
print("VIDEO_TITLE:" + info['desc'][:80])
print("VIDEO_AUTHOR:" + str(info.get('author', {}).get('nickname', '') if isinstance(info.get('author'), dict) else info.get('author', '')))
print("VIDEO_DURATION:" + str(info.get('duration', 0) or info.get('video', {}).get('duration', 0) or 0))
print("VIDEO_URL:" + url)
`;
  fs.writeFileSync(tmpScript, pyCode, 'utf-8');

  let output;
  try {
    output = execSync(`python3 "${tmpScript}"`, { encoding: 'utf-8' });
    console.log(output);
  } catch (e) {
    console.error('❌ 视频下载失败：\n', e.stderr || e.message);
    console.error('\n可能原因：');
    console.error('  1. 视频已删除或设为私密');
    console.error('  2. 链接格式不支持（支持：v.douyin.com 短链、www.douyin.com 长链、分享文案）');
    console.error('  3. 网络问题，请稍后重试');
    process.exit(1);
  } finally {
    try { fs.unlinkSync(tmpScript); } catch {}
  }

  // 提取实际保存路径（Python 打印 SAVED_PATH:xxx）
  const savedMatch = output.match(/SAVED_PATH:(.+)/);
  const actualPath = savedMatch ? savedMatch[1].trim() : VIDEO_PATH;

  // 如果实际保存路径和预期路径不同，复制过去
  if (actualPath !== VIDEO_PATH && fs.existsSync(actualPath)) {
    fs.copyFileSync(actualPath, VIDEO_PATH);
    console.log(`  📋 视频已复制到标准路径：${VIDEO_PATH}`);
  }

  if (!fs.existsSync(VIDEO_PATH)) {
    console.error('❌ 视频文件未找到：', VIDEO_PATH);
    process.exit(1);
  }

  const stat = fs.statSync(VIDEO_PATH);
  console.log(`✅ 视频下载完成：${VIDEO_PATH}（${(stat.size / 1024 / 1024).toFixed(1)} MB）`);

  // 提取视频元数据，写入工作目录
  const titleMatch    = output.match(/VIDEO_TITLE:(.+)/);
  const authorMatch   = output.match(/VIDEO_AUTHOR:(.+)/);
  const durationMatch = output.match(/VIDEO_DURATION:(\d+)/);
  const urlMatch      = output.match(/VIDEO_URL:(.+)/);

  const meta = {
    title:    (titleMatch    ? titleMatch[1].trim()    : '') || DOC_TITLE,
    author:   (authorMatch   ? authorMatch[1].trim()   : ''),
    duration: (durationMatch ? parseInt(durationMatch[1]) : 0),
    url:      (urlMatch      ? urlMatch[1].trim()      : url),
  };

  fs.writeFileSync(path.join(WORK_DIR, 'video_title.txt'), meta.title, 'utf-8');
  fs.writeFileSync(path.join(WORK_DIR, 'video_meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
  console.log('  📝 视频标题：', meta.title);
  if (meta.author)   console.log('  👤 作者：', meta.author);
  if (meta.duration) console.log('  ⏱️  时长：', meta.duration, '秒');

  return VIDEO_PATH;
}

// ══════════════════════════════════════
//  STEP 2: 音频提取 + 带时间戳转录
// ══════════════════════════════════════
async function stepTranscribe(videoPath) {
  console.log('\n🎙️ [Step 2] 提取音频 + 带时间戳转录...');

  if (!commandExists('ffmpeg')) {
    console.error('❌ ffmpeg 未安装！');
    console.error('   macOS：  brew install ffmpeg');
    console.error('   Ubuntu： sudo apt install ffmpeg');
    process.exit(1);
  }

  const audioPath = videoPath.replace(/\.[^.]+$/, '.mp3');
  run(`ffmpeg -y -i "${videoPath}" -ar 16000 -ac 1 -b:a 64k "${audioPath}"`);
  console.log('✅ 音频提取完成:', audioPath);

  let segments = [];

  // 优先使用本地 whisper（精准、无网络依赖）
  const localWhisper = commandExists('whisper');

  if (localWhisper) {
    console.log('  使用本地 whisper 转录（small 模型，中文）...');
    try {
      const whisperCmd = `KMP_DUPLICATE_LIB_OK=TRUE whisper "${audioPath}" --model small --language zh --output_format json --output_dir "${WORK_DIR}"`;
      run(whisperCmd);
      const jsonPath = path.join(WORK_DIR, path.basename(audioPath, '.mp3') + '.json');
      if (!fs.existsSync(jsonPath)) throw new Error('未找到输出 JSON: ' + jsonPath);
      const result = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      segments = (result.segments || []).map(s => ({
        start: parseFloat(s.start.toFixed(2)),
        end:   parseFloat(s.end.toFixed(2)),
        text:  s.text.trim()
      })).filter(s => s.text.length > 0);
      console.log(`✅ 本地转录完成，共 ${segments.length} 段，时长 ${fmtTime(segments[segments.length-1]?.end || 0)}`);
    } catch (e) {
      console.error('❌ 本地 whisper 失败:', e.message);
      process.exit(1);
    }
  } else if (OPENAI_KEY) {
    console.log('  本地 whisper 未找到，回退到 OpenAI Whisper API...');
    console.log('  （建议安装本地 whisper：pip3 install openai-whisper）');
    const audioFile = fs.readFileSync(audioPath);
    const b = 'WB' + Date.now();
    const fields = [
      { name: 'model',           value: 'whisper-1' },
      { name: 'language',        value: 'zh' },
      { name: 'response_format', value: 'verbose_json' },
    ];
    const headerParts = fields.map(f =>
      `--${b}\r\nContent-Disposition: form-data; name="${f.name}"\r\n\r\n${f.value}\r\n`
    ).join('');
    const fileHeader = `--${b}\r\nContent-Disposition: form-data; name="file"; filename="audio.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`;
    const body = Buffer.concat([
      Buffer.from(headerParts + fileHeader),
      audioFile,
      Buffer.from(`\r\n--${b}--\r\n`)
    ]);
    const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    const r = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + OPENAI_KEY, 'Content-Type': `multipart/form-data; boundary=${b}` },
      body
    });
    const text = await r.text();
    let result;
    try { result = JSON.parse(text); } catch (e) {
      console.error('❌ Whisper API 响应解析失败:', text.substring(0, 200));
      process.exit(1);
    }
    if (result.error) { console.error('❌ Whisper API 错误:', result.error.message); process.exit(1); }
    segments = (result.segments || []).map(s => ({
      start: parseFloat(s.start.toFixed(2)),
      end:   parseFloat(s.end.toFixed(2)),
      text:  s.text.trim()
    })).filter(s => s.text.length > 0);
    console.log(`✅ API 转录完成，共 ${segments.length} 段，时长 ${fmtTime(segments[segments.length-1]?.end || 0)}`);
  } else {
    console.error(`
❌ 转录失败：本地 whisper 未安装，且未配置 OPENAI_API_KEY

请选择以下方式之一解决：

【方式 A】安装本地 whisper（推荐，无需联网）
  pip3 install openai-whisper
  
  安装完成后重新运行：
  node douyin_to_feishu.js --step transcribe --video "${videoPath}"

【方式 B】配置 OpenAI API Key（在线转录）
  方法1：在对话中告知 AI："我的 OpenAI API Key 是 sk-xxx"
  方法2：设置环境变量：export OPENAI_API_KEY=sk-xxxxxxxx
  方法3：在 .env 文件中添加：OPENAI_API_KEY=sk-xxxxxxxx
`);
    process.exit(1);
  }

  fs.writeFileSync(SEGMENTS_PATH, JSON.stringify(segments, null, 2), 'utf-8');
  const plainTxt = segments.map(s => `[${fmtTime(s.start)}-${fmtTime(s.end)}] ${s.text}`).join('\n');
  fs.writeFileSync(SEGMENTS_PATH.replace('.json', '.txt'), plainTxt, 'utf-8');
  console.log('📄 segments 已保存:', SEGMENTS_PATH);
  return segments;
}

// ══════════════════════════════════════
//  STEP 3: AI 语义分析（由主 AI 直接完成，不调用外部 LLM API）
// ══════════════════════════════════════
/**
 * 设计说明（v3/v4）：
 *   此步骤不调用任何外部 LLM API。
 *   由运行此 Skill 的主 AI 直接阅读转录文本完成语义分析：
 *     1. 按内容主题划分段落
 *     2. 为每段推荐最佳截图时间点（选最能体现该段核心内容的时刻）
 *     3. 提炼每段摘要（10~20 字）
 *   主 AI 将分析结果写入 paragraphs.json（通过 --step write-paragraphs 命令）
 */
async function stepAnalyze(segmentsPath) {
  console.log('\n🧠 [Step 3] AI 语义分析：读取转录文本，请主 AI 完成段落划分和截图时间点决策');

  const segments = JSON.parse(fs.readFileSync(segmentsPath, 'utf-8'));
  const totalDuration = segments[segments.length - 1]?.end || 0;

  // 打印完整转录文本供主 AI 阅读
  console.log(`\n📄 转录文本（共 ${segments.length} 句，时长 ${fmtTime(totalDuration)}）：\n`);
  segments.forEach(s => {
    console.log(`[${fmtTime(s.start)}-${fmtTime(s.end)}] ${s.text}`);
  });

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 主 AI 任务：
   1. 阅读以上转录文本，按语义划分段落（建议 5~8 段）
   2. 为每段推荐截图时间点（选最能体现该段核心内容的时刻，避开开头结尾 3s）
   3. 为每段写摘要（10~20 字）
   4. 直接将 paragraphs.json 写入 ${PARAGRAPHS_PATH}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  // 检查 paragraphs.json 是否已由主 AI 写入
  if (fs.existsSync(PARAGRAPHS_PATH)) {
    const paragraphs = JSON.parse(fs.readFileSync(PARAGRAPHS_PATH, 'utf-8'));
    if (Array.isArray(paragraphs) && paragraphs.length > 0) {
      console.log(`\n✅ 检测到 paragraphs.json（${paragraphs.length} 段）`);
      paragraphs.forEach((p, i) => {
        console.log(`  [${i + 1}] ${fmtTime(p.start)}~${fmtTime(p.end)} | 截图@${fmtTime(p.screenshot_at)} | ${p.summary || ''}`);
      });
      return paragraphs;
    }
  }

  console.log('\n⏳ 等待主 AI 写入 paragraphs.json...');
  return null;
}

/**
 * 辅助工具：将主 AI 分析结果写入 paragraphs.json
 *
 * 推荐用法（稳定）：先用文件写工具把 JSON 写到文件，再传文件路径
 *   node douyin_to_feishu.js --step write-paragraphs --file /tmp/douyin_task/paragraphs.json
 *
 * 也支持 --data 传字符串（仅内容不含特殊字符时可用）：
 *   node douyin_to_feishu.js --step write-paragraphs --data '<JSON>'
 *
 * 说明：--data 方式在段落文本含中文引号、换行符等特殊字符时，Shell 会破坏 JSON 结构，
 *       导致解析失败。推荐始终使用 --file 方式，先直接写文件再执行此命令。
 */
function stepWriteParagraphs(dataStr, filePath) {
  let paragraphs;

  // 优先从文件读取（推荐方式，规避 Shell 特殊字符问题）
  if (filePath) {
    if (!fs.existsSync(filePath)) {
      console.error(`❌ 文件不存在：${filePath}`);
      console.error('  请先将 JSON 内容写入该文件，再执行此命令');
      process.exit(1);
    }
    try {
      paragraphs = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
      console.error(`❌ 文件 JSON 解析失败（${filePath}）:`, e.message);
      process.exit(1);
    }
    // 如果文件路径不是标准路径，复制到标准路径
    if (path.resolve(filePath) !== path.resolve(PARAGRAPHS_PATH)) {
      fs.mkdirSync(path.dirname(PARAGRAPHS_PATH), { recursive: true });
      fs.copyFileSync(filePath, PARAGRAPHS_PATH);
    }
  } else if (dataStr) {
    // 回退：从 --data 字符串解析（含特殊字符时可能失败）
    try { paragraphs = JSON.parse(dataStr); } catch (e) {
      console.error('❌ --data JSON 解析失败:', e.message);
      console.error('  提示：如果段落文本含中文引号或换行符，请改用 --file 方式：');
      console.error('  1. 先将 JSON 写入文件（AI 使用文件写工具）');
      console.error(`  2. 执行：node douyin_to_feishu.js --step write-paragraphs --file <文件路径>`);
      process.exit(1);
    }
  } else {
    // 检查标准路径是否已存在（主 AI 直接写入的情况）
    if (fs.existsSync(PARAGRAPHS_PATH)) {
      try {
        paragraphs = JSON.parse(fs.readFileSync(PARAGRAPHS_PATH, 'utf-8'));
        console.log(`  ℹ️  未提供 --file 或 --data，读取已存在的 ${PARAGRAPHS_PATH}`);
      } catch (e) {
        console.error('❌ 读取已有 paragraphs.json 失败:', e.message);
        process.exit(1);
      }
    } else {
      console.error('❌ 请提供 --file <路径> 或 --data <JSON>');
      console.error('  推荐方式：');
      console.error('  1. 将 JSON 写入文件（AI 使用文件写工具直接写入）');
      console.error(`  2. node douyin_to_feishu.js --step write-paragraphs --file ${PARAGRAPHS_PATH}`);
      process.exit(1);
    }
  }

  if (!Array.isArray(paragraphs) || paragraphs.length === 0) {
    console.error('❌ 段落数组为空或格式错误'); process.exit(1);
  }
  for (const p of paragraphs) {
    if (typeof p.screenshot_at !== 'number' || p.screenshot_at < p.start || p.screenshot_at > p.end) {
      p.screenshot_at = parseFloat((p.start + (p.end - p.start) * 0.6).toFixed(1));
    }
    p.screenshot_at = parseFloat(p.screenshot_at.toFixed(1));
  }
  fs.mkdirSync(path.dirname(PARAGRAPHS_PATH), { recursive: true });
  fs.writeFileSync(PARAGRAPHS_PATH, JSON.stringify(paragraphs, null, 2), 'utf-8');
  console.log(`✅ paragraphs.json 已写入 ${PARAGRAPHS_PATH}，共 ${paragraphs.length} 段`);
  paragraphs.forEach((p, i) => {
    console.log(`  [${i + 1}] ${fmtTime(p.start)}~${fmtTime(p.end)} | 截图@${fmtTime(p.screenshot_at)} | ${p.summary || ''}`);
  });
}

// ══════════════════════════════════════
//  STEP 4.5: AI 文字优化（可选，截帧后写入飞书前）
// ══════════════════════════════════════
/**
 * 打印段落内容供主 AI 优化，并提示主 AI 将优化后结果写回 paragraphs.json。
 *
 * 优化目标：
 *   1. 修正 Whisper 转录错误（同音字替换、专有名词、英文大小写）
 *      - 常见错误：Cloud → Claude、Starik → Strik（按实际情况修正）
 *      - 专业术语统一：skill / hook / gotchas / config.json 等保持英文
 *   2. 补全因口语省略导致的逻辑断裂
 *   3. 修正明显的错别字
 *   4. 不改变原意，不润色成"AI 感"文风
 *
 * 主 AI 完成优化后，直接将修改后的 paragraphs.json 写回原路径即可。
 */
async function stepPolish(paragraphsPath) {
  console.log('\n✏️ [Step 4.5] AI 文字优化：读取段落内容，请主 AI 修正转录错误\n');

  if (!fs.existsSync(paragraphsPath)) {
    console.error('❌ 未找到 paragraphs.json，请先完成 analyze 步骤');
    process.exit(1);
  }

  const paragraphs = JSON.parse(fs.readFileSync(paragraphsPath, 'utf-8'));

  console.log(`📄 共 ${paragraphs.length} 段，以下是当前文案内容：\n`);
  paragraphs.forEach((p, i) => {
    console.log(`━━━ 段落 [${i + 1}] ${fmtTime(p.start)}~${fmtTime(p.end)} ━━━`);
    console.log(`摘要：${p.summary || '（无）'}`);
    console.log(`文案：\n${p.text}`);
    console.log('');
  });

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 主 AI 任务（文字优化）：
   1. 阅读以上各段文案，找出 Whisper 转录错误：
      · 同音字替换（如 Cloud → Claude、工具名称、人名）
      · 专有名词错误（保持英文原词：skill, hook, gotchas, Config.json 等）
      · 口语省略导致的逻辑断裂（适度补全，不改变原意）
      · 明显错别字
   2. 修改完毕后，直接将完整的 paragraphs.json 写回：
      ${paragraphsPath}
   3. 写回后执行：
      node douyin_to_feishu.js --step write-paragraphs --file ${paragraphsPath}
      验证内容是否正确保存。
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

  return paragraphs;
}


async function stepFrames(videoPath, paragraphsPath) {
  console.log('\n🎞️ [Step 4] 精准截帧（按 AI 指定时间点）...');

  if (!commandExists('ffmpeg')) {
    console.error('❌ ffmpeg 未安装！请运行：brew install ffmpeg');
    process.exit(1);
  }

  const paragraphs = JSON.parse(fs.readFileSync(paragraphsPath, 'utf-8'));
  fs.mkdirSync(FRAMES_DIR, { recursive: true });

  const results = [];

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    if (typeof p.screenshot_at !== 'number') continue;

    const sec = p.screenshot_at;
    const outPath = path.join(FRAMES_DIR, `frame_p${String(i + 1).padStart(2, '0')}_${Math.round(sec)}s.jpg`);

    try {
      execSync(
        `ffmpeg -y -ss ${sec} -i "${videoPath}" -frames:v 1 -q:v 3 -vf "scale=1280:-2" "${outPath}"`,
        { stdio: 'pipe' }
      );
      console.log(`  ✅ 段落[${i + 1}] 截图@${fmtTime(sec)} → ${path.basename(outPath)}`);
      results.push({ paragraphIdx: i, time: sec, path: outPath });
    } catch (e) {
      console.warn(`  ⚠️ 段落[${i + 1}] 截帧失败（@${fmtTime(sec)}）:`, e.message);
    }
  }

  // 保存截帧索引（写入到 paragraphs.json 中，方便 write 步骤直接使用）
  for (const r of results) {
    paragraphs[r.paragraphIdx].frame_path = r.path;
  }
  fs.writeFileSync(paragraphsPath, JSON.stringify(paragraphs, null, 2), 'utf-8');

  console.log(`\n✅ 截帧完成，共 ${results.length} 张 → ${FRAMES_DIR}`);
  return results;
}

// ══════════════════════════════════════
//  STEP 5: 写入飞书文档
// ══════════════════════════════════════
async function stepWrite(paragraphsPath, title) {
  console.log('\n📝 [Step 5] 写入飞书文档...');

  // 检查飞书凭证（缺失时打印引导并退出）
  checkFeishuCredentials();

  const paragraphs = JSON.parse(fs.readFileSync(paragraphsPath, 'utf-8'));
  console.log(`  段落数：${paragraphs.length}，含截图：${paragraphs.filter(p => p.frame_path).length} 张`);

  const token = await getFeishuToken();

  // 创建新文档
  const cr = await fetchWithRetry(
    'https://open.feishu.cn/open-apis/docx/v1/documents',
    { method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }) }
  );
  if (!cr || cr.code !== 0) { console.error('❌ 创建文档失败:', cr?.msg); process.exit(1); }
  const docId = cr.data.document.document_id;
  const docUrl = `https://my.feishu.cn/docx/${docId}`;
  console.log('  ✅ 文档创建:', docUrl);
  await delay(800);

  // ── 写入标题 ──
  await H1(token, docId, title);
  await BR(token, docId);

  let imgCount = 0;

  // ── 逐段写入文案 + 截图 ──
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];

    // 段落标题（如果有摘要，作为小标题）
    if (p.summary) {
      await addBlock(token, docId, {
        block_type: 4,  // H2
        heading2: { elements: [{ text_run: { content: `${fmtTime(p.start)}  ${p.summary}` } }] }
      });
    } else {
      await P(token, docId, `**[${fmtTime(p.start)}]**`);
    }

    // 正文（完整段落文案）
    await P(token, docId, p.text);

    // 截图（如果有）
    if (p.frame_path && fs.existsSync(p.frame_path)) {
      console.log(`  → 段落[${i + 1}] 插入截图 @${fmtTime(p.screenshot_at)}`);
      await IMG(token, docId, p.frame_path);
      await BR(token, docId);
      imgCount++;
    }
  }

  // ── 总结章节 ──
  await BR(token, docId);
  await H1(token, docId, '总结');
  await P(token, docId, `本文根据视频《${title}》由 AI 自动转录与整理，共 ${paragraphs.length} 个语义段落，插入 ${imgCount} 张关键截图。`);
  await P(token, docId, '截图时间点由 AI 根据语义内容分析确定，选取最能体现各段核心内容的画面。');
  await P(token, docId, '内容仅供参考，如有出入以原视频为准。');

  console.log('\n🎉 全部写入完成！');
  console.log('📄 飞书文档：', docUrl);

  // 自动记录到多维表格（如果配置了 BITABLE_APP_TOKEN）
  await stepLogToBitable({ docUrl, paragraphCount: paragraphs.length, screenshotCount: imgCount }).catch(() => {});

  return docUrl;
}

// ══════════════════════════════════════
//  STEP 6: 记录到飞书多维表格（可选）
// ══════════════════════════════════════
/**
 * 将本次转换结果记录到飞书多维表格
 *
 * 参数（命令行或调用时传入）：
 *   --bitable-token   多维表格 app_token（必须）
 *   --bitable-table   数据表 table_id（必须）
 *   --source-url      原视频地址
 *   --author          原作者
 *   --platform        视频平台（抖音/B站/微信视频号/其他）
 *   --video-type      视频类型（教程/科技/知识讲解/产品演示/生活/其他）
 *   --duration        视频时长（秒）
 *   --doc-url         已生成的飞书文档地址
 *   --paragraphs-file paragraphs.json 路径（自动读取段落数和截图数）
 *   --transcribe-by   转录方式（本地 Whisper / OpenAI Whisper API）
 */
async function stepLogToBitable(opts = {}) {
  const bitableToken = opts.bitableToken || getArg('--bitable-token') || process.env.BITABLE_APP_TOKEN;
  const bitableTable = opts.bitableTable || getArg('--bitable-table') || process.env.BITABLE_TABLE_ID;

  if (!bitableToken || !bitableTable) {
    console.log('\nℹ️  未配置多维表格信息，跳过记录步骤');
    console.log('   如需记录，请提供 --bitable-token 和 --bitable-table 参数');
    console.log('   或设置环境变量 BITABLE_APP_TOKEN / BITABLE_TABLE_ID');
    return;
  }

  console.log('\n📊 [Step 6] 记录转换结果到飞书多维表格...');
  checkFeishuCredentials();
  const token = await getFeishuToken();

  // ── 自动清除默认空行 ──────────────────────────────────────────
  // 飞书新建多维表格会自动生成若干空行（字段全为 null），首次写入时一并清理
  try {
    const listR = await fetchWithRetry(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${bitableToken}/tables/${bitableTable}/records?page_size=50`,
      { method: 'GET', headers: { 'Authorization': 'Bearer ' + token } }
    );
    if (listR && listR.code === 0 && listR.data?.items?.length) {
      const emptyIds = listR.data.items
        .filter(item => Object.values(item.fields).every(v => v === null || v === undefined))
        .map(item => item.record_id);
      if (emptyIds.length > 0) {
        console.log(`  🧹 检测到 ${emptyIds.length} 条默认空行，自动清除...`);
        const delR = await fetchWithRetry(
          `https://open.feishu.cn/open-apis/bitable/v1/apps/${bitableToken}/tables/${bitableTable}/records/batch_delete`,
          {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ records: emptyIds })
          }
        );
        if (delR && delR.code === 0) {
          console.log(`  ✅ 已清除 ${emptyIds.length} 条空行`);
        }
      }
    }
  } catch (e) {
    // 清除空行失败不阻断主流程
    console.warn('  ⚠️  清除空行时出错（不影响写入）:', e.message);
  }

  // 读取 paragraphs.json 获取段落数和截图数
  let paragraphCount = opts.paragraphCount || 0;
  let screenshotCount = opts.screenshotCount || 0;
  const pPath = opts.paragraphsFile || getArg('--paragraphs-file', PARAGRAPHS_PATH);
  if (fs.existsSync(pPath)) {
    try {
      const paragraphs = JSON.parse(fs.readFileSync(pPath, 'utf-8'));
      paragraphCount  = paragraphs.length;
      screenshotCount = paragraphs.filter(p => p.frame_path).length;
    } catch (e) { /* ignore */ }
  }

  // 读取视频元数据（优先 video_meta.json，兼容旧 video_title.txt）
  let videoTitle = opts.videoTitle || DOC_TITLE;
  const metaFile  = path.join(WORK_DIR, 'video_meta.json');
  const titleFile = path.join(WORK_DIR, 'video_title.txt');
  let metaFromFile = {};
  if (fs.existsSync(metaFile)) {
    try { metaFromFile = JSON.parse(fs.readFileSync(metaFile, 'utf-8')); } catch {}
  }
  if (metaFromFile.title) {
    videoTitle = metaFromFile.title;
  } else if (fs.existsSync(titleFile)) {
    videoTitle = fs.readFileSync(titleFile, 'utf-8').trim() || videoTitle;
  }

  const docUrl    = opts.docUrl         || getArg('--doc-url',       '');
  const sourceUrl = opts.sourceUrl      || getArg('--source-url',    metaFromFile.url || DOUYIN_URL || '');
  const author    = opts.author         || getArg('--author',        metaFromFile.author || '');
  const platform  = opts.platform       || getArg('--platform',      '抖音');
  const videoType = opts.videoType      || getArg('--video-type',    '');
  const duration  = opts.duration       || parseInt(getArg('--duration', '0')) || metaFromFile.duration || 0;
  const transcribeBy = opts.transcribeBy || getArg('--transcribe-by', '本地 Whisper');

  const fields = {
    '视频标题':        videoTitle,
    '转换状态':        '成功',
    '转换时间':        Date.now(),
    '段落数':          Number(paragraphCount) || 0,
    '截图数':          Number(screenshotCount) || 0,
    '转录方式':        transcribeBy,
  };

  if (docUrl)    fields['飞书文档地址'] = { link: docUrl, text: '查看飞书文档' };
  if (sourceUrl) fields['原视频地址']   = { link: sourceUrl, text: '查看原视频' };
  if (author)    fields['原作者']       = author;
  if (platform)  fields['视频平台']     = platform;
  if (videoType) fields['视频类型']     = videoType;
  if (duration)  fields['视频时长（秒）'] = duration;

  // ── 防重复写入：按视频标题 + 飞书文档地址查重 ──────────────────
  try {
    const conditions = [{ field_name: '视频标题', operator: 'is', value: [videoTitle] }];
    if (docUrl) conditions.push({ field_name: '飞书文档地址', operator: 'is', value: [docUrl] });
    const dupCheck = await fetchWithRetry(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${bitableToken}/tables/${bitableTable}/records/search`,
      {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ filter: { conjunction: 'and', conditions }, page_size: 1 })
      }
    );
    if (dupCheck && dupCheck.code === 0 && (dupCheck.data?.total ?? 0) > 0) {
      const existId = dupCheck.data.items[0].record_id;
      console.log(`⚠️  检测到重复记录（${existId}），跳过写入。`);
      console.log('   如需强制覆盖，请手动删除多维表格中该条记录后重试。');
      console.log('📊 多维表格:', `https://my.feishu.cn/base/${bitableToken}`);
      return;
    }
  } catch (e) {
    // 查重出错不阻断主流程，继续写入
    console.warn('  ⚠️  重复检测出错（继续写入）:', e.message);
  }

  // ── 正式写入 ──────────────────────────────────────────────────
  try {
    const r = await fetchWithRetry(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${bitableToken}/tables/${bitableTable}/records`,
      {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields })
      }
    );
    if (r && r.code === 0) {
      console.log('✅ 已记录到多维表格，record_id:', r.data.record.record_id);
      const baseUrl = `https://my.feishu.cn/base/${bitableToken}`;
      console.log('📊 多维表格:', baseUrl);
    } else {
      console.warn('⚠️  多维表格写入失败:', r?.msg || '未知错误');
    }
  } catch (e) {
    console.warn('⚠️  多维表格写入异常:', e.message);
  }
}

// ══════════════════════════════════════
//  主入口
// ══════════════════════════════════════
async function main() {
  fs.mkdirSync(WORK_DIR, { recursive: true });

  if (IS_FULL || STEP === 'all') {
    // 全流程前先做依赖检测
    checkDependencies(true);
    const videoPath   = await stepDownload(DOUYIN_URL);
    const _segments   = await stepTranscribe(videoPath);
    await stepAnalyze(SEGMENTS_PATH);
    // 注意：analyze 步骤结束后需要主 AI 写入 paragraphs.json，
    // 再继续执行 frames 和 write
    if (fs.existsSync(PARAGRAPHS_PATH)) {
      await stepFrames(videoPath, PARAGRAPHS_PATH);
      const docUrl = await stepWrite(PARAGRAPHS_PATH, DOC_TITLE);
      console.log('\n✅ 完整流程结束！', docUrl);
    } else {
      console.log('\n⏸ 请主 AI 完成语义分析后，继续执行：');
      console.log(`   node douyin_to_feishu.js --step frames --video "${videoPath}"`);
      console.log(`   node douyin_to_feishu.js --step write --title "${DOC_TITLE}"`);
    }

  } else if (STEP === 'check') {
    stepCheck();

  } else if (STEP === 'download') {
    await stepDownload(DOUYIN_URL);

  } else if (STEP === 'transcribe') {
    await stepTranscribe(VIDEO_PATH);

  } else if (STEP === 'analyze') {
    await stepAnalyze(SEGMENTS_PATH);

  } else if (STEP === 'write-paragraphs') {
    const dataStr  = getArg('--data');
    const filePath = getArg('--file');
    stepWriteParagraphs(dataStr, filePath);

  } else if (STEP === 'polish') {
    const pPath = getArg('--paragraphs', PARAGRAPHS_PATH);
    await stepPolish(pPath);

  } else if (STEP === 'frames') {
    const pPath = getArg('--paragraphs', PARAGRAPHS_PATH);
    if (!fs.existsSync(pPath)) {
      console.error('❌ 未找到 paragraphs.json，请先运行 --step analyze 并由主 AI 写入段落数据');
      process.exit(1);
    }
    await stepFrames(VIDEO_PATH, pPath);

  } else if (STEP === 'write') {
    const pPath = getArg('--paragraphs', PARAGRAPHS_PATH);
    if (!fs.existsSync(pPath)) {
      console.error('❌ 未找到 paragraphs.json，请先运行 --step analyze 和 --step frames');
      process.exit(1);
    }
    await stepWrite(pPath, DOC_TITLE);

  } else if (STEP === 'log') {
    // 单独记录到多维表格（不依赖飞书文档生成步骤）
    await stepLogToBitable();

  } else {
    console.log(`
抖音视频 → 飞书文档 v4.2（内置下载器 + 依赖检测 + 多维表格记录版）

环境检测（推荐先运行）：
  node douyin_to_feishu.js --step check

流程（推荐按顺序执行）：
  分步执行时，请通过 --work-dir 指定同一工作目录（或直接使用 --full 全流程）。
  工作目录示例：WORK=/tmp/douyin_task_20260329

  1. 下载视频（使用内置 douyin_parser，无水印）
     node douyin_to_feishu.js --step download --url "<抖音链接>" --work-dir $WORK

  2. 本地 Whisper 转录（带时间戳）
     node douyin_to_feishu.js --step transcribe --work-dir $WORK
     → 优先用本地 whisper，无则回退到 OpenAI Whisper API
     → 输出 segments.json（每句话的时间范围和文案）

  3. AI 语义分析（由主 AI 直接完成，不调用外部 LLM）
     node douyin_to_feishu.js --step analyze --work-dir $WORK
     → 打印转录全文，由主 AI 阅读后决定段落划分和截图时间点
     → 主 AI 直接写入 paragraphs.json：
       先用文件写工具写入 $WORK/paragraphs.json
       再执行：node douyin_to_feishu.js --step write-paragraphs --file $WORK/paragraphs.json --work-dir $WORK

  4. 精准截帧（按 AI 指定时间点）
     node douyin_to_feishu.js --step frames --work-dir $WORK

  4.5 [可选] AI 文字优化（修正转录错误）
     node douyin_to_feishu.js --step polish --work-dir $WORK
     → 打印段落文案，由主 AI 修正 Whisper 同音字、专有名词错误、错别字
     → 主 AI 将修改后的 paragraphs.json 写回原路径

  5. 写入飞书文档（完成后自动记录到多维表格，如已配置）
     node douyin_to_feishu.js --step write --title "视频标题" --work-dir $WORK

  6. [可选] 单独记录到多维表格
     node douyin_to_feishu.js --step log --work-dir $WORK \\
       --bitable-token <app_token> --bitable-table <table_id> \\
       --doc-url "https://my.feishu.cn/docx/xxx" \\
       --source-url "https://v.douyin.com/xxx" \\
       --author "作者名" --platform 抖音 --video-type 知识讲解

环境变量：
  FEISHU_APP_ID       飞书应用 ID（必须，--step write 时检测）
  FEISHU_APP_SECRET   飞书应用密钥（必须）
  OPENAI_API_KEY      本地 whisper 不可用时的备用 Whisper API
  BITABLE_APP_TOKEN   多维表格 app_token（配置后 write 完成自动记录）
  BITABLE_TABLE_ID    多维表格数据表 ID
    `);
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
