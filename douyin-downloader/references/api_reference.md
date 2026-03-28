# API Reference — douyin_parser.py

## parse_video(share_text, verbose=True) → dict

从分享文本或 URL 解析抖音视频完整信息。

### 返回结构

```python
{
  "aweme_id": "7621924750243713716",   # 视频唯一ID（19位）
  "desc": "视频标题文案",
  "create_time": 1774617646,           # Unix时间戳
  "author": {
    "uid": "76127084506",
    "nickname": "作者昵称",
    "avatar": "https://..."
  },
  "video_urls": [                      # 无水印视频地址（优先级由高到低）
    "https://www.iesdouyin.com/aweme/v1/play/?video_id=...",  # URI构造，最稳定
    "https://v26-default.365yg.com/...",                       # CDN直链
    ...
  ],
  "cover_urls": ["https://..."],       # 封面图地址列表
  "music_url": "https://...mp3",       # 背景音乐
  "duration": 10055,                   # 时长（毫秒）
  "width": 832,
  "height": 1104,
  "_raw": {...}                        # 原始API响应数据（调试用）
}
```

## download_video(video_info, output_path=None, output_dir=None, verbose=True) → str

下载无水印视频文件。

- 自动逐个尝试 `video_urls` 中的链接，直到下载成功
- 文件大小 < 10KB 视为无效，自动跳过
- 返回已保存文件的**绝对路径**

## resolve_short_url(share_text, timeout=10) → dict

仅解析短链接，提取 aweme_id，不获取视频详情。

```python
{
  "aweme_id": "7621924750243713716",
  "real_url": "https://www.iesdouyin.com/share/video/...",
  "share_url": "https://v.douyin.com/SgnkhzW73Ww/"
}
```
