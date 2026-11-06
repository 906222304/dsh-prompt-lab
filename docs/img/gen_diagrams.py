# -*- coding: utf-8 -*-
"""生成 dsh-purge / prompt-lab 说明用流程图（Pillow 手绘，中文用微软雅黑）。"""
import math
import os

from PIL import Image, ImageDraw, ImageFont

OUT = os.path.dirname(os.path.abspath(__file__))
os.makedirs(OUT, exist_ok=True)

FONT = "C:/Windows/Fonts/msyh.ttc"
FONT_BD = "C:/Windows/Fonts/msyhbd.ttc"

INK = "#16324F"
BODY = "#33506B"
LINE = "#3C6EA5"
SOFT = "#EEF4FB"
WARN = "#B4472A"
WARN_SOFT = "#FBEDE8"
OK = "#2F6B4F"
OK_SOFT = "#EAF5EE"
GREY = "#6B7A8A"
GOLD_SOFT = "#FCF6E5"
GOLD = "#96701C"


def font(size, bold=False):
    return ImageFont.truetype(FONT_BD if bold else FONT, size)


class Canvas:
    def __init__(self, w, h, title, subtitle=""):
        self.img = Image.new("RGB", (w, h), "white")
        self.d = ImageDraw.Draw(self.img)
        self.w, self.h = w, h
        self.d.text((36, 26), title, font=font(30, True), fill=INK)
        if subtitle:
            self.d.text((36, 68), subtitle, font=font(17), fill=GREY)

    def _wrap(self, txt, f, max_w):
        lines = []
        for para in str(txt).split("\n"):
            cur = ""
            for ch in para:
                if self.d.textlength(cur + ch, font=f) <= max_w:
                    cur += ch
                else:
                    lines.append(cur)
                    cur = ch
            lines.append(cur)
        return lines

    def box(self, x, y, w, h, title="", body="", fill=SOFT, border=LINE,
            tsize=21, bsize=15, tcolor=INK, bcolor=BODY, radius=12, center=False):
        self.d.rounded_rectangle([x, y, x + w, y + h], radius=radius, fill=fill,
                                 outline=border, width=2)
        ty = y + 11
        if title:
            f = font(tsize, True)
            for ln in self._wrap(title, f, w - 22):
                tw = self.d.textlength(ln, font=f)
                self.d.text((x + (w - tw) / 2 if center else x + 12, ty), ln, font=f, fill=tcolor)
                ty += tsize + 5
        if body:
            f = font(bsize)
            ty += 1
            for ln in self._wrap(body, f, w - 22):
                tw = self.d.textlength(ln, font=f)
                self.d.text((x + (w - tw) / 2 if center else x + 12, ty), ln, font=f, fill=bcolor)
                ty += bsize + 6
        return (x, y, w, h)

    def chip(self, x, y, w, h, text, fill="#FFFFFF", border=LINE, color=INK, size=15):
        self.d.rounded_rectangle([x, y, x + w, y + h], radius=9, fill=fill, outline=border, width=2)
        f = font(size, True)
        tw = self.d.textlength(text, font=f)
        self.d.text((x + (w - tw) / 2, y + (h - size) / 2 - 2), text, font=f, fill=color)

    def arrow(self, p1, p2, label="", color=LINE, width=3, dashed=False, lpos=0.5):
        x1, y1 = p1
        x2, y2 = p2
        if dashed:
            total = math.hypot(x2 - x1, y2 - y1)
            step = 14
            n = max(1, int(total // step))
            for i in range(n):
                if i % 2:
                    continue
                t0 = i / n
                t1 = (i + 1) / n
                self.d.line([x1 + (x2 - x1) * t0, y1 + (y2 - y1) * t0,
                             x1 + (x2 - x1) * t1, y1 + (y2 - y1) * t1], fill=color, width=width)
        else:
            self.d.line([x1, y1, x2, y2], fill=color, width=width)
        ang = math.atan2(y2 - y1, x2 - x1)
        L = 15
        a = 0.44
        self.d.polygon([(x2, y2),
                        (x2 - L * math.cos(ang - a), y2 - L * math.sin(ang - a)),
                        (x2 - L * math.cos(ang + a), y2 - L * math.sin(ang + a))], fill=color)
        if label:
            f = font(14, True)
            tw = self.d.textlength(label, font=f)
            mx = x1 + (x2 - x1) * lpos
            my = y1 + (y2 - y1) * lpos
            self.d.rectangle([mx - tw / 2 - 5, my - 12, mx + tw / 2 + 5, my + 12], fill="white")
            self.d.text((mx - tw / 2, my - 9), label, font=f, fill=color)

    def note(self, x, y, text, color=GREY, size=15, width=None):
        f = font(size)
        for ln in self._wrap(text, f, width or (self.w - x - 40)):
            self.d.text((x, y), ln, font=f, fill=color)
            y += size + 6
        return y

    def save(self, name):
        self.img.save(os.path.join(OUT, name), "PNG")
        print("saved", name)


# ---------------------------------------------------------------- 图 1 架构
c = Canvas(1600, 900, "图 1  dsh-purge 的整体结构：四套入口 → 一个主行 → 五个被改造对象",
           "它不是一个纯提示词插件：入口只是壳，真正的动作落在宿主文件、启动器、提示词装配和本地数据上")
c.d.text((36, 108), "入口（用户 / 模型 / 命令行怎么触发它）", font=font(16, True), fill=LINE)
entries = [
    ("侧栏 UI", "会话输入框右侧按钮\n打开「清洗 / 演练台」"),
    ("聊天命令 ×4", "/purge  /rules\n/skills  /rewind"),
    ("模型工具 ×3", "purge_status\npurge_apply / purge_revert"),
    ("CLI", "dsh-purge --apply\n--revert / --uninstall"),
]
xs = [60, 420, 780, 1140]
for i, (t, b) in enumerate(entries):
    c.box(xs[i], 132, 300, 96, t, b, tsize=20, bsize=14)

c.box(60, 288, 1480, 190, "dsh-purge 主行（inject: systemPrompt, tools）",
      "所有入口最终都收敛到这一行的能力集合；它同时往“提示词”和“宿主文件”两个方向动手",
      fill="#E7EFF9", tsize=24, bsize=16)
c.chip(88, 360, 268, 50, "① 提示词注入（3 段）", fill="white")
c.chip(374, 360, 268, 50, "② 组装改写（重建 sections）", fill="white")
c.chip(660, 360, 268, 50, "③ 补丁引擎 core（86 条）", fill="white")
c.chip(946, 360, 268, 50, "④ 规则库 / 本地指令", fill="white")
c.chip(1232, 360, 268, 50, "⑤ net-scope 闸门", fill="white")
c.chip(88, 418, 268, 42, "重试 / 继续", fill="white", size=14)
c.chip(374, 418, 268, 42, "rewind（回退）", fill="white", size=14)
c.chip(660, 418, 268, 42, "skills 管理", fill="white", size=14)
c.chip(946, 418, 268, 42, "更新 / 卸载", fill="white", size=14)
c.chip(1232, 418, 268, 42, "桌面端工程化", fill="white", size=14)

for x in xs:
    c.arrow((x + 150, 228), (x + 150, 286))

c.d.text((36, 508), "被它改动的东西（后果落在哪里）", font=font(16, True), fill=LINE)
targets = [
    ("宿主包源码", "@deepseek-ai/* 的 lib/*.js\n86 条字面串替换\n备份 .dshpurge.bak", WARN_SOFT, WARN),
    ("启动器 shim", "dsh / dsh.ps1 插入注入块\ndsh.cmd 反向剥离\n每次启动自动生效", WARN_SOFT, WARN),
    ("systemPrompt", "新增 3 段 + 事件里重建\nidentity / baseline 段\n可被删除或改写", SOFT, LINE),
    ("$DSH_HOME 数据", "prompt-inject.md\nrules/  skills/  各种 json\nnet-scope-allow.txt", OK_SOFT, OK),
    ("演练台", "3 个插件行 + SQLite\n56 个工具 + 23 个技能", GOLD_SOFT, GOLD),
]
tx = [60, 360, 660, 960, 1260]
for i, (t, b, fill, border) in enumerate(targets):
    c.box(tx[i], 536, 280, 150, t, b, fill=fill, border=border, tsize=20, bsize=14)
    c.arrow((tx[i] + 140, 482), (tx[i] + 140, 532), color=LINE, width=2)

c.note(60, 716, "看这张图的重点：①②③ 描述“提示词怎么进模型”，④⑤ 管“规则与网络边界”，中间五个盒子才是需要长期跟着宿主版本维护的部分——"
                "它的复杂度几乎都在“改宿主 / 对抗宿主变化”，提示词能力只占很小一块。", size=16)
c.save("01-architecture.png")


# ---------------------------------------------------------------- 图 2 应用流程
c = Canvas(1500, 1120, "图 2  「应用」到底做了什么：一条可回滚的改文件流水线",
           "幂等靠回读文件内容判定，不靠“我记得改过”；npm 升级盖掉 node_modules 后由启动自愈重打")
steps = [
    ("① 触发", "启动时自动检查 / 用户在侧栏点「应用」/ CLI --apply", SOFT, LINE),
    ("② 读状态 gatherState()", "回读目标文件，逐条匹配 markers，算出每个 patch 是 applied / already / notFound", SOFT, LINE),
    ("③ 判定", "全部已生效 → 跳过（幂等，不重复叠加）", OK_SOFT, OK),
    ("④ 备份", "原件另存 <文件>.dshpurge.bak，并留一份“官方快照”供还原兜底", SOFT, LINE),
    ("⑤ 替换", "对 86 条补丁逐条做字面串替换（YAML 另做标量清洗）", WARN_SOFT, WARN),
    ("⑥ 注入 shim", "往 dsh / dsh.ps1 写入注入块；密封运行目录跳过", WARN_SOFT, WARN),
    ("⑦ 落戳", "写 applied.json + installed-rev，记录“这版装了什么”", SOFT, LINE),
    ("⑧ 重启宿主", "改的是宿主源码，必须重启才生效（桌面端由分离进程重启）", WARN_SOFT, WARN),
]
y = 116
for i, (t, b, fill, border) in enumerate(steps):
    c.box(80, y, 760, 84, t, b, fill=fill, border=border, tsize=20, bsize=15)
    if i:
        c.arrow((460, y - 26), (460, y - 4))
    y += 116

c.box(900, 116, 540, 180, "还原（revert）走另一条路",
      "优先用 .dshpurge.bak / 官方快照覆盖回去，再删备份；没有备份时，\n"
      "反向去掉 shim 里由本插件写入的行。prompt-inject.md 属于用户文件，还原时保留。",
      fill="#F4F6F8", border=GREY, tsize=21, bsize=15)
c.box(900, 320, 540, 195, "失败时会发生什么",
      "宿主改了文案 → pattern 对不上 → 该条记为 notFound 并静默跳过；\n"
      "整个应用的“成功”只代表跑完了，不代表每条都打上了。\n"
      "这就是它必须随身带 markers / 官方快照 / applied.json 的原因。",
      fill=WARN_SOFT, border=WARN, tsize=21, bsize=15)
c.box(900, 535, 540, 180, "为什么需要“启动自愈”",
      "npm 升级会整包覆盖 node_modules，之前打的补丁全部消失。\n"
      "插件在启动时用 installed-rev + applied.json 对比，发现补丁丢了就重打一遍。",
      fill=GOLD_SOFT, border=GOLD, tsize=21, bsize=15)

c.note(80, 1035, "这条流水线每一步都在改“用户机器上的宿主安装”，所以它必须同时具备备份、幂等、自愈、卸载四件套——"
                 "而这四件套正是 prompt-lab 明确不想要的部分。", size=16)
c.save("02-apply-flow.png")


# ---------------------------------------------------------------- 图 3 一轮对话
c = Canvas(1600, 860, "图 3  一轮对话里提示词是怎么被摆到模型面前的",
           "同一批 section 被收集 → 宿主排序渲染 → 它再用事件钩子把结果“重建”一遍 → 才发给模型")
c.d.text((40, 108), "order 轴（越小越靠前；插件三段刻意插在最前面）", font=font(16, True), fill=LINE)
c.box(60, 136, 1480, 30, "", "", fill="#F7F9FC", border="#D8E2EC")
c.arrow((80, 151), (1520, 151), color="#D8E2EC", width=2)
axis = [(90, "-100000  dsh-purge（主注入）", WARN), (400, "-99999  能力协议", WARN),
        (700, "0  内置身份 / persona", GREY), (1000, "10+  工具与工作区指令", GREY),
        (1290, "5100  插件 postPrompt", LINE)]
for x, label, color in axis:
    c.d.line([x, 136, x, 166], fill=color, width=3)
    c.d.text((x + 6, 172), label, font=font(14, True), fill=color)

stages = [
    ("1. 新一轮开始", "宿主收集所有已注册的\nsystemPrompt section", SOFT, LINE),
    ("2. assemble", "按 order 排序、渲染文本\n（此处会调用每段的 text()）", SOFT, LINE),
    ("3. 事件钩子介入", "插件在 system-prompt/assemble\n里先调 next()，拿到结果", WARN_SOFT, WARN),
    ("4. 重建 sections", "删身份/基线段、洗 persona、\n把注入折进去、补全文", WARN_SOFT, WARN),
    ("5. 发给模型", "重建后的 sections 拼成\n最终请求正文", OK_SOFT, OK),
]
sx = [60, 372, 684, 996, 1308]
for i, (t, b, fill, border) in enumerate(stages):
    c.box(sx[i], 262, 272, 150, t, b, fill=fill, border=border, tsize=19, bsize=14)
    if i:
        c.arrow((sx[i] - 14, 337), (sx[i] - 2, 337))

c.box(60, 456, 700, 150, "为什么要“重建”而不是“加一段”",
      "宿主某些路径（complete / 换预设 / 子 agent）会只保留“一个完整段”，\n"
      "或把加载顺序换掉。插件只能在下游重排整个 sections 并补回自己那段。",
      fill=GOLD_SOFT, border=GOLD, tsize=21, bsize=15)
c.box(800, 456, 740, 150, "400ms 守卫：对抗“宿主把 assemble 换掉”",
      "切预设 / 子 agent / 热挂载会换掉 systemPrompt 代理，原钩子失效，\n"
      "于是每 400ms 检查并再包一层 —— 最侵入的一招，prompt-lab 不采用。",
      fill=WARN_SOFT, border=WARN, tsize=21, bsize=15)
c.note(60, 640, "对照 prompt-lab：同样用 section 注入、同样监听 assemble，但只“读”不“改”——"
                "把重建换成“按 marker 删除自己认得的两类段”，策略全关时零改写。", size=16)
c.save("03-prompt-pipeline.png")


# ---------------------------------------------------------------- 图 4 重建管线
c = Canvas(1600, 800, "图 4  重建管线拆开看：8 步，其中 3 步最脆",
           "rewritePromptAssembly：不原地修改传入对象，返回一份新的 sections")
steps = [
    ("① 丢身份段", "去掉 harness:identity\n与插件自己的 identity", SOFT, LINE),
    ("② 丢 mnemon（可配）", "name 含 mnemon 的段\n直接从结果里移除", SOFT, LINE),
    ("③ 丢 workspace baseline", "按 strict / fallback / always\n与两条 marker 判定", WARN_SOFT, WARN),
    ("④ 洗 persona 文本", "对所有非插件段做正则替换\n去掉 Harness 自称句", WARN_SOFT, WARN),
    ("⑤ 注入折进 persona", "把操作者正文并进 persona 段\n防止被“只留完整段”吃掉", WARN_SOFT, WARN),
    ("⑥ 追加能力协议", "固定 order 99999\n（红队主控另有版本）", SOFT, LINE),
    ("⑦ ensureFullInject", "兜底：确认注入全文仍在\n不在就补一段", WARN_SOFT, WARN),
    ("⑧ 返回新对象", "不污染宿主复用的 assembled\n下一轮从干净状态开始", OK_SOFT, OK),
]
positions = [(60, 130), (440, 130), (820, 130), (1200, 130), (1200, 350), (820, 350), (440, 350), (60, 350)]
for (x, y), (t, b, fill, border) in zip(positions, steps):
    c.box(x, y, 340, 120, t, b, fill=fill, border=border, tsize=19, bsize=14)

for i in range(3):
    c.arrow((positions[i][0] + 344, 190), (positions[i + 1][0] - 4, 190))
c.arrow((positions[3][0] + 170, 254), (positions[3][0] + 170, 346))
for i in range(4, 7):
    c.arrow((positions[i][0] - 4, 410), (positions[i + 1][0] + 344, 410))

c.box(60, 516, 1480, 110, "三处“脆点”的具体含义",
      "③ 依赖宿主 baseline 的文案 marker；④ 依赖宿主身份句的原文；⑤⑦ 依赖宿主“是否只保留完整段”的行为。\n"
      "任何一处被宿主改掉，表现都不是报错，而是“注入被截断 / 身份句漏出 / 策略不生效”——静默失败，最难排查。",
      fill=WARN_SOFT, border=WARN, tsize=20, bsize=15)
c.note(60, 660, "迁移取舍：③④ 可迁（只删认得的段，且可一键关闭）；⑤⑦ 不迁（改为 section 注入 + 不重建）。", size=16)
c.save("04-rewrite-pipeline.png")


# ---------------------------------------------------------------- 图 5 规则两条路
c = Canvas(1600, 900, "图 5  “规则”其实是两条完全不同的路径",
           "左边是规则集（覆盖工作区文件），右边是本地指令勾选（读文件拼进注入）；两者都不进 system section")
c.d.text((40, 104), "A. 规则集：激活 = 覆盖 AGENTS.md", font=font(18, True), fill=WARN)
ax = 60
c.box(ax, 132, 400, 92, "rules/<id>.md + <id>.json", "正文 + {name,target}\n存 $DSH_HOME/rules/", tsize=19, bsize=14)
c.box(ax, 252, 400, 92, "state.json", "只记 {active: <id>}\n（当前启用哪套）", tsize=19, bsize=14)
c.box(ax, 372, 400, 92, "activateRule()", "读出规则正文\n准备覆盖目标文件", fill=WARN_SOFT, border=WARN, tsize=19, bsize=14)
c.box(ax, 492, 400, 92, "先备份再覆盖", "目标原内容不是“另一套规则”时\n存 .bak，然后整体写入", fill=WARN_SOFT, border=WARN, tsize=19, bsize=14)
c.box(ax, 612, 400, 92, "$DSH_HOME/AGENTS.md", "DSH 原生加载 → 进入\nworkspace 指令段（不是插件段）", fill=OK_SOFT, border=OK, tsize=19, bsize=14)
for y0, y1 in [(224, 250), (344, 370), (464, 490), (584, 610)]:
    c.arrow((ax + 200, y0), (ax + 200, y1))

c.d.text((860, 104), "B. 本地指令：勾选哪些文件进注入", font=font(18, True), fill=OK)
bx = 860
c.box(bx, 132, 400, 92, "从 cwd 向上扫", "AGENTS.md / CLAUDE.md / *.local.md\n遇 .git 等根标记停", tsize=19, bsize=14)
c.box(bx, 252, 400, 92, "cwd-selections.json", "勾选表（绝对路径集合）\n换目录后旧勾选自动失效", tsize=19, bsize=14)
c.box(bx, 372, 400, 92, "readSelectedCwdInject()", "只取“仍在当前候选集”的路径\n拼接，带标识头，512KB 截断", tsize=19, bsize=14)
c.box(bx, 492, 400, 92, "拼进注入正文", "<!-- dsh-purge:cwd-rule -->\n随后走主注入段进入系统提示词", fill=OK_SOFT, border=OK, tsize=19, bsize=14)
c.box(bx, 612, 400, 92, "没勾选 = 不注入", "候选为空时这段完全不出现在\n最终提示词里", fill="#F4F6F8", border=GREY, tsize=19, bsize=14)
for y0, y1 in [(224, 250), (344, 370), (464, 490), (584, 610)]:
    c.arrow((bx + 200, y0), (bx + 200, y1))

c.box(60, 744, 1480, 108, "prompt-lab 的取舍",
      "规则集不再覆盖用户文件，而是作为独立 section（prompt-lab:rules）注入——同样效果，但可回滚、可审计、不碰用户仓库；\n"
      "本地指令保留“扫描 + 勾选”的交互，但只做只读读取。", fill=SOFT, border=LINE, tsize=20, bsize=15)
c.save("05-rules.png")


# ---------------------------------------------------------------- 图 6 迁移路线
c = Canvas(1700, 820, "图 6  prompt-lab 迁移路线：6 个阶段，先能力后边界",
           "核心 8 人日；每一步都可独立发布，且每步都有可验收的“能看见的东西”")
phases = [
    ("P1  数据模型", "settings.json + rules/\n原子写 / 校验 / 损坏回退", "单测覆盖读写与非法输入", SOFT, LINE),
    ("P2  多段注入", "4 段 section + 各自开关\n一次性注入按会话记账", "面板看到每段最终文本", SOFT, LINE),
    ("P3  组装后处理", "策略链：baseline / identity\n只按 marker 删认得的两段", "全关时与 0.4.2 逐段一致", WARN_SOFT, WARN),
    ("P4  规则与本地指令", "规则集 CRUD → section 注入\ncwd 扫描 + 勾选", "切目录后旧勾选失效", SOFT, LINE),
    ("P5  UI", "4 个子页 + 增量轮询\n所有开关持久化", "刷新不丢、新会话生效", SOFT, LINE),
    ("P7  收尾", "共存检测 + 迁移文档\n版本 0.5.0", "与 dsh-purge 并存时告警", OK_SOFT, OK),
]
for i, (t, b, acc, fill, border) in enumerate(phases):
    x = 60 + i * 268
    c.box(x, 150, 240, 200, t, b, fill=fill, border=border, tsize=21, bsize=14)
    c.d.line([x + 14, 262, x + 226, 262], fill="#D8E2EC", width=1)
    fy = 274
    for ln in c._wrap("验收：" + acc, font(13), 214):
        c.d.text((x + 14, fy), ln, font=font(13), fill=GREY)
        fy += 19
    if i:
        c.arrow((x - 26, 250), (x - 4, 250))

c.box(60, 390, 760, 130, "P0 基线（0.5 人日）",
      "冻结 prompt-lab 0.4.2 的 14 个用例作为“零改写”保护网；\n记录宿主 API 事实（section 签名 / assemble 参数 / 段名排序）。",
      fill="#F4F6F8", border=GREY, tsize=20, bsize=15)
c.box(860, 390, 780, 130, "P6 可选（2 人日，可砍）",
      "能力协议（0.2d）、rewind（0.5d）、skills 导入（0.5d）、\n自动重试/继续（1d，最不确定——依赖会话事件时序）。",
      fill=GOLD_SOFT, border=GOLD, tsize=20, bsize=15)

c.box(60, 552, 1580, 118, "明确不迁（与 prompt-lab 定位冲突）",
      "宿主包补丁 / .bak / shim / 自动重启  ｜  自动更新 / 卸载  ｜  net-scope 网络闸门  ｜  hooks deny 旁路\n"
      "演练台（SQLite + 56 工具 + 23 技能）  ｜  CLI 与聊天命令",
      fill=WARN_SOFT, border=WARN, tsize=20, bsize=16)

c.note(60, 706, "验收基线一句话：策略全关时，prompt-lab 0.5 的 assemble 结果必须与 0.4.2 逐段一致；"
                "只有打开某项策略，才允许出现对应的差异。", size=16)
c.save("06-migration-roadmap.png")


# ---------------------------------------------------------------- 图 7 演练台 vs 桌面端
c = Canvas(1600, 840, "图 7  两个容易混淆的点：演练台不是“一个技能”；桌面端工程化是“改宿主的工程税”",
           "左：演练台由四块组成，技能只是它的素材　｜　右：桌面端工程化在解决的六个具体问题，全部来自“改宿主文件”这条路线")
c.d.rounded_rectangle([40, 96, 760, 566], radius=14, fill="#FAFBFD", outline="#E0E8F1", width=2)
c.d.rounded_rectangle([780, 96, 1560, 566], radius=14, fill="#FAFBFD", outline="#E0E8F1", width=2)

c.d.text((60, 112), "A. 演练台 = 预设 + 事实库 + 工具集 + 控制台", font=font(19, True), fill=INK)
c.d.text((60, 140), "技能只是它运行时可用的“素材”，本身不构成演练台", font=font(14), fill=GREY)
c.box(60, 168, 320, 112, "① 预设（红队模式）", "preset.yml + agent.cordis.yml\n主控 + 5 个执行角色（并发 3）\n装到 .agent-presets/redteam", tsize=19, bsize=13)
c.box(400, 168, 340, 112, "② 事实库", "node:sqlite DatabaseSync\n按靶标分库，跨会话共享", tsize=19, bsize=13)
c.box(60, 296, 320, 112, "③ 工具集", "56 个 redteam_* 工具\n写入只走工具，不直连 SQL", tsize=19, bsize=13)
c.box(400, 296, 340, 112, "④ 控制台", "POST /redteam/api\n侧栏「演练台」页", tsize=19, bsize=13)
c.box(60, 424, 680, 116, "素材：23 个技能 md",
      "frontmatter: name / description / whenToUse / role\n由 DSH 原生 skill 体系加载，本身不进注入段；① 的角色在编排时按需引用它们",
      fill=GOLD_SOFT, border=GOLD, tsize=19, bsize=13)

c.d.text((800, 112), "B. 桌面端工程化：六个“只有官方桌面端才有”的问题", font=font(19, True), fill=INK)
c.d.text((800, 140), "全部来自“改宿主文件 + 要重启”这个前提，不是独立功能", font=font(14), fill=GREY)
c.box(800, 168, 340, 112, "① asar 是归档", "源码不是明文文件\n普通 fs 写入会 ENOENT\n要 original-fs / 解包 / 改名", fill=WARN_SOFT, border=WARN, tsize=18, bsize=13)
c.box(1170, 168, 340, 112, "② 改完必须重启", "宿主源码已改，进程内不生效\n分离进程 + JSON 传参重启", fill=WARN_SOFT, border=WARN, tsize=18, bsize=13)
c.box(800, 296, 340, 112, "③ stderr 会被当 crash", "宿主把最后一行 stderr\n当失败原因，日志只能写文件", fill=WARN_SOFT, border=WARN, tsize=18, bsize=13)
c.box(1170, 296, 340, 112, "④ Windows 弹黑窗", "spawn 默认开控制台\n打 windowsHide 补丁 +\n往 bin 注入 import hook", fill=WARN_SOFT, border=WARN, tsize=18, bsize=13)
c.box(800, 424, 340, 116, "⑤ 安装位置不确定", "注册表 + 常见目录探测\n密封运行时目录只能跳过", fill=WARN_SOFT, border=WARN, tsize=18, bsize=13)
c.box(1170, 424, 340, 116, "⑥ 官方更新会覆盖", "自动更新会换掉整个 asar\n需要 handoff 补丁与脚本兼容", fill=WARN_SOFT, border=WARN, tsize=18, bsize=13)

c.box(60, 600, 1480, 106, "prompt-lab 为什么完全不需要这一层",
      "不改宿主文件 → 不需要解 asar、不需要重启、不需要静默控制台、不需要探测安装位置；\n"
      "只用公开 API，进程内生效，关掉插件即回原状。", fill=OK_SOFT, border=OK, tsize=20, bsize=15)
c.note(60, 740, "换个说法：桌面端工程化不是“功能”，而是“改宿主文件”这条路线必须支付的工程税——"
                "这部分代码约 3 500 行（desktop / extract-asar / hide-console / restart / web / host），在 prompt-lab 里没有对应需求。", size=16)
c.save("07-drill-vs-desktop.png")

print("all done ->", OUT)

