"""媒体与文件库：保存照片/任意文件、记录上传者IP、文字便签、列表、缩略图、EXIF、PIN码管理、回收站、打包下载。

设计要点（低占用 & 护盘）：
- 上传以 1MB 分块流式写盘，保存原文件，不做格式转换（无 CPU / 内存峰值）。
- 目录列表与元数据、文字便签、PIN 配置均做内存缓存，目录未变动时零磁盘 stat / 零重复读取。
- Pillow 仅在首次需要生成缩略图或读取 EXIF 时才导入；小图直接复用原图，避免多余缩略图落盘。
- 缩略图生成有并发上限（最多同时 2 张），避免一次解码多张大图导致内存暴涨。
"""
import json
import os
import re
import sys
import threading
import time
import zipfile
from datetime import datetime

IMAGE_EXTS = {
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp',
    '.heic', '.heif', '.avif', '.tif', '.tiff',
}
NATIVE_SMALL_EXTS = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif'}
SMALL_THUMB_SKIP_BYTES = 36 * 1024  # 小于 36KB 的原生网页图片直接用原图，不额外写盘生成缩略图
MIME_TO_EXT = {
    'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
    'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp',
    'image/heic': '.heic', 'image/heif': '.heif', 'image/avif': '.avif',
    'image/tiff': '.tif', 'text/plain': '.txt', 'application/pdf': '.pdf',
    'application/zip': '.zip', 'video/mp4': '.mp4', 'audio/mpeg': '.mp3',
}
THUMB_DIR = '.thumbs'
TRASH_DIR = '.trash'
TEXTS_FILE = '.texts.json'
META_FILE = '.meta.json'
PINS_FILE = '.pins.json'
CHUNK = 1024 * 1024
_BAD_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_WIN_RESERVED = {
    'CON', 'PRN', 'AUX', 'NUL',
    *(f'COM{i}' for i in range(1, 10)),
    *(f'LPT{i}' for i in range(1, 10)),
}


class StorageError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _hide_on_windows(path):
    if sys.platform == 'win32':
        try:
            import ctypes
            ctypes.windll.kernel32.SetFileAttributesW(str(path), 0x02)  # HIDDEN
        except Exception:
            pass


def _atomic_write_json(path, data):
    """紧凑 JSON 原子写盘，仅在 Windows 隐藏属性拦截 replace 时解除隐藏，减少系统调用与写盘体积。"""
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    try:
        os.replace(tmp, path)
    except PermissionError:
        if sys.platform == 'win32' and os.path.exists(path):
            try:
                import ctypes
                ctypes.windll.kernel32.SetFileAttributesW(str(path), 0x80)
                os.replace(tmp, path)
            except OSError:
                pass
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
    _hide_on_windows(path)


class Library:
    def __init__(self, root, thumb_size=400, max_upload_mb=500):
        self.root = os.path.abspath(root)
        self.trash = os.path.join(self.root, TRASH_DIR)
        self.thumb_root = os.path.join(self.root, THUMB_DIR)
        self.texts_path = os.path.join(self.root, TEXTS_FILE)
        self.meta_path = os.path.join(self.root, META_FILE)
        self.pins_path = os.path.join(self.root, PINS_FILE)
        self.thumb_size = thumb_size
        self.max_upload = max_upload_mb * 1024 * 1024
        for d in (self.root, self.trash, self.thumb_root, os.path.join(self.thumb_root, 'trash')):
            os.makedirs(d, exist_ok=True)
        _hide_on_windows(self.trash)
        _hide_on_windows(self.thumb_root)

        self._lock = threading.Lock()              # 文件命名 / 移动 / 元数据 / 文字 / PIN 存取
        self._thumb_sem = threading.Semaphore(2)   # 同时最多解码 2 张大图
        self._thumb_failed = set()
        self._pil = None                           # 懒加载 (Image, ImageOps, ExifTags)
        self._pil_checked = False
        self._counter = 0
        self._meta_cache = None
        self._texts_cache = None
        self._texts_mtime = -1
        self._pins_cache = None
        self._pin_usage = {}                       # {pin_id: {'count': int, 'lastUsed': ms, 'lastIp': str}} 仅存内存不刷盘
        self._scan_cache = {}                      # {trash_bool: (dir_mtime_ns, counter, items_list)}

    # ------------------------------------------------------------------ 基础
    def _touch(self):
        self._counter += 1
        self._scan_cache.clear()

    @property
    def version(self):
        """变化标记：内部计数 + 目录修改时间（可感知资源管理器中的外部改动）。"""
        try:
            m1 = os.stat(self.root).st_mtime_ns
            m2 = os.stat(self.trash).st_mtime_ns
        except OSError:
            m1 = m2 = 0
        return f'{self._counter}-{m1}-{m2}'

    def _area(self, trash):
        return self.trash if trash else self.root

    @staticmethod
    def _is_image(name):
        return os.path.splitext(name)[1].lower() in IMAGE_EXTS

    @staticmethod
    def _valid_name(name):
        if not isinstance(name, str) or not name or len(name) > 200:
            return False
        if name != os.path.basename(name) or name.startswith('.') or name.endswith((' ', '.')):
            return False
        if _BAD_CHARS.search(name):
            return False
        stem = os.path.splitext(name)[0].upper()
        return stem not in _WIN_RESERVED

    @classmethod
    def _sanitize_name(cls, raw):
        raw = os.path.basename((raw or '').strip())
        raw = _BAD_CHARS.sub('_', raw).strip(' .')
        if not raw or raw.startswith('.'):
            return ''
        stem, ext = os.path.splitext(raw)
        if stem.upper() in _WIN_RESERVED:
            stem = f'_{stem}'
        clean = (stem[:160] + ext[:20]) if stem else ''
        return clean if cls._valid_name(clean) else ''

    def resolve(self, name, trash=False):
        if not self._valid_name(name):
            raise StorageError('文件名无效', 400)
        path = os.path.join(self._area(trash), name)
        if not os.path.isfile(path):
            raise StorageError('文件不存在', 404)
        return path

    @staticmethod
    def _free_name(folder, name):
        stem, ext = os.path.splitext(name)
        candidate, i = name, 1
        while os.path.exists(os.path.join(folder, candidate)):
            candidate = f'{stem}_{i}{ext}'
            i += 1
        return candidate

    # ------------------------------------------------------------------ 元数据（记录上传者 IP）
    def _read_meta_unlocked(self):
        if self._meta_cache is not None:
            return self._meta_cache
        if not os.path.isfile(self.meta_path):
            self._meta_cache = {}
            return self._meta_cache
        try:
            with open(self.meta_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                self._meta_cache = data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            self._meta_cache = {}
        return self._meta_cache

    def _write_meta_unlocked(self):
        if self._meta_cache is None:
            return
        try:
            _atomic_write_json(self.meta_path, self._meta_cache)
        except OSError:
            pass

    @staticmethod
    def _meta_key(name, trash=False):
        return f'trash/{name}' if trash else name

    # ------------------------------------------------------------------ 列表（带目录 mtime 缓存，避免重复 scandir/stat）
    def _scan_area(self, trash=False):
        area = self._area(trash)
        try:
            dir_mtime = os.stat(area).st_mtime_ns
        except OSError:
            dir_mtime = 0
        cached = self._scan_cache.get(trash)
        if cached and cached[0] == dir_mtime and cached[1] == self._counter:
            return cached[2]

        items = []
        with self._lock:
            meta = dict(self._read_meta_unlocked())
        try:
            with os.scandir(area) as it:
                for e in it:
                    if not e.is_file() or not self._valid_name(e.name):
                        continue
                    item_kind = 'image' if self._is_image(e.name) else 'file'
                    st = e.stat()
                    m = meta.get(self._meta_key(e.name, trash)) or meta.get(e.name) or {}
                    items.append({
                        'name': e.name,
                        'size': st.st_size,
                        'mtime': int(st.st_mtime * 1000),
                        'kind': item_kind,
                        'ip': m.get('ip') or '本机',
                    })
        except FileNotFoundError:
            pass
        items.sort(key=lambda x: x['mtime'], reverse=True)
        self._scan_cache[trash] = (dir_mtime, self._counter, items)
        return items

    def list(self, trash=False, kind=None):
        all_items = self._scan_area(trash)
        if not kind:
            return list(all_items)
        return [i for i in all_items if i['kind'] == kind]

    def stats(self):
        all_lib = self._scan_area(False)
        imgs = [i for i in all_lib if i['kind'] == 'image']
        files = [i for i in all_lib if i['kind'] == 'file']
        tr = self._scan_area(True)
        texts = self.list_texts()
        ip_counts = {}
        for i in all_lib:
            ip = i.get('ip') or '本机'
            ip_counts[ip] = ip_counts.get(ip, 0) + 1
        for t in texts:
            ip = t.get('ip') or '本机'
            ip_counts[ip] = ip_counts.get(ip, 0) + 1
        ips = [{'ip': k, 'count': v} for k, v in sorted(ip_counts.items(), key=lambda x: (-x[1], x[0]))]
        return {
            'count': len(imgs), 'size': sum(i['size'] for i in imgs),
            'fileCount': len(files), 'fileSize': sum(i['size'] for i in files),
            'textCount': len(texts),
            'trashCount': len(tr), 'trashSize': sum(i['size'] for i in tr),
            'ips': ips,
        }

    # ------------------------------------------------------------------ 上传
    def save_stream(self, stream, length, filename_hint='', content_type='', keep_name=False, client_ip=''):
        if length <= 0:
            raise StorageError('空文件', 400)
        if length > self.max_upload:
            raise StorageError(f'文件过大（上限 {self.max_upload // 1024 // 1024} MB）', 413)

        clean_hint = self._sanitize_name(filename_hint)
        ext = os.path.splitext(clean_hint)[1].lower()
        if not ext:
            ext = MIME_TO_EXT.get((content_type or '').split(';')[0].strip().lower(), '')
        if ext == '.jpeg':
            ext = '.jpg'

        is_img = ext in IMAGE_EXTS
        if not is_img and not keep_name and not clean_hint:
            raise StorageError('文件名无效', 400)

        tmp = os.path.join(self.root, f'.upload-{threading.get_ident()}-{id(stream)}.part')
        remaining = length
        try:
            with open(tmp, 'wb') as f:
                while remaining > 0:
                    chunk = stream.read(min(CHUNK, remaining))
                    if not chunk:
                        raise StorageError('上传中断', 400)
                    f.write(chunk)
                    remaining -= len(chunk)
            with self._lock:
                if (keep_name or not is_img) and clean_hint:
                    base = clean_hint if os.path.splitext(clean_hint)[1] else (clean_hint + ext)
                else:
                    base = datetime.now().strftime('%Y%m%d_%H%M%S_%f')[:19] + (ext or '.bin')
                name = self._free_name(self.root, base)
                os.replace(tmp, os.path.join(self.root, name))
                meta = self._read_meta_unlocked()
                ip = client_ip or '本机'
                meta[self._meta_key(name, False)] = {'ip': ip, 'orig': clean_hint or name}
                self._write_meta_unlocked()
                self._touch()
            return {
                'name': name,
                'size': length,
                'kind': 'image' if self._is_image(name) else 'file',
                'ip': client_ip or '本机',
            }
        finally:
            if os.path.exists(tmp):
                try:
                    os.remove(tmp)
                except OSError:
                    pass

    # ------------------------------------------------------------------ 文字便签（内存缓存 + 编辑 + 拖拽排序）
    def _read_texts_unlocked(self):
        try:
            mt = os.stat(self.texts_path).st_mtime_ns
        except OSError:
            self._texts_cache = []
            self._texts_mtime = 0
            return self._texts_cache
        if self._texts_cache is not None and self._texts_mtime == mt:
            return self._texts_cache
        try:
            with open(self.texts_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                self._texts_cache = data if isinstance(data, list) else []
                self._texts_mtime = mt
        except (OSError, ValueError):
            self._texts_cache = []
            self._texts_mtime = 0
        return self._texts_cache

    def _write_texts_unlocked(self, items):
        self._texts_cache = items
        _atomic_write_json(self.texts_path, items)
        try:
            self._texts_mtime = os.stat(self.texts_path).st_mtime_ns
        except OSError:
            self._texts_mtime = 0

    def list_texts(self):
        with self._lock:
            return list(self._read_texts_unlocked())

    def add_text(self, text, ip=''):
        content = (text or '').strip()
        if not content:
            raise StorageError('文字内容不能为空', 400)
        if len(content) > 200_000:
            raise StorageError('文字内容过长（上限 20 万字）', 413)
        now_ms = int(time.time() * 1000)
        with self._lock:
            items = list(self._read_texts_unlocked())
            item = {
                'id': f'{now_ms}-{self._counter + 1}',
                'text': content,
                'mtime': now_ms,
                'ip': ip or '本机',
            }
            items.insert(0, item)
            self._write_texts_unlocked(items)
            self._touch()
            return item

    def update_text(self, text_id, new_text):
        if not text_id:
            raise StorageError('缺少便签 ID', 400)
        content = (new_text or '').strip()
        if not content:
            raise StorageError('文字内容不能为空', 400)
        if len(content) > 200_000:
            raise StorageError('文字内容过长（上限 20 万字）', 413)
        with self._lock:
            items = list(self._read_texts_unlocked())
            for it in items:
                if it.get('id') == text_id:
                    if it.get('text') == content:
                        return it
                    it['text'] = content
                    it['mtime'] = int(time.time() * 1000)
                    self._write_texts_unlocked(items)
                    self._touch()
                    return dict(it)
        raise StorageError('未找到该条文字便签', 404)

    def reorder_texts(self, ordered_ids):
        if not isinstance(ordered_ids, list) or not ordered_ids:
            return False
        with self._lock:
            items = list(self._read_texts_unlocked())
            by_id = {it.get('id'): it for it in items}
            picked_ids = [tid for tid in ordered_ids if tid in by_id]
            if len(picked_ids) <= 1:
                return False
            picked_set = set(picked_ids)
            it_picked = iter(picked_ids)
            new_items = [by_id[next(it_picked)] if it.get('id') in picked_set else it for it in items]
            if [i.get('id') for i in new_items] == [i.get('id') for i in items]:
                return False
            self._write_texts_unlocked(new_items)
            self._touch()
            return True

    def delete_texts(self, ids):
        id_set = set(ids or [])
        with self._lock:
            items = self._read_texts_unlocked()
            kept = [i for i in items if i.get('id') not in id_set]
            removed = len(items) - len(kept)
            if removed:
                self._write_texts_unlocked(kept)
                self._touch()
            return removed

    def clear_texts(self):
        with self._lock:
            items = self._read_texts_unlocked()
            count = len(items)
            if count:
                self._write_texts_unlocked([])
                self._touch()
            return count

    # ------------------------------------------------------------------ PIN 码管理（分用户侧 user 与管理员侧 admin，均支持多 PIN 独立管理）
    @staticmethod
    def _normalize_pin_scope(scope):
        return 'admin' if scope == 'admin' else 'user'

    def _read_pins_unlocked(self):
        if self._pins_cache is not None:
            return self._pins_cache
        default = {
            'user': {'enabled': False, 'pins': []},
            'admin': {'enabled': False, 'pins': []},
        }
        if not os.path.isfile(self.pins_path):
            self._pins_cache = default
            return self._pins_cache
        try:
            with open(self.pins_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, dict):
                # 兼容旧版单层 {'enabled': ..., 'pins': [...]} 结构
                if 'pins' in data and 'user' not in data:
                    u_pins = [p for p in (data.get('pins') or []) if isinstance(p, dict) and p.get('id') and p.get('pin')]
                    self._pins_cache = {
                        'user': {
                            'enabled': bool(data.get('enabled')) and any(p.get('enabled', True) for p in u_pins),
                            'pins': u_pins,
                        },
                        'admin': {'enabled': False, 'pins': []},
                    }
                else:
                    res = {}
                    for sc in ('user', 'admin'):
                        sec = data.get(sc) if isinstance(data.get(sc), dict) else {}
                        pins = [p for p in (sec.get('pins') or []) if isinstance(p, dict) and p.get('id') and p.get('pin')]
                        res[sc] = {
                            'enabled': bool(sec.get('enabled')) and any(p.get('enabled', True) for p in pins),
                            'pins': pins,
                        }
                    self._pins_cache = res
            else:
                self._pins_cache = default
        except (OSError, ValueError):
            self._pins_cache = default
        return self._pins_cache

    def _write_pins_unlocked(self):
        if self._pins_cache is None:
            return
        try:
            _atomic_write_json(self.pins_path, self._pins_cache)
        except OSError:
            pass

    def _format_scope_config(self, cfg_sec):
        out_pins = []
        for p in cfg_sec['pins']:
            u = self._pin_usage.get(p['id']) or {}
            out_pins.append({
                'id': p['id'],
                'pin': p['pin'],
                'label': p.get('label') or '',
                'enabled': bool(p.get('enabled', True)),
                'created': p.get('created') or 0,
                'useCount': u.get('count', 0),
                'lastUsed': u.get('lastUsed', 0),
                'lastIp': u.get('lastIp', ''),
            })
        return {'enabled': bool(cfg_sec['enabled']), 'pins': out_pins}

    def get_pin_config(self):
        with self._lock:
            cfg = self._read_pins_unlocked()
            return {
                'user': self._format_scope_config(cfg['user']),
                'admin': self._format_scope_config(cfg['admin']),
            }

    def set_pin_enabled(self, scope: str, enabled: bool):
        sc = self._normalize_pin_scope(scope)
        with self._lock:
            cfg = self._read_pins_unlocked()
            sec = cfg[sc]
            if enabled and not any(p.get('enabled', True) for p in sec['pins']):
                role = '管理员侧' if sc == 'admin' else '用户侧'
                raise StorageError(f'请先添加并启用至少一个{role} PIN 码', 400)
            sec['enabled'] = bool(enabled)
            self._write_pins_unlocked()
        return self.get_pin_config()

    def add_pin(self, scope: str, pin_code: str, label: str = ''):
        sc = self._normalize_pin_scope(scope)
        code = (pin_code or '').strip()
        lbl = (label or '').strip()[:40]
        if not code or len(code) > 32:
            raise StorageError('PIN 码长度需在 1 ~ 32 位之间', 400)
        now_ms = int(time.time() * 1000)
        with self._lock:
            cfg = self._read_pins_unlocked()
            sec = cfg[sc]
            if any(p['pin'] == code for p in sec['pins']):
                raise StorageError('该 PIN 码已存在', 409)
            default_prefix = '管理员' if sc == 'admin' else '设备'
            item = {
                'id': f'{sc[0]}{now_ms}_{len(sec["pins"]) + 1}',
                'pin': code,
                'label': lbl or f'{default_prefix} #{len(sec["pins"]) + 1}',
                'enabled': True,
                'created': now_ms,
            }
            sec['pins'].append(item)
            if len(sec['pins']) == 1:
                sec['enabled'] = True
            self._write_pins_unlocked()
        return self.get_pin_config()

    def update_pin(self, scope: str, pin_id: str, pin_code=None, label=None, enabled=None):
        sc = self._normalize_pin_scope(scope)
        with self._lock:
            cfg = self._read_pins_unlocked()
            sec = cfg[sc]
            target = next((p for p in sec['pins'] if p['id'] == pin_id), None)
            if not target:
                raise StorageError('未找到该 PIN 码', 404)
            if pin_code is not None:
                code = str(pin_code).strip()
                if not code or len(code) > 32:
                    raise StorageError('PIN 码长度需在 1 ~ 32 位之间', 400)
                if any(p['pin'] == code and p['id'] != pin_id for p in sec['pins']):
                    raise StorageError('该 PIN 码已存在', 409)
                target['pin'] = code
            if label is not None:
                target['label'] = str(label).strip()[:40]
            if enabled is not None:
                target['enabled'] = bool(enabled)
            if sec['enabled'] and not any(p.get('enabled', True) for p in sec['pins']):
                sec['enabled'] = False
            self._write_pins_unlocked()
        return self.get_pin_config()

    def delete_pin(self, scope: str, pin_id: str):
        sc = self._normalize_pin_scope(scope)
        with self._lock:
            cfg = self._read_pins_unlocked()
            sec = cfg[sc]
            before = len(sec['pins'])
            sec['pins'] = [p for p in sec['pins'] if p['id'] != pin_id]
            if len(sec['pins']) == before:
                raise StorageError('未找到该 PIN 码', 404)
            self._pin_usage.pop(pin_id, None)
            if sec['enabled'] and not any(p.get('enabled', True) for p in sec['pins']):
                sec['enabled'] = False
            self._write_pins_unlocked()
        return self.get_pin_config()

    def reset_pin_stats(self, scope: str = ''):
        with self._lock:
            if not scope:
                self._pin_usage.clear()
            else:
                sc = self._normalize_pin_scope(scope)
                cfg = self._read_pins_unlocked()
                for p in cfg[sc]['pins']:
                    self._pin_usage.pop(p['id'], None)
        return self.get_pin_config()

    def disable_all_pins(self):
        with self._lock:
            cfg = self._read_pins_unlocked()
            cfg['user']['enabled'] = False
            cfg['admin']['enabled'] = False
            self._write_pins_unlocked()

    def verify_pin(self, scope: str, pin_code: str, client_ip: str = '', touch_usage: bool = False):
        sc = self._normalize_pin_scope(scope)
        code = (pin_code or '').strip()
        with self._lock:
            cfg = self._read_pins_unlocked()
            sec = cfg[sc]
            active_pins = [p for p in sec['pins'] if p.get('enabled', True)]
            if not sec['enabled'] or not active_pins:
                return {'ok': True, 'required': False, 'label': ''}
            matched = next((p for p in active_pins if p['pin'] == code), None)
            if not matched:
                return {'ok': False, 'required': True, 'label': ''}
            if touch_usage:
                u = self._pin_usage.setdefault(matched['id'], {'count': 0, 'lastUsed': 0, 'lastIp': ''})
                u['count'] += 1
                u['lastUsed'] = int(time.time() * 1000)
                if client_ip:
                    u['lastIp'] = client_ip
            return {'ok': True, 'required': True, 'label': matched.get('label') or '', 'id': matched['id']}

    # ------------------------------------------------------------------ 缩略图 & EXIF & 孤儿清理
    def _load_pil(self):
        if not self._pil_checked:
            self._pil_checked = True
            try:
                from PIL import ExifTags, Image, ImageOps
                Image.MAX_IMAGE_PIXELS = 200_000_000
                self._pil = (Image, ImageOps, ExifTags)
            except ImportError:
                self._pil = None
        return self._pil

    @property
    def has_pil(self):
        if self._pil_checked:
            return self._pil is not None
        import importlib.util
        return importlib.util.find_spec('PIL') is not None

    def _thumb_path(self, name, trash):
        sub = os.path.join(self.thumb_root, 'trash') if trash else self.thumb_root
        return os.path.join(sub, name + '.jpg')

    def thumbnail(self, name, trash=False):
        """返回缩略图路径；小图或无法生成时返回 None（调用方直接使用原图，避免多余磁盘写入）。"""
        src = self.resolve(name, trash)
        ext = os.path.splitext(name)[1].lower()
        if ext not in IMAGE_EXTS:
            return None
        st = os.stat(src)
        if ext in NATIVE_SMALL_EXTS and st.st_size <= SMALL_THUMB_SKIP_BYTES:
            return None
        dst = self._thumb_path(name, trash)
        src_m = st.st_mtime
        if os.path.exists(dst) and os.path.getmtime(dst) >= src_m:
            return dst
        key = (src, src_m)
        if key in self._thumb_failed:
            return None
        pil = self._load_pil()
        if pil is None:
            return None
        Image, ImageOps, _ = pil
        with self._thumb_sem:
            if os.path.exists(dst) and os.path.getmtime(dst) >= src_m:
                return dst
            tmp = dst + f'.{threading.get_ident()}.tmp'
            try:
                with Image.open(src) as im:
                    s = self.thumb_size
                    im.draft('RGB', (s * 2, s * 2))  # JPEG 解码时直接降采样，快且省内存
                    im = ImageOps.exif_transpose(im)
                    im.thumbnail((s, s), reducing_gap=2.0)
                    if im.mode in ('RGBA', 'LA', 'P'):
                        im = im.convert('RGBA')
                        bg = Image.new('RGB', im.size, (255, 255, 255))
                        bg.paste(im, mask=im.getchannel('A'))
                        im = bg
                    elif im.mode != 'RGB':
                        im = im.convert('RGB')
                    im.save(tmp, 'JPEG', quality=80)
                os.replace(tmp, dst)
                return dst
            except Exception:
                self._thumb_failed.add(key)
                return None
            finally:
                if os.path.exists(tmp):
                    try:
                        os.remove(tmp)
                    except OSError:
                        pass

    def exif(self, name, trash=False):
        """按需读取图片头部与 EXIF 信息（不解码像素数据，极低内存与 CPU 开销）。"""
        src = self.resolve(name, trash)
        st = os.stat(src)
        with self._lock:
            meta = self._read_meta_unlocked()
            m = dict(meta.get(self._meta_key(name, trash)) or meta.get(name) or {})

        info = {
            'name': name,
            'origName': m.get('orig') or name,
            'size': st.st_size,
            'mtime': int(st.st_mtime * 1000),
            'ip': m.get('ip') or '本机',
            'format': os.path.splitext(name)[1].lstrip('.').upper(),
            'width': 0,
            'height': 0,
            'mode': '',
            'fields': [],
        }
        if not self._is_image(name):
            return info
        pil = self._load_pil()
        if pil is None:
            return info
        Image, _, ExifTags = pil

        def _val_to_float(v):
            try:
                if isinstance(v, tuple) and len(v) == 2:
                    return float(v[0]) / float(v[1]) if v[1] else 0.0
                return float(v)
            except Exception:
                return None

        def _clean_str(v):
            if v is None:
                return ''
            if isinstance(v, bytes):
                try:
                    v = v.decode('utf-8', errors='ignore')
                except Exception:
                    return ''
            return str(v).strip('\x00 ').strip()

        fields = []
        try:
            with Image.open(src) as im:
                info['width'], info['height'] = im.size
                info['format'] = (im.format or info['format']).upper()
                info['mode'] = im.mode or ''
                raw_exif = im.getexif()
                if raw_exif:
                    exif_dict = dict(raw_exif)
                    # 读取 Exif IFD (0x8769) 与 GPS IFD (0x8825)
                    try:
                        sub = raw_exif.get_ifd(0x8769)
                        if sub:
                            exif_dict.update(sub)
                    except Exception:
                        pass

                    make = _clean_str(exif_dict.get(271))      # Make
                    model = _clean_str(exif_dict.get(272))     # Model
                    lens = _clean_str(exif_dict.get(42036))    # LensModel
                    dt_orig = _clean_str(exif_dict.get(36867) or exif_dict.get(306))  # DateTimeOriginal / DateTime
                    software = _clean_str(exif_dict.get(305))  # Software

                    if make or model:
                        cam = model if (make and model.lower().startswith(make.lower())) else f'{make} {model}'.strip()
                        fields.append({'label': '相机设备', 'value': cam})
                    if lens:
                        fields.append({'label': '镜头型号', 'value': lens})
                    if dt_orig:
                        # 格式化 YYYY:MM:DD HH:MM:SS -> YYYY-MM-DD HH:MM:SS
                        if len(dt_orig) >= 10 and dt_orig[4] == ':' and dt_orig[7] == ':':
                            dt_orig = dt_orig[:10].replace(':', '-') + dt_orig[10:]
                        fields.append({'label': '拍摄时间', 'value': dt_orig})

                    # 焦距
                    fl = _val_to_float(exif_dict.get(37386))
                    fl35 = exif_dict.get(41989)
                    if fl and fl > 0:
                        fl_str = f'{fl:.1f}'.rstrip('0').rstrip('.') + ' mm'
                        if fl35:
                            fl_str += f' (等效 {fl35} mm)'
                        fields.append({'label': '焦距', 'value': fl_str})

                    # 光圈
                    fn = _val_to_float(exif_dict.get(33437))
                    if fn and fn > 0:
                        fields.append({'label': '光圈', 'value': f'f/{fn:.1f}'.rstrip('0').rstrip('.')})

                    # 快门速度
                    exp = _val_to_float(exif_dict.get(33434))
                    if exp and exp > 0:
                        if exp < 1:
                            fields.append({'label': '快门速度', 'value': f'1/{int(round(1.0 / exp))} s'})
                        else:
                            fields.append({'label': '快门速度', 'value': f'{exp:.1f}'.rstrip('0').rstrip('.') + ' s'})

                    # ISO
                    iso = exif_dict.get(34855) or exif_dict.get(34867)
                    if iso:
                        if isinstance(iso, (tuple, list)):
                            iso = iso[0]
                        fields.append({'label': 'ISO 感光度', 'value': f'ISO {iso}'})

                    # 曝光补偿
                    bias = _val_to_float(exif_dict.get(37380))
                    if bias is not None and abs(bias) < 20:
                        sign = '+' if bias > 0 else ''
                        fields.append({'label': '曝光补偿', 'value': f'{sign}{bias:.1f}'.rstrip('0').rstrip('.') + ' EV'})

                    # 闪光灯
                    flash = exif_dict.get(37385)
                    if isinstance(flash, int):
                        fields.append({'label': '闪光灯', 'value': '已开启' if (flash & 1) else '未开启'})

                    # GPS 坐标
                    try:
                        gps = raw_exif.get_ifd(0x8825)
                        if gps and 2 in gps and 4 in gps:
                            def _dms(dms, ref):
                                d = _val_to_float(dms[0]) or 0
                                m_ = _val_to_float(dms[1]) or 0
                                s_ = _val_to_float(dms[2]) or 0
                                val = d + m_ / 60.0 + s_ / 3600.0
                                return -val if ref in ('S', 'W', b'S', b'W') else val
                            lat = _dms(gps[2], _clean_str(gps.get(1)))
                            lon = _dms(gps[4], _clean_str(gps.get(3)))
                            if lat or lon:
                                fields.append({'label': 'GPS 坐标', 'value': f'{lat:.6f}, {lon:.6f}'})
                    except Exception:
                        pass

                    if software:
                        fields.append({'label': '处理软件', 'value': software})
        except Exception:
            pass

        info['fields'] = fields
        return info

    def clean_orphans(self):
        """清理回收站与图库中的孤儿缩略图、残留临时文件及失效元数据条目。"""
        thumb_removed = 0
        freed_bytes = 0
        meta_removed = 0

        with self._lock:
            valid_lib = set()
            valid_trash = set()
            try:
                with os.scandir(self.root) as it:
                    for e in it:
                        if e.is_file() and self._valid_name(e.name):
                            valid_lib.add(e.name)
            except OSError:
                pass
            try:
                with os.scandir(self.trash) as it:
                    for e in it:
                        if e.is_file() and self._valid_name(e.name):
                            valid_trash.add(e.name)
            except OSError:
                pass

            # 1. 扫描 .thumbs 及 .thumbs/trash
            for sub_dir, valid_set in ((self.thumb_root, valid_lib), (os.path.join(self.thumb_root, 'trash'), valid_trash)):
                try:
                    with os.scandir(sub_dir) as it:
                        for e in it:
                            if not e.is_file():
                                continue
                            # 清理残留 .tmp 或原图已不存在的 .jpg 缩略图
                            is_tmp = e.name.endswith('.tmp')
                            orig_name = e.name[:-4] if e.name.endswith('.jpg') else ''
                            if is_tmp or not orig_name or orig_name not in valid_set:
                                try:
                                    sz = e.stat().st_size
                                    os.remove(e.path)
                                    thumb_removed += 1
                                    freed_bytes += sz
                                except OSError:
                                    pass
                except OSError:
                    pass

            # 2. 清理失效的 .meta.json 记录
            meta = self._read_meta_unlocked()
            stale_keys = []
            for k in list(meta.keys()):
                if k.startswith('trash/'):
                    if k[6:] not in valid_trash:
                        stale_keys.append(k)
                else:
                    if k not in valid_lib:
                        stale_keys.append(k)
            for k in stale_keys:
                meta.pop(k, None)
                meta_removed += 1
            if meta_removed:
                self._write_meta_unlocked()

            self._thumb_failed.clear()

        return {
            'count': thumb_removed,
            'metaCount': meta_removed,
            'freedBytes': freed_bytes,
        }

    def _move_thumb(self, name, trash_from, new_name, trash_to):
        try:
            os.replace(self._thumb_path(name, trash_from), self._thumb_path(new_name, trash_to))
        except OSError:
            pass

    def _drop_thumb(self, name, trash):
        try:
            os.remove(self._thumb_path(name, trash))
        except OSError:
            pass

    # ------------------------------------------------------------------ 管理
    def _move(self, names, from_trash, to_trash):
        moved = []
        src_dir, dst_dir = self._area(from_trash), self._area(to_trash)
        with self._lock:
            meta = self._read_meta_unlocked()
            meta_changed = False
            for n in names:
                try:
                    src = self.resolve(n, from_trash)
                except StorageError:
                    continue
                target = self._free_name(dst_dir, n)
                os.replace(src, os.path.join(dst_dir, target))
                self._move_thumb(n, from_trash, target, to_trash)
                old_k = self._meta_key(n, from_trash)
                new_k = self._meta_key(target, to_trash)
                if old_k in meta:
                    meta[new_k] = meta.pop(old_k)
                    meta_changed = True
                moved.append(target)
            if meta_changed:
                self._write_meta_unlocked()
            self._touch()
        return moved

    def delete(self, names):
        """移入回收站。"""
        return self._move(names, False, True)

    def restore(self, names):
        return self._move(names, True, False)

    def purge(self, names):
        """从回收站彻底删除。"""
        removed = 0
        with self._lock:
            meta = self._read_meta_unlocked()
            meta_changed = False
            for n in names:
                try:
                    os.remove(self.resolve(n, True))
                    self._drop_thumb(n, True)
                    if meta.pop(self._meta_key(n, True), None) is not None:
                        meta_changed = True
                    removed += 1
                except (StorageError, OSError):
                    continue
            if meta_changed:
                self._write_meta_unlocked()
            self._touch()
        return removed

    def empty_trash(self):
        return self.purge([i['name'] for i in self.list(True)])

    def rename(self, name, new_stem, trash=False):
        src = self.resolve(name, trash)
        ext = os.path.splitext(name)[1]
        new_stem = (new_stem or '').strip()
        if ext and new_stem.lower().endswith(ext.lower()):
            new_stem = new_stem[: -len(ext)]
        new_name = new_stem + ext
        if not new_stem or not self._valid_name(new_name) or len(new_name) > 200:
            raise StorageError('新文件名无效（不能包含 \\ / : * ? " < > | 且不能以 . 开头）', 400)
        if new_name == name:
            return name
        with self._lock:
            dst = os.path.join(self._area(trash), new_name)
            if os.path.exists(dst) and os.path.normcase(dst) != os.path.normcase(src):
                raise StorageError('已存在同名文件', 409)
            os.replace(src, dst)
            self._move_thumb(name, trash, new_name, trash)
            meta = self._read_meta_unlocked()
            old_k = self._meta_key(name, trash)
            new_k = self._meta_key(new_name, trash)
            if old_k in meta:
                meta[new_k] = meta.pop(old_k)
                self._write_meta_unlocked()
            self._touch()
        return new_name

    def write_zip(self, names, out, trash=False):
        """把选中文件以 ZIP 流式写入 out。"""
        with zipfile.ZipFile(out, 'w', zipfile.ZIP_STORED, allowZip64=True) as zf:
            for n in names:
                try:
                    zf.write(self.resolve(n, trash), arcname=n)
                except StorageError:
                    continue
