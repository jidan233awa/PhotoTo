"""轻量级纯 Python 二维码 SVG 生成器（零第三方依赖，仅在用户点击二维码按钮时按需调用）。

支持 Byte 模式（ISO/IEC 18004），纠错等级 L，Version 1~6（最长 134 字节，远超局域网 URL 长度）。
"""

# (版本, 总码字数, EC 码字数/块, 块数, 对齐图案中心坐标)
_VERSIONS = (
    (1, 26, 7, 1, ()),
    (2, 44, 10, 1, (6, 18)),
    (3, 70, 15, 1, (6, 22)),
    (4, 100, 20, 1, (6, 26)),
    (5, 134, 26, 1, (6, 30)),
    (6, 172, 18, 2, (6, 34)),
)

# GF(256) 指数表与对数表（本原多项式 0x11D）
_EXP = [0] * 512
_LOG = [0] * 256
_x = 1
for _i in range(255):
    _EXP[_i] = _x
    _LOG[_x] = _i
    _x = (_x << 1) ^ (0x11D if _x & 0x80 else 0)
for _i in range(255, 512):
    _EXP[_i] = _EXP[_i - 255]


def _rs_encode(data: bytes, nsym: int) -> bytes:
    """计算 Reed-Solomon 纠错码字。"""
    gen = [1]
    for i in range(nsym):
        ng = [0] * (len(gen) + 1)
        for j, g in enumerate(gen):
            ng[j] ^= g
            ng[j + 1] ^= _EXP[_LOG[g] + i] if g else 0
        gen = ng
    res = list(data) + [0] * nsym
    for i in range(len(data)):
        coef = res[i]
        if coef:
            lcoef = _LOG[coef]
            for j in range(1, len(gen)):
                if gen[j]:
                    res[i + j] ^= _EXP[lcoef + _LOG[gen[j]]]
    return bytes(res[len(data):])


def _bch_format(mask: int, ecl: int = 1) -> int:
    """计算 15 位格式信息（ECL=L 时 ecl=0b01）。"""
    data = (ecl << 3) | mask
    rem = data << 10
    for i in range(4, -1, -1):
        if rem & (1 << (i + 10)):
            rem ^= 0x537 << i
    return ((data << 10) | rem) ^ 0x5412


def qr_svg(text: str, border: int = 2) -> str:
    """将文本编码为紧凑的 SVG 二维码路径字符串。"""
    raw = text.encode('utf-8')
    n = len(raw)
    for ver, total_cw, ec_cw, blocks, align in _VERSIONS:
        data_cw = total_cw - ec_cw * blocks
        if n + 2 <= data_cw:
            break
    else:
        raise ValueError('URL 过长，无法生成二维码')

    # 1. 构造数据位流：0100 (Byte 模式) + 8位长度 + 数据 + 终止符 + 补齐字节
    bits = [0, 1, 0, 0]
    for i in range(7, -1, -1):
        bits.append((n >> i) & 1)
    for b in raw:
        for i in range(7, -1, -1):
            bits.append((b >> i) & 1)
    cap_bits = data_cw * 8
    bits.extend([0] * min(4, cap_bits - len(bits)))
    while len(bits) & 7:
        bits.append(0)
    codewords = [
        sum(bits[i + k] << (7 - k) for k in range(8))
        for i in range(0, len(bits), 8)
    ]
    pad = (0xEC, 0x11)
    while len(codewords) < data_cw:
        codewords.append(pad[len(codewords) & 1])

    # 2. 分块并生成纠错码，交织输出
    if blocks == 1:
        ec = _rs_encode(bytes(codewords), ec_cw)
        final_cw = codewords + list(ec)
    else:
        bsize = data_cw // blocks
        dblocks = [codewords[i * bsize:(i + 1) * bsize] for i in range(blocks)]
        eblocks = [list(_rs_encode(bytes(b), ec_cw)) for b in dblocks]
        final_cw = [b[i] for i in range(bsize) for b in dblocks] + [
            e[i] for i in range(ec_cw) for e in eblocks
        ]

    stream = [
        (b >> i) & 1 for b in final_cw for i in range(7, -1, -1)
    ] + [0] * 7

    # 3. 初始化矩阵与功能图案
    size = ver * 4 + 17
    grid = [[None] * size for _ in range(size)]
    is_func = [[False] * size for _ in range(size)]

    def set_mod(r, c, val):
        if 0 <= r < size and 0 <= c < size:
            grid[r][c] = bool(val)
            is_func[r][c] = True

    def finder(r0, c0):
        for dr in range(-1, 8):
            for dc in range(-1, 8):
                if 0 <= dr <= 6 and 0 <= dc <= 6:
                    v = dr in (0, 6) or dc in (0, 6) or (2 <= dr <= 4 and 2 <= dc <= 4)
                else:
                    v = False
                set_mod(r0 + dr, c0 + dc, v)

    finder(0, 0)
    finder(0, size - 7)
    finder(size - 7, 0)

    for i in range(8, size - 8):
        set_mod(6, i, i % 2 == 0)
        set_mod(i, 6, i % 2 == 0)

    for ar in align:
        for ac in align:
            if (ar < 9 and ac < 9) or (ar < 9 and ac > size - 10) or (ar > size - 10 and ac < 9):
                continue
            for dr in range(-2, 3):
                for dc in range(-2, 3):
                    set_mod(ar + dr, ac + dc, max(abs(dr), abs(dc)) != 1)

    # 预留格式信息区与暗模块
    for i in range(9):
        if i != 6:
            set_mod(8, i, False)
            set_mod(i, 8, False)
    for i in range(8):
        set_mod(8, size - 1 - i, False)
        set_mod(size - 1 - i, 8, False)
    set_mod(size - 8, 8, True)

    # 4. 填充数据位（双列蛇形向上/向下）
    idx = 0
    up = True
    col = size - 1
    while col > 0:
        if col == 6:
            col -= 1
        rows = range(size - 1, -1, -1) if up else range(size)
        for r in rows:
            for dc in (0, 1):
                c = col - dc
                if not is_func[r][c]:
                    grid[r][c] = bool(stream[idx])
                    idx += 1
        up = not up
        col -= 2

    # 5. 选取最佳掩码（评估相邻同色惩罚）
    masks = (
        lambda r, c: (r + c) % 2 == 0,
        lambda r, c: r % 2 == 0,
        lambda r, c: c % 3 == 0,
        lambda r, c: (r + c) % 3 == 0,
        lambda r, c: (r // 2 + c // 3) % 2 == 0,
        lambda r, c: (r * c) % 2 + (r * c) % 3 == 0,
        lambda r, c: ((r * c) % 2 + (r * c) % 3) % 2 == 0,
        lambda r, c: ((r + c) % 2 + (r * c) % 3) % 2 == 0,
    )

    def apply_fmt(g, m):
        fmt = _bch_format(m)
        pos1 = [(8, 0), (8, 1), (8, 2), (8, 3), (8, 4), (8, 5), (8, 7), (8, 8),
                (7, 8), (5, 8), (4, 8), (3, 8), (2, 8), (1, 8), (0, 8)]
        pos2 = [(size - 1 - i, 8) for i in range(7)] + [(8, size - 8 + i) for i in range(8)]
        for i in range(15):
            bit = bool((fmt >> i) & 1)
            r1, c1 = pos1[i]
            r2, c2 = pos2[i]
            g[r1][c1] = bit
            g[r2][c2] = bit

    def penalty(g):
        score = 0
        for r in range(size):
            run = 1
            for c in range(1, size):
                if g[r][c] == g[r][c - 1]:
                    run += 1
                    if run == 5:
                        score += 3
                    elif run > 5:
                        score += 1
                else:
                    run = 1
        for c in range(size):
            run = 1
            for r in range(1, size):
                if g[r][c] == g[r - 1][c]:
                    run += 1
                    if run == 5:
                        score += 3
                    elif run > 5:
                        score += 1
                else:
                    run = 1
        return score

    best_grid = None
    best_score = 1 << 30
    for m, fn in enumerate(masks):
        cand = [
            [(grid[r][c] ^ fn(r, c)) if not is_func[r][c] else grid[r][c] for c in range(size)]
            for r in range(size)
        ]
        apply_fmt(cand, m)
        sc = penalty(cand)
        if sc < best_score:
            best_score = sc
            best_grid = cand

    # 6. 生成单路径 SVG（同行连续黑块合并为水平线段，体积最小）
    vb = size + border * 2
    parts = []
    for r in range(size):
        c = 0
        row = best_grid[r]
        while c < size:
            if row[c]:
                w = 1
                while c + w < size and row[c + w]:
                    w += 1
                parts.append(f'M{c + border},{r + border}h{w}v1h-{w}z')
                c += w
            else:
                c += 1
    d = ''.join(parts)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {vb} {vb}" '
        f'shape-rendering="crispEdges">'
        f'<rect width="{vb}" height="{vb}" fill="#fff" rx="1.5"/>'
        f'<path d="{d}" fill="#0f172a"/></svg>'
    )
