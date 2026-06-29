#!/usr/bin/env node
/**
 * 多平台视频 → 本地 Markdown 文案 核心脚本
 *
 * 派生自 video_to_joyspace.js，移除媒体上传 / 截帧 / JoySpace MCP / OpenAI 回退逻辑。
 * 仅本地转录（faster-whisper / whisper）。write 步骤组装纯文本 output.md。
 *
 * 整体流程：
 *   check → download → audio → transcribe → analyze(AI) → write
 *
 * 用法（分步，必须用同一 --work-dir 共享中间文件）：
 *   WORK=/tmp/video_to_markdown_task
 *   node scripts/video_to_markdown.js --step check
 *   node scripts/video_to_markdown.js --step download --url "<链接或分享文案>" --work-dir $WORK
 *   node scripts/video_to_markdown.js --step audio                              --work-dir $WORK
 *   node scripts/video_to_markdown.js --step transcribe                         --work-dir $WORK
 *   node scripts/video_to_markdown.js --step analyze                            --work-dir $WORK
 *   node scripts/video_to_markdown.js --step write-paragraphs --file $WORK/paragraphs.json --work-dir $WORK
 *   node scripts/video_to_markdown.js --step write      --title "标题"          --work-dir $WORK
 *
 * 可选配置：
 *   YTDLP_COOKIES            yt-dlp cookies.txt 路径
 *   YTDLP_COOKIES_FROM_BROWSER  从浏览器读取 cookies，例如 chrome
 *   TRANSCRIBE_CHUNK_SEC     转录分段阈值（秒，默认 600）
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

// ══════════════════════════════════════
//  参数 & 配置
// ══════════════════════════════════════
const args = process.argv.slice(2);
function getArg(name, defaultVal = null) {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : defaultVal;
}
function hasFlag(name) { return args.includes(name); }

// douyin_video_parser.py 所在目录（和本脚本同目录）；需在 loadDotEnv 之前定义以便读取 skill 根目录 .env
const SCRIPTS_DIR   = path.dirname(path.resolve(__filename));
const SKILL_ROOT    = path.dirname(SCRIPTS_DIR);

/**
 * 读取 .env：先 skill 根目录，再 cwd；后者覆盖前者。
 * 这样无论从仓库哪一级执行 node scripts/video_to_markdown.js，都能加载凭证。
 */
function loadDotEnv() {
  const paths = [
    path.join(SKILL_ROOT, '.env'),
    path.join(process.cwd(), '.env'),
  ];
  const env = {};
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
      const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
      if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return env;
}
const dotenv = loadDotEnv();

const YTDLP_COOKIES = getArg('--ytdlp-cookies') || process.env.YTDLP_COOKIES || dotenv.YTDLP_COOKIES;
const YTDLP_COOKIES_FROM_BROWSER = getArg('--ytdlp-cookies-from-browser')
  || process.env.YTDLP_COOKIES_FROM_BROWSER
  || dotenv.YTDLP_COOKIES_FROM_BROWSER;
// Whisper 模型：可传名称（small/medium…）或本地模型目录路径。
// 受限网络下可先用镜像把模型下到本地目录，再用 WHISPER_MODEL=/path/to/model 指向它。
const WHISPER_MODEL = getArg('--whisper-model')
  || process.env.WHISPER_MODEL
  || dotenv.WHISPER_MODEL
  || 'small';
const BROWSER_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const YTDLP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function parsePositiveIntOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = parseInt(String(v), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function persistTranscribeChunkSecToEnvFile(valueSec) {
  const envPath = path.join(SKILL_ROOT, '.env');
  let content = '';
  if (fs.existsSync(envPath)) content = fs.readFileSync(envPath, 'utf-8');

  const key = 'TRANSCRIBE_CHUNK_SEC';
  const lines = content.split(/\r?\n/);
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*TRANSCRIBE_CHUNK_SEC\s*=/.test(lines[i])) {
      lines[i] = `${key}=${valueSec}`;
      found = true;
      break;
    }
  }
  if (!found) {
    // 避免在空文件末尾追加空行导致格式混乱
    if (lines.length === 1 && lines[0] === '') lines.pop();
    lines.push(`${key}=${valueSec}`);
  }
  fs.writeFileSync(envPath, lines.join('\n'), 'utf-8');
  console.log(`  ✅ 已写入 ${key}=${valueSec} 到 ${envPath}`);
}

const TRANSCRIBE_CHUNK_SEC_CLI_RAW = getArg('--transcribe-chunk-sec');
let TRANSCRIBE_CHUNK_SEC = parsePositiveIntOrNull(
  process.env.TRANSCRIBE_CHUNK_SEC ?? dotenv.TRANSCRIBE_CHUNK_SEC ?? '600'
) ?? 600;
if (TRANSCRIBE_CHUNK_SEC_CLI_RAW !== null && TRANSCRIBE_CHUNK_SEC_CLI_RAW !== undefined) {
  const v = parsePositiveIntOrNull(TRANSCRIBE_CHUNK_SEC_CLI_RAW);
  if (v) {
    TRANSCRIBE_CHUNK_SEC = v;
    persistTranscribeChunkSecToEnvFile(v);
  } else {
    console.warn('⚠️  无效的 --transcribe-chunk-sec 参数，将忽略本次覆盖：', TRANSCRIBE_CHUNK_SEC_CLI_RAW);
  }
}

const STEP          = getArg('--step');
const IS_FULL       = hasFlag('--full');
const CLEAN_OLD_WORK_DIRS = (
  process.env.CLEAN_OLD_WORK_DIRS
  ?? process.env.CLEAN_OLD_WORKDIRS
  ?? dotenv.CLEAN_OLD_WORK_DIRS
  ?? dotenv.CLEAN_OLD_WORKDIRS
  ?? '1'
) === '1' && !hasFlag('--no-cleanup-old');
const DOUYIN_URL    = getArg('--url');
const DOC_TITLE     = getArg('--title',         '视频文案');

// 工作目录：优先用 --work-dir 参数（方便分步执行时共享同一目录）；
// 否则生成带时间戳的唯一目录，避免多任务并发或重复安装时互相覆盖。
// 注意：分步执行时，请在每步都传相同的 --work-dir，或使用 --full 辅助全流程。
const _ts           = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // e.g. 20260329025500
const WORK_DIR      = getArg('--work-dir', `/tmp/douyin_task_${_ts}`);

const VIDEO_PATH    = getArg('--video',        path.join(WORK_DIR, 'video.mp4'));
const AUDIO_PATH    = getArg('--audio',        path.join(WORK_DIR, 'audio.mp3'));
const SEGMENTS_PATH = getArg('--segments',     path.join(WORK_DIR, 'segments.json'));
const PARAGRAPHS_PATH = getArg('--paragraphs', path.join(WORK_DIR, 'paragraphs.json'));
const FRAMES_DIR    = getArg('--frames',        path.join(WORK_DIR, 'frames'));

// ══════════════════════════════════════
//  自动查找最新工作目录（解决分步执行时路径不一致问题）
// ══════════════════════════════════════

/**
 * 自动查找 /tmp 下最新的包含 paragraphs.json 的工作目录
 * 用于 frames/write 步骤未指定 --work-dir 时，自动复用已存在的最新结果
 */
function findLatestWorkDir() {
  try {
    const dirs = fs.readdirSync('/tmp')
      .filter(d => d.startsWith('douyin_task_'))
      .filter(d => {
        try { return fs.statSync(path.join('/tmp', d)).isDirectory(); } catch { return false; }
      })
      .map(d => ({
        name: d,
        mtime: fs.statSync(path.join('/tmp', d)).mtimeMs,
        hasParagraphs: fs.existsSync(path.join('/tmp', d, 'paragraphs.json')),
        hasVideo: fs.existsSync(path.join('/tmp', d, 'video.mp4'))
      }))
      .filter(d => d.hasParagraphs && d.hasVideo)
      .sort((a, b) => b.mtime - a.mtime); // 按时间倒序，最新的在前

    if (dirs.length > 0) {
      console.log(`  🔗 自动关联最新工作目录: /tmp/${dirs[0].name}`);
      return `/tmp/${dirs[0].name}`;
    }
  } catch (e) {
    // 忽略错误，继续使用默认 WORK_DIR
  }
  return null;
}

/**
 * 获取 paragraphs.json 路径（优先 --paragraphs 参数，自动查找回退）
 * @param {string} callerStep - 调用者步骤名称（用于日志）
 */
function resolveParagraphsPath(callerStep = 'unknown') {
  // 如果用户明确指定了 --paragraphs，直接使用
  const cliIdx = args.indexOf('--paragraphs');
  if (cliIdx !== -1 && args[cliIdx + 1]) {
    return { path: args[cliIdx + 1], autoDetected: false };
  }

  // 如果指定了 --work-dir，使用 WORK_DIR/paragraphs.json
  if (args.includes('--work-dir')) {
    return { path: path.join(WORK_DIR, 'paragraphs.json'), autoDetected: false };
  }

  // 自动查找最新的 paragraphs.json（解决 AI 直接写文件导致的路径不一致问题）
  const latestDir = findLatestWorkDir();
  if (latestDir) {
    return { path: path.join(latestDir, 'paragraphs.json'), autoDetected: true };
  }

  // 回退到默认 WORK_DIR
  return { path: PARAGRAPHS_PATH, autoDetected: false };
}

/**
 * 获取 video 路径（与 resolveParagraphsPath 联动）
 */
function resolveVideoPath(paragraphsPath) {
  // 如果用户指定了 --video，直接使用
  const videoIdx = args.indexOf('--video');
  if (videoIdx !== -1 && args[videoIdx + 1]) {
    return args[videoIdx + 1];
  }

  // 自动关联到 paragraphs.json 所在目录
  return path.join(path.dirname(paragraphsPath), 'video.mp4');
}

function extractFirstUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>，。；、）)]+/u);
  return m ? m[0].replace(/[.,;!?，。；！？、]+$/u, '') : null;
}

function detectPlatform(input) {
  const url = extractFirstUrl(input) || String(input || '');
  const lower = url.toLowerCase();
  if (/douyin\.com|iesdouyin\.com|amemv\.com/.test(lower)) {
    return { key: 'douyin', label: '抖音', url };
  }
  if (/bilibili\.com|b23\.tv/.test(lower)) {
    return { key: 'bilibili', label: '哔哩哔哩', url };
  }
  if (/kuaishou\.com|chenzhongtech\.com|gifshow\.com/.test(lower)) {
    return { key: 'kuaishou', label: '快手', url };
  }
  if (/weibo\.com|m\.weibo\.cn/.test(lower)) {
    return { key: 'weibo', label: '微博', url };
  }
  if (/xiaohongshu\.com|xhslink\.com/.test(lower)) {
    return { key: 'xiaohongshu', label: '小红书', url };
  }
  return { key: 'other', label: '其他', url };
}

function ytdlpBaseArgs() {
  const extra = ['--user-agent', YTDLP_UA];
  if (YTDLP_COOKIES) extra.push('--cookies', YTDLP_COOKIES);
  if (YTDLP_COOKIES_FROM_BROWSER) extra.push('--cookies-from-browser', YTDLP_COOKIES_FROM_BROWSER);
  return extra;
}

async function resolveRedirectUrl(url, maxRedirects = 5) {
  let current = url;
  for (let i = 0; i < maxRedirects; i++) {
    try {
      const r = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      });
      const location = r.headers.get('location');
      if (!location || ![301, 302, 303, 307, 308].includes(r.status)) break;
      current = new URL(location, current).toString();
    } catch {
      break;
    }
  }
  return current;
}

function normalizePlatformUrl(url, platform) {
  if (platform.key === 'bilibili') {
    const bv = String(url).match(/\/video\/(BV[a-zA-Z0-9]+)/)?.[1] || String(url).match(/\b(BV[a-zA-Z0-9]{8,})\b/)?.[1];
    if (bv) return `https://www.bilibili.com/video/${bv}`;
  }
  return url;
}

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
    execFileSync('which', [cmd], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function pythonModuleExists(moduleName) {
  try {
    execFileSync('python3', ['-c', `import ${moduleName}`], {
      stdio: 'pipe',
      env: moduleName === 'faster_whisper'
        ? { ...process.env, KMP_DUPLICATE_LIB_OK: 'TRUE' }
        : process.env,
    });
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
    const nodeVer = execFileSync('node', ['--version'], { stdio: 'pipe' }).toString().trim();
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
    const v = (() => { try { return execFileSync('ffmpeg', ['-version'], { stdio: 'pipe' }).toString().split('\n')[0].trim(); } catch { return '（版本未知）'; } })();
    console.log(`  ✅ ffmpeg  ${v}`);
  } else {
    missing.push('ffmpeg');
    console.log('  ❌ ffmpeg  未安装');
  }

  // python3（运行 douyin_video_parser.py 下载视频）
  if (commandExists('python3')) {
    const v = (() => { try { return execFileSync('python3', ['--version'], { stdio: 'pipe' }).toString().trim(); } catch { return ''; } })();
    console.log(`  ✅ python3  ${v}`);

    // 检查 requests 库
    try {
      execFileSync('python3', ['-c', 'import requests'], { stdio: 'pipe' });
      console.log('  ✅ python3-requests  已安装');
    } catch {
      missing.push('python3-requests');
      console.log('  ❌ python3-requests  未安装');
    }
  } else {
    missing.push('python3');
    console.log('  ❌ python3  未安装');
  }

  // ── 转录依赖（本地，二选一）────────────────────────
  const hasFasterWhisper = commandExists('python3') && pythonModuleExists('faster_whisper');
  const hasLocalWhisper = commandExists('whisper');

  if (hasFasterWhisper) {
    console.log('  ✅ faster-whisper（本地）  已安装');
  } else if (hasLocalWhisper) {
    const v = (() => { try { return execFileSync('whisper', ['--version'], { stdio: 'pipe' }).toString().trim().split('\n')[0]; } catch { return ''; } })();
    console.log(`  ⚠️  faster-whisper 未安装，检测到 whisper（本地）  ${v}`);
    optional.push('faster-whisper');
  } else {
    missing.push('faster-whisper（本地）');
    console.log('  ❌ faster-whisper  未安装');
  }

  // ── 多平台下载依赖 ─────────────────────────────────
  if (commandExists('yt-dlp')) {
    const v = (() => { try { return execFileSync('yt-dlp', ['--version'], { stdio: 'pipe' }).toString().trim(); } catch { return ''; } })();
    console.log(`  ✅ yt-dlp  ${v}（B站/微博/小红书下载依赖）`);
  } else {
    optional.push('yt-dlp');
    console.log('  ⚠️  yt-dlp 未安装：抖音/快手可用；B站/微博/小红书需要安装 yt-dlp');
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
    if (missing.some(m => m.startsWith('faster-whisper'))) {
      console.log('  【faster-whisper】本地语音转文字（推荐）');
      console.log('    pip3 install faster-whisper\n');
    }
    if (optional.includes('yt-dlp')) {
      console.log('  【yt-dlp】多平台视频下载（B站/微博/小红书）');
      console.log('    brew install yt-dlp');
      console.log('    或：pip3 install -U yt-dlp\n');
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


// ══════════════════════════════════════
//  工具函数
// ══════════════════════════════════════
const delay = ms => new Promise(r => setTimeout(r, ms));

function formatCmd(cmd, args = []) {
  return [cmd, ...args.map(a => {
    const s = String(a);
    return /[\s"']/u.test(s) ? JSON.stringify(s) : s;
  })].join(' ');
}

function runFile(cmd, args = [], opts = {}) {
  console.log('  $', formatCmd(cmd, args).substring(0, 160));
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}


function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function cleanupOldWorkDirs() {
  if (!CLEAN_OLD_WORK_DIRS) return;
  const current = path.resolve(WORK_DIR);
  if (!current.startsWith('/tmp/douyin_task_')) return;

  try {
    const oldDirs = fs.readdirSync('/tmp')
      .filter(name => name.startsWith('douyin_task_'))
      .map(name => path.join('/tmp', name))
      .filter(dir => {
        try {
          return fs.statSync(dir).isDirectory() && path.resolve(dir) !== current;
        } catch {
          return false;
        }
      });

    if (oldDirs.length === 0) return;
    console.log(`\n🧹 新任务启动：清理 ${oldDirs.length} 个旧工作目录`);
    for (const dir of oldDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`  ✅ 已删除旧目录：${dir}`);
    }
  } catch (e) {
    console.warn('⚠️ 清理旧工作目录失败：', e.message);
  }
}


// ══════════════════════════════════════
//  STEP 0: 依赖检测（可单独运行）
// ══════════════════════════════════════
async function stepCheck() {
  console.log('\n🔍 [Step 0] 运行环境 & 依赖检测...');
  const result = checkDependencies(false);

  // 显示当前分段时长配置
  const chunkSecFromEnv = dotenv.TRANSCRIBE_CHUNK_SEC || process.env.TRANSCRIBE_CHUNK_SEC;
  const currentChunkSec = TRANSCRIBE_CHUNK_SEC; // 最终会用的值（含默认 600）
  const hasChunkSec = chunkSecFromEnv && String(chunkSecFromEnv).trim() !== '';
  
  console.log('\n── 分段时长配置 ──');
  if (hasChunkSec) {
    console.log(`  ✅ TRANSCRIBE_CHUNK_SEC 已配置（${currentChunkSec} 秒）`);
    console.log(`    来源：${chunkSecFromEnv}（来自 .env 或环境变量）`);
  } else {
    console.log(`  ℹ️  TRANSCRIBE_CHUNK_SEC 未配置，默认将使用 ${currentChunkSec} 秒（${currentChunkSec/60} 分钟）`);
  }
  console.log(`  说明：音频时长 > 此值时切 chunk 转录（可用 --transcribe-chunk-sec <秒> 覆盖）`);

  if (!result.ok) {
    console.log('\n⚠️  请先安装缺失依赖，然后重新运行');
    process.exit(1);
  }

  // 首次使用引导：如果用户尚未配置默认分段时长（TRANSCRIBE_CHUNK_SEC），询问是否要修改
  const hasChunkSecInEnv = hasChunkSec ||
    (TRANSCRIBE_CHUNK_SEC_CLI_RAW !== null && TRANSCRIBE_CHUNK_SEC_CLI_RAW !== undefined && parsePositiveIntOrNull(TRANSCRIBE_CHUNK_SEC_CLI_RAW) !== null);

  if (!hasChunkSecInEnv) {
    const defaultSec = 600;
    console.log('\n── 分段时长配置（TRANSCRIBE_CHUNK_SEC） ──');
    console.log(`  ℹ️ 当前未配置 TRANSCRIBE_CHUNK_SEC，默认将使用 ${defaultSec} 秒（10 分钟）。`);

    console.log('\n  需要你的选择：');
    console.log('  - 回复一个数字（秒），例如：900（表示 15 分钟）');
    console.log('  - 或回复：`保持默认` / 直接什么都不改');
    console.log(`  主 AI 读取你这条回复后，会自动用 --transcribe-chunk-sec <秒> 写入 ${path.join(SKILL_ROOT, '.env')} 并继续流程。`);
    return;
  }

  console.log('\n✅ 环境检测通过，可以开始使用！\n');
}

// ══════════════════════════════════════
//  STEP 1: 下载视频（使用 douyin_video_parser.py）
// ══════════════════════════════════════
async function stepDownload(url) {
  if (!url) { console.error('❌ 请提供 --url 参数'); process.exit(1); }
  const platform = detectPlatform(url);
  console.log(`\n📥 [Step 1] 下载${platform.label}视频...`);
  if (platform.key === 'douyin') {
    return stepDownloadDouyin(url, platform);
  }
  if (platform.key === 'kuaishou') {
    return stepDownloadKuaishou(url, platform);
  }
  return stepDownloadWithYtDlp(url, platform);
}

async function stepDownloadDouyin(url, platform = detectPlatform(url)) {
  console.log('  使用内置抖音无水印解析器...');
  fs.mkdirSync(WORK_DIR, { recursive: true });

  const parserPath = path.join(SCRIPTS_DIR, 'douyin_video_parser.py');
  if (!fs.existsSync(parserPath)) {
    console.error(`❌ 未找到 douyin_video_parser.py，路径：${parserPath}`);
    console.error('   请确认 skill 完整性，或重新安装 video-to-markdown skill');
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
    execFileSync('python3', ['-c', 'import requests'], { stdio: 'pipe' });
  } catch {
    console.error('❌ Python requests 库未安装！');
    console.error('   请运行：pip3 install requests');
    process.exit(1);
  }

  // 使用内嵌 Python 脚本调用 douyin_video_parser（指定输出路径）
  const outputBase = VIDEO_PATH.replace(/\.mp4$/, '');
  const outputDir  = path.dirname(VIDEO_PATH);
  const outputName = path.basename(outputBase);

  // 写一个临时 Python 调用脚本
  const tmpScript = path.join(WORK_DIR, '_dl_tmp.py');
  const pyCode = `
import sys
sys.path.insert(0, ${JSON.stringify(SCRIPTS_DIR)})
from douyin_video_parser import parse_video, download_video
import json

url = ${JSON.stringify(url)}
out_dir = ${JSON.stringify(outputDir)}
out_name = ${JSON.stringify(outputName)}

print("[下载] 解析抖音链接...")
info = parse_video(url, verbose=True)
print("[下载] 视频标题:", info['desc'][:60])
saved = download_video(info, output_path=out_name, output_dir=out_dir, verbose=True)
print("SAVED_PATH:" + saved)

# 输出视频元数据，供主脚本使用（duration 在 douyin_video_parser 中为毫秒，此处转为秒）
_ms = int(info.get('duration', 0) or info.get('video', {}).get('duration', 0) or 0)
_sec = round(_ms / 1000.0, 2) if _ms else 0
print("VIDEO_TITLE:" + info['desc'][:80])
print("VIDEO_AUTHOR:" + str(info.get('author', {}).get('nickname', '') if isinstance(info.get('author'), dict) else info.get('author', '')))
print("VIDEO_DURATION:" + str(_sec))
print("VIDEO_URL:" + url)
`;
  fs.writeFileSync(tmpScript, pyCode, 'utf-8');

  let output;
  try {
    output = execFileSync('python3', [tmpScript], { encoding: 'utf-8' });
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
  const durationMatch = output.match(/VIDEO_DURATION:([\d.]+)/);
  const urlMatch      = output.match(/VIDEO_URL:(.+)/);

  const meta = {
    title:    (titleMatch    ? titleMatch[1].trim()    : '') || DOC_TITLE,
    author:   (authorMatch   ? authorMatch[1].trim()   : ''),
    duration: (durationMatch ? parseFloat(durationMatch[1]) : 0),
    url:      (urlMatch      ? urlMatch[1].trim()      : url),
    platform: platform.label,
    platform_key: platform.key,
    downloader: 'douyin_video_parser',
  };

  fs.writeFileSync(path.join(WORK_DIR, 'video_title.txt'), meta.title, 'utf-8');
  fs.writeFileSync(path.join(WORK_DIR, 'video_meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
  console.log('  📝 视频标题：', meta.title);
  if (meta.author)   console.log('  👤 作者：', meta.author);
  if (meta.duration) console.log('  ⏱️  时长：', Number.isInteger(meta.duration) ? meta.duration : meta.duration.toFixed(1), '秒');

  return VIDEO_PATH;
}

function parseYtDlpJson(output) {
  const lines = String(output || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try { return JSON.parse(lines[i]); } catch {}
  }
  return {};
}

function findDownloadedVideo(outputDir, outputName) {
  const files = fs.readdirSync(outputDir)
    .filter(f => f.startsWith(outputName + '.'))
    .map(f => path.join(outputDir, f))
    .filter(f => {
      try { return fs.statSync(f).isFile(); } catch { return false; }
    })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] || null;
}

async function fetchTextWithUa(url, userAgent) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': 'https://www.kuaishou.com/',
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
  return r.text();
}

function extractJsonAssignment(html, marker) {
  const start = String(html || '').indexOf(marker);
  if (start < 0) return null;
  const braceStart = html.indexOf('{', start + marker.length);
  if (braceStart < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = braceStart; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return html.slice(braceStart, i + 1);
    }
  }
  return null;
}

function extractKuaishouState(html) {
  const markers = [
    'window.INIT_STATE = ',
    'window.INIT_STATE=',
    'window.__APOLLO_STATE__=',
    'window.__APOLLO_STATE__ = ',
  ];

  for (const marker of markers) {
    const jsonText = extractJsonAssignment(html, marker);
    if (!jsonText) continue;
    try {
      return JSON.parse(jsonText);
    } catch {}
  }
  return null;
}

function findKuaishouPhoto(node, seen = new Set()) {
  if (!node || typeof node !== 'object') return null;
  if (seen.has(node)) return null;
  seen.add(node);

  if (node.photo && (node.photo.mainMvUrls || node.photo.manifest)) return node.photo;
  if (node.mainMvUrls || node.manifest) return node;

  for (const value of Object.values(node)) {
    const found = findKuaishouPhoto(value, seen);
    if (found) return found;
  }
  return null;
}

function pickKuaishouVideoUrl(photo) {
  const main = Array.isArray(photo?.mainMvUrls)
    ? photo.mainMvUrls.map(item => item && item.url).find(Boolean)
    : null;
  if (main) return main;

  const sets = Array.isArray(photo?.manifest?.adaptationSet) ? photo.manifest.adaptationSet : [];
  const reps = sets.flatMap(set => Array.isArray(set.representation) ? set.representation : []);
  const sorted = reps
    .filter(rep => rep && (rep.url || (Array.isArray(rep.backupUrl) && rep.backupUrl[0])))
    .sort((a, b) => Number(b.avgBitrate || b.maxBitrate || 0) - Number(a.avgBitrate || a.maxBitrate || 0));
  const rep = sorted[0];
  return rep?.url || rep?.backupUrl?.[0] || null;
}

function normalizeKuaishouTitle(caption) {
  const text = String(caption || '').replace(/\r/g, '').trim();
  if (!text) return DOC_TITLE;
  return text.split('\n').map(s => s.trim()).find(Boolean)?.slice(0, 80) || DOC_TITLE;
}

async function downloadUrlToFile(url, outPath, headers = {}) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
  if (!r.body) throw new Error('下载响应为空');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(outPath));
}

async function stepDownloadKuaishou(input, platform) {
  let url = platform.url || extractFirstUrl(input);
  if (!url || !url.startsWith('http')) {
    console.error('❌ 未能从输入中提取有效 URL：', input);
    process.exit(1);
  }

  const resolvedUrl = await resolveRedirectUrl(url);
  if (resolvedUrl !== url) {
    console.log(`  🔗 已解析分享链接：${resolvedUrl}`);
    url = resolvedUrl;
  }

  fs.mkdirSync(WORK_DIR, { recursive: true });

  let html = '';
  for (const ua of [BROWSER_UA, YTDLP_UA]) {
    try {
      html = await fetchTextWithUa(url, ua);
      if (extractKuaishouState(html)) break;
    } catch (e) {
      console.warn('  ⚠️ 快手页面获取失败，将尝试备用 UA：', e.message);
    }
  }

  const state = extractKuaishouState(html);
  const photo = findKuaishouPhoto(state);
  const videoUrl = photo ? pickKuaishouVideoUrl(photo) : null;
  if (!videoUrl) {
    console.error('❌ 快手公开视频解析失败：页面中未找到可下载视频地址');
    console.error('   可能原因：视频私密/删除、需要登录、分享链接过期，或快手页面结构已变化。');
    process.exit(1);
  }

  const headers = {
    'User-Agent': BROWSER_UA,
    'Referer': url,
    'Accept': 'video/mp4,video/*,*/*',
  };

  try {
    await downloadUrlToFile(videoUrl, VIDEO_PATH, headers);
  } catch (e) {
    console.error('❌ 快手视频文件下载失败：', e.message);
    process.exit(1);
  }

  if (!fs.existsSync(VIDEO_PATH)) {
    console.error('❌ 视频文件未找到：', VIDEO_PATH);
    process.exit(1);
  }

  const stat = fs.statSync(VIDEO_PATH);
  if (stat.size < 1024 * 1024) {
    console.warn(`  ⚠️ 下载文件偏小（${stat.size} bytes），请确认链接是否为有效视频。`);
  }
  console.log(`✅ 视频下载完成：${VIDEO_PATH}（${(stat.size / 1024 / 1024).toFixed(1)} MB）`);

  const durationRaw = Number(photo.duration || 0);
  const meta = {
    title: normalizeKuaishouTitle(photo.caption),
    author: photo.userName || photo.user?.user_name || '',
    duration: durationRaw > 1000 ? Number((durationRaw / 1000).toFixed(2)) : durationRaw,
    url,
    webpage_url: url,
    platform: platform.label,
    platform_key: platform.key,
    downloader: 'kuaishou_public_page',
  };

  fs.writeFileSync(path.join(WORK_DIR, 'video_title.txt'), meta.title, 'utf-8');
  fs.writeFileSync(path.join(WORK_DIR, 'video_meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
  console.log('  📝 视频标题：', meta.title);
  console.log('  🌐 平台：', meta.platform);
  if (meta.author) console.log('  👤 作者：', meta.author);
  if (meta.duration) console.log('  ⏱️  时长：', Number.isInteger(meta.duration) ? meta.duration : meta.duration.toFixed(1), '秒');

  return VIDEO_PATH;
}

async function stepDownloadWithYtDlp(input, platform) {
  if (!commandExists('yt-dlp')) {
    console.error(`❌ 下载${platform.label}视频需要安装 yt-dlp`);
    console.error('   macOS：brew install yt-dlp');
    console.error('   或：pip3 install -U yt-dlp');
    console.error('   如果内容需要登录，可配置 YTDLP_COOKIES 或 YTDLP_COOKIES_FROM_BROWSER');
    process.exit(1);
  }

  let url = platform.url || extractFirstUrl(input);
  if (!url || !url.startsWith('http')) {
    console.error('❌ 未能从输入中提取有效 URL：', input);
    process.exit(1);
  }
  // Weibo's extractor accepts the original video.weibo.com URL, while its h5 redirect
  // can become unsupported by yt-dlp. Other platforms still benefit from short-link resolution.
  const resolvedUrl = platform.key === 'weibo' ? url : await resolveRedirectUrl(url);
  const normalizedUrl = normalizePlatformUrl(resolvedUrl, platform);
  if (normalizedUrl !== url) {
    console.log(`  🔗 已解析分享链接：${normalizedUrl}`);
    url = normalizedUrl;
  }

  fs.mkdirSync(WORK_DIR, { recursive: true });
  const outputDir = path.dirname(VIDEO_PATH);
  const outputName = path.basename(VIDEO_PATH, path.extname(VIDEO_PATH));
  const outputTemplate = path.join(outputDir, `${outputName}.%(ext)s`);
  const baseArgs = ytdlpBaseArgs();

  let info = {};
  try {
    const infoOut = execFileSync('yt-dlp', ['--dump-json', '--no-playlist', ...baseArgs, url], {
      encoding: 'utf-8',
      maxBuffer: 20 * 1024 * 1024,
    });
    info = parseYtDlpJson(infoOut);
  } catch (e) {
    console.warn('  ⚠️ 元数据预读取失败，将直接尝试下载：', (e.stderr && String(e.stderr).trim()) || e.message);
  }

  try {
    runFile('yt-dlp', [
      '--no-playlist',
      '--merge-output-format', 'mp4',
      '--remux-video', 'mp4',
      '-f', 'bv*+ba/best',
      '-o', outputTemplate,
      ...baseArgs,
      url,
    ]);
  } catch (e) {
    console.error(`❌ ${platform.label}视频下载失败：`, e.message);
    console.error('   如该内容需要登录，请导出 cookies 后设置 YTDLP_COOKIES，或设置 YTDLP_COOKIES_FROM_BROWSER=chrome');
    process.exit(1);
  }

  const actualPath = fs.existsSync(VIDEO_PATH) ? VIDEO_PATH : findDownloadedVideo(outputDir, outputName);
  if (!actualPath || !fs.existsSync(actualPath)) {
    console.error('❌ 下载完成后未找到视频文件：', VIDEO_PATH);
    process.exit(1);
  }
  if (path.resolve(actualPath) !== path.resolve(VIDEO_PATH)) {
    fs.copyFileSync(actualPath, VIDEO_PATH);
    console.log(`  📋 视频已复制到标准路径：${VIDEO_PATH}`);
  }

  const stat = fs.statSync(VIDEO_PATH);
  console.log(`✅ 视频下载完成：${VIDEO_PATH}（${(stat.size / 1024 / 1024).toFixed(1)} MB）`);

  const meta = {
    title: info.title || DOC_TITLE,
    author: info.uploader || info.channel || info.creator || '',
    duration: Number(info.duration || 0),
    url,
    webpage_url: info.webpage_url || url,
    platform: platform.label,
    platform_key: platform.key,
    downloader: 'yt-dlp',
  };

  fs.writeFileSync(path.join(WORK_DIR, 'video_title.txt'), meta.title, 'utf-8');
  fs.writeFileSync(path.join(WORK_DIR, 'video_meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
  console.log('  📝 视频标题：', meta.title);
  console.log('  🌐 平台：', meta.platform);
  if (meta.author) console.log('  👤 作者：', meta.author);
  if (meta.duration) console.log('  ⏱️  时长：', Number.isInteger(meta.duration) ? meta.duration : meta.duration.toFixed(1), '秒');

  return VIDEO_PATH;
}

// ══════════════════════════════════════
//  STEP 2: 提取音频（ffmpeg → 16kHz 单声道 mp3）
// ══════════════════════════════════════
async function stepAudio(videoPath) {
  console.log('\n🎵 [Step 2] 提取音频（16kHz 单声道 mp3）...');

  if (!commandExists('ffmpeg')) {
    console.error('❌ ffmpeg 未安装！');
    console.error('   macOS：  brew install ffmpeg');
    console.error('   Ubuntu： sudo apt install ffmpeg');
    process.exit(1);
  }
  if (!fs.existsSync(videoPath)) {
    console.error(`❌ 未找到视频文件：${videoPath}，请先运行 --step download`);
    process.exit(1);
  }

  runFile('ffmpeg', ['-y', '-i', videoPath, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '64k', AUDIO_PATH]);
  console.log('✅ 音频提取完成:', AUDIO_PATH);
  return AUDIO_PATH;
}

// ══════════════════════════════════════
//  STEP 3: 带时间戳转录
// ══════════════════════════════════════
async function stepTranscribe(audioPath) {
  console.log('\n🎙️ [Step 3] 带时间戳转录...');

  if (!commandExists('ffmpeg')) {
    console.error('❌ ffmpeg 未安装！');
    console.error('   macOS：  brew install ffmpeg');
    console.error('   Ubuntu： sudo apt install ffmpeg');
    process.exit(1);
  }
  if (!fs.existsSync(audioPath)) {
    console.error(`❌ 未找到音频文件：${audioPath}，请先运行 --step audio`);
    process.exit(1);
  }

  let segments = [];

  // 分段阈值（秒）
  const chunkSec = TRANSCRIBE_CHUNK_SEC;
  let audioDurationSec = null;

  // 用 ffprobe 获取音频时长；失败时保持现有单次转录行为（不做 chunk）
  if (commandExists('ffprobe')) {
    try {
      const out = execFileSync(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath],
        { stdio: 'pipe' }
      ).toString().trim();
      const sec = parseFloat(out);
      if (Number.isFinite(sec) && sec > 0) audioDurationSec = sec;
    } catch {
      audioDurationSec = null;
    }
  }

  const needChunk = audioDurationSec !== null && audioDurationSec > chunkSec;

  // 优先使用 faster-whisper（更快更省内存）
  const hasFasterWhisper = commandExists('python3') && pythonModuleExists('faster_whisper');
  const localWhisper = commandExists('whisper');

  if (needChunk) {
    console.log(`  🎛️ 检测到音频时长 ${(audioDurationSec || 0).toFixed(2)}s > 分段阈值 ${chunkSec}s，开始 chunked 转录...`);
    console.log(`  🔪 chunk 时长：${chunkSec}s（默认 600s）；将输出 wav：_tw_chunk_000.wav...`);

    // 生成 chunk wav：16kHz mono
    const chunkPattern = path.join(WORK_DIR, '_tw_chunk_%03d.wav');

    // 清理旧 chunk（避免残留干扰）
    try {
      const oldChunks = fs.readdirSync(WORK_DIR).filter(f => /^_tw_chunk_\d+\.wav$/.test(f));
      oldChunks.forEach(f => {
        try { fs.unlinkSync(path.join(WORK_DIR, f)); } catch {}
      });
    } catch {}

    runFile('ffmpeg', [
      '-y', '-i', audioPath,
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
      '-f', 'segment', '-segment_time', String(chunkSec), '-reset_timestamps', '1',
      chunkPattern,
    ]);

    const chunkFiles = (() => {
      const files = fs.readdirSync(WORK_DIR).filter(f => /^_tw_chunk_\d+\.wav$/.test(f));
      return files
        .map(f => {
          const m = f.match(/^_tw_chunk_(\d+)\.wav$/);
          return { idx: parseInt(m[1], 10), wavPath: path.join(WORK_DIR, f) };
        })
        .sort((a, b) => a.idx - b.idx);
    })();

    const chunks = chunkFiles.map(c => ({
      wavPath: c.wavPath,
      offsetSec: parseFloat((c.idx * chunkSec).toFixed(2))
    }));

    console.log(`  ✅ 已生成 ${chunks.length} 个 chunk；offsetSec 范围：${chunks[0]?.offsetSec || 0}s ~ ${chunks[chunks.length - 1]?.offsetSec || 0}s`);

    // ── 分段转录：faster-whisper ──
    if (hasFasterWhisper) {
      console.log('  使用本地 faster-whisper 分段转录（small 模型，中文）...');
      const tmpScript = path.join(WORK_DIR, '_fw_chunk_transcribe.py');
      const jsonOut = path.join(WORK_DIR, '_segments_chunked_fw.json');
      try {
        const pyChunks = chunks.map(c => ({ wav: c.wavPath, offset: c.offsetSec }));
        const pyCode = `
import json
import os
from faster_whisper import WhisperModel

chunks = ${JSON.stringify(pyChunks)}
json_path = ${JSON.stringify(jsonOut)}

model = WhisperModel(${JSON.stringify(WHISPER_MODEL)}, device="cpu", compute_type="int8")
all_segments = []

for i, ch in enumerate(chunks):
    print(f"[chunk {i+1}/{len(chunks)}] transcribing {os.path.basename(ch['wav'])} ...", flush=True)
    segs, _ = model.transcribe(ch['wav'], language="zh", vad_filter=True, beam_size=5)
    for s in segs:
        text = (s.text or "").strip()
        if not text:
            continue
        start = float(s.start) + float(ch['offset'])
        end = float(s.end) + float(ch['offset'])
        all_segments.append({
            "start": round(start, 2),
            "end": round(end, 2),
            "text": text
        })

all_segments.sort(key=lambda x: x["start"])
with open(json_path, "w", encoding="utf-8") as f:
    json.dump({"segments": all_segments}, f, ensure_ascii=False, indent=2)
`;
        fs.writeFileSync(tmpScript, pyCode, 'utf-8');
        runFile('python3', [tmpScript], { env: { ...process.env, KMP_DUPLICATE_LIB_OK: 'TRUE' } });
        if (!fs.existsSync(jsonOut)) throw new Error('未找到输出 JSON: ' + jsonOut);
        const result = JSON.parse(fs.readFileSync(jsonOut, 'utf-8'));
        segments = (result.segments || []).map(s => ({
          start: parseFloat(s.start.toFixed(2)),
          end: parseFloat(s.end.toFixed(2)),
          text: s.text.trim()
        })).filter(s => s.text.length > 0);
        segments.sort((a, b) => a.start - b.start);
        console.log(`✅ faster-whisper chunked 转录完成，共 ${segments.length} 段，时长 ${fmtTime(segments[segments.length - 1]?.end || 0)}`);
      } catch (e) {
        console.warn('⚠️  faster-whisper chunked 转录失败，尝试回退到 whisper CLI：', e.message);
      } finally {
        try { fs.unlinkSync(tmpScript); } catch {}
        try { fs.unlinkSync(jsonOut); } catch {}
      }
    }

    // ── 分段转录：本地 whisper CLI ──
    if (segments.length === 0 && localWhisper) {
      console.log('  回退：使用本地 whisper CLI 分段转录...');
      for (let i = 0; i < chunks.length; i++) {
        const ch = chunks[i];
        const chunkIdx1 = i + 1;
        const chunkJsonPath = path.join(WORK_DIR, path.basename(ch.wavPath, '.wav') + '.json');
        console.log(`    [chunk ${chunkIdx1}/${chunks.length}] ${path.basename(ch.wavPath)} (offset ${ch.offsetSec}s)`);
        try {
          // whisper CLI 会输出对应 chunk basename 的 json
          runFile('whisper', [ch.wavPath, '--model', 'small', '--language', 'zh', '--output_format', 'json', '--output_dir', WORK_DIR], {
            env: { ...process.env, KMP_DUPLICATE_LIB_OK: 'TRUE' },
          });
          if (!fs.existsSync(chunkJsonPath)) throw new Error('未找到输出 JSON: ' + chunkJsonPath);
          const result = JSON.parse(fs.readFileSync(chunkJsonPath, 'utf-8'));
          const partSegments = (result.segments || []).map(s => ({
            start: parseFloat((parseFloat(s.start) + ch.offsetSec).toFixed(2)),
            end: parseFloat((parseFloat(s.end) + ch.offsetSec).toFixed(2)),
            text: (s.text || '').trim()
          })).filter(s => s.text.length > 0);
          segments.push(...partSegments);
        } catch (e) {
          console.warn(`    ⚠️ chunk ${chunkIdx1}/${chunks.length} 转录失败：`, e.message);
        } finally {
          try { if (fs.existsSync(chunkJsonPath)) fs.unlinkSync(chunkJsonPath); } catch {}
          try { if (fs.existsSync(ch.wavPath)) fs.unlinkSync(ch.wavPath); } catch {}
        }
      }
      segments.sort((a, b) => a.start - b.start);
      console.log(`✅ 本地 whisper CLI chunked 合并完成，共 ${segments.length} 段，时长 ${fmtTime(segments[segments.length - 1]?.end || 0)}`);
    }

    // 再兜底清理 chunk wav（有些路径会提前清理，但确保不残留）
    try {
      for (const ch of chunks) {
        try { if (fs.existsSync(ch.wavPath)) fs.unlinkSync(ch.wavPath); } catch {}
      }
    } catch {}

  } else {
    // ─────────────────────────────────────────────
    // 非分段：保持现有单次转录行为完全不变
    // ─────────────────────────────────────────────

    if (hasFasterWhisper) {
      console.log('  使用本地 faster-whisper 转录（small 模型，中文）...');
      const tmpScript = path.join(WORK_DIR, '_fw_transcribe.py');
      try {
        const jsonPath = path.join(WORK_DIR, path.basename(audioPath, '.mp3') + '.json');
        const pyCode = `
import json
from faster_whisper import WhisperModel

audio_path = ${JSON.stringify(audioPath)}
json_path = ${JSON.stringify(jsonPath)}

model = WhisperModel(${JSON.stringify(WHISPER_MODEL)}, device="cpu", compute_type="int8")
segments, _ = model.transcribe(audio_path, language="zh", vad_filter=True, beam_size=5)
data = {"segments": []}
for s in segments:
    text = (s.text or "").strip()
    if not text:
        continue
    data["segments"].append({
        "start": round(float(s.start), 2),
        "end": round(float(s.end), 2),
        "text": text
    })

with open(json_path, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
`;
        fs.writeFileSync(tmpScript, pyCode, 'utf-8');
        runFile('python3', [tmpScript], { env: { ...process.env, KMP_DUPLICATE_LIB_OK: 'TRUE' } });
        if (!fs.existsSync(jsonPath)) throw new Error('未找到输出 JSON: ' + jsonPath);
        const result = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        segments = (result.segments || []).map(s => ({
          start: parseFloat(s.start.toFixed(2)),
          end:   parseFloat(s.end.toFixed(2)),
          text:  s.text.trim()
        })).filter(s => s.text.length > 0);
        console.log(`✅ faster-whisper 转录完成，共 ${segments.length} 段，时长 ${fmtTime(segments[segments.length-1]?.end || 0)}`);
      } catch (e) {
        console.warn('⚠️  faster-whisper 转录失败，尝试回退到 whisper CLI：', e.message);
      } finally {
        try { fs.unlinkSync(tmpScript); } catch {}
      }
    }

    // 回退：本地 whisper CLI
    if (segments.length === 0 && localWhisper) {
      console.log('  使用本地 whisper 转录（small 模型，中文）...');
      try {
        runFile('whisper', [audioPath, '--model', 'small', '--language', 'zh', '--output_format', 'json', '--output_dir', WORK_DIR], {
          env: { ...process.env, KMP_DUPLICATE_LIB_OK: 'TRUE' },
        });
        const jsonPath = path.join(WORK_DIR, path.basename(audioPath, '.mp3') + '.json');
        if (!fs.existsSync(jsonPath)) throw new Error('未找到输出 JSON: ' + jsonPath);
        const result = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        segments = (result.segments || []).map(s => ({
          start: parseFloat(s.start.toFixed(2)),
          end:   parseFloat(s.end.toFixed(2)),
          text:  s.text.trim()
        })).filter(s => s.text.length > 0);
        console.log(`✅ 本地 whisper 转录完成，共 ${segments.length} 段，时长 ${fmtTime(segments[segments.length-1]?.end || 0)}`);
      } catch (e) {
        console.warn('⚠️  本地 whisper 转录失败：', e.message);
      }
    }
  }

  if (segments.length === 0) {
    console.error(`
❌ 转录失败：本地 faster-whisper/whisper 不可用

请安装 faster-whisper（推荐，无需联网）：
  pip3 install faster-whisper

安装完成后重新运行：
  node video_to_markdown.js --step transcribe --work-dir <WORK_DIR>
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
   2. 修正 Whisper 转录错误（同音字、专有名词、明显错别字），保持原意
   3. 为每段写摘要（10~20 字）作为小标题
   4. 直接将 paragraphs.json 写入 ${PARAGRAPHS_PATH}
      每项格式：{ "start": 秒, "end": 秒, "text": "正文", "summary": "摘要" }
   ⚠️ 注意：后续 write 步骤会自动关联到此工作目录
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  // 检查 paragraphs.json 是否已由主 AI 写入
  if (fs.existsSync(PARAGRAPHS_PATH)) {
    const paragraphs = JSON.parse(fs.readFileSync(PARAGRAPHS_PATH, 'utf-8'));
    if (Array.isArray(paragraphs) && paragraphs.length > 0) {
      console.log(`\n✅ 检测到 paragraphs.json（${paragraphs.length} 段）`);
      paragraphs.forEach((p, i) => {
        console.log(`  [${i + 1}] ${fmtTime(p.start)}~${fmtTime(p.end)} | ${p.summary || p.title || ''}`);
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
 *   node video_to_markdown.js --step write-paragraphs --file /tmp/douyin_task/paragraphs.json
 *
 * 也支持 --data 传字符串（仅内容不含特殊字符时可用）：
 *   node video_to_markdown.js --step write-paragraphs --data '<JSON>'
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
      console.error(`  2. 执行：node video_to_markdown.js --step write-paragraphs --file <文件路径>`);
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
      console.error(`  2. node video_to_markdown.js --step write-paragraphs --file ${PARAGRAPHS_PATH}`);
      process.exit(1);
    }
  }

  if (!Array.isArray(paragraphs) || paragraphs.length === 0) {
    console.error('❌ 段落数组为空或格式错误'); process.exit(1);
  }
  fs.mkdirSync(path.dirname(PARAGRAPHS_PATH), { recursive: true });
  fs.writeFileSync(PARAGRAPHS_PATH, JSON.stringify(paragraphs, null, 2), 'utf-8');
  console.log(`✅ paragraphs.json 已写入 ${PARAGRAPHS_PATH}，共 ${paragraphs.length} 段`);
  paragraphs.forEach((p, i) => {
    console.log(`  [${i + 1}] ${fmtTime(p.start)}~${fmtTime(p.end)} | ${p.summary || p.title || ''}`);
  });
}

// ══════════════════════════════════════
//  STEP 5: 组装 output.md
// ══════════════════════════════════════
/**
 * 将 paragraphs.json 组装为纯文本 Markdown：H1 标题 + 每段 H2 摘要小标题 + 正文。
 */
function buildMarkdown(paragraphs, title) {
  let md = `# ${title}\n\n`;
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    const sectionTitle = (p.summary && p.summary.trim())
      || (p.title && p.title.trim())
      || `段落 ${i + 1}`;
    const sectionBody = (p.text || p.content || '').trim();
    md += `## ${sectionTitle}\n\n${sectionBody}\n\n`;
  }
  return md;
}

async function stepWrite(paragraphsPath, title) {
  console.log('\n📝 [Step 5] 组装 output.md ...');

  const paragraphs = JSON.parse(fs.readFileSync(paragraphsPath, 'utf-8'));
  console.log(`  段落数：${paragraphs.length}`);

  const md = buildMarkdown(paragraphs, title);
  const outPath = path.join(WORK_DIR, 'output.md');
  fs.writeFileSync(outPath, md, 'utf-8');

  console.log(`  ✅ 已生成: ${outPath}`);
  return outPath;
}


// ══════════════════════════════════════
//  主入口
// ══════════════════════════════════════
async function main() {
  if (IS_FULL || STEP === 'all' || STEP === 'download') {
    cleanupOldWorkDirs();
  }
  const needsWorkDir = IS_FULL || ['all', 'download', 'audio', 'transcribe', 'analyze', 'write-paragraphs', 'write'].includes(STEP);
  if (needsWorkDir) {
    fs.mkdirSync(WORK_DIR, { recursive: true });
  }

  if (IS_FULL || STEP === 'all') {
    checkDependencies(true);
    const videoPath   = await stepDownload(DOUYIN_URL);
    const audioPath   = await stepAudio(videoPath);
    const _segments   = await stepTranscribe(audioPath);
    await stepAnalyze(SEGMENTS_PATH);
    if (fs.existsSync(PARAGRAPHS_PATH)) {
      const outPath = await stepWrite(PARAGRAPHS_PATH, DOC_TITLE);
      console.log('\n✅ 完整流程结束！', outPath);
    } else {
      console.log('\n⏸ 请主 AI 完成语义分析后，继续执行（write 会自动检测最新目录）：');
      console.log(`   node video_to_markdown.js --step write --title "${DOC_TITLE}" --work-dir "${WORK_DIR}"`);
    }

  } else if (STEP === 'check') {
    await stepCheck();

  } else if (STEP === 'download') {
    await stepDownload(DOUYIN_URL);

  } else if (STEP === 'audio') {
    await stepAudio(VIDEO_PATH);

  } else if (STEP === 'transcribe') {
    await stepTranscribe(AUDIO_PATH);

  } else if (STEP === 'analyze') {
    await stepAnalyze(SEGMENTS_PATH);

  } else if (STEP === 'write-paragraphs') {
    const dataStr  = getArg('--data');
    const filePath = getArg('--file');
    stepWriteParagraphs(dataStr, filePath);

  } else if (STEP === 'write') {
    const { path: pPath, autoDetected } = resolveParagraphsPath('write');
    if (autoDetected) {
      console.log('  💡 提示：自动检测到已存在的 paragraphs.json，无需指定 --work-dir 或 --paragraphs');
    }
    if (!fs.existsSync(pPath)) {
      console.error('❌ 未找到 paragraphs.json，请先运行 --step analyze 并由主 AI 写入段落数据');
      process.exit(1);
    }
    await stepWrite(pPath, DOC_TITLE);

  } else {
    console.log(`
多平台视频 → 本地 Markdown 文案（抖音/快手内置解析 + yt-dlp 多平台下载；写入本地 output.md）

环境检测（推荐先运行）：
  node scripts/video_to_markdown.js --step check

流程（按顺序，--work-dir 共享同一目录）：
  WORK=/tmp/video_to_markdown_task

  1. 下载视频（平台链接或分享文案）
     node scripts/video_to_markdown.js --step download --url "<链接或分享文案>" --work-dir $WORK
     → 抖音：使用内置 douyin_video_parser
     → 快手：使用公开分享页解析器
     → 哔哩哔哩/微博/小红书：使用 yt-dlp
     → 如内容需要登录，可配置 YTDLP_COOKIES 或 YTDLP_COOKIES_FROM_BROWSER=chrome

  2. 提取音频
     node scripts/video_to_markdown.js --step audio --work-dir $WORK

  3. 本地 Whisper 转录
     node scripts/video_to_markdown.js --step transcribe --work-dir $WORK

  4. AI 语义分析 + 文案修正（主 AI 读 segments.json 后写入 paragraphs.json）
     node scripts/video_to_markdown.js --step analyze --work-dir $WORK
     node scripts/video_to_markdown.js --step write-paragraphs --file $WORK/paragraphs.json --work-dir $WORK

  5. 组装 output.md
     node scripts/video_to_markdown.js --step write --title "视频标题" --work-dir $WORK

环境变量：
  YTDLP_COOKIES             yt-dlp cookies.txt 路径
  YTDLP_COOKIES_FROM_BROWSER  从浏览器读取 cookies，例如 chrome
  TRANSCRIBE_CHUNK_SEC      转录分段阈值（秒，默认 600）
  WHISPER_MODEL             Whisper 模型名称或本地模型目录（默认 small）；受限网络可指向本地目录
  HF_ENDPOINT               HuggingFace 镜像，如 https://hf-mirror.com（首次下载模型用）
  CLEAN_OLD_WORK_DIRS       新任务启动时是否清理旧 /tmp/douyin_task_* 目录（默认 1）
    `);
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
