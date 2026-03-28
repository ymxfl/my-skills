---
name: douyin-downloader
description: >
  抖音视频无水印下载工具。当用户想要下载抖音视频、解析抖音分享链接、获取无水印视频地址时使用。
  支持 v.douyin.com 短链接、完整分享文案、douyin.com 长链接。
  触发词示例：下载抖音视频、抖音去水印、解析抖音链接、douyin download。
---

# Douyin Downloader Skill

解析抖音分享链接，提取无水印视频地址，支持直接下载到本地。

## 脚本位置

所有脚本位于本 skill 的 `scripts/` 目录：

- `scripts/douyin_parser.py` — 核心解析库（直接 import 使用）
- `scripts/douyin_dl.py` — 命令行工具（直接执行）

## 依赖安装

```bash
pip install requests flask   # flask 仅 Web 服务需要
```

## 核心工作流

### 方式 A：让 AI 调用 Python 代码执行下载（推荐）

当用户给出抖音链接时，直接用 `execute_command` 调用脚本：

```bash
# 基本用法（下载到当前目录）
python3 <skill_scripts_dir>/douyin_dl.py "<分享链接或文案>"

# 指定输出目录
python3 <skill_scripts_dir>/douyin_dl.py "<链接>" -d ~/Downloads

# 指定目录 + 自定义文件名
python3 <skill_scripts_dir>/douyin_dl.py "<链接>" -d ~/Downloads -o my_video

# 仅解析，不下载（返回视频信息和链接）
python3 <skill_scripts_dir>/douyin_dl.py "<链接>" --info-only

# JSON 格式输出（便于程序解析）
python3 <skill_scripts_dir>/douyin_dl.py "<链接>" --json
```

**参数说明：**

| 参数 | 说明 |
|------|------|
| `<input>` | 抖音分享链接或包含链接的完整分享文案 |
| `-o FILENAME` | 输出文件名（不含 .mp4），支持绝对路径 |
| `-d DIR` | 输出目录，不存在时自动创建 |
| `--info-only` | 仅解析元数据，不下载文件 |
| `--json` | 以 JSON 格式输出解析结果 |
| `-q` | 安静模式 |

### 方式 B：在 Python 代码中调用解析库

```python
import sys
sys.path.insert(0, "<skill_scripts_dir>")
from douyin_parser import parse_video, download_video

# 解析视频信息
info = parse_video("https://v.douyin.com/SgnkhzW73Ww/")

# 下载到指定目录
save_path = download_video(
    info,
    output_dir="/Users/me/Downloads",   # 输出目录
    output_path="my_video",              # 文件名（可选）
)
print(f"已保存至: {save_path}")
```

**`download_video` 参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `video_info` | dict | `parse_video()` 的返回值 |
| `output_path` | str\|None | 文件名或绝对路径（不含 .mp4）。若含目录部分，`output_dir` 会被忽略 |
| `output_dir` | str\|None | 输出目录。不存在时自动创建。默认当前目录 |
| `verbose` | bool | 是否显示下载进度（默认 True） |

**返回值：** 已保存文件的绝对路径字符串。

## 技术说明

### 三方案 Fallback 机制

解析器依次尝试以下三种方案，成功即返回：

1. **方案 A**（最优）：请求 `iesdouyin.com/share/video/{id}/`，解析页面内嵌 `window._ROUTER_DATA` JSON，无需任何签名参数或 Cookie。
2. **方案 B**：调用旧版 `iesdouyin.com/web/api/v2/aweme/iteminfo/` Web API。
3. **方案 C**：模拟 iOS APP 请求 `api.amemv.com/aweme/v1/feed/`。

### 无水印链接优先级

1. URI 构造链接 `iesdouyin.com/aweme/v1/play/?video_id={uri}` — 稳定，不受 CDN 时效影响
2. `download_addr` 直链 — 无水印但 CDN 链接有时效性
3. `play_addr` 替换 `playwm→play` — 备用

### 链接类型支持

- `https://v.douyin.com/xxxxx/` — 短链接（自动跟随 302 重定向）
- `https://www.douyin.com/video/7123456789012345678` — 长链接
- `8.46 复制打开抖音...https://v.douyin.com/xxxxx/...` — 富文本分享文案（自动提取 URL）

## 常见问题

- **所有方案失败**：视频可能已删除、设为私密，或接口有更新，可稍后重试。
- **下载链接 404**：CDN 直链有时效性（通常几分钟），建议使用 URI 构造链接（列表第1个）。
- **文件大小 < 10KB**：自动判定为无效，跳过该链接尝试下一个。
