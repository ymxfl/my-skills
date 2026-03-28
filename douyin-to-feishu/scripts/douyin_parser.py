"""
douyin_parser.py
抖音视频无水印解析核心库

技术方案（优先级从高到低）：
  1. 移动端分享页面内嵌 JSON（无需签名/Cookie，最稳定）
  2. iesdouyin.com 旧版 Web API（需要 Cookie）
  3. douyin.com 新版 Web API（需要签名参数）
"""

import re
import json
import time
import random
import urllib.parse
from typing import Optional

import requests

# ─────────────────────────────────────────────
# 请求头配置
# ─────────────────────────────────────────────

MOBILE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) "
    "Version/17.0 Mobile/15E148 Safari/604.1"
)

PC_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)

MOBILE_HEADERS = {
    "User-Agent": MOBILE_UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Referer": "https://www.douyin.com/",
}

API_HEADERS = {
    "User-Agent": PC_UA,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": "https://www.douyin.com/",
    "Origin": "https://www.douyin.com",
}

DOWNLOAD_HEADERS = {
    "User-Agent": MOBILE_UA,
    "Referer": "https://www.douyin.com/",
    "Accept": "*/*",
    "Accept-Encoding": "identity",
}

# ─────────────────────────────────────────────
# 工具函数
# ─────────────────────────────────────────────

def extract_url_from_text(text: str) -> Optional[str]:
    """从富文本分享内容中提取 URL（支持 v.douyin.com / douyin.com / iesdouyin.com）"""
    pattern = r'https?://(?:v\.douyin\.com|www\.douyin\.com|www\.iesdouyin\.com)/\S+'
    match = re.search(pattern, text)
    return match.group(0).rstrip('/ ') if match else None


def extract_aweme_id_from_url(url: str) -> Optional[str]:
    """从 URL 中直接提取 aweme_id（适用于长链接）"""
    patterns = [
        r'/video/(\d{15,20})',
        r'/share/video/(\d{15,20})',
        r'aweme_id=(\d{15,20})',
        r'/(\d{15,20})/?$',
    ]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return None


def random_sleep(min_sec=0.5, max_sec=1.5):
    """随机延迟，模拟人类行为"""
    time.sleep(random.uniform(min_sec, max_sec))


# ─────────────────────────────────────────────
# 第一步：短链接 → aweme_id
# ─────────────────────────────────────────────

def resolve_short_url(share_text: str, timeout: int = 10) -> dict:
    """
    从分享文本解析出 aweme_id。
    
    Returns:
        {
          "aweme_id": "7123...",
          "real_url": "https://www.iesdouyin.com/share/video/...",
          "share_url": "https://v.douyin.com/xxx/",
        }
    """
    # 1. 提取 URL
    share_url = extract_url_from_text(share_text)
    if not share_url:
        # 如果传入的本身就是URL
        if share_text.startswith("http"):
            share_url = share_text.strip()
        else:
            raise ValueError(f"未能从文本中找到有效的抖音链接: {share_text!r}")

    # 2. 如果是长链接，直接提取 aweme_id
    aweme_id = extract_aweme_id_from_url(share_url)
    if aweme_id:
        return {"aweme_id": aweme_id, "real_url": share_url, "share_url": share_url}

    # 3. 短链接：跟随重定向
    session = requests.Session()
    session.max_redirects = 10

    try:
        resp = session.get(
            share_url,
            headers=MOBILE_HEADERS,
            allow_redirects=True,
            timeout=timeout
        )
        real_url = resp.url
    except requests.TooManyRedirects:
        raise RuntimeError("重定向次数过多，请检查链接是否有效")
    except requests.RequestException as e:
        raise RuntimeError(f"请求短链接失败: {e}")

    # 4. 从最终 URL 中提取 aweme_id
    aweme_id = extract_aweme_id_from_url(real_url)
    if not aweme_id:
        # 尝试从页面内容中查找
        try:
            content = resp.text
            match = re.search(r'"aweme_id"\s*:\s*"(\d{15,20})"', content)
            if match:
                aweme_id = match.group(1)
        except Exception:
            pass

    if not aweme_id:
        raise RuntimeError(f"无法从重定向地址提取视频ID，最终URL: {real_url}")

    return {"aweme_id": aweme_id, "real_url": real_url, "share_url": share_url}


# ─────────────────────────────────────────────
# 第二步：获取视频元数据（三种方案，按优先级尝试）
# ─────────────────────────────────────────────

def fetch_via_share_page(aweme_id: str, timeout: int = 15) -> Optional[dict]:
    """
    方案 A（最优）：请求移动端分享页面，解析内嵌的 window._ROUTER_DATA JSON。
    无需任何签名参数或登录 Cookie。
    """
    url = f"https://www.iesdouyin.com/share/video/{aweme_id}/"
    
    try:
        resp = requests.get(
            url,
            headers=MOBILE_HEADERS,
            timeout=timeout,
            allow_redirects=True
        )
        resp.raise_for_status()
    except requests.RequestException as e:
        print(f"  [方案A] 请求失败: {e}")
        return None

    html = resp.text

    # 尝试提取 window._ROUTER_DATA
    patterns = [
        r'window\._ROUTER_DATA\s*=\s*(\{.+?\});\s*</script>',
        r'<script[^>]*>\s*window\._ROUTER_DATA\s*=\s*(\{[\s\S]+?\})\s*</script>',
        r'window\.__INIT_PROPS__\s*=\s*(\{[\s\S]+?\})\s*</script>',
    ]

    for pattern in patterns:
        match = re.search(pattern, html)
        if match:
            try:
                raw_json = match.group(1)
                data = json.loads(raw_json)
                # 在嵌套结构中查找视频信息
                video_info = _extract_from_router_data(data, aweme_id)
                if video_info:
                    return video_info
            except json.JSONDecodeError:
                continue

    # 也尝试在整个 HTML 中搜索 aweme_detail 或 video 字段
    try:
        match = re.search(r'"aweme_detail"\s*:\s*(\{[\s\S]{100,5000}?\}),\s*"[a-z_]+":', html)
        if match:
            data = json.loads(match.group(1))
            return _normalize_aweme_detail(data)
    except Exception:
        pass

    print(f"  [方案A] 未能从页面解析到视频数据")
    return None


def _extract_from_router_data(data: dict, aweme_id: str) -> Optional[dict]:
    """递归从 _ROUTER_DATA 中查找视频信息"""
    if not isinstance(data, dict):
        return None
    
    # 常见的路径
    search_paths = [
        ["loaderData", "video_(id)/page", "videoInfoRes", "item_list", 0],
        ["loaderData", "video_[id]/page", "videoInfoRes", "item_list", 0],
        ["initialState", "awemeDetail"],
        ["aweme_detail"],
    ]
    
    for path in search_paths:
        try:
            node = data
            for key in path:
                if isinstance(key, int):
                    node = node[key]
                else:
                    node = node[key]
            if isinstance(node, dict) and "video" in node:
                return _normalize_aweme_detail(node)
        except (KeyError, IndexError, TypeError):
            continue
    
    # 深度搜索
    return _deep_search_aweme(data, aweme_id)


def _deep_search_aweme(data, aweme_id: str, depth: int = 0) -> Optional[dict]:
    """深度优先搜索 aweme_detail 数据"""
    if depth > 8:
        return None
    
    if isinstance(data, dict):
        # 如果当前节点是视频详情
        if "video" in data and ("aweme_id" in data or "desc" in data):
            vid = data.get("aweme_id", data.get("id", ""))
            if str(vid) == str(aweme_id) or not aweme_id:
                return _normalize_aweme_detail(data)
        # 递归搜索子节点
        for value in data.values():
            result = _deep_search_aweme(value, aweme_id, depth + 1)
            if result:
                return result
    elif isinstance(data, list):
        for item in data:
            result = _deep_search_aweme(item, aweme_id, depth + 1)
            if result:
                return result
    
    return None


def fetch_via_old_api(aweme_id: str, timeout: int = 10) -> Optional[dict]:
    """
    方案 B：调用旧版 iesdouyin.com API。
    部分情况下无需签名，成功率中等。
    """
    url = f"https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/"
    params = {
        "item_ids": aweme_id,
        "aid": "1128",
        "version_code": "99.99.99",
    }
    
    headers = {**API_HEADERS, "Referer": "https://www.iesdouyin.com/"}
    
    try:
        resp = requests.get(url, params=params, headers=headers, timeout=timeout)
        resp.raise_for_status()
        data = resp.json()
        
        if data.get("status_code") == 0:
            items = data.get("item_list", [])
            if items:
                return _normalize_aweme_detail(items[0])
    except Exception as e:
        print(f"  [方案B] 请求失败: {e}")
    
    return None


def fetch_via_mobile_api(aweme_id: str, timeout: int = 10) -> Optional[dict]:
    """
    方案 C：模拟移动端 API 请求（类似 yt-dlp 策略）。
    """
    url = "https://api.amemv.com/aweme/v1/feed/"
    params = {
        "aweme_id": aweme_id,
        "version_code": "250601",
        "app_name": "aweme",
        "channel": "App",
        "device_id": str(random.randint(10**18, 10**19 - 1)),
        "os_version": "14.0",
        "device_type": "iPhone12,1",
    }
    
    mobile_app_headers = {
        "User-Agent": "com.ss.iphone.ugc.Aweme/25.6.0 (iPhone; iOS 17.0; Scale/3.00)",
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate",
    }
    
    try:
        resp = requests.get(url, params=params, headers=mobile_app_headers, timeout=timeout)
        resp.raise_for_status()
        data = resp.json()
        
        aweme_list = data.get("aweme_list", [])
        for item in aweme_list:
            if str(item.get("aweme_id", "")) == str(aweme_id):
                return _normalize_aweme_detail(item)
        if aweme_list:
            return _normalize_aweme_detail(aweme_list[0])
    except Exception as e:
        print(f"  [方案C] 请求失败: {e}")
    
    return None


def _normalize_aweme_detail(item: dict) -> dict:
    """将不同来源的视频数据统一归一化为标准格式"""
    result = {
        "aweme_id": str(item.get("aweme_id", item.get("id", ""))),
        "desc": item.get("desc", item.get("title", "未知标题")),
        "create_time": item.get("create_time", 0),
        "author": {},
        "video_urls": [],       # 无水印视频地址列表
        "cover_urls": [],       # 封面图地址列表
        "music_url": "",        # 背景音乐地址
        "duration": 0,          # 视频时长（毫秒）
        "width": 0,
        "height": 0,
        "_raw": item,           # 保留原始数据供调试
    }
    
    # 作者信息
    author = item.get("author", item.get("user", {}))
    if author:
        result["author"] = {
            "uid": str(author.get("uid", author.get("user_id", ""))),
            "nickname": author.get("nickname", ""),
            "avatar": _get_first_url(author.get("avatar_thumb", author.get("avatar", {}))),
        }
    
    # 视频信息
    video = item.get("video", {})
    if video:
        result["width"] = video.get("width", 0)
        result["height"] = video.get("height", 0)
        result["duration"] = video.get("duration", 0)
        
        # 优先：通过 URI 构造的稳定播放链接（不受CDN时效影响）
        play_addr = video.get("play_addr", {})
        if play_addr:
            uri = play_addr.get("uri", "")
            if uri:
                constructed = f"https://www.iesdouyin.com/aweme/v1/play/?video_id={uri}&ratio=720p&line=0"
                result["video_urls"].append(constructed)
        
        # 其次：download_addr 直链（无水印，但CDN链接有时效性）
        download_addr = video.get("download_addr", {})
        if download_addr:
            urls = download_addr.get("url_list", [])
            for u in urls:
                if u not in result["video_urls"]:
                    result["video_urls"].append(u)
        
        # 再次：从 play_addr 转换（playwm → play）
        if play_addr:
            play_urls = play_addr.get("url_list", [])
            for u in play_urls:
                no_wm = u.replace("playwm", "play")
                if no_wm not in result["video_urls"]:
                    result["video_urls"].append(no_wm)
        
        # 封面图
        cover = video.get("cover", video.get("origin_cover", video.get("dynamic_cover", {})))
        if cover:
            result["cover_urls"] = cover.get("url_list", [])
    
    # 音乐
    music = item.get("music", {})
    if music:
        play_url = music.get("play_url", {})
        if isinstance(play_url, dict):
            urls = play_url.get("url_list", [])
            if urls:
                result["music_url"] = urls[0]
        elif isinstance(play_url, str):
            result["music_url"] = play_url
    
    return result


def _get_first_url(url_obj) -> str:
    """从 URL 对象或字符串中获取第一个 URL"""
    if isinstance(url_obj, str):
        return url_obj
    if isinstance(url_obj, dict):
        urls = url_obj.get("url_list", [])
        return urls[0] if urls else ""
    if isinstance(url_obj, list):
        return url_obj[0] if url_obj else ""
    return ""


# ─────────────────────────────────────────────
# 主入口：解析视频（多方案自动 fallback）
# ─────────────────────────────────────────────

def parse_video(share_text: str, verbose: bool = True) -> dict:
    """
    完整解析流程入口。
    
    Args:
        share_text: 抖音分享文本或 URL
        verbose: 是否打印详细日志
    
    Returns:
        标准化的视频信息字典，包含 video_urls、cover_urls 等字段
    
    Raises:
        RuntimeError: 所有方案均失败时抛出
    """
    def log(msg):
        if verbose:
            print(msg)
    
    # 步骤1：提取 aweme_id
    log(f"\n{'='*50}")
    log(f"[解析中] 输入: {share_text[:80]}...")
    log(f"{'='*50}")
    
    log("\n[步骤1] 解析链接，提取视频ID...")
    url_info = resolve_short_url(share_text)
    aweme_id = url_info["aweme_id"]
    log(f"  ✓ aweme_id = {aweme_id}")
    log(f"  ✓ 真实链接 = {url_info['real_url']}")
    
    # 步骤2：获取视频数据（三方案依次尝试）
    log("\n[步骤2] 获取视频元数据...")
    
    video_info = None
    
    # 方案A：移动端分享页面内嵌JSON
    log("  尝试方案A（分享页面内嵌JSON）...")
    video_info = fetch_via_share_page(aweme_id)
    if video_info and video_info.get("video_urls"):
        log("  ✓ 方案A 成功")
    else:
        # 方案B：旧版 Web API
        log("  方案A失败，尝试方案B（旧版API）...")
        random_sleep(0.5, 1.0)
        video_info = fetch_via_old_api(aweme_id)
        if video_info and video_info.get("video_urls"):
            log("  ✓ 方案B 成功")
        else:
            # 方案C：移动端APP API
            log("  方案B失败，尝试方案C（移动端API）...")
            random_sleep(0.5, 1.0)
            video_info = fetch_via_mobile_api(aweme_id)
            if video_info and video_info.get("video_urls"):
                log("  ✓ 方案C 成功")
            else:
                raise RuntimeError(
                    f"所有解析方案均失败，视频ID: {aweme_id}。"
                    "可能原因：视频已删除、仅限私信、或接口已更新。"
                )
    
    # 步骤3：验证并输出结果
    log("\n[步骤3] 解析结果：")
    log(f"  标题    : {video_info['desc'][:50]}")
    log(f"  作者    : {video_info['author'].get('nickname', '未知')}")
    log(f"  视频尺寸: {video_info['width']}x{video_info['height']}")
    log(f"  时长    : {video_info['duration'] / 1000:.1f}s" if video_info['duration'] else "  时长    : 未知")
    log(f"  视频链接: {len(video_info['video_urls'])} 个")
    for i, url in enumerate(video_info['video_urls'][:3], 1):
        log(f"    [{i}] {url[:80]}...")
    
    return video_info


# ─────────────────────────────────────────────
# 下载功能
# ─────────────────────────────────────────────

def download_video(
    video_info: dict,
    output_path: str = None,
    output_dir: str = None,
    verbose: bool = True
) -> str:
    """
    下载无水印视频到本地文件。
    
    Args:
        video_info:  parse_video() 返回的视频信息
        output_path: 保存路径（不含扩展名）。可以是绝对路径或相对路径。
                     若同时指定了 output_dir，则 output_path 只取文件名部分。
                     默认使用"视频标题_aweme_id"。
        output_dir:  输出目录。若指定，文件会保存到该目录下。
                     目录不存在时自动创建。
        verbose:     是否显示进度
    
    Returns:
        保存的文件绝对路径
    """
    import os as _os

    def log(msg):
        if verbose:
            print(msg)
    
    urls = video_info.get("video_urls", [])
    if not urls:
        raise RuntimeError("没有可用的视频链接")
    
    # ── 生成最终保存路径 ──────────────────────────────────────
    if output_path:
        # 用户指定了路径
        basename = _os.path.basename(output_path)          # 取文件名部分
        if not basename:
            basename = output_path                          # 纯文件名时直接用
        # 去掉 .mp4 后缀（若用户已带上），统一在末尾追加
        if basename.lower().endswith(".mp4"):
            basename = basename[:-4]
    else:
        # 自动生成文件名：标题 + aweme_id
        title = video_info.get("desc", "video")
        title = re.sub(r'[\\/:*?"<>|#@\n\r]', '_', title)[:50].strip()
        aweme_id = video_info.get("aweme_id", "unknown")
        basename = f"{title}_{aweme_id}"
    
    # 确定目录
    if output_dir:
        save_dir = _os.path.abspath(output_dir)
        _os.makedirs(save_dir, exist_ok=True)
    elif output_path and _os.path.dirname(output_path):
        # output_path 本身包含目录部分
        save_dir = _os.path.abspath(_os.path.dirname(output_path))
        _os.makedirs(save_dir, exist_ok=True)
    else:
        save_dir = _os.getcwd()
    
    save_path = _os.path.join(save_dir, f"{basename}.mp4")
    
    log(f"\n[下载中] 目标文件: {save_path}")
    
    # 逐个尝试视频链接
    for i, url in enumerate(urls, 1):
        log(f"  尝试链接 [{i}/{len(urls)}]...")
        try:
            resp = requests.get(
                url,
                headers=DOWNLOAD_HEADERS,
                stream=True,
                timeout=30,
                allow_redirects=True
            )
            
            if resp.status_code != 200:
                log(f"  ✗ HTTP {resp.status_code}，跳过")
                continue
            
            content_type = resp.headers.get("Content-Type", "")
            if "video" not in content_type and "octet-stream" not in content_type and "mp4" not in content_type:
                # 如果不是视频内容，可能是重定向到了广告页或错误页
                if "text/html" in content_type:
                    log(f"  ✗ 返回了HTML页面（可能需要登录），跳过")
                    continue
            
            total_size = int(resp.headers.get("Content-Length", 0))
            downloaded = 0
            
            with open(save_path, "wb") as f:
                for chunk in resp.iter_content(chunk_size=1024 * 64):
                    if chunk:
                        f.write(chunk)
                        downloaded += len(chunk)
                        if verbose and total_size > 0:
                            progress = downloaded / total_size * 100
                            print(f"\r  进度: {progress:.1f}% ({downloaded/1024/1024:.1f}MB / {total_size/1024/1024:.1f}MB)", end="", flush=True)
            
            if verbose:
                print()  # 换行
            
            # 验证文件大小
            file_size = _os.path.getsize(save_path)
            if file_size < 10240:  # 小于10KB认为下载失败
                log(f"  ✗ 文件过小 ({file_size} bytes)，可能是错误页面，跳过")
                _os.remove(save_path)
                continue
            
            log(f"  ✓ 下载成功！文件大小: {file_size/1024/1024:.2f}MB")
            return _os.path.abspath(save_path)
        
        except requests.RequestException as e:
            log(f"  ✗ 下载出错: {e}，尝试下一个链接")
            continue
    
    raise RuntimeError(f"所有视频链接均下载失败，请检查网络或稍后重试")


if __name__ == "__main__":
    # 快速测试
    test_text = "8.46 复制打开抖音，看看【基普乔华的作品】内容变现新时代：AiToEarn 来了# 变现 #... https://v.douyin.com/SgnkhzW73Ww/ B@t.re 03/21 jCu:/"
    info = parse_video(test_text)
    print("\n[完整解析结果]")
    print(json.dumps({k: v for k, v in info.items() if k != "_raw"}, ensure_ascii=False, indent=2))
