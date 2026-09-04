#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
產生「透視校正」的驗證素材。

為什麼素材要用 Pillow 產、校正卻用前端的 TypeScript 做：
  如果形變與校正都用同一份程式，量到的誤差只證明它「跟自己一致」，
  系統性的錯（例如把 homography 解反了）會完全對消。
  這裡用 Pillow 的 PERSPECTIVE（C 實作，跟我們的程式毫無關係）把已知圖案
  壓成已知的梯形，前端再把它拉回來 —— 兩邊獨立，誤差才有意義。

輸出（原始 RGBA，不壓縮：Node 沒有內建 PNG 解碼器，寫 bin 比拉一個
解碼函式庫進來乾淨，而且這是離線驗證用的暫存檔，不進 repo）：
  meta.json   尺寸與四角（模擬手持拍攝：梯形 + 旋轉）
  pattern.bin 真值圖案（正矩形，63:88）
  photo.bin   把 pattern 壓進四角之後的「照片」

用法：python3 scripts/trainer-card/make_warp_fixture.py <輸出目錄>
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

CARD_W, CARD_H = 542, 758      # 跟樣板上那塊卡同一個量級
PHOTO_W, PHOTO_H = 900, 1200   # 模擬手機拍到的整張照片

# 基準點中心（在 pattern 的座標系裡），驗證腳本會拿這組當真值
FIDUCIALS = [(84, 96), (458, 96), (84, 662), (458, 662), (271, 379)]


def perspective_coeffs(dst_quad, src_quad):
    A, b = [], []
    for (x, y), (u, v) in zip(dst_quad, src_quad):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.append(u)
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y]); b.append(v)
    return np.linalg.solve(np.asarray(A, float), np.asarray(b, float)).tolist()



def half_pixel(quad):
    """
    把四角平移 −0.5px，用來抵銷 Pillow 與我們之間的**像素中心慣例差**。

    Pillow 的 PERSPECTIVE 把輸出像素的**索引** (x, y) 直接當座標去取樣；
    連續幾何（Canvas、OpenGL、我們的 perspective.ts）則把像素 i 的中心
    定在 i+0.5。兩者差剛好半個像素，實測就是整齊的 0.5px 系統性位移
    （五顆基準點的誤差一模一樣都是 0.64px ≈ √2/2），跟形變量無關。

    把對應點兩邊都減 0.5，等於在 Pillow 外面包一層 T(−0.5)∘H∘T(+0.5)，
    索引慣例就對齊到中心慣例了。**不修這個，量到的會是慣例差不是校正誤差。**
    """
    return [(x - 0.5, y - 0.5) for (x, y) in quad]


def make_pattern() -> Image.Image:
    """
    高頻 + 低頻都有的測試圖案。
    只用平滑漸層的話，任何模糊的校正都會拿到很漂亮的誤差；
    棋盤格與細線才逼得出取樣的錯位。
    """
    img = Image.new("RGB", (CARD_W, CARD_H), (250, 250, 248))
    d = ImageDraw.Draw(img)
    cell = 38
    for j in range(0, CARD_H, cell):
        for i in range(0, CARD_W, cell):
            if ((i // cell) + (j // cell)) % 2 == 0:
                d.rectangle((i, j, i + cell - 1, j + cell - 1), fill=(38, 44, 60))
    # 低頻：垂直漸層疊上去，測 8 bit 精度有沒有被吃掉
    g = np.linspace(0, 60, CARD_H, dtype=np.float32)[:, None, None]
    arr = np.clip(np.asarray(img).astype(np.float32) + g, 0, 255).astype(np.uint8)
    img = Image.fromarray(arr)
    d = ImageDraw.Draw(img)
    # 細線與角標：角落對齊差 1px 就看得出來
    for k in range(6):
        d.line((0, 120 + k * 100, CARD_W, 150 + k * 100), fill=(40, 200, 90), width=3)
    d.rectangle((6, 6, CARD_W - 7, CARD_H - 7), outline=(0, 140, 200), width=5)
    d.ellipse((CARD_W // 2 - 60, CARD_H // 2 - 60, CARD_W // 2 + 60, CARD_H // 2 + 60),
              outline=(255, 190, 0), width=7)

    # ── 基準點（fiducial）：五顆純紅圓盤，外圍留白 ───────────────────
    # 為什麼要有這個：棋盤格的逐像素差**量不到幾何誤差**，它量到的是
    # 「兩次重取樣把銳利邊緣磨掉多少」。校正準不準是幾何問題，要用
    # 幾何的量法 —— 校正後把圓盤的重心找回來，跟已知位置比，單位是像素。
    # 圓盤用純紅、周圍其他東西都不含純紅，重心才抓得乾淨。
    for cx, cy in FIDUCIALS:
        d.ellipse((cx - 36, cy - 36, cx + 36, cy + 36), fill=(255, 255, 255))
        d.ellipse((cx - 22, cy - 22, cx + 22, cy + 22), fill=(255, 0, 0))
    return img


def main() -> None:
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out_dir, exist_ok=True)

    pattern = make_pattern()

    # 模擬手持：上緣比下緣窄（鏡頭俯視）＋ 整體轉 6°＋ 不置中。
    # 這比實際拍卡的偏差大一些，是刻意的 —— 驗證要在比真實更壞的條件下過。
    quad = [
        (196.0, 168.0),      # 左上
        (694.0, 232.0),      # 右上
        (742.0, 1012.0),     # 右下
        (140.0, 940.0),      # 左下
    ]

    coeffs = perspective_coeffs(
        half_pixel(quad),
        half_pixel([(0, 0), (CARD_W, 0), (CARD_W, CARD_H), (0, CARD_H)]))
    photo = Image.new("RGB", (PHOTO_W, PHOTO_H), (24, 26, 30))
    warped = pattern.convert("RGBA").transform(
        (PHOTO_W, PHOTO_H), Image.PERSPECTIVE, coeffs, Image.BICUBIC)
    photo = Image.alpha_composite(photo.convert("RGBA"), warped)

    with open(os.path.join(out_dir, "pattern.bin"), "wb") as f:
        f.write(pattern.convert("RGBA").tobytes())
    with open(os.path.join(out_dir, "photo.bin"), "wb") as f:
        f.write(photo.convert("RGBA").tobytes())
    with open(os.path.join(out_dir, "meta.json"), "w") as f:
        json.dump({
            "pattern": [CARD_W, CARD_H],
            "photo": [PHOTO_W, PHOTO_H],
            "quad": [{"x": x, "y": y} for x, y in quad],
            "fiducials": [{"x": x, "y": y} for x, y in FIDUCIALS],
        }, f, indent=2)

    photo.convert("RGB").save(os.path.join(out_dir, "photo.png"))
    pattern.save(os.path.join(out_dir, "pattern.png"))
    print(f"fixture → {out_dir}")


if __name__ == "__main__":
    main()
