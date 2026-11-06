# -*- coding: utf-8 -*-
"""把 macOS 便携目录压成带 Unix 权限位的 zip。

Windows 上 `Compress-Archive` 写出的条目 external_attr 全是 0，解压后
「启动MFlixTV.command」和 runtime 里的 node/ffmpeg 都没有执行位，双击直接
报「找不到可执行文件」。这里手工写 ZipInfo：create_system=3（Unix），
可执行文件 0755、其余 0644、目录 0755。

用法：
    python packaging/zip-macos.py <payload_dir> <out.zip> [prefix]
"""
import os
import sys
import time
import zipfile

EXEC_NAMES = {
    "启动MFlixTV.command",
    "runtime/node-arm64",
    "runtime/node-x64",
    "runtime/ffmpeg/ffmpeg-arm64",
    "runtime/ffmpeg/ffmpeg-x64",
}


def entries(root):
    for dirpath, _dirnames, filenames in os.walk(root):
        rel = os.path.relpath(dirpath, root)
        yield ("" if rel == "." else rel), True
        for name in filenames:
            yield os.path.relpath(os.path.join(dirpath, name), root), False


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    root = os.path.abspath(sys.argv[1])
    out = os.path.abspath(sys.argv[2])
    prefix = sys.argv[3] if len(sys.argv) > 3 else "MFlixTV-macOS"
    prefix = prefix.strip("/") + "/"
    if not os.path.isdir(root):
        print("目录不存在:", root)
        return 1

    execs = {n.replace("/", os.sep) for n in EXEC_NAMES}
    count = 0
    t0 = time.time()
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for rel, isdir in entries(root):
            arc = prefix + (rel.replace(os.sep, "/") if rel else "")
            if isdir:
                if not arc.endswith("/"):
                    arc += "/"
                zi = zipfile.ZipInfo(arc, time.localtime()[:6])
                zi.create_system = 3
                zi.external_attr = (0o40755 << 16) | 0x10
                zf.writestr(zi, b"")
                continue
            mode = 0o100755 if rel in execs else 0o100644
            src = os.path.join(root, rel)
            zi = zipfile.ZipInfo(arc, time.localtime(os.path.getmtime(src))[:6])
            zi.create_system = 3
            zi.external_attr = mode << 16
            zi.compress_type = zipfile.ZIP_DEFLATED
            with open(src, "rb") as fh:
                zf.writestr(zi, fh.read())
            count += 1
    print("files=%d out=%s %.1f MB %.0fs" % (
        count, out, os.path.getsize(out) / 1048576.0, time.time() - t0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
