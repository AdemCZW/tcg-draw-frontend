#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
訓練家卡 —— 產生「佔位樣板」template.jpg（1696×2528）。

╔══════════════════════════════════════════════════════════════════════╗
║  這是佔位資產，不是正式素材。                                          ║
║  真樣板（AI 生成、人工核准）到位後，assets/ 底下這四個檔案             ║
║  template.jpg / finger-mask.png / card-shading.png / coords.json      ║
║  必須**整組重做**（規格 §6.2：四個檔一起定案、一起鎖死）。            ║
║  重做方式：把真樣板放成 template.jpg，重跑 measure_template.py。      ║
╚══════════════════════════════════════════════════════════════════════╝

為什麼要自己畫一張，而不是等真樣板：
  真樣板的白卡在哪裡、歪幾度，只有「量出來的值」，沒有真值可以對照 ——
  量測腳本準不準，永遠驗不了。這張佔位樣板是**先定四角、再把卡精確地
  透視貼進那四角**，所以四角是已知真值，量測腳本的誤差可以量化。
  這是真樣板做不到的事，也是這張圖存在的唯一理由。

刻意畫進去的三件事（對應規格的三個缺口）：
  ① 白卡**旋轉 2.5°** —— 規格 §4.3 用軸對齊 bbox，歪 2° 就對不齊手指。
     量測腳本必須找「實際四角」而不是 bbox，這張圖就是用來抓那個錯的。
  ② 白卡上有**柔和陰影**（垂直漸層 + 兩個拇指的落影）—— 規格 §6.2 的
     `mn > 200` 二值化會把陰影一起丟掉，貼上去的卡就是全平的貼紙。
  ③ 拇指用**帶彩度的膚色**，陰影用**中性灰** —— 兩者的分離靠彩度而不是
     亮度，這樣「壓暗的卡面」不會被誤判成手指。真樣板同理（膚色有彩度）。

用法：python3 scripts/trainer-card/make_placeholder_template.py
輸出：src/features/trainer-card/assets/template.jpg
      scripts/trainer-card/placeholder-truth.json   ← 四角真值，給驗證用
"""
from __future__ import annotations

import json
import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ASSETS = os.path.join(ROOT, "src", "features", "trainer-card", "assets")
HERE = os.path.dirname(os.path.abspath(__file__))

W, H = 1696, 2528

# ── 卡片真值：先定死，再把卡「透視貼」進這四角 ─────────────────────────
CARD_CX, CARD_CY = 847.0, 1545.0
CARD_H = 756.0
CARD_W = CARD_H * 63.0 / 88.0        # 嚴格照實體裸卡比例 0.7159
CARD_DEG = 2.5                        # 刻意的輕微旋轉


def truth_corners() -> list[list[float]]:
    """四角真值，順序：左上、右上、右下、左下（順時針，影像座標 y 向下）。"""
    t = math.radians(CARD_DEG)
    cos, sin = math.cos(t), math.sin(t)
    hw, hh = CARD_W / 2, CARD_H / 2
    local = [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)]
    return [
        [CARD_CX + x * cos - y * sin, CARD_CY + x * sin + y * cos]
        for (x, y) in local
    ]


def perspective_coeffs(dst_quad, src_quad):
    """
    求 PIL Image.PERSPECTIVE 要的 8 個係數。

    PIL 的 PERSPECTIVE 是**反向映射**：輸出像素 (x,y) 去輸入取樣
        u = (a x + b y + c) / (g x + h y + 1)
        v = (d x + e y + f) / (g x + h y + 1)
    所以要解的是「輸出座標 → 輸入座標」的 homography，
    也就是 dst_quad（輸出上的四角）對應 src_quad（來源圖的四角）。

    這跟前端 perspective.ts 解的是同一組方程式 —— 兩邊各自實作、
    互相對照，等於免費多一層交叉驗證。
    """
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


def vgrad(w: int, h: int, top: tuple[int, int, int], bot: tuple[int, int, int]) -> Image.Image:
    t = np.linspace(0.0, 1.0, h, dtype=np.float32)[:, None, None]
    a = np.asarray(top, np.float32)[None, None, :]
    z = np.asarray(bot, np.float32)[None, None, :]
    arr = (a + (z - a) * t).repeat(w, axis=1)
    return Image.fromarray(arr.astype(np.uint8))


def build_card_layer() -> Image.Image:
    """
    未旋轉的卡片圖層（CARD_W × CARD_H），白底 + 中性陰影。

    陰影**刻意是中性灰**（R=G=B），不是偏色：真樣板上打在白卡的光也接近中性，
    而量測腳本靠「彩度低 = 卡、彩度高 = 手」來分離兩者。
    """
    w, h = int(round(CARD_W)), int(round(CARD_H))
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    u, v = xx / (w - 1), yy / (h - 1)

    # 主光：左上偏亮、右下偏暗（模擬單一光源）
    shade = 1.0 - 0.16 * v - 0.07 * u
    # 兩個拇指壓在卡上會投下落影 —— 位置跟下面畫的拇指對齊
    for tx, ty in ((0.10, 0.62), (0.90, 0.62)):
        d = np.hypot((u - tx) * 1.35, (v - ty))
        shade -= 0.22 * np.exp(-(d * 4.2) ** 2)
    # 卡緣一圈極淡的暗角，讓卡看起來有厚度而不是貼紙
    edge = np.minimum.reduce([u, 1 - u, v, 1 - v])
    shade -= 0.09 * np.exp(-(edge * 26.0))
    shade = np.clip(shade, 0.55, 1.0)

    base = 252.0 * shade
    rgb = np.repeat(base[:, :, None], 3, axis=2).astype(np.uint8)
    img = Image.fromarray(rgb).filter(ImageFilter.GaussianBlur(2.0))
    out = Image.new("RGBA", (w, h))
    out.paste(img, (0, 0))
    out.putalpha(255)
    return out


def main() -> None:
    quad = truth_corners()

    # ── 背景：柔和的戶外漸層（淺景深的替身） ──────────────────────────
    # 背景刻意帶彩度（藍天 → 草地）。真樣板的 prompt 要的也是「戶外小鎮、
    # 日光、淺景深」，那種背景本來就有顏色；如果背景是近中性的米白，
    # 量測腳本靠彩度分離卡片的做法會失效 —— 那是樣板挑選要避開的情況，
    # 不是腳本要硬扛的（規格 §6.2 對白手套也做了同樣的取捨）。
    img = vgrad(W, H, (162, 200, 232), (186, 212, 168)).convert("RGBA")
    d = ImageDraw.Draw(img, "RGBA")
    d.ellipse((-380, 1180, 720, 2280), fill=(198, 212, 186, 190))
    d.ellipse((1020, 1320, 2120, 2420), fill=(203, 214, 192, 190))
    img = img.filter(ImageFilter.GaussianBlur(26))
    d = ImageDraw.Draw(img, "RGBA")

    SKIN = (231, 183, 148, 255)
    SKIN_DK = (206, 156, 121, 255)
    CLOTH = (74, 96, 138, 255)
    HAIR = (58, 47, 44, 255)

    # ── 角色（半身）：軀幹 → 頭髮 → 臉 ────────────────────────────────
    d.rounded_rectangle((470, 1300, 1226, 2528), radius=150, fill=CLOTH)
    d.ellipse((560, 300, 1136, 960), fill=HAIR)
    d.ellipse((618, 400, 1078, 1010), fill=SKIN)
    d.ellipse((610, 330, 1086, 700), fill=HAIR)
    d.ellipse((700, 640, 760, 700), fill=(52, 44, 42, 255))
    d.ellipse((936, 640, 996, 700), fill=(52, 44, 42, 255))
    d.rounded_rectangle((760, 940, 936, 1360), radius=80, fill=SKIN)   # 脖子

    # ── 手臂：從身體兩側伸到卡片下緣兩角 ──────────────────────────────
    d.line((470, 1980, 700, 1760), fill=SKIN, width=150, joint="curve")
    d.line((1226, 1980, 994, 1760), fill=SKIN, width=150, joint="curve")

    # ── 貼卡：把卡片圖層用 PERSPECTIVE 精確送進 truth 四角 ─────────────
    card = build_card_layer()
    cw, ch = card.size
    coeffs = perspective_coeffs(
        half_pixel(quad), half_pixel([(0, 0), (cw, 0), (cw, ch), (0, ch)]))
    warped = card.transform((W, H), Image.PERSPECTIVE, coeffs, Image.BICUBIC)

    # 卡片底下先鋪一層落影，卡才不會像浮在角色前面
    sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(sh).polygon(
        [(x + 16, y + 26) for x, y in quad], fill=(28, 26, 30, 120)
    )
    img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(22)))
    img.alpha_composite(warped)

    # ── 拇指：壓在卡片**上方**，用帶彩度的膚色 ────────────────────────
    hands = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hands, "RGBA")
    t = math.radians(CARD_DEG)
    for sgn in (-1, 1):
        # 以卡片中心為原點，用卡片自身的旋轉座標系定位，拇指才會跟著卡歪
        lx, ly = sgn * CARD_W * 0.40, CARD_H * 0.12
        cx = CARD_CX + lx * math.cos(t) - ly * math.sin(t)
        cy = CARD_CY + lx * math.sin(t) + ly * math.cos(t)
        hd.ellipse((cx - 62, cy - 108, cx + 62, cy + 108), fill=SKIN)
        hd.ellipse((cx - 44, cy - 92, cx + 30, cy + 20), fill=SKIN_DK)
    img.alpha_composite(hands.filter(ImageFilter.GaussianBlur(1.2)))

    os.makedirs(ASSETS, exist_ok=True)
    out = os.path.join(ASSETS, "template.jpg")
    img.convert("RGB").save(out, "JPEG", quality=88, optimize=True)

    truth = {
        "_note": "佔位樣板的四角真值。真樣板到位後這個檔案作廢。",
        "size": [W, H],
        "cardCenter": [CARD_CX, CARD_CY],
        "cardSize": [CARD_W, CARD_H],
        "rotationDeg": CARD_DEG,
        "corners": quad,
    }
    with open(os.path.join(HERE, "placeholder-truth.json"), "w") as f:
        json.dump(truth, f, indent=2)

    print(f"wrote {out}  ({os.path.getsize(out)/1024:.0f} KB)")
    print("truth corners:", [[round(v, 2) for v in c] for c in quad])


if __name__ == "__main__":
    main()
