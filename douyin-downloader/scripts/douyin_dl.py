#!/usr/bin/env python3
"""
douyin_dl.py
抖音视频无水印下载 - 命令行工具

用法示例：
  python douyin_dl.py "https://v.douyin.com/iXxxxxx/"
  python douyin_dl.py "https://v.douyin.com/iXxxxxx/" -o my_video
  python douyin_dl.py "https://v.douyin.com/iXxxxxx/" -d ~/Downloads
  python douyin_dl.py "https://v.douyin.com/iXxxxxx/" -d ~/Downloads -o clip
  python douyin_dl.py "https://v.douyin.com/iXxxxxx/" --info-only
  python douyin_dl.py "分享文案...https://v.douyin.com/iXxxxxx/..." --json
"""

import argparse
import json
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from douyin_parser import parse_video, download_video


def print_banner():
    banner = """
╔══════════════════════════════════════════════════════╗
║         抖音视频无水印下载工具  v1.1                  ║
║         支持 v.douyin.com 短链接及富文本分享           ║
╚══════════════════════════════════════════════════════╝
"""
    print(banner)


def print_video_info(info: dict):
    """格式化打印视频信息"""
    print("\n" + "─" * 55)
    print(f"  标题    : {info['desc'][:60]}")
    print(f"  作者    : {info['author'].get('nickname', '未知')}")
    print(f"  视频ID  : {info['aweme_id']}")
    if info['duration']:
        print(f"  时长    : {info['duration'] / 1000:.1f} 秒")
    if info['width'] and info['height']:
        print(f"  分辨率  : {info['width']} x {info['height']}")
    print("─" * 55)

    print(f"\n  无水印视频链接 ({len(info['video_urls'])} 个):")
    for i, url in enumerate(info['video_urls'], 1):
        print(f"    [{i}] {url}")

    if info['cover_urls']:
        print(f"\n  封面图链接:")
        print(f"    {info['cover_urls'][0]}")

    if info['music_url']:
        print(f"\n  背景音乐:")
        print(f"    {info['music_url']}")

    print()


def main():
    print_banner()

    parser = argparse.ArgumentParser(
        description="抖音视频无水印下载工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  %(prog)s "https://v.douyin.com/SgnkhzW73Ww/"
  %(prog)s "https://v.douyin.com/SgnkhzW73Ww/" -d ~/Downloads
  %(prog)s "https://v.douyin.com/SgnkhzW73Ww/" -d ~/Downloads -o my_clip
  %(prog)s "分享文案...https://v.douyin.com/SgnkhzW73Ww/..." --info-only
  %(prog)s "https://v.douyin.com/SgnkhzW73Ww/" --json
        """
    )

    parser.add_argument(
        "input",
        help="抖音分享链接或包含链接的分享文本"
    )
    parser.add_argument(
        "-o", "--output",
        default=None,
        metavar="FILENAME",
        help="输出文件名（不含扩展名）。默认使用视频标题+ID。"
             "可以是绝对路径，此时 -d 参数会被忽略。"
    )
    parser.add_argument(
        "-d", "--output-dir",
        default=None,
        metavar="DIR",
        help="输出目录。目录不存在时自动创建。"
             "默认为当前工作目录。"
    )
    parser.add_argument(
        "--info-only",
        action="store_true",
        help="仅解析并显示视频信息，不下载"
    )
    parser.add_argument(
        "--json",
        action="store_true",
        dest="output_json",
        help="以 JSON 格式输出解析结果（不下载）"
    )
    parser.add_argument(
        "--quiet", "-q",
        action="store_true",
        help="安静模式，减少输出（仍会打印最终文件路径）"
    )

    args = parser.parse_args()
    verbose = not args.quiet

    try:
        # 解析视频元数据
        info = parse_video(args.input, verbose=verbose)

        if args.output_json:
            output = {k: v for k, v in info.items() if k != "_raw"}
            print(json.dumps(output, ensure_ascii=False, indent=2))
            return

        if not args.quiet:
            print_video_info(info)

        if args.info_only:
            print("✓ 解析完成（仅信息模式，不下载）")
            return

        # 下载视频
        save_path = download_video(
            info,
            output_path=args.output,
            output_dir=args.output_dir,
            verbose=verbose,
        )
        print(f"\n✓ 视频已保存至: {save_path}")

    except ValueError as e:
        print(f"\n✗ 输入错误: {e}", file=sys.stderr)
        sys.exit(1)
    except RuntimeError as e:
        print(f"\n✗ 解析失败: {e}", file=sys.stderr)
        sys.exit(2)
    except KeyboardInterrupt:
        print("\n\n已取消", file=sys.stderr)
        sys.exit(130)


if __name__ == "__main__":
    main()
