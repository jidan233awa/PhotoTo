# PhotoTo

局域网照片、文件和文字互传工具。

在电脑上启动后，手机扫码打开网页就能把照片、任意文件或文字直接传到电脑，不需要装 App，也不经过公网。

## 功能

- **手机端上传（`/`）**：支持批量上传照片和任意文件，可选择保留原文件名，支持发送文字便签。
- **电脑端管理（`/admin`）**：仅限本机访问，实时同步收到的内容。
  - 图片预览、纯前端预览旋转（不改原文件）、查看 EXIF、一键复制到剪贴板。
  - 重命名、本地文件夹定位、单文件下载和批量 ZIP 打包下载。
  - 文字便签支持收发、编辑、拖拽排序、复制和清空。
  - 回收站支持还原、彻底删除、清空和清理孤儿缩略图。
- **双端多 PIN 码**：用户侧（上传）和管理员侧（打开管理端）独立控制，可配置多个 PIN 并单独启停。
- **轻量运行**：后端仅用 Python 标准库（可选 Pillow 生成缩略图和读 EXIF），前端零框架、无外部 CDN，上传流式写盘。

## 使用方法

### 直接运行预编译版本

从 [Releases](../../releases) 下载对应平台的单文件程序：

- Windows (x64): `PhotoTo-windows-x64.exe`
- Linux (x64): `PhotoTo-linux-x64`
- Linux (ARM64): `PhotoTo-linux-arm64`

双击或在终端运行即可，默认会自动打开浏览器进入管理页面，终端里会打印手机端访问地址，管理页右上角也可以直接扫码。

Linux 首次运行需先加执行权限：

```bash
chmod +x PhotoTo-linux-x64
./PhotoTo-linux-x64
```

### 从源码运行

需要 Python 3.10+（推荐 3.12+）。

```bash
# 可选：安装 Pillow 以启用缩略图和 EXIF 读取
pip install -r requirements.txt

python main.py
```

不装 Pillow 也能正常运行，管理页会直接加载原图。

## 启动参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--port` | `5000` | 监听端口，被占用时自动向后顺延 |
| `--host` | `0.0.0.0` | 监听地址 |
| `--dir` | `./data/png` | 文件保存目录（单文件版默认在程序同级目录） |
| `--max-size` | `500` | 单文件大小上限（MB） |
| `--idle-exit` | `0` | 无访问 N 分钟后自动退出，`0` 为不退出 |
| `--no-browser` | 关闭 | 启动时不自动打开管理页 |
| `--reset-pin` | 关闭 | 启动时关闭所有用户侧和管理员侧 PIN 锁 |
| `-v, --verbose` | 关闭 | 输出请求日志 |
| `-V, --version` | - | 显示版本号 |

示例：

```bash
python main.py --port 8080 --dir D:/Photos --idle-exit 30
```

忘记管理员 PIN 码时，带 `--reset-pin` 启动一次即可解锁：

```bash
./PhotoTo-windows-x64.exe --reset-pin
```

## 自行打包

项目使用 Nuitka 打包为单文件可执行程序，并开启持久化解压缓存：

```bash
pip install --upgrade Pillow nuitka ordered-set zstandard
python scripts/build.py
```

产物输出在 `dist/` 目录。推送 `v*` 标签会自动通过 GitHub Actions 构建 Windows 和 Linux（x64 / ARM64）版本并发布 Release。

## 协议

MIT License - Copyright (c) CRWorld
