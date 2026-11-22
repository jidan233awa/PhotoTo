"""PhotoTo - 局域网手机拍照/传图到电脑。

用法:
    python main.py                  # 默认端口 5000，保存到 ./data/png
    python main.py --port 8080 --dir D:/Photos
    python main.py --idle-exit 30   # 30 分钟无任何访问自动退出
    python main.py --no-browser     # 启动时不自动打开管理页面
"""
import argparse
import os
import sys
import webbrowser

from phototo import __version__
from phototo.server import IdleExit, PhotoServer
from phototo.storage import Library


def _app_dir():
    """定位程序所在目录：Nuitka 单文件/独立模式指向可执行文件目录，源码模式指向脚本目录。"""
    if '__compiled__' in globals():
        containing = getattr(__compiled__, 'containing_dir', None)
        if containing:
            return os.path.abspath(containing)
        return os.path.dirname(os.path.abspath(sys.argv[0]))
    if getattr(sys, 'frozen', False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


DEFAULT_DIR = os.path.join(_app_dir(), 'data', 'png')


def parse_args():
    p = argparse.ArgumentParser(description='PhotoTo 局域网照片互传')
    p.add_argument('-V', '--version', action='version', version=f'PhotoTo {__version__}')
    p.add_argument('--port', type=int, default=5000, help='监听端口（被占用时自动顺延），默认 5000')
    p.add_argument('--host', default='0.0.0.0', help='监听地址，默认 0.0.0.0')
    p.add_argument('--dir', default=DEFAULT_DIR, help='照片保存目录，默认 ./data/png')
    p.add_argument('--max-size', type=int, default=500, help='单个文件大小上限 (MB)，默认 500')
    p.add_argument('--idle-exit', type=int, default=0, metavar='MIN', help='无访问 N 分钟后自动退出，0 为不退出')
    p.add_argument('--no-browser', action='store_true', help='启动时不打开电脑端管理页面')
    p.add_argument('--reset-pin', action='store_true', help='应急关闭用户侧与管理员侧 PIN 码锁')
    p.add_argument('-v', '--verbose', action='store_true', help='输出每个请求的日志')
    return p.parse_args()


def create_server(args, library):
    last_err = None
    for port in range(args.port, args.port + 20):
        try:
            return PhotoServer((args.host, port), library, args.idle_exit, args.verbose)
        except OSError as e:
            last_err = e
    raise SystemExit(f'无法监听端口 {args.port}~{args.port + 19}: {last_err}')


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(errors='replace')
    args = parse_args()
    library = Library(args.dir, max_upload_mb=args.max_size)
    if args.reset_pin:
        library.disable_all_pins()
        print(' [提示] 已重置并关闭所有 PIN 码锁')
    server = create_server(args, library)
    admin_url = f'http://127.0.0.1:{server.port}/admin'

    print('=' * 52)
    print(' PhotoTo 已启动')
    print('-' * 52)
    for url in server.phone_urls():
        print(f' 手机访问:  {url}')
    print(f' 电脑管理:  {admin_url}')
    print(f' 保存目录:  {library.root}')
    if not library.has_pil:
        print(' 提示: 未安装 Pillow，管理页面将直接加载原图（pip install Pillow）')
    if args.idle_exit:
        print(f' 空闲 {args.idle_exit} 分钟无访问将自动退出')
    print(' 按 Ctrl+C 退出')
    print('=' * 52)

    if not args.no_browser:
        webbrowser.open(admin_url)

    try:
        # poll_interval 越大空闲唤醒越少；仅影响退出响应速度
        server.serve_forever(poll_interval=1.0)
    except KeyboardInterrupt:
        print('\n已退出')
    except IdleExit:
        print(f'\n{args.idle_exit} 分钟无访问，已自动退出')
    finally:
        server.server_close()


if __name__ == '__main__':
    main()