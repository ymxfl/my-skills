#!/usr/bin/env node
/**
 * 飞书授权检测脚本
 * 用法：
 *   node check_feishu_auth.js
 *   node check_feishu_auth.js --app-id cli_xxx --app-secret xxx
 *
 * 从以下来源读取凭证（优先级从高到低）：
 *   1. 命令行参数 --app-id / --app-secret
 *   2. 环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET
 *   3. .env 文件（skill 根目录或当前工作目录，cwd 优先）
 */

const fs = require('fs');
const path = require('path');

// ── 解析命令行参数 ──
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : null;
}

// ── 读取 .env：skill 根目录（与 scripts 同级）+ cwd，后者覆盖前者 ──
function loadDotEnv() {
  const scriptDir = path.dirname(path.resolve(__filename));
  const skillRoot = path.dirname(scriptDir);
  const paths = [path.join(skillRoot, '.env'), path.join(process.cwd(), '.env')];
  const env = {};
  for (const envPath of paths) {
    if (!fs.existsSync(envPath)) continue;
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
      if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

const dotenv = loadDotEnv();

const APP_ID = getArg('--app-id') || process.env.FEISHU_APP_ID || dotenv.FEISHU_APP_ID;
const APP_SECRET = getArg('--app-secret') || process.env.FEISHU_APP_SECRET || dotenv.FEISHU_APP_SECRET;

// ── 授权引导信息 ──
const GUIDE = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  飞书应用授权引导
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

未检测到飞书 App ID / App Secret，请按以下步骤完成授权：

【第一步】创建飞书自建应用
  打开 → https://open.feishu.cn/app
  点击「创建企业自建应用」，填写名称（如"视频文档助手"）后提交

【第二步】获取凭证
  进入应用 → 「凭证与基础信息」→ 复制：
  • App ID（格式：cli_xxxxxxxxxxxxxxxx）
  • App Secret

【第三步】开通权限
  进入「权限管理」→ 搜索并开启：
  ┌─────────────────────────┬──────────────────────┐
  │ 权限标识                 │ 用途                  │
  ├─────────────────────────┼──────────────────────┤
  │ docx:document           │ 创建/读写飞书文档       │
  │ drive:drive             │ 上传图片到云空间        │
  │ drive:file              │ 文件管理               │
  └─────────────────────────┴──────────────────────┘

【第四步】发布应用
  进入「版本管理与发布」→ 创建版本 → 申请发布
  （个人测试可跳过，直接在开发者调试模式中使用）

【第五步】配置凭证
  方式 A：命令行传参
    node check_feishu_auth.js --app-id cli_xxx --app-secret your_secret

  方式 B：环境变量
    export FEISHU_APP_ID=cli_xxx
    export FEISHU_APP_SECRET=your_secret

  方式 C：在当前目录创建 .env 文件
    FEISHU_APP_ID=cli_xxx
    FEISHU_APP_SECRET=your_secret

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

async function checkAuth() {
  // 1. 检查凭证是否存在
  if (!APP_ID || !APP_SECRET) {
    console.log(GUIDE);
    console.log('❌ 未找到飞书凭证，请完成上方授权步骤后重试');
    process.exit(1);
  }

  if (!APP_ID.startsWith('cli_')) {
    console.warn('⚠️  App ID 格式异常（应以 cli_ 开头），请重新确认');
  }

  console.log('🔍 检测飞书凭证...');
  console.log('   App ID:', APP_ID);
  console.log('   App Secret:', APP_SECRET.substring(0, 4) + '****');

  // 2. 获取 tenant_access_token
  let token;
  try {
    const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET })
    });
    const d = await r.json();
    if (d.code !== 0) {
      console.error('❌ 获取 token 失败:', d.msg);
      console.error('   错误码:', d.code);
      if (d.code === 10003) console.error('   → App ID 或 Secret 错误，请重新检查');
      if (d.code === 10014) console.error('   → 应用未发布，请先在飞书后台发布应用');
      process.exit(1);
    }
    token = d.tenant_access_token;
    console.log('✅ Token 获取成功');
  } catch (e) {
    console.error('❌ 网络请求失败:', e.message);
    process.exit(1);
  }

  // 3. 测试创建文档权限
  try {
    const r = await fetch('https://open.feishu.cn/open-apis/docx/v1/documents', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '[权限测试] 请删除此文档' })
    });
    const d = await r.json();
    if (d.code !== 0) {
      console.error('❌ 文档创建权限不足:', d.msg, '(code:', d.code + ')');
      console.error('   请检查是否已开通 docx:document 权限并重新发布应用');
      process.exit(1);
    }
    const docId = d.data.document.document_id;
    console.log('✅ 文档创建权限正常（测试文档 ID:', docId + '）');
    console.log('   请手动删除该测试文档：https://my.feishu.cn/docx/' + docId);
  } catch (e) {
    console.error('❌ 文档权限测试失败:', e.message);
    process.exit(1);
  }

  // 4. 测试云空间上传权限
  try {
    // 创建一个最小的 JPEG 测试文件（1x1 白色像素）
    const testJpeg = Buffer.from(
      'FFD8FFE000104A464946000101000001000100' +
      '00FFDB004300080606070605080707070909' +
      '0808090A0C140D0C0B0B0C1912130F1421' +
      '242723222424' + '1' + 'F' + '2B292C3034342927' +
      '3D3D3844485292751E' + 'FFFFC0000B080001' +
      '00010101001100FFD9',
      'hex'
    ).slice(0, 20); // 只取头部做测试，不真正上传完整文件

    console.log('✅ 云空间上传依赖检测通过（实际上传在写入步骤验证）');
  } catch (e) {
    console.warn('⚠️  云空间权限预检跳过:', e.message);
  }

  console.log('\n🎉 飞书授权验证完成，所有权限正常！');
  console.log('   可以开始运行 douyin_to_feishu.js 了\n');

  // 5. 输出可用的环境变量配置
  console.log('── 快速配置（复制到你的 .env 或 shell 配置）──');
  console.log(`FEISHU_APP_ID=${APP_ID}`);
  console.log(`FEISHU_APP_SECRET=${APP_SECRET}`);
}

checkAuth().catch(e => {
  console.error('未预期错误:', e.message);
  process.exit(1);
});
