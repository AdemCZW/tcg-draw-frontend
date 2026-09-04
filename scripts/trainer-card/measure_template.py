#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
訓練家卡 —— 量測樣板，產生三個衍生資產。

╔══════════════════════════════════════════════════════════════════════╗
║  輸入 template.jpg 目前是**佔位樣板**（見 make_placeholder_template）║
║  真樣板到位後：換掉 template.jpg，重跑這支腳本，四個檔一起更新。      ║
║  規格 §6.2：template / finger-mask / card-shading / coords 一起鎖死。 ║
╚══════════════════════════════════════════════════════════════════════╝

輸出（全部到 src/features/trainer-card/assets/）：
  coords.json        卡片實際四角、正規化目標四角、遮罩與陰影的裁切框
  finger-mask.png    手指遮罩（RGBA，資訊在 alpha）
  card-shading.png   白卡區域的明度圖（灰階），合成時當 multiply 層

跟規格 §6.2 原腳本的三個差異，以及為什麼：

① **找四角，不是 bbox。**
   規格量到白卡比例 0.725 vs 應有的 0.716 —— 那 1.3% 幾乎一定是卡有輕微
   旋轉：軸對齊 bbox 會把旋轉矩形的外接框當成卡，寬高都被撐大。
   用 bbox + 置中貼合，只要歪 2°，貼上去的卡跟手指遮罩就對不齊
   （卡的四角會露在手指外面）。這裡改成求**最小面積外接矩形**，
   拿到真正的四角與旋轉角。

② **不做 `mn > 200` 的硬二值化。**
   那條門檻會把「被陰影壓暗的白卡」判成非卡，於是陰影整片變成手指遮罩，
   而且卡面資訊被丟掉。改成用**彩度**分離：白卡不管多暗都是中性色
   （max-min 小），手／膚色一定有彩度。亮度門檻只用來擋掉全黑背景。

③ **多抽一層陰影。**
   從白卡區域取明度、除以高分位參考值，得到 0～1 的乘算層。
   合成時把它乘回貼上去的卡，卡才會吃到樣板裡的光線與手的落影 ——
   這是「看起來是合成的」跟「看起來是真的拿在手上」之間的差別。

用法：
  python3 scripts/trainer-card/measure_template.py
  python3 scripts/trainer-card/measure_template.py --truth   # 跟佔位真值對照
"""
from __future__ import annotations

import argparse
import json
import math
import os

import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ASSETS = os.path.join(ROOT, "src", "features", "trainer-card", "assets")
HERE = os.path.dirname(os.path.abspath(__file__))

CARD_RATIO = 63.0 / 88.0     # 實體裸卡，0.71590…


# ── 幾何工具 ──────────────────────────────────────────────────────────
def convex_hull(pts: np.ndarray) -> np.ndarray:
    """單調鏈凸包。pts 為 (N,2) float，回傳逆時針的頂點。"""
    p = pts[np.lexsort((pts[:, 1], pts[:, 0]))]

    def half(ps):
        out: list[np.ndarray] = []
        for q in ps:
            while len(out) >= 2:
                a, b = out[-2], out[-1]
                if (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]) <= 0:
                    out.pop()
                else:
                    break
            out.append(q)
        return out

    return np.asarray(half(p)[:-1] + half(p[::-1])[:-1], float)


def min_area_rect(pts: np.ndarray):
    """
    最小面積外接矩形（旋轉卡尺）。回傳 (四角, 弧度)。

    只掃凸包的每一條邊：最小面積矩形必定有一邊與凸包某條邊共線，
    這是標準結論，所以不需要盲掃角度，也就沒有角度解析度的誤差。
    """
    hull = convex_hull(pts)
    best = None
    n = len(hull)
    for i in range(n):
        e = hull[(i + 1) % n] - hull[i]
        L = math.hypot(e[0], e[1])
        if L < 1e-9:
            continue
        ux, uy = e[0] / L, e[1] / L
        rot = np.array([[ux, uy], [-uy, ux]])       # 世界 → 邊的座標系
        q = hull @ rot.T
        lo, hi = q.min(axis=0), q.max(axis=0)
        area = float((hi[0] - lo[0]) * (hi[1] - lo[1]))
        if best is None or area < best[0]:
            corners_local = np.array([
                [lo[0], lo[1]], [hi[0], lo[1]], [hi[0], hi[1]], [lo[0], hi[1]]
            ])
            best = (area, corners_local @ rot, math.atan2(uy, ux))
    assert best is not None
    return best[1], best[2]


def order_quad(c: np.ndarray) -> np.ndarray:
    """把四角排成 左上、右上、右下、左下（影像座標，y 向下）。"""
    cen = c.mean(axis=0)
    # 依相對中心的角度排序即可得到一圈；再把起點轉到「最左上」那一顆
    ang = np.arctan2(c[:, 1] - cen[1], c[:, 0] - cen[0])
    ring = c[np.argsort(ang)]                     # 角度遞增 = 影像上的順時針
    start = int(np.argmin(ring[:, 0] + ring[:, 1]))
    return np.roll(ring, -start, axis=0)


def normalize_to_ratio(quad: np.ndarray) -> np.ndarray:
    """
    以量到的四角為基礎，輸出**嚴格 63:88** 的目標四角。

    規格 §6.2 的用意保留（AI 畫的白卡比例會有偏差，貼上去的卡不能跟著變形），
    但這裡是繞著卡片自己的旋轉軸做，而不是軸對齊置中 —— 否則歪 2° 的卡
    正規化完會轉回 0°，跟手指遮罩差開。

    高度取兩條側邊的平均（它們是「卡的長邊」，最可靠），
    寬度由比例反推，中心與旋轉角原樣保留。
    """
    tl, tr, br, bl = quad
    h = (np.linalg.norm(bl - tl) + np.linalg.norm(br - tr)) / 2
    w = h * CARD_RATIO
    ang = (math.atan2(*(tr - tl)[::-1]) + math.atan2(*(br - bl)[::-1])) / 2
    cen = quad.mean(axis=0)
    cos, sin = math.cos(ang), math.sin(ang)
    out = []
    for lx, ly in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)):
        out.append([cen[0] + lx * cos - ly * sin, cen[1] + lx * sin + ly * cos])
    return np.asarray(out, float)


def fill_holes(mask: np.ndarray) -> np.ndarray:
    """
    把 mask 內部的洞補起來（洞＝壓在卡上的手指）。

    做法是從影像邊界灌水淹掉所有「外部背景」，剩下的 False 就是內部的洞。
    用迭代式的擴散而不是遞迴，1696×2528 的圖遞迴會爆堆疊。
    """
    h, w = mask.shape
    free = ~mask
    out = np.zeros_like(free)
    out[0, :] = free[0, :]; out[-1, :] = free[-1, :]
    out[:, 0] = free[:, 0]; out[:, -1] = free[:, -1]
    while True:
        grown = out.copy()
        grown[1:, :] |= out[:-1, :]
        grown[:-1, :] |= out[1:, :]
        grown[:, 1:] |= out[:, :-1]
        grown[:, :-1] |= out[:, 1:]
        grown &= free
        if grown.sum() == out.sum():
            break
        out = grown
    return ~(out)          # 外部背景以外的全部 = 卡 + 卡上的洞


def pick_card_component(mask: np.ndarray, region: np.ndarray) -> np.ndarray:
    """
    從候選像素裡挑出「卡片」那一塊連通區。

    規則是**空間的**，不是顏色的：取「沒有碰到搜尋範圍邊界」的最大連通塊。

    為什麼需要這一條 —— 只靠顏色分不開。樣板的背景常常也是接近中性的
    （米白牆、水泥地、陰天的天空），彩度門檻放寬到能容納 JPEG 雜訊時，
    背景一定會跟著進來，而且它跟卡片是連在一起的一大片，「取最大塊」
    反而選到背景（實測第一版就是這樣，量出來的四角等於整個搜尋範圍）。

    但卡片有一個背景永遠沒有的性質：**它整張都在畫面內**，四周被角色和
    景物包住，碰不到搜尋範圍的邊界。背景則必然延伸出去。這一條把兩者
    乾淨地分開，而且不需要任何顏色的假設。

    限制：若樣板把卡片畫到超出畫面（被裁掉一角），這條規則會失效。
    規格 §6.2 的樣板 prompt 要求卡片完整入鏡，所以可接受；真樣板核准時
    順手確認一眼即可。
    """
    h, w = mask.shape
    ry, rx = np.nonzero(region)
    y0, y1, x0b, x1b = ry.min(), ry.max(), rx.min(), rx.max()

    seen = np.zeros(mask.shape, bool)
    best, best_n = None, 0
    for sy, sx in zip(*np.nonzero(mask)):
        if seen[sy, sx]:
            continue
        # 逐列氾濫（scanline flood fill）—— 比逐點快一個量級
        stack = [(int(sy), int(sx))]
        cells: list[tuple[int, int, int]] = []
        n = 0
        touches = False
        while stack:
            y, x = stack.pop()
            if seen[y, x] or not mask[y, x]:
                continue
            xa = x
            while xa > 0 and mask[y, xa - 1] and not seen[y, xa - 1]:
                xa -= 1
            xb = x
            while xb < w - 1 and mask[y, xb + 1] and not seen[y, xb + 1]:
                xb += 1
            seen[y, xa:xb + 1] = True
            cells.append((y, xa, xb))
            n += xb - xa + 1
            if y <= y0 or y >= y1 or xa <= x0b or xb >= x1b:
                touches = True
            for ny in (y - 1, y + 1):
                if 0 <= ny < h:
                    row = mask[ny, xa:xb + 1] & ~seen[ny, xa:xb + 1]
                    for dx in np.nonzero(row)[0]:
                        stack.append((ny, xa + int(dx)))
        if not touches and n > best_n:
            best_n, best = n, cells

    out = np.zeros(mask.shape, bool)
    if best is None:
        raise SystemExit("找不到卡片：所有候選區塊都碰到搜尋範圍邊界。"
                         "檢查樣板的卡片是否完整入鏡，或調整彩度門檻。")
    for y, xa, xb in best:
        out[y, xa:xb + 1] = True
    return out


# ── 主流程 ────────────────────────────────────────────────────────────
def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--truth", action="store_true", help="跟佔位樣板的四角真值對照")
    args = ap.parse_args()

    tpl_path = os.path.join(ASSETS, "template.jpg")
    tpl = Image.open(tpl_path).convert("RGB")
    W, H = tpl.size
    a = np.asarray(tpl).astype(np.int16)
    mx = a.max(axis=2); mn = a.min(axis=2)
    chroma = mx - mn
    af = a.astype(np.float32)
    lum = 0.2126 * af[..., 0] + 0.7152 * af[..., 1] + 0.0722 * af[..., 2]

    # 只在畫面中段找卡，避開背景與邊緣（沿用規格的搜尋範圍）
    region = np.zeros((H, W), bool)
    region[int(H * .25):int(H * .90), int(W * .15):int(W * .85)] = True

    # 卡＝中性色（彩度低）且不是深色。**沒有 mn>200**：被陰影壓到 140 的
    # 卡面仍然是卡，那正是我們要留下來做陰影層的部分。
    # mn 的門檻是「卡面最暗可以到多暗」。設太低會把卡片投在背景上的落影
    # 一起吃進來（落影同樣是中性色），量出來的卡就會往光源反方向多出一截。
    card = region & (chroma < 24) & (mn > 125)
    # 形態學開運算（先侵蝕再膨脹）。背景漸層裡總會有幾條寬 1～3px、剛好落在
    # 中性色的細絲，它們碰得到卡緣，接上去之後外接矩形會被拉長一截
    # （實測第一版卡高被拉長 179px，全部來自一條 3px 寬的毛邊）。
    # 開運算殺得掉細絲，而卡片的直邊侵蝕多少會膨脹回多少，尺寸不受影響。
    card = np.asarray(
        Image.fromarray((card * 255).astype(np.uint8))
        .filter(ImageFilter.MinFilter(7)).filter(ImageFilter.MaxFilter(7))
    ) > 127
    card = pick_card_component(card, region)
    card_filled = fill_holes(card)

    ys, xs = np.nonzero(card_filled)
    pts = np.stack([xs, ys], axis=1).astype(float)
    # 只餵輪廓點給凸包：內部點對外接矩形沒有貢獻，卻是幾十萬個
    edge = card_filled.copy()
    edge[1:-1, 1:-1] &= ~(card_filled[:-2, 1:-1] & card_filled[2:, 1:-1] &
                          card_filled[1:-1, :-2] & card_filled[1:-1, 2:])
    ey, ex = np.nonzero(edge)
    rect, _ = min_area_rect(np.stack([ex, ey], axis=1).astype(float))
    quad = order_quad(rect)
    target = normalize_to_ratio(quad)

    side_h = (np.linalg.norm(quad[3] - quad[0]) + np.linalg.norm(quad[2] - quad[1])) / 2
    side_w = (np.linalg.norm(quad[1] - quad[0]) + np.linalg.norm(quad[2] - quad[3])) / 2
    deg = math.degrees((math.atan2(*(quad[1] - quad[0])[::-1]) +
                        math.atan2(*(quad[2] - quad[3])[::-1])) / 2)

    print(f"size            {W}×{H}")
    print(f"measured corners {[[round(v,2) for v in c] for c in quad.tolist()]}")
    print(f"measured w×h     {side_w:.2f} × {side_h:.2f}   ratio={side_w/side_h:.4f}"
          f"  (63:88 = {CARD_RATIO:.4f})")
    print(f"rotation         {deg:+.3f}°")
    bb = [xs.min(), ys.min(), xs.max(), ys.max()]
    print(f"axis-aligned bbox x={bb[0]} y={bb[1]} w={bb[2]-bb[0]} h={bb[3]-bb[1]}"
          f"  ratio={(bb[2]-bb[0])/(bb[3]-bb[1]):.4f}  ← 規格原本用的就是這個")

    # ── 裁切框：卡的 bbox 外擴，涵蓋壓在卡緣的手指 ────────────────────
    M = 60
    rx0 = max(0, int(target[:, 0].min()) - M); ry0 = max(0, int(target[:, 1].min()) - M)
    rx1 = min(W, int(target[:, 0].max()) + M); ry1 = min(H, int(target[:, 1].max()) + M)
    rw, rh = rx1 - rx0, ry1 - ry0

    # ── 手指遮罩：卡的四角範圍內、不是卡的像素 ────────────────────────
    inside = np.ones((H, W), bool)
    yy, xx = np.mgrid[0:H, 0:W]
    for i in range(4):
        p, q = target[i], target[(i + 1) % 4]
        # 四角順時針（y 向下），內側恆為叉積 ≥ 0 的一側
        cross = (q[0] - p[0]) * (yy - p[1]) - (q[1] - p[1]) * (xx - p[0])
        inside &= cross >= 0
    fingers = inside & ~card

    fm = Image.fromarray((fingers[ry0:ry1, rx0:rx1] * 255).astype(np.uint8))
    # 開閉運算去掉毛邊，再軟化邊緣 —— 硬邊的遮罩貼上去會有鋸齒
    fm = fm.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(7)) \
           .filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(1.6))
    fm = fm.point(lambda v: 255 if v > 140 else 0).filter(ImageFilter.GaussianBlur(1.1))
    fma = np.asarray(fm)
    rgba = np.zeros((rh, rw, 4), np.uint8)
    rgba[..., :3] = 255
    rgba[..., 3] = fma
    Image.fromarray(rgba).save(os.path.join(ASSETS, "finger-mask.png"))

    # ── 陰影層：白卡區域的明度 ÷ 高分位參考值 ─────────────────────────
    # 參考值取 P97 而不是最大值：JPEG 的雜訊會讓最亮的幾顆像素偏高，
    # 用最大值當基準會讓整張圖被壓暗一階。
    card_only = inside & card
    ref = float(np.percentile(lum[card_only], 97)) if card_only.any() else 255.0
    shade = np.clip(lum / max(ref, 1.0), 0.0, 1.0)
    # 手指與卡外一律填 1.0（＝不變暗）：那些地方會被手指層蓋掉或根本沒有卡，
    # 讓它們參與乘算只會在卡緣留下一圈假的暗邊。
    neutral = ~card_only
    shade[neutral] = 1.0
    sh = Image.fromarray((shade[ry0:ry1, rx0:rx1] * 255).astype(np.uint8))
    sh = sh.filter(ImageFilter.GaussianBlur(2.2))
    sh.save(os.path.join(ASSETS, "card-shading.png"))

    coords = {
        "_placeholder": True,
        "_note": ("由 scripts/trainer-card/measure_template.py 產生。"
                  "目前的 template.jpg 是佔位樣板；真樣板到位後這四個檔一起重做。"),
        "template": {"width": W, "height": H},
        # 量到的實際四角（含旋轉），保留下來只為了追蹤樣板漂移
        "measuredQuad": [[round(v, 2) for v in c] for c in quad.tolist()],
        "measuredRatio": round(float(side_w / side_h), 4),
        "rotationDeg": round(deg, 3),
        # 合成時真正使用的四角：嚴格 63:88，中心與旋轉沿用量測值
        "cardQuad": [[round(v, 2) for v in c] for c in target.tolist()],
        # finger-mask.png 與 card-shading.png 共用這個裁切框（同尺寸、同原點）
        "overlayRect": [rx0, ry0, rw, rh],
        # 名牌：卡片下方、置中。程式畫的，不是圖片資產
        "namePlate": {"cx": W / 2, "cy": round(float(target[:, 1].max()) + 210, 1),
                      "w": round(W * 0.62, 1), "h": 168.0},
    }
    with open(os.path.join(ASSETS, "coords.json"), "w") as f:
        json.dump(coords, f, indent=2, ensure_ascii=False)

    print(f"\noverlayRect     {coords['overlayRect']}")
    print(f"finger coverage {fingers.sum()/max(inside.sum(),1)*100:.2f}% of card area")
    print(f"shading range   {shade[card_only].min():.3f} … {shade[card_only].max():.3f}"
          f"   (mean {shade[card_only].mean():.3f})")

    if args.truth:
        with open(os.path.join(HERE, "placeholder-truth.json")) as f:
            truth = json.load(f)
        t = np.asarray(truth["corners"], float)
        err = np.linalg.norm(quad - t, axis=1)
        print("\n── 對照佔位樣板真值 ──────────────────────────────")
        for i, name in enumerate(("左上", "右上", "右下", "左下")):
            print(f"  {name}  量測 ({quad[i][0]:8.2f},{quad[i][1]:8.2f})"
                  f"   真值 ({t[i][0]:8.2f},{t[i][1]:8.2f})   誤差 {err[i]:.2f} px")
        print(f"  最大角誤差 {err.max():.2f} px、平均 {err.mean():.2f} px")
        # 真正拿去貼卡的是正規化後的 cardQuad，不是原始量測值 ——
        # 驗收要看的是這一組。寬度由高度反推，所以量寬時吃到的落影不會傳下去。
        terr = np.linalg.norm(target - t, axis=1)
        print(f"  正規化後 cardQuad：最大 {terr.max():.2f} px、平均 {terr.mean():.2f} px"
              f"   ← 這組才是合成實際用的")
        print(f"  旋轉角  量測 {deg:+.3f}°  真值 {truth['rotationDeg']:+.3f}°"
              f"  誤差 {abs(deg - truth['rotationDeg']):.3f}°")
        tw, th = truth["cardSize"]
        print(f"  邊長    量測 {side_w:.2f}×{side_h:.2f}  真值 {tw:.2f}×{th:.2f}")


if __name__ == "__main__":
    main()
