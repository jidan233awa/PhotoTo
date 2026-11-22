"""基于标准库的轻量 HTTP 服务（无 Flask 依赖，空闲时几乎零占用）。

- 手机端：/          上传页面（局域网设备可访问，支持可选的多 PIN 码认证）
- 电脑端：/admin     管理中心（仅本机可访问）
"""
import json
import mimetypes
import os
import socket
import subprocess
import sys
import time
from email.utils import formatdate, parsedate_to_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlsplit

from .storage import Library, StorageError

WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'web')
mimetypes.add_type('image/heic', '.heic')
mimetypes.add_type('image/heif', '.heif')
mimetypes.add_type('image/avif', '.avif')
mimetypes.add_type('image/webp', '.webp')
mimetypes.add_type('text/javascript', '.js')


class IdleExit(Exception):
    pass


# ---------------------------------------------------------------------- 网络工具
def primary_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))  # 不会真正发包
        return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        s.close()


def local_ips():
    ips = []
    first = primary_ip()
    if first != '127.0.0.1':
        ips.append(first)
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in ips and not ip.startswith('127.') and not ip.startswith('169.254.'):
                ips.append(ip)
    except OSError:
        pass
    return ips


def _win_spawn_on_default_desktop(cmd_str: str) -> bool:
    """在 Windows 的 WinSta0\\Default 桌面并以桌面 Shell (explorer.exe) 为父进程启动命令。

    解决从后台/沙箱桌面启动 explorer.exe 时窗口落入隐藏桌面或因 COM 令牌隔离而无响应的问题。
    """
    import ctypes
    import ctypes.wintypes as wt

    u32 = ctypes.windll.user32
    k32 = ctypes.windll.kernel32

    class STARTUPINFOW(ctypes.Structure):
        _fields_ = [
            ('cb', wt.DWORD), ('lpReserved', wt.LPWSTR), ('lpDesktop', wt.LPWSTR), ('lpTitle', wt.LPWSTR),
            ('dwX', wt.DWORD), ('dwY', wt.DWORD), ('dwXSize', wt.DWORD), ('dwYSize', wt.DWORD),
            ('dwXCountChars', wt.DWORD), ('dwYCountChars', wt.DWORD), ('dwFillAttribute', wt.DWORD),
            ('dwFlags', wt.DWORD), ('wShowWindow', wt.WORD), ('cbReserved2', wt.WORD),
            ('lpReserved2', ctypes.POINTER(ctypes.c_byte)), ('hStdInput', wt.HANDLE),
            ('hStdOutput', wt.HANDLE), ('hStdError', wt.HANDLE),
        ]

    class STARTUPINFOEXW(ctypes.Structure):
        _fields_ = [('StartupInfo', STARTUPINFOW), ('lpAttributeList', ctypes.c_void_p)]

    class PROCESS_INFORMATION(ctypes.Structure):
        _fields_ = [('hProcess', wt.HANDLE), ('hThread', wt.HANDLE), ('dwProcessId', wt.DWORD), ('dwThreadId', wt.DWORD)]

    orig_desk = u32.GetThreadDesktop(k32.GetCurrentThreadId())
    h_desk = u32.OpenDesktopW('Default', 0, False, 0x01FF)
    if h_desk:
        u32.SetThreadDesktop(h_desk)
    try:
        u32.keybd_event(0, 0, 0, 0)
    except Exception:
        pass

    u32.GetShellWindow.restype = wt.HWND
    shell_hwnd = u32.GetShellWindow()
    pid = wt.DWORD()
    if shell_hwnd:
        u32.GetWindowThreadProcessId(shell_hwnd, ctypes.byref(pid))

    k32.OpenProcess.restype = wt.HANDLE
    h_parent = k32.OpenProcess(0x0080, False, pid.value) if pid.value else None

    attr_buf = None
    siex = STARTUPINFOEXW()
    siex.StartupInfo.cb = ctypes.sizeof(STARTUPINFOEXW)
    siex.StartupInfo.lpDesktop = 'WinSta0\\Default'
    siex.StartupInfo.dwFlags = 1  # STARTF_USESHOWWINDOW
    siex.StartupInfo.wShowWindow = 1  # SW_SHOWNORMAL
    creation_flags = 0x00000400  # CREATE_UNICODE_ENVIRONMENT

    try:
        if h_parent:
            size = ctypes.c_size_t(0)
            k32.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
            attr_buf = (ctypes.c_byte * size.value)()
            if k32.InitializeProcThreadAttributeList(ctypes.byref(attr_buf), 1, 0, ctypes.byref(size)):
                parent_handle = wt.HANDLE(h_parent)
                k32.UpdateProcThreadAttribute.argtypes = [
                    ctypes.c_void_p, wt.DWORD, ctypes.c_size_t,
                    ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_void_p,
                ]
                # PROC_THREAD_ATTRIBUTE_PARENT_PROCESS = 0x00020000
                if k32.UpdateProcThreadAttribute(
                    ctypes.byref(attr_buf), 0, 0x00020000,
                    ctypes.byref(parent_handle), ctypes.sizeof(parent_handle), None, None,
                ):
                    siex.lpAttributeList = ctypes.addressof(attr_buf)
                    creation_flags |= 0x00080000  # EXTENDED_STARTUPINFO_PRESENT
        if not siex.lpAttributeList:
            siex.StartupInfo.cb = ctypes.sizeof(STARTUPINFOW)

        pi = PROCESS_INFORMATION()
        cmd = ctypes.create_unicode_buffer(cmd_str)
        ok = bool(k32.CreateProcessW(
            None, cmd, None, None, False, creation_flags,
            None, None, ctypes.byref(siex), ctypes.byref(pi),
        ))
        if ok:
            k32.CloseHandle(pi.hProcess)
            k32.CloseHandle(pi.hThread)
        return ok
    finally:
        if attr_buf is not None:
            k32.DeleteProcThreadAttributeList(ctypes.byref(attr_buf))
        if h_parent:
            k32.CloseHandle(h_parent)
        if h_desk:
            if orig_desk:
                u32.SetThreadDesktop(orig_desk)
            u32.CloseDesktop(h_desk)


def open_path(path, reveal=False):
    norm = os.path.normpath(os.path.abspath(path))
    if sys.platform == 'win32':
        if reveal:
            cmd = f'explorer.exe /select,"{norm}"'
        else:
            cmd = f'explorer.exe "{norm}"'
        try:
            if _win_spawn_on_default_desktop(cmd):
                return
        except Exception:
            pass
        if reveal:
            subprocess.Popen(['explorer.exe', f'/select,{norm}'])
        elif os.path.isdir(norm):
            subprocess.Popen(['explorer.exe', norm])
        else:
            os.startfile(norm)  # noqa: 仅 Windows
    elif sys.platform == 'darwin':
        subprocess.Popen(['open', '-R', norm] if reveal else ['open', norm])
    else:
        subprocess.Popen(['xdg-open', os.path.dirname(norm) if reveal else norm])


# ---------------------------------------------------------------------- 服务
class PhotoServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False
    # Windows 上 SO_REUSEADDR 允许多个进程绑定同一端口，关闭以便正确检测端口占用
    allow_reuse_address = sys.platform != 'win32'

    def __init__(self, addr, library: Library, idle_exit_min=0, verbose=False):
        super().__init__(addr, Handler)
        self.library = library
        self.verbose = verbose
        self.idle_exit = idle_exit_min * 60
        self.last_activity = time.monotonic()
        self.local_addrs = {'127.0.0.1', '::1', *local_ips()}
        self.port = self.server_address[1]

    def phone_urls(self):
        return [f'http://{ip}:{self.port}/' for ip in local_ips()] or [f'http://127.0.0.1:{self.port}/']

    def service_actions(self):
        # serve_forever 每个轮询周期调用一次，无需额外线程
        if self.idle_exit and time.monotonic() - self.last_activity > self.idle_exit:
            raise IdleExit()


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'PhotoTo'
    sys_version = ''
    timeout = 20  # 空闲的长连接 20 秒后关闭，释放线程

    server: PhotoServer

    # ------------------------------------------------------------ 基础工具
    @property
    def lib(self) -> Library:
        return self.server.library

    def log_message(self, fmt, *args):
        if self.server.verbose:
            super().log_message(fmt, *args)

    def is_local(self):
        return self.client_address[0] in self.server.local_addrs

    def get_cookie(self, key: str) -> str:
        raw = self.headers.get('Cookie') or ''
        for part in raw.split(';'):
            if '=' in part:
                k, v = part.strip().split('=', 1)
                if k == key:
                    return unquote(v)
        return ''

    def get_admin_pin_from_req(self) -> str:
        return unquote(self.headers.get('X-Admin-Pin') or '') or self.get_cookie('pt_admin_pin')

    def check_admin_pin(self, touch_usage=False):
        """校验管理员侧 PIN 码（用于打开 /admin 及调用所有管理端接口）。"""
        pin = self.get_admin_pin_from_req()
        res = self.lib.verify_pin('admin', pin, client_ip=self.client_address[0], touch_usage=touch_usage)
        if not res['ok']:
            err = StorageError('需要验证管理员 PIN 码', 401)
            err.admin_lock = True
            raise err
        return res.get('label') or ''

    def check_client_pin(self):
        """校验上传与发文字的 PIN 码：本机管理端校验管理员 PIN，手机端/外部设备校验用户侧 PIN。"""
        if self.is_local() and self.headers.get('X-Client') != 'phone':
            self.check_admin_pin(touch_usage=False)
            return ''
        pin = unquote(self.headers.get('X-Pin') or '')
        res = self.lib.verify_pin('user', pin, client_ip=self.client_address[0], touch_usage=True)
        if not res['ok']:
            self.close_connection = True
            raise StorageError('需要输入正确的用户侧 PIN 码', 401)
        return res.get('label') or ''

    def send_json(self, data, status=200, extra_headers=None):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        if extra_headers:
            for k, v in extra_headers:
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status, message, admin_lock=False):
        payload = {'ok': False, 'err': message, 'status': status}
        if admin_lock:
            payload['adminLock'] = True
        self.send_json(payload, status)

    def read_body(self, limit=1024 * 1024):
        length = int(self.headers.get('Content-Length') or 0)
        if length > limit:
            raise StorageError('请求过大', 413)
        return self.rfile.read(length) if length else b''

    def read_json(self):
        try:
            return json.loads(self.read_body() or b'{}')
        except ValueError:
            raise StorageError('JSON 格式错误', 400)

    def send_file(self, path, content_type=None, cache='no-cache', download_name=None):
        st = os.stat(path)
        ims = self.headers.get('If-Modified-Since')
        if ims:
            try:
                if int(st.st_mtime) <= parsedate_to_datetime(ims).timestamp():
                    self.send_response(304)
                    self.send_header('Cache-Control', cache)
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    return
            except (TypeError, ValueError):
                pass
        ctype = content_type or mimetypes.guess_type(path)[0] or 'application/octet-stream'
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(st.st_size))
        self.send_header('Last-Modified', formatdate(st.st_mtime, usegmt=True))
        self.send_header('Cache-Control', cache)
        if download_name:
            self.send_header('Content-Disposition', f"attachment; filename*=UTF-8''{quote(download_name)}")
        self.end_headers()
        if self.command == 'HEAD':
            return
        with open(path, 'rb') as f:
            while True:
                chunk = f.read(256 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)

    # ------------------------------------------------------------ 分发
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        self._dispatch('GET')

    def do_POST(self):
        self._dispatch('POST')

    def _dispatch(self, method):
        self.server.last_activity = time.monotonic()
        url = urlsplit(self.path)
        path = unquote(url.path)
        self.query = {k: v[-1] for k, v in parse_qs(url.query).items()}
        try:
            route_fn = ROUTES.get((method, path))
            if route_fn is None:
                for (m, prefix), fn in PREFIX_ROUTES.items():
                    if m == method and path.startswith(prefix):
                        route_fn, arg = fn, path[len(prefix):]
                        break
                else:
                    return self.send_error_json(404, '未找到')
            else:
                arg = None
            admin_only = getattr(route_fn, 'admin', False)
            if admin_only and not self.is_local():
                return self.send_error_json(403, '仅限本机访问管理功能')
            if admin_only and not getattr(route_fn, 'public_admin', False):
                self.check_admin_pin(touch_usage=False)
            if arg is None:
                route_fn(self)
            else:
                route_fn(self, arg)
        except StorageError as e:
            self.send_error_json(e.status, str(e), admin_lock=getattr(e, 'admin_lock', False))
        except (ConnectionError, BrokenPipeError, socket.timeout):
            self.close_connection = True
        except Exception as e:  # pragma: no cover
            self.log_error('处理 %s 出错: %r', self.path, e)
            try:
                self.send_error_json(500, f'服务器错误: {e}')
            except Exception:
                self.close_connection = True

    @property
    def is_trash(self):
        return self.query.get('trash') in ('1', 'true')


# ---------------------------------------------------------------------- 路由
ROUTES = {}
PREFIX_ROUTES = {}


def route(method, path, admin=False, prefix=False, public_admin=False):
    def deco(fn):
        fn.admin = admin
        fn.public_admin = public_admin
        (PREFIX_ROUTES if prefix else ROUTES)[(method, path)] = fn
        return fn
    return deco


@route('GET', '/')
def page_phone(h: Handler):
    h.send_file(os.path.join(WEB_DIR, 'phone.html'), 'text/html; charset=utf-8')


@route('GET', '/admin', admin=True, public_admin=True)
def page_admin(h: Handler):
    h.send_file(os.path.join(WEB_DIR, 'admin.html'), 'text/html; charset=utf-8')


@route('GET', '/static/', prefix=True)
def static(h: Handler, name):
    path = os.path.normpath(os.path.join(WEB_DIR, name))
    if not path.startswith(WEB_DIR + os.sep) or not os.path.isfile(path):
        raise StorageError('未找到', 404)
    h.send_file(path)


@route('GET', '/favicon.ico')
def favicon(h: Handler):
    h.send_file(os.path.join(WEB_DIR, 'icon.svg'), 'image/svg+xml', cache='max-age=86400')


# ---- 用户侧（手机端）PIN 状态查询与验证
@route('GET', '/api/auth/status')
def api_auth_status(h: Handler):
    pin = unquote(h.headers.get('X-Pin') or h.query.get('pin') or '')
    res = h.lib.verify_pin('user', pin, client_ip=h.client_address[0], touch_usage=False)
    h.send_json({
        'ok': True,
        'required': res['required'],
        'authed': res['ok'],
        'label': res.get('label') or '',
    })


@route('POST', '/api/auth/verify')
def api_auth_verify(h: Handler):
    data = h.read_json()
    pin = str(data.get('pin') or '').strip()
    res = h.lib.verify_pin('user', pin, client_ip=h.client_address[0], touch_usage=True)
    if not res['ok']:
        raise StorageError('用户侧 PIN 码错误或已停用', 401)
    h.send_json({
        'ok': True,
        'required': res['required'],
        'authed': True,
        'label': res.get('label') or '',
    })


# ---- 管理员侧（打开 /admin）PIN 状态查询、解锁与锁定
@route('GET', '/api/admin/auth/status', admin=True, public_admin=True)
def api_admin_auth_status(h: Handler):
    pin = h.get_admin_pin_from_req()
    res = h.lib.verify_pin('admin', pin, client_ip=h.client_address[0], touch_usage=False)
    h.send_json({
        'ok': True,
        'required': res['required'],
        'authed': res['ok'],
        'label': res.get('label') or '',
    })


@route('POST', '/api/admin/auth/verify', admin=True, public_admin=True)
def api_admin_auth_verify(h: Handler):
    data = h.read_json()
    pin = str(data.get('pin') or '').strip()
    remember = bool(data.get('remember'))
    res = h.lib.verify_pin('admin', pin, client_ip=h.client_address[0], touch_usage=True)
    if not res['ok']:
        raise StorageError('管理员 PIN 码错误或已停用', 401)
    cookie = f'pt_admin_pin={quote(pin)}; Path=/; HttpOnly; SameSite=Strict'
    if remember:
        cookie += '; Max-Age=2592000'
    h.send_json({
        'ok': True,
        'required': res['required'],
        'authed': True,
        'label': res.get('label') or '',
    }, extra_headers=[('Set-Cookie', cookie)])


@route('POST', '/api/admin/auth/logout', admin=True, public_admin=True)
def api_admin_auth_logout(h: Handler):
    h.read_body()
    cookie = 'pt_admin_pin=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict'
    h.send_json({'ok': True}, extra_headers=[('Set-Cookie', cookie)])


# ---- 上传（手机 / 电脑拖拽导入）：原始请求体 + X-Filename 头，服务端流式写盘
@route('POST', '/api/upload')
def api_upload(h: Handler):
    pin_label = h.check_client_pin()
    length = int(h.headers.get('Content-Length') or 0)
    hint = unquote(h.headers.get('X-Filename') or '')
    keep_name = h.headers.get('X-Keep-Name') == '1'
    raw_ip = h.client_address[0]
    client_ip = f'{raw_ip} ({pin_label})' if pin_label else raw_ip
    try:
        info = h.lib.save_stream(
            h.rfile, length, hint, h.headers.get('Content-Type', ''),
            keep_name=keep_name, client_ip=client_ip,
        )
    except StorageError:
        h.close_connection = True  # 请求体可能未读完，断开以免污染长连接
        raise
    print(f'[{time.strftime("%H:%M:%S")}] 已接收 {info["name"]}  ({info["size"] / 1048576:.1f} MB)  来自 {client_ip}')
    h.send_json({'ok': True, **info})


@route('POST', '/api/text')
def api_text_add(h: Handler):
    pin_label = h.check_client_pin()
    data = h.read_json()
    raw_ip = h.client_address[0]
    client_ip = f'{raw_ip} ({pin_label})' if pin_label else raw_ip
    item = h.lib.add_text(data.get('text'), client_ip)
    preview = item['text'].replace('\n', ' ')[:30]
    print(f'[{time.strftime("%H:%M:%S")}] 已接收文字 ({len(item["text"])} 字): {preview}  来自 {client_ip}')
    h.send_json({'ok': True, 'item': item})


# ---- 管理接口（仅本机）
@route('GET', '/api/info', admin=True)
def api_info(h: Handler):
    h.send_json({
        'ok': True, 'dir': h.lib.root, 'phoneUrls': h.server.phone_urls(),
        'pil': h.lib.has_pil, 'version': h.lib.version,
        'pins': h.lib.get_pin_config(),
    })


@route('GET', '/api/qr', admin=True)
def api_qr(h: Handler):
    url = (h.query.get('url') or '').strip()
    if not url:
        raise StorageError('缺少 url 参数', 400)
    # 仅在用户点击二维码按钮时按需导入并计算，平时不占用任何 CPU 与内存
    from .qr import qr_svg
    try:
        svg = qr_svg(url).encode('utf-8')
    except ValueError as e:
        raise StorageError(str(e), 400)
    h.send_response(200)
    h.send_header('Content-Type', 'image/svg+xml; charset=utf-8')
    h.send_header('Content-Length', str(len(svg)))
    h.send_header('Cache-Control', 'no-store')
    h.end_headers()
    h.wfile.write(svg)


@route('GET', '/api/photos', admin=True)
def api_photos(h: Handler):
    kind = None if h.is_trash else (h.query.get('kind') or 'image')
    h.send_json({
        'ok': True, 'version': h.lib.version,
        'items': h.lib.list(h.is_trash, kind=kind), 'stats': h.lib.stats(),
    })


@route('GET', '/api/exif', admin=True)
def api_exif(h: Handler):
    name = (h.query.get('name') or '').strip()
    if not name:
        raise StorageError('缺少文件名', 400)
    h.send_json({'ok': True, 'exif': h.lib.exif(name, h.is_trash)})


@route('GET', '/api/texts', admin=True)
def api_texts(h: Handler):
    h.send_json({
        'ok': True, 'version': h.lib.version,
        'items': h.lib.list_texts(), 'stats': h.lib.stats(),
    })


@route('POST', '/api/text/update', admin=True)
def api_text_update(h: Handler):
    data = h.read_json()
    item = h.lib.update_text(data.get('id'), data.get('text'))
    h.send_json({'ok': True, 'item': item})


@route('POST', '/api/text/reorder', admin=True)
def api_text_reorder(h: Handler):
    data = h.read_json()
    changed = h.lib.reorder_texts(data.get('ids') or [])
    h.send_json({'ok': True, 'changed': changed})


@route('POST', '/api/text/delete', admin=True)
def api_text_delete(h: Handler):
    data = h.read_json()
    ids = data.get('ids') or []
    h.send_json({'ok': True, 'count': h.lib.delete_texts(ids)})


@route('POST', '/api/text/clear', admin=True)
def api_text_clear(h: Handler):
    h.read_body()
    h.send_json({'ok': True, 'count': h.lib.clear_texts()})


# ---- 双端（用户侧 user / 管理员侧 admin）多 PIN 码管理（仅本机）
@route('GET', '/api/pins', admin=True)
def api_pins_get(h: Handler):
    h.send_json({'ok': True, 'pins': h.lib.get_pin_config()})


@route('POST', '/api/pins/toggle', admin=True)
def api_pins_toggle(h: Handler):
    data = h.read_json()
    cfg = h.lib.set_pin_enabled(data.get('scope', 'user'), bool(data.get('enabled')))
    h.send_json({'ok': True, 'pins': cfg})


@route('POST', '/api/pins/add', admin=True)
def api_pins_add(h: Handler):
    data = h.read_json()
    scope = data.get('scope', 'user')
    pin_code = str(data.get('pin') or '').strip()
    cfg = h.lib.add_pin(scope, pin_code, data.get('label'))
    # 若管理员添加了第一个管理员侧 PIN 且当前未设置管理员会话 Cookie，自动为当前会话写入该 PIN，避免刚添加就把自己锁在外面
    extra = None
    if scope == 'admin' and pin_code and not h.get_admin_pin_from_req():
        extra = [('Set-Cookie', f'pt_admin_pin={quote(pin_code)}; Path=/; HttpOnly; SameSite=Strict')]
    h.send_json({'ok': True, 'pins': cfg, 'autoAdminPin': pin_code if extra else ''}, extra_headers=extra)


@route('POST', '/api/pins/update', admin=True)
def api_pins_update(h: Handler):
    data = h.read_json()
    scope = data.get('scope', 'user')
    new_pin = data.get('pin')
    cfg = h.lib.update_pin(
        scope,
        data.get('id'),
        pin_code=new_pin,
        label=data.get('label'),
        enabled=data.get('enabled'),
    )
    extra = None
    auto_pin = ''
    if scope == 'admin' and new_pin is not None:
        code = str(new_pin).strip()
        if code:
            extra = [('Set-Cookie', f'pt_admin_pin={quote(code)}; Path=/; HttpOnly; SameSite=Strict')]
            auto_pin = code
    h.send_json({'ok': True, 'pins': cfg, 'autoAdminPin': auto_pin}, extra_headers=extra)


@route('POST', '/api/pins/delete', admin=True)
def api_pins_delete(h: Handler):
    data = h.read_json()
    cfg = h.lib.delete_pin(data.get('scope', 'user'), data.get('id'))
    h.send_json({'ok': True, 'pins': cfg})


@route('POST', '/api/pins/reset-stats', admin=True)
def api_pins_reset_stats(h: Handler):
    data = h.read_json()
    cfg = h.lib.reset_pin_stats(data.get('scope', ''))
    h.send_json({'ok': True, 'pins': cfg})


@route('GET', '/photo/', admin=True, prefix=True)
def get_photo(h: Handler, name):
    path = h.lib.resolve(name, h.is_trash)
    dl = name if h.query.get('download') else None
    h.send_file(path, cache='private, max-age=31536000, immutable', download_name=dl)


@route('GET', '/thumb/', admin=True, prefix=True)
def get_thumb(h: Handler, name):
    thumb = h.lib.thumbnail(name, h.is_trash)
    if thumb:
        h.send_file(thumb, 'image/jpeg', cache='private, max-age=31536000, immutable')
    else:
        h.send_file(h.lib.resolve(name, h.is_trash), cache='private, max-age=600')


def _names(data):
    names = data.get('names') or []
    if not isinstance(names, list):
        raise StorageError('参数错误', 400)
    return [n for n in names if isinstance(n, str)]


@route('POST', '/api/delete', admin=True)
def api_delete(h: Handler):
    moved = h.lib.delete(_names(h.read_json()))
    h.send_json({'ok': True, 'count': len(moved), 'names': moved})


@route('POST', '/api/restore', admin=True)
def api_restore(h: Handler):
    moved = h.lib.restore(_names(h.read_json()))
    h.send_json({'ok': True, 'count': len(moved), 'names': moved})


@route('POST', '/api/purge', admin=True)
def api_purge(h: Handler):
    h.send_json({'ok': True, 'count': h.lib.purge(_names(h.read_json()))})


@route('POST', '/api/empty-trash', admin=True)
def api_empty_trash(h: Handler):
    h.read_body()
    h.send_json({'ok': True, 'count': h.lib.empty_trash()})


@route('POST', '/api/clean-orphans', admin=True)
def api_clean_orphans(h: Handler):
    h.read_body()
    res = h.lib.clean_orphans()
    h.send_json({'ok': True, **res})


@route('POST', '/api/rename', admin=True)
def api_rename(h: Handler):
    data = h.read_json()
    new = h.lib.rename(data.get('name'), data.get('newName'), bool(data.get('trash')))
    h.send_json({'ok': True, 'name': new})


@route('POST', '/api/open', admin=True)
def api_open(h: Handler):
    data = h.read_json()
    if data.get('name'):
        open_path(h.lib.resolve(data['name'], bool(data.get('trash'))), reveal=data.get('action') == 'reveal')
    else:
        open_path(h.lib.root)
    h.send_json({'ok': True})


@route('POST', '/api/zip', admin=True)
def api_zip(h: Handler):
    # 通过普通表单提交触发浏览器原生下载：names=<JSON 数组>
    form = parse_qs(h.read_body(4 * 1024 * 1024).decode('utf-8'))
    try:
        names = json.loads(form.get('names', ['[]'])[0])
    except ValueError:
        raise StorageError('参数错误', 400)
    trash = form.get('trash', ['0'])[0] == '1'
    fname = f'PhotoTo_{time.strftime("%Y%m%d_%H%M%S")}.zip'
    h.send_response(200)
    h.send_header('Content-Type', 'application/zip')
    h.send_header('Content-Disposition', f'attachment; filename="{fname}"')
    h.send_header('Connection', 'close')  # 无 Content-Length，以断开连接表示结束
    h.end_headers()
    h.close_connection = True
    h.lib.write_zip([n for n in names if isinstance(n, str)], h.wfile, trash)
