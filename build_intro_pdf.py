# -*- coding: utf-8 -*-
"""系统介绍 PDF：真实界面截图 + 功能解说（ReportLab）"""
import os
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm, mm
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_CENTER
from reportlab.platypus import (
    BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Table, TableStyle,
    PageBreak, Image, KeepTogether, NextPageTemplate, Preformatted,
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

ROOT = r'D:\2026\车间安全管理系统'
ASSETS = os.path.join(ROOT, 'intro-assets')
OUT = os.path.join(ROOT, '系统介绍.pdf')

regular = os.environ.get('DAIMON_CJK_FONT_REGULAR')
bold = os.environ.get('DAIMON_CJK_FONT_BOLD')
if not regular or not bold:
    raise RuntimeError('Daimon CJK fonts unavailable')
pdfmetrics.registerFont(TTFont('CJK', regular))
pdfmetrics.registerFont(TTFont('CJK-B', bold))
pdfmetrics.registerFontFamily('CJK', normal='CJK', bold='CJK-B', italic='CJK', boldItalic='CJK-B')

INK = HexColor('#1d1d1f')
BODY = HexColor('#3a3a3c')
GRAY = HexColor('#6e6e73')
FAINT = HexColor('#aeaeb2')
LIGHT = HexColor('#f5f5f7')
BLUE = HexColor('#007AFF')
GREEN = HexColor('#34C759')
ORANGE = HexColor('#FF9500')
RULE = HexColor('#d2d2d7')

S = {
    'h1': ParagraphStyle('h1', fontName='CJK-B', fontSize=19, leading=27, textColor=INK,
                         spaceBefore=6, spaceAfter=4),
    'h1sub': ParagraphStyle('h1sub', fontName='CJK', fontSize=10.5, leading=16, textColor=GRAY,
                            spaceAfter=12),
    'h2': ParagraphStyle('h2', fontName='CJK-B', fontSize=13.5, leading=20, textColor=INK,
                         spaceBefore=14, spaceAfter=5, keepWithNext=1),
    'body': ParagraphStyle('body', fontName='CJK', fontSize=10.5, leading=17.5, textColor=BODY,
                           spaceAfter=5),
    'bullet': ParagraphStyle('bullet', fontName='CJK', fontSize=10.5, leading=17.5, textColor=BODY,
                             leftIndent=16, bulletIndent=4, spaceAfter=3.5),
    'caption': ParagraphStyle('caption', fontName='CJK', fontSize=9, leading=14, textColor=GRAY,
                              alignment=TA_CENTER, spaceBefore=4, spaceAfter=10),
    'code': ParagraphStyle('code', fontName='CJK', fontSize=9.5, leading=15, textColor=INK,
                           backColor=LIGHT, leftIndent=10, rightIndent=10,
                           borderPadding=(8, 10, 8, 10), spaceBefore=4, spaceAfter=8),
    'cell': ParagraphStyle('cell', fontName='CJK', fontSize=9.5, leading=14.5, textColor=BODY),
    'cellB': ParagraphStyle('cellB', fontName='CJK-B', fontSize=9.5, leading=14.5, textColor=INK),
}

def shot(name, width):
    """截图（1052x1248）等比缩放 + 细边框"""
    img = Image(os.path.join(ASSETS, name))
    ratio = img.imageHeight / img.imageWidth
    img.drawWidth = width
    img.drawHeight = width * ratio
    t = Table([[img]], colWidths=[width + 2])
    t.setStyle(TableStyle([
        ('BOX', (0, 0), (-1, -1), 0.8, RULE),
        ('TOPPADDING', (0, 0), (-1, -1), 0),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
        ('LEFTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
    ]))
    t.hAlign = 'CENTER'
    return t

def figure(name, width, caption):
    return KeepTogether([shot(name, width), Paragraph(caption, S['caption'])])

def figure_row(pairs, total=15.4 * cm):
    """并排两张截图"""
    gap = 0.5 * cm
    w = (total - gap) / 2
    cells = []
    for name, cap in pairs:
        cells.append([shot(name, w), Paragraph(cap, S['caption'])])
    t = Table([[Table([[c[0]], [c[1]]], colWidths=[w + 2]) for c in cells]],
              colWidths=[w + 2 + gap / 2, w + 2 + gap / 2])
    t.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('TOPPADDING', (0, 0), (-1, -1), 0),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
    ]))
    t.hAlign = 'CENTER'
    return t

def bullets(items):
    return [Paragraph(t, S['bullet'], bulletText='•') for t in items]

def kv_table(rows):
    avail = A4[0] - 5.2 * cm
    ncols = max(len(r) for r in rows)
    data = []
    for ri, row in enumerate(rows):
        style = S['cellB'] if ri == 0 else S['cell']
        data.append([Paragraph(c, style) for c in row])
    t = Table(data, colWidths=[avail / ncols] * ncols)
    t.setStyle(TableStyle([
        ('LINEABOVE', (0, 0), (-1, 0), 1.2, INK),
        ('LINEBELOW', (0, 0), (-1, 0), 0.6, INK),
        ('LINEBELOW', (0, -1), (-1, -1), 1.2, INK),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ('LEFTPADDING', (0, 0), (-1, -1), 4),
        ('RIGHTPADDING', (0, 0), (-1, -1), 4),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
    ]))
    return t

def cover(canvas, doc):
    w, h = A4
    canvas.saveState()
    canvas.setFillColor(BLUE)
    canvas.rect(0, h - 14 * mm, w, 2.2 * mm, stroke=0, fill=1)
    canvas.setFillColor(GRAY)
    canvas.setFont('CJK', 10)
    canvas.drawCentredString(w / 2, 24 * mm, '车间安全管理系统 · 系统介绍')
    canvas.restoreState()

def later(canvas, doc):
    w, h = A4
    canvas.saveState()
    canvas.setFont('CJK', 8.5)
    canvas.setFillColor(GRAY)
    canvas.drawString(2.8 * cm, h - 1.5 * cm, '系统介绍 · 车间安全管理系统')
    canvas.drawRightString(w - 2.4 * cm, h - 1.5 * cm, '2026-09')
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(0.5)
    canvas.line(2.8 * cm, h - 1.7 * cm, w - 2.4 * cm, h - 1.7 * cm)
    canvas.drawCentredString(w / 2, 1.4 * cm, f'第 {doc.page - 1} 页')
    canvas.restoreState()

story = []

# ── 封面 ──
story.append(Spacer(1, 5.2 * cm))
story.append(Paragraph('车间安全管理系统', ParagraphStyle(
    't', fontName='CJK-B', fontSize=32, leading=42, alignment=TA_CENTER, textColor=INK)))
story.append(Spacer(1, 10))
story.append(Paragraph('成品车间隐患排查治理闭环 · 系统介绍', ParagraphStyle(
    'st', fontName='CJK', fontSize=14, leading=22, alignment=TA_CENTER, textColor=GRAY)))
story.append(Spacer(1, 2.6 * cm))
for line in ['多渠道录入（手动 / 督察通报 PPT / Word / Excel）',
             '标签化管理 · 整改闭环 · 防复发三次复查',
             '周期统计 · 定时提醒 · 现场照片归档 · 手机端可用']:
    story.append(Paragraph(line, ParagraphStyle(
        'cl', fontName='CJK', fontSize=11, leading=22, alignment=TA_CENTER, textColor=GRAY)))
story.append(Spacer(1, 2.2 * cm))
story.append(Paragraph('版本 2026-09 · 供厂部、车间管理人员参阅', ParagraphStyle(
    'cv', fontName='CJK', fontSize=10, leading=18, alignment=TA_CENTER, textColor=FAINT)))
story.append(NextPageTemplate('later'))
story.append(PageBreak())

# ── 一、系统概述 ──
story.append(Paragraph('一、系统概述', S['h1']))
story.append(Paragraph('为什么做、管什么、怎么运转', S['h1sub']))
story.append(Paragraph(
    '车间安全管理系统是一套面向成品车间的隐患排查治理闭环软件。它把「发现问题」到「问题真正不再复发」'
    '的全过程数字化：多渠道录入隐患、标签化归档、限期整改、闭环确认、防复发复查，'
    '并辅以周期统计与定时提醒，让安全管理从"纸面台账 + 人脑记忆"变成"系统驱动、数据说话"。', S['body']))
story.append(Paragraph('业务主线', S['h2']))
story.append(Preformatted(
    '录入（手动 / 通报 PPT / 表格）\n'
    '　↓ 文件在本机浏览器解析，暂存区人工逐条核对后才入库\n'
    '问题库：成品车间隐患走闭环，其他车间仅存档参考\n'
    '　↓ 待整改 → 整改中 → 待复查 → 已闭环\n'
    '防复发复查 ×3（默认每 7 天一次，到点自动提醒）\n'
    '　↓\n'
    '周期统计 · 提醒中心 · 检查计划 持续运转', S['code']))
story.append(Paragraph('三条设计原则', S['h2']))
story.extend(bullets([
    '<b>机器初判、人工定责</b>：文件解析结果一律进暂存区，逐条勾选确认才入库，每条数据有人负责',
    '<b>闭环不是终点</b>：隐患闭环后默认再做 3 次防复发复查（间隔可编辑），防止"改完就反弹"',
    '<b>成品车间是主战场</b>：闭环、提醒、闭环率只围绕成品车间；厂督察通报里其他车间的问题存档为参考件，用于观察厂督察的检查风向',
]))

# ── 二、运行数据 ──
story.append(Paragraph('二、当前运行数据（2026-09-29）', S['h1']))
story.append(Paragraph('系统已接入真实生产数据', S['h1sub']))
story.append(kv_table([
    ['指标', '数值', '说明'],
    ['隐患总数', '52 条', '成品车间 5 条（3 闭环 / 1 整改中 / 1 待整改），其他车间参考件 47 条'],
    ['督察通报', '8 份全覆盖', '第 525 / 535 ~ 540 期 + 三违问题统计，含复查核销自动闭环'],
    ['标签', '25 个', '隐患类型 / 区域 / 自定义三组，内置标签不可删除'],
    ['检查计划', '2 个', '每日班前安全检查、每周消防专项检查'],
    ['提醒', '四类自动生成', '检查到点 / 整改超期 / 待复查 / 防复发复查到点'],
]))
story.append(Spacer(1, 8))

# ── 三、功能模块 ──
story.append(Paragraph('三、功能模块（真实界面）', S['h1']))
story.append(Paragraph('以下截图均取自系统真实运行界面', S['h1sub']))

story.append(Paragraph('3.1 总览 —— 打开就知道"现在最该干什么"', S['h2']))
story.extend(bullets([
    '待整改 / 已超期 / 整改闭环率 / 进行中检查计划四张数字卡片，红色直观暴露风险',
    '下方列出最新隐患与临近事项，逾期隐患红色警示',
]))
story.append(figure('01-总览.png', 9.2 * cm, '总览页：核心数字一眼看清'))

story.append(Paragraph('3.2 多渠道录入 —— 手动、通报 PPT、表格三条通道', S['h2']))
story.extend(bullets([
    '<b>手动录入</b>：标题 / 描述 / 类型 / 区域 / 风险 / 期限 / 责任人 / 现场照片，手机端可直接拍照',
    '<b>通报 PPT 导入</b>：按厂督察通报句式自动识别问题页与复查核销页，车间、时间、照片一并提取；'
    '结果进暂存区逐条核对，橙色"未识别页"清单防止漏网',
    '<b>Word / Excel</b>：文档同句式识别，表格按表头映射',
    '全部解析在本机浏览器完成，文件不出本机',
]))
story.append(figure('04-文件导入.png', 9.2 * cm, '文件导入：选择通报后自动解析进暂存区'))

story.append(Paragraph('3.3 问题库 —— 隐患总账', S['h2']))
story.extend(bullets([
    '三个页签：成品车间（要闭环）/ 其他车间（参考）/ 全部；搜索 + 状态 / 类型 / 区域组合筛选',
    '每条卡片：风险等级、状态、来源、发现与期限时间、现场照片缩略图，可补传整改照片',
    '删除为两段式确认，防误触',
]))
story.append(figure('02-问题库.png', 9.2 * cm, '问题库：52 条隐患总账，照片随卡展示'))

story.append(Paragraph('3.4 隐患详情与防复发复查', S['h2']))
story.extend(bullets([
    '点标题弹出详情层：完整描述、时间线、来源通报、照片管理、状态流转，字段可直接编辑',
    '<b>防复发复查</b>：每条成品车间隐患默认 3 次复查、间隔 7 天（可按隐患调整），'
    '到点自动生成提醒，复查进度实时可见',
]))
story.append(figure('03-详情层.png', 9.2 * cm, '详情层：信息、编辑、复查一屏办妥'))

story.append(Paragraph('3.5 参考标注 —— 把其他车间的问题变成成品车间的镜子', S['h2']))
story.extend(bullets([
    '逐条评估参考件对成品车间的参考意义：需严格注意 / 对照自查 / 一般了解 三级分级',
    '记录"成品车间的相似点"与"需要严格注意"事项，标注进度与清单一目了然',
    '"需严格注意"清单即成品车间的对照排查清单；问题库参考件同步显示等级徽标',
]))
story.append(figure('10-参考标注.png', 8.6 * cm, '参考标注：47 条参考件逐条评估'))

story.append(Paragraph('3.6 周期统计 —— 数据说话', S['h2']))
story.extend(bullets([
    '时间范围（7 / 30 / 90 天）× 统计范围（成品车间 / 其他车间 / 全部）自由组合',
    '新增与闭环趋势、类型分布（标签外置饼图）、区域分布（按数量降序）、风险等级构成',
    '<b>切到"其他车间"视角</b>：区域分布第一名就是厂督察近期查得最狠的车间，成品车间可对照自查',
]))
story.append(figure_row([('05-周期统计.png', '周期统计：趋势与分布'),
                         ('06-区域分布.png', '其他车间视角：督察检查重点')]))

story.append(Paragraph('3.7 检查计划与提醒中心', S['h2']))
story.extend(bullets([
    '周期计划（每日 / 每周 / 每月 / 每季）到点提醒，"完成本次检查"记台账并自动推进下一周期',
    '提醒中心四类提醒自动汇聚：检查到点、整改超期、待复查、防复发复查到点',
]))
story.append(figure_row([('07-检查计划.png', '检查计划：周期任务与执行台账'),
                         ('09-提醒中心.png', '提醒中心：四类提醒自动汇聚')]))

story.append(Paragraph('3.8 标签管理', S['h2']))
story.extend(bullets([
    '隐患类型 / 区域 / 自定义三组标签，导入通报时遇到新车间自动建档',
    '内置标签不可删除，保证历史数据可追溯；重名即时拦截',
]))
story.append(figure('08-标签管理.png', 9.2 * cm, '标签管理：三组标签一目了然'))

# ── 四、技术架构 ──
sec4 = [
    Paragraph('四、技术架构与部署', S['h1']),
    Paragraph('内网单机即可运行，手机电脑同用', S['h1sub']),
    kv_table([
        ['层', '技术', '说明'],
        ['前端', 'React 19 + Vite + Tailwind', 'iOS 亮色风格，响应式 + PWA，可"添加到主屏幕"当 App'],
        ['后端', 'NestJS + Prisma', 'REST API，JWT 登录鉴权，字段白名单防注入'],
        ['数据库', 'PostgreSQL 16（Docker）', '容器 wsms-postgres，数组字段原生支持照片与标签'],
        ['文档解析', '浏览器本地（JSZip 等）', '通报文件不出本机，零外部依赖、零 API 费用'],
        ['部署形态', '单端口 3100', '后端托管前端产物，免跨域；局域网 IP 直连或 Tailscale 组网外网访问'],
    ]),
    Spacer(1, 6),
    *bullets([
        '<b>运维极简</b>：双击「重启服务.bat」一键重启；数据库 pg_dump + uploads 目录拷贝即完成备份',
        '<b>数据安全</b>：全部数据存于本机/内网服务器，无任何云端外传；登录态 7 天过期',
    ]),
]
story.append(KeepTogether(sec4))

doc = BaseDocTemplate(
    OUT, pagesize=A4,
    topMargin=2.4 * cm, bottomMargin=2.2 * cm, leftMargin=2.8 * cm, rightMargin=2.4 * cm,
    title='系统介绍 · 车间安全管理系统', author='车间安全管理系统')
frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id='main')
doc.addPageTemplates([
    PageTemplate(id='cover', frames=[frame], onPage=cover),
    PageTemplate(id='later', frames=[frame], onPage=later),
])
doc.build(story)
print('OK', OUT)
