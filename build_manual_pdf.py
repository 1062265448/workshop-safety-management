# -*- coding: utf-8 -*-
"""使用手册.md → 排版精美的 PDF（ReportLab 路由）"""
import os
import re
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm, mm
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.colors import HexColor, white
from reportlab.platypus import (
    BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Table, TableStyle,
    PageBreak, Preformatted, KeepTogether,
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# ── 字体 ──
regular = os.environ.get('DAIMON_CJK_FONT_REGULAR')
bold = os.environ.get('DAIMON_CJK_FONT_BOLD')
if not regular or not bold:
    raise RuntimeError('Daimon CJK fonts unavailable')
pdfmetrics.registerFont(TTFont('CJK', regular))
pdfmetrics.registerFont(TTFont('CJK-B', bold))
pdfmetrics.registerFontFamily('CJK', normal='CJK', bold='CJK-B', italic='CJK', boldItalic='CJK-B')

# ── 配色（冷灰 + 系统蓝点缀） ──
INK = HexColor('#1d1d1f')
BODY = HexColor('#333333')
GRAY = HexColor('#6e6e73')
LIGHT = HexColor('#f5f5f7')
BLUE = HexColor('#007AFF')
RULE = HexColor('#d2d2d7')

# ── 样式 ──
S = {
    'h1': ParagraphStyle('h1', fontName='CJK-B', fontSize=17, leading=24, textColor=INK,
                         spaceBefore=22, spaceAfter=10, keepWithNext=1),
    'h2': ParagraphStyle('h2', fontName='CJK-B', fontSize=13, leading=19, textColor=INK,
                         spaceBefore=14, spaceAfter=6, keepWithNext=1),
    'body': ParagraphStyle('body', fontName='CJK', fontSize=10.5, leading=17, textColor=BODY,
                           spaceAfter=5),
    'bullet': ParagraphStyle('bullet', fontName='CJK', fontSize=10.5, leading=17, textColor=BODY,
                             leftIndent=16, bulletIndent=4, spaceAfter=3),
    'quote': ParagraphStyle('quote', fontName='CJK', fontSize=10.5, leading=17, textColor=GRAY,
                            leftIndent=12, spaceAfter=8),
    'code': ParagraphStyle('code', fontName='CJK', fontSize=9, leading=13.5, textColor=INK,
                           backColor=LIGHT, leftIndent=8, rightIndent=8,
                           borderPadding=(6, 8, 6, 8), spaceBefore=4, spaceAfter=8),
    'cell': ParagraphStyle('cell', fontName='CJK', fontSize=9.5, leading=14, textColor=BODY),
    'cellB': ParagraphStyle('cellB', fontName='CJK-B', fontSize=9.5, leading=14, textColor=INK),
    'caption': ParagraphStyle('caption', fontName='CJK', fontSize=9, leading=13, textColor=GRAY),
}

def inline(text: str) -> str:
    """Markdown 行内标记 → reportlab 段落标记"""
    text = text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    text = text.replace('✔', '√')  # CJK 字体无 ✔ 字形
    text = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', text)
    text = re.sub(r'`([^`]+)`', r'<font face="CJK" backColor="#f5f5f7">\1</font>', text)
    # Markdown 链接 [文字](路径) → 只留文字（内部文档链接在 PDF 中不可点）
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)
    return text

def make_table(rows):
    """Markdown 表格行 → 三线表"""
    ncols = max(len(r) for r in rows)
    data = []
    for ri, row in enumerate(rows):
        style = S['cellB'] if ri == 0 else S['cell']
        data.append([Paragraph(inline(c), style) for c in row] + [''] * (ncols - len(row)))
    avail = A4[0] - 5.2 * cm
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

def parse_md(path):
    with open(path, encoding='utf-8') as f:
        lines = f.read().split('\n')
    story = []
    i = 0
    in_code = False
    code_buf = []
    while i < len(lines):
        line = lines[i]
        # 代码块
        if line.strip().startswith('```'):
            if in_code:
                story.append(Preformatted('\n'.join(code_buf), S['code']))
                code_buf = []
                in_code = False
            else:
                in_code = True
            i += 1
            continue
        if in_code:
            code_buf.append(line)
            i += 1
            continue
        # 表格
        if line.strip().startswith('|') and i + 1 < len(lines) and re.match(r'^\s*\|[\s:\-|]+\|\s*$', lines[i + 1]):
            rows = []
            header = [c.strip() for c in line.strip().strip('|').split('|')]
            rows.append(header)
            i += 2
            while i < len(lines) and lines[i].strip().startswith('|'):
                rows.append([c.strip() for c in lines[i].strip().strip('|').split('|')])
                i += 1
            story.append(Spacer(1, 4))
            story.append(make_table(rows))
            story.append(Spacer(1, 8))
            continue
        s = line.strip()
        if not s or s == '---':
            i += 1
            continue
        if s.startswith('## '):
            story.append(Paragraph(inline(s[3:]), S['h1']))
        elif s.startswith('### '):
            story.append(Paragraph(inline(s[4:]), S['h2']))
        elif s.startswith('# '):
            pass  # 封面已含标题
        elif s.startswith('> '):
            story.append(Paragraph(inline(s[2:]), S['quote']))
        elif re.match(r'^[-*] ', s):
            story.append(Paragraph(inline(s[2:]), S['bullet'], bulletText='•'))
        elif re.match(r'^\d+\. ', s):
            m = re.match(r'^(\d+)\. (.*)$', s)
            story.append(Paragraph(inline(m.group(2)), S['bullet'], bulletText=m.group(1) + '.'))
        else:
            story.append(Paragraph(inline(s), S['body']))
        i += 1
    return story

# ── 页面装饰 ──
def cover(canvas, doc):
    w, h = A4
    canvas.saveState()
    canvas.setFillColor(BLUE)
    canvas.rect(0, h - 14 * mm, w, 2.2 * mm, stroke=0, fill=1)
    canvas.setFillColor(GRAY)
    canvas.setFont('CJK', 10)
    canvas.drawCentredString(w / 2, 24 * mm, '车间安全管理系统 · 内部资料')
    canvas.restoreState()

def later(canvas, doc):
    w, h = A4
    canvas.saveState()
    canvas.setFont('CJK', 8.5)
    canvas.setFillColor(GRAY)
    canvas.drawString(2.8 * cm, h - 1.5 * cm, '使用手册 · 车间安全管理系统')
    canvas.drawRightString(w - 2.4 * cm, h - 1.5 * cm, '2026-09')
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(0.5)
    canvas.line(2.8 * cm, h - 1.7 * cm, w - 2.4 * cm, h - 1.7 * cm)
    canvas.drawCentredString(w / 2, 1.4 * cm, f'第 {doc.page - 1} 页')
    canvas.restoreState()

def build():
    src = r'D:\2026\车间安全管理系统\使用手册.md'
    out = r'D:\2026\车间安全管理系统\使用手册.pdf'
    doc = BaseDocTemplate(
        out, pagesize=A4,
        topMargin=2.4 * cm, bottomMargin=2.2 * cm, leftMargin=2.8 * cm, rightMargin=2.4 * cm,
        title='使用手册 · 车间安全管理系统', author='车间安全管理系统')
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id='main')
    doc.addPageTemplates([
        PageTemplate(id='cover', frames=[frame], onPage=cover),
        PageTemplate(id='later', frames=[frame], onPage=later),
    ])

    story = []
    # 封面
    story.append(Spacer(1, 6.5 * cm))
    story.append(Paragraph('使用手册', ParagraphStyle(
        't', fontName='CJK-B', fontSize=34, leading=44, alignment=1, textColor=INK)))
    story.append(Spacer(1, 8))
    story.append(Paragraph('车间安全管理系统 · 成品车间隐患排查治理闭环', ParagraphStyle(
        'st', fontName='CJK', fontSize=13, leading=20, alignment=1, textColor=GRAY)))
    story.append(Spacer(1, 3.2 * cm))
    for line in ['多渠道录入（手动 / PPT / 文档） · 标签化管理 · 周期统计 · 定时提醒',
                 '现场照片归档 · 整改闭环流转 · 手机端可用',
                 '版本 2026-09 · 供车间安全员与责任人使用']:
        story.append(Paragraph(line, ParagraphStyle(
            'cl', fontName='CJK', fontSize=10.5, leading=20, alignment=1, textColor=GRAY)))
    story.append(PageBreak())

    # 正文（从第二页起用 later 模板）
    story.extend(parse_md(src))

    from reportlab.platypus import NextPageTemplate
    story.insert(0, NextPageTemplate('later'))
    # 首页用 cover 模板
    doc.pageTemplate = doc.pageTemplates[0]
    doc.build(story)
    print('OK', out)

if __name__ == '__main__':
    build()
