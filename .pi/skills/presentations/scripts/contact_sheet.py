#!/usr/bin/env python3
"""Compose Poppler P6 thumbnails as a PNG using only the Python standard library."""
import argparse
import binascii
from pathlib import Path
import struct
import zlib


def read_ppm(path):
    data = Path(path).read_bytes()
    offset = 0

    def token():
        nonlocal offset
        while offset < len(data):
            if data[offset] in b' \t\r\n':
                offset += 1
            elif data[offset] == 35:
                end = data.find(b'\n', offset)
                if end < 0:
                    raise ValueError('Invalid PPM comment')
                offset = end + 1
            else:
                break
        start = offset
        while offset < len(data) and data[offset] not in b' \t\r\n':
            offset += 1
        return data[start:offset]

    if token() != b'P6':
        raise ValueError('Expected a P6 thumbnail')
    width, height, maximum = int(token()), int(token()), int(token())
    if not (0 < width <= 480 and 0 < height <= 480 and maximum == 255):
        raise ValueError('Invalid thumbnail dimensions or color depth')
    if offset >= len(data) or data[offset] not in b' \t\r\n':
        raise ValueError('Missing PPM raster separator')
    offset += 2 if data[offset:offset + 2] == b'\r\n' else 1
    pixels = data[offset:]
    if len(pixels) != width * height * 3:
        raise ValueError('Invalid thumbnail raster length')
    return width, height, pixels


def compose(paths, output, columns):
    if not 1 <= len(paths) <= 200 or not 1 <= columns <= 8:
        raise ValueError('Expected 1–200 pages and 1–8 columns')
    pages = [read_ppm(path) for path in paths]
    gap = 12
    cell_w, cell_h = max(p[0] for p in pages), max(p[1] for p in pages)
    columns = min(columns, len(pages))
    rows = (len(pages) + columns - 1) // columns
    width, height = columns * (cell_w + gap) + gap, rows * (cell_h + gap) + gap
    canvas = bytearray(bytes((32, 33, 36)) * width * height)
    for index, (w, h, pixels) in enumerate(pages):
        left = gap + (index % columns) * (cell_w + gap) + (cell_w - w) // 2
        top = gap + (index // columns) * (cell_h + gap) + (cell_h - h) // 2
        for row in range(h):
            start = ((top + row) * width + left) * 3
            canvas[start:start + w * 3] = pixels[row * w * 3:(row + 1) * w * 3]

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', binascii.crc32(kind + data) & 0xffffffff)

    scanlines = b''.join(b'\0' + canvas[y * width * 3:(y + 1) * width * 3] for y in range(height))
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(scanlines)) + chunk(b'IEND', b'')
    Path(output).write_bytes(png)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    parser.add_argument('--columns', type=int, default=3)
    parser.add_argument('images', nargs='+')
    args = parser.parse_args()
    compose(args.images, args.output, args.columns)
