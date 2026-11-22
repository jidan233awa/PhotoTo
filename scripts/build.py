"""PhotoTo 跨平台 Nuitka 单文件打包脚本（Windows x64 / Linux x64 & ARM64）。

本地打包前置依赖（建议 Python 3.12+）:
    pip install --upgrade Pillow nuitka ordered-set zstandard

用法:
    python scripts/build.py
    python scripts/build.py --output-dir dist --output-name PhotoTo-windows-x64.exe
    python scripts/build.py --dry-run
"""
import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 剥离未使用的标准库与 Pillow GUI/桌面抓图模块，显著减小单文件体积
EXCLUDED_MODULES = (
    # GUI / 文档 / 测试工具
    'tkinter',
    '_tkinter',
    'turtle',
    'turtledemo',
    'idlelib',
    'unittest',
    'pydoc',
    'doctest',
    'test',
    # 打包与虚拟环境工具
    'venv',
    'ensurepip',
    'pip',
    'setuptools',
    'distutils',
    # 未使用的数据库与网络协议栈
    'sqlite3',
    'xmlrpc',
    'ftplib',
    'imaplib',
    'poplib',
    'smtplib',
    # Pillow 中不需要的 GUI 桥接模块
    'PIL.ImageTk',
    'PIL.ImageQt',
    'PIL.ImageShow',
    'PIL.ImageWin',
    'PIL.ImageGrab',
)


def read_version() -> str:
    init_file = ROOT / 'phototo' / '__init__.py'
    text = init_file.read_text(encoding='utf-8')
    m = re.search(r"__version__\s*=\s*['\"]([^'\"]+)['\"]", text)
    return m.group(1) if m else '0.0.0'


def to_windows_version(ver: str) -> str:
    """将语义化版本（如 1.0.0-rc.1）转为 Windows PE 要求的 4 段数字版本（1.0.0.1）。"""
    nums = [int(n) for n in re.findall(r'\d+', ver)]
    while len(nums) < 4:
        nums.append(0)
    return '.'.join(str(n) for n in nums[:4])


def build_command(args, version: str) -> list[str]:
    is_win = sys.platform == 'win32'
    default_name = 'PhotoTo.exe' if is_win else 'PhotoTo'
    out_name = args.output_name or default_name
    out_dir = str((ROOT / args.output_dir).resolve())

    # 开启持久化解压缓存：首次解压后复用缓存目录，避免每次启动重复写盘
    # Windows -> %LOCALAPPDATA%\PhotoTo\<version>
    # Linux   -> $XDG_CACHE_HOME/PhotoTo/<version> (默认 ~/.cache/PhotoTo/<version>)
    cache_spec = f'{{CACHE_DIR}}/PhotoTo/{version}'

    cmd = [
        sys.executable,
        '-m',
        'nuitka',
        '--onefile',
        f'--onefile-tempdir-spec={cache_spec}',
        '--assume-yes-for-downloads',
        '--remove-output',
        f'--lto={args.lto}',
        f'--output-dir={out_dir}',
        f'--output-filename={out_name}',
        '--include-data-dir=phototo/web=phototo/web',
        '--include-package=PIL',
    ]

    if args.jobs:
        cmd.append(f'--jobs={args.jobs}')

    for mod in EXCLUDED_MODULES:
        cmd.append(f'--nofollow-import-to={mod}')

    if is_win:
        win_ver = to_windows_version(version)
        cmd.extend([
            '--windows-console-mode=force',
            '--company-name=CRWorld',
            '--product-name=PhotoTo',
            '--file-description=PhotoTo LAN Photo Transfer',
            f'--product-version={win_ver}',
            f'--file-version={win_ver}',
        ])

    cmd.append('main.py')
    return cmd


def main() -> int:
    parser = argparse.ArgumentParser(description='使用 Nuitka 打包 PhotoTo 单文件可执行程序')
    parser.add_argument('--output-dir', default='dist', help='产物输出目录，默认 dist')
    parser.add_argument('--output-name', default='', help='输出文件名，默认 PhotoTo(.exe)')
    parser.add_argument('--lto', choices=('yes', 'no', 'auto'), default='yes', help='是否开启 LTO 链接时优化，默认 yes')
    parser.add_argument('--jobs', type=int, default=0, help='并行编译线程数（0 为自动）')
    parser.add_argument('--dry-run', action='store_true', help='仅打印 Nuitka 命令，不实际编译')
    args = parser.parse_args()

    version = read_version()
    cmd = build_command(args, version)

    print(f'[PhotoTo Build] version={version} platform={sys.platform}')
    print('[PhotoTo Build] command:')
    print('  ' + ' '.join(cmd))

    if args.dry_run:
        return 0

    proc = subprocess.run(cmd, cwd=str(ROOT))
    return proc.returncode


if __name__ == '__main__':
    raise SystemExit(main())
