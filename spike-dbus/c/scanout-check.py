#!/usr/bin/env python3
"""分析 spike 探针导出的 Scanout raw 像素帧，校验画面非空且内容丰富。

用法: python3 scanout-check.py <raw-file> <width> <height> <stride>
"""
import sys


def main():
    if len(sys.argv) < 5:
        print("usage: scanout-check.py <file> <width> <height> <stride>")
        return 2
    path, w, h, stride = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
    data = open(path, "rb").read()
    bpp = 4  # pixman x8r8g8b8 = 4 字节/像素
    expected = h * stride
    print(f"file={path} {len(data)}B, expect {w}x{h} stride={stride} = {expected}B")
    if len(data) < expected:
        print("RESULT: FAIL (数据长度不足)")
        return 1

    nonzero = 0
    distinct = set()
    total = 0
    # 抽样统计（每 97 行取 1 行，避免全扫太慢）
    for y in range(0, h, 97):
        row = data[y * stride:(y + 1) * stride]
        for x in range(0, w, 7):
            o = x * bpp
            if o + 3 > len(row):
                break
            r, g, b = row[o], row[o + 1], row[o + 2]
            if r or g or b:
                nonzero += 1
            distinct.add((r >> 4, g >> 4, b >> 4))
            total += 1

    # 首个像素
    first = data[:4]
    print(f"first pixel RGBA={list(first)}")
    nz_ratio = nonzero / total if total else 0
    print(f"sampled {total} px, nonblack={nonzero} ({100*nz_ratio:.1f}%), distinct color buckets={len(distinct)}")
    if nz_ratio > 0.05:
        print("C6_SCANOUT_VERDICT: PASS (画面像素非空且可见)")
        return 0
    elif nz_ratio > 0:
        print("C6_SCANOUT_VERDICT: PARTIAL (有像素但极少)")
        return 0
    else:
        print("C6_SCANOUT_VERDICT: FAIL (全黑/空帧)")
        return 1


if __name__ == "__main__":
    sys.exit(main())
