from __future__ import annotations

import importlib.util
import shutil
from pathlib import Path
from typing import Iterable, Sequence

from PIL import Image as PILImage
from reportlab.lib import colors
from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Flowable,
    Frame,
    Image,
    KeepTogether,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path('/Users/wanglei/Documents/纳米work企业版本')
OUT = ROOT / 'output/pdf/纳米Work销售作战系统-2026-09-17-V2'
DESKTOP = Path('/Users/wanglei/Desktop/纳米Work销售作战系统-2026-09-17-V2')
TMP = ROOT / 'tmp/pdfs/v2'
IMG = ROOT / 'artifacts/chengdu-0909/ppt/images'
SHOT = ROOT / 'tmp/pdfs/screenshots'
BRAND = ROOT / 'tmp/pdfs/brand'
OUT.mkdir(parents=True, exist_ok=True)
DESKTOP.mkdir(parents=True, exist_ok=True)
TMP.mkdir(parents=True, exist_ok=True)

NAVY = HexColor('#071D36')
NAVY_2 = HexColor('#0E2A4A')
BLUE = HexColor('#1769D2')
BLUE_L = HexColor('#EAF1FA')
BLUE_XL = HexColor('#F3F7FC')
INK = HexColor('#18263A')
SLATE = HexColor('#586A80')
PAGE = HexColor('#FBF9F5')
PANEL = HexColor('#FFFFFF')
LINE = HexColor('#DFE7F1')
ORANGE = HexColor('#F26B38')
ORANGE_L = HexColor('#FFF0E8')
GREEN = HexColor('#159C87')
GREEN_L = HexColor('#EAF8F4')
RED = HexColor('#D84A45')
RED_L = HexColor('#FDEEEE')
GOLD = HexColor('#BA8A3B')
WHITE = colors.white

PW, PH = A4
LEFT = 17 * mm
RIGHT = 17 * mm
TOP = 19 * mm
BOTTOM = 17 * mm
CW = PW - LEFT - RIGHT


def register_font():
    for p in ['/System/Library/Fonts/STHeiti Medium.ttc', '/System/Library/Fonts/Supplemental/Songti.ttc']:
        if Path(p).exists():
            try:
                pdfmetrics.registerFont(TTFont('NanoCN', p, subfontIndex=0))
                return
            except Exception:
                pass
    raise RuntimeError('Chinese font unavailable')


register_font()

S = {
    'cover_eyebrow': ParagraphStyle('cover_eyebrow', fontName='NanoCN', fontSize=8.5, leading=12, textColor=HexColor('#9BC4FF'), spaceAfter=5 * mm),
    'cover_title': ParagraphStyle('cover_title', fontName='NanoCN', fontSize=29, leading=39, textColor=WHITE, spaceAfter=5 * mm),
    'cover_sub': ParagraphStyle('cover_sub', fontName='NanoCN', fontSize=11, leading=18, textColor=HexColor('#C7D6E8'), spaceAfter=6 * mm),
    'cover_meta': ParagraphStyle('cover_meta', fontName='NanoCN', fontSize=8.3, leading=12.5, textColor=WHITE),
    'chapter_num': ParagraphStyle('chapter_num', fontName='NanoCN', fontSize=9, leading=12, textColor=BLUE, spaceAfter=2 * mm),
    'chapter': ParagraphStyle('chapter', fontName='NanoCN', fontSize=22, leading=30, textColor=NAVY, spaceAfter=4 * mm),
    'h1': ParagraphStyle('h1', fontName='NanoCN', fontSize=16, leading=23, textColor=NAVY, spaceBefore=2 * mm, spaceAfter=3 * mm),
    'h2': ParagraphStyle('h2', fontName='NanoCN', fontSize=12, leading=18, textColor=INK, spaceBefore=2.5 * mm, spaceAfter=2 * mm),
    'body': ParagraphStyle('body', fontName='NanoCN', fontSize=9.6, leading=15.4, textColor=INK, spaceAfter=2.2 * mm),
    'body_white': ParagraphStyle('body_white', fontName='NanoCN', fontSize=9.5, leading=15, textColor=WHITE),
    'small': ParagraphStyle('small', fontName='NanoCN', fontSize=8, leading=12.6, textColor=SLATE, spaceAfter=1.4 * mm),
    'tiny': ParagraphStyle('tiny', fontName='NanoCN', fontSize=6.8, leading=10, textColor=SLATE),
    'bullet': ParagraphStyle('bullet', fontName='NanoCN', fontSize=9.2, leading=14.8, textColor=INK, leftIndent=4 * mm, firstLineIndent=-3 * mm, spaceAfter=1.5 * mm),
    'quote': ParagraphStyle('quote', fontName='NanoCN', fontSize=11, leading=18, textColor=NAVY, spaceAfter=2 * mm),
    'table': ParagraphStyle('table', fontName='NanoCN', fontSize=7.7, leading=11.8, textColor=INK),
    'table_head': ParagraphStyle('table_head', fontName='NanoCN', fontSize=7.8, leading=11.5, textColor=WHITE, alignment=TA_CENTER),
    'card_title': ParagraphStyle('card_title', fontName='NanoCN', fontSize=10.8, leading=15, textColor=NAVY, spaceAfter=1.8 * mm),
    'card_num': ParagraphStyle('card_num', fontName='NanoCN', fontSize=22, leading=25, textColor=BLUE),
    'center': ParagraphStyle('center', fontName='NanoCN', fontSize=8.2, leading=12, textColor=INK, alignment=TA_CENTER),
    'source': ParagraphStyle('source', fontName='NanoCN', fontSize=7.2, leading=11.5, textColor=SLATE),
}


def P(text: str, style='body') -> Paragraph:
    return Paragraph(text, S[style])


def bullets(items: Iterable[str]):
    return [Paragraph('• ' + x, S['bullet']) for x in items]


class AccentRule(Flowable):
    def __init__(self, color=BLUE, width=CW, thickness=1.3, gap=3 * mm):
        super().__init__()
        self.color, self.width, self.thickness, self.height = color, width, thickness, gap

    def draw(self):
        self.canv.setStrokeColor(self.color)
        self.canv.setLineWidth(self.thickness)
        self.canv.line(0, self.height / 2, self.width, self.height / 2)


def logo(light=False, width=58 * mm):
    p = BRAND / ('nanowork-enterprise-light.png' if light else 'nanowork-enterprise-dark.png')
    ratio = 80 / (454 if light else 461)
    return Image(str(p), width=width, height=width * ratio)


def chapter(num: str, title: str, sub: str | None = None):
    out = [P(num, 'chapter_num'), P(title, 'chapter'), AccentRule()]
    if sub:
        out += [P(sub, 'body')]
    return out


def card(title: str, body: str, accent=BLUE, fill=PANEL, width=CW, tag: str | None = None):
    rows = []
    if tag:
        rows.append([P(tag, 'chapter_num')])
    rows += [[P(title, 'card_title')], [P(body, 'body')]]
    t = Table(rows, colWidths=[width - 10 * mm], hAlign='LEFT', cornerRadii=[4 * mm] * 4)
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), fill),
        ('BOX', (0, 0), (-1, -1), 0.65, LINE),
        ('LINEBEFORE', (0, 0), (0, -1), 4, accent),
        ('LEFTPADDING', (0, 0), (-1, -1), 5 * mm),
        ('RIGHTPADDING', (0, 0), (-1, -1), 5 * mm),
        ('TOPPADDING', (0, 0), (-1, -1), 3.3 * mm),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3.3 * mm),
    ]))
    return t


def bento(items: Sequence[tuple[str, str]], accent=BLUE, fills=(PANEL, BLUE_XL)):
    cells = []
    for i, (title, body) in enumerate(items):
        cells.append(card(title, body, accent=accent, fill=fills[i % len(fills)], width=(CW - 5 * mm) / 2))
    rows = []
    for i in range(0, len(cells), 2):
        row = cells[i:i + 2]
        if len(row) == 1:
            row.append(Spacer(1, 1))
        rows.append(row)
    t = Table(rows, colWidths=[(CW - 5 * mm) / 2] * 2, hAlign='LEFT')
    t.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ('TOPPADDING', (0, 0), (-1, -1), 0),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4 * mm),
    ]))
    return t


def rich_table(headers: Sequence[str], rows: Sequence[Sequence[str]], widths: Sequence[float], font=7.7, repeat=1, accent=NAVY):
    body_style = ParagraphStyle('table_dynamic', parent=S['table'], fontSize=font, leading=font * 1.52)
    data = [[P(x, 'table_head') for x in headers]] + [[Paragraph(str(x), body_style) for x in row] for row in rows]
    t = Table(data, colWidths=widths, repeatRows=repeat, hAlign='LEFT', cornerRadii=[3 * mm] * 4)
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), accent),
        ('GRID', (0, 0), (-1, -1), 0.45, LINE),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 2.4 * mm),
        ('RIGHTPADDING', (0, 0), (-1, -1), 2.4 * mm),
        ('TOPPADDING', (0, 0), (-1, -1), 2.2 * mm),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2.2 * mm),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [PANEL, BLUE_XL]),
    ]))
    return t


def photo(path: Path, max_w=CW, max_h=102 * mm):
    with PILImage.open(path) as im:
        w, h = im.size
    k = min(max_w / w, max_h / h)
    return Image(str(path), width=w * k, height=h * k)


def evidence(path: Path, title: str, callouts: Sequence[str], max_h=92 * mm):
    pic = photo(path, max_w=CW - 8 * mm, max_h=max_h)
    inner = Table([[pic]], colWidths=[CW - 8 * mm], cornerRadii=[3 * mm] * 4)
    inner.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), PANEL),
        ('BOX', (0, 0), (-1, -1), 0.6, LINE),
        ('LEFTPADDING', (0, 0), (-1, -1), 3 * mm),
        ('RIGHTPADDING', (0, 0), (-1, -1), 3 * mm),
        ('TOPPADDING', (0, 0), (-1, -1), 3 * mm),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3 * mm),
    ]))
    cr = []
    for i, text in enumerate(callouts, 1):
        cr.append([P(f'{i:02d}', 'center'), P(text, 'small')])
    notes = Table(cr, colWidths=[11 * mm, CW - 11 * mm], hAlign='LEFT', cornerRadii=[2 * mm] * 4)
    notes.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (0, -1), BLUE),
        ('TEXTCOLOR', (0, 0), (0, -1), WHITE),
        ('BACKGROUND', (1, 0), (1, -1), PANEL),
        ('GRID', (0, 0), (-1, -1), 0.45, LINE),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 2.4 * mm),
        ('RIGHTPADDING', (0, 0), (-1, -1), 2.4 * mm),
        ('TOPPADDING', (0, 0), (-1, -1), 1.8 * mm),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 1.8 * mm),
    ]))
    return KeepTogether([P(title, 'h2'), inner, Spacer(1, 2 * mm), notes, Spacer(1, 2 * mm)])


def source_list(items: Sequence[tuple[str, str]]):
    rows = []
    for title, url in items:
        domain = url.split('/')[2] if '://' in url else url
        rows.append([title, f'<link href="{url}" color="#1769D2">{domain} · 查看原文 ↗</link>'])
    return rich_table(['方法来源', '公开链接'], rows, [54 * mm, CW - 54 * mm], font=7.0)


TOOLKIT = [
    ('01', '信任与政策', '背书、承诺、边界、价格、激励'),
    ('02', '使用与价值', '真实页面、场景、交付、上线'),
    ('03', '五路获客', '名单、话术、会销、转介绍、协会'),
    ('04', '异议对话', '顾虑拆解、20秒回答、证据、推进'),
    ('05', '成交作战', '诊断、体验、PQL、报价、采用'),
    ('06', '100问速查', '餐饮老板常问问题的统一口径'),
]


def toolkit_map(current: str):
    items = []
    for n, t, d in TOOLKIT:
        prefix = '正在使用' if n == current else f'资料 {n}'
        items.append((f'{prefix}｜{t}', d))
    return [
        *chapter('SYSTEM MAP', '整套销售武器包怎么用', '按客户旅程顺序使用，让销售知道下一步翻哪一本。'),
        bento(items, accent=ORANGE if current == '03' else BLUE),
        card('推荐顺序', '找客户看 03 → 判断和诊断看 05 → 真实演示看 02 → 处理异议看 04 → 商务与承诺看 01 → 临场查答案看 06。', accent=GREEN, fill=GREEN_L),
    ]


class NanoDoc(BaseDocTemplate):
    def __init__(self, path: Path, title: str, doc_no: str, confidentiality='内部销售使用'):
        self.short_title = title
        self.doc_no = doc_no
        self.confidentiality = confidentiality
        self._outline_id = 0
        super().__init__(str(path), pagesize=A4, leftMargin=LEFT, rightMargin=RIGHT, topMargin=TOP, bottomMargin=BOTTOM,
                         title=title, author='纳米 Work 行业版', subject='销售作战系统 V2')
        frame = Frame(LEFT, BOTTOM, CW, PH - TOP - BOTTOM, id='main')
        self.addPageTemplates(PageTemplate(id='brand', frames=[frame], onPage=self._page))

    def _page(self, c, d):
        c.saveState()
        if d.page == 1:
            c.setFillColor(NAVY)
            c.rect(0, 0, PW, PH, fill=1, stroke=0)
            c.setFillColor(BLUE)
            c.rect(0, PH - 8 * mm, PW, 8 * mm, fill=1, stroke=0)
            c.setFillColor(HexColor('#0B2543'))
            c.circle(PW - 2 * mm, 40 * mm, 68 * mm, fill=1, stroke=0)
            c.setFillColor(ORANGE)
            c.roundRect(PW - 46 * mm, PH - 44 * mm, 28 * mm, 4 * mm, 2 * mm, fill=1, stroke=0)
            c.restoreState()
            return
        c.setFillColor(PAGE)
        c.rect(0, 0, PW, PH, fill=1, stroke=0)
        c.drawImage(str(BRAND / 'nanowork-enterprise-dark.png'), LEFT, PH - 12.7 * mm, width=42 * mm, height=7.3 * mm, mask='auto')
        c.setFillColor(BLUE)
        c.roundRect(PW - RIGHT - 28 * mm, PH - 11.5 * mm, 28 * mm, 5.5 * mm, 2.75 * mm, fill=1, stroke=0)
        c.setFillColor(WHITE)
        c.setFont('NanoCN', 6.7)
        c.drawCentredString(PW - RIGHT - 14 * mm, PH - 9.5 * mm, f'武器包 {self.doc_no}')
        c.setStrokeColor(LINE)
        c.line(LEFT, 12 * mm, PW - RIGHT, 12 * mm)
        c.setFillColor(SLATE)
        c.setFont('NanoCN', 6.7)
        c.drawString(LEFT, 7.5 * mm, f'{self.confidentiality} · V2 · 2026-09-17')
        c.drawRightString(PW - RIGHT, 7.5 * mm, f'{d.page:02d}')
        c.restoreState()

    def afterFlowable(self, flowable):
        if isinstance(flowable, Paragraph) and flowable.style.name in {'chapter', 'h1'}:
            text = flowable.getPlainText()
            self._outline_id += 1
            key = f'outline-{self._outline_id}'
            self.canv.bookmarkPage(key)
            self.canv.addOutlineEntry(text, key, level=0 if flowable.style.name == 'chapter' else 1, closed=False)


def cover(doc_no: str, title: str, subtitle: str, audience: str, share: str):
    meta = Table([
        [P('适用对象', 'table_head'), P(audience, 'cover_meta')],
        [P('分享级别', 'table_head'), P(share, 'cover_meta')],
        [P('版本', 'table_head'), P('V2 · 2026-09-17 · 以线上产品与当期合同为准', 'cover_meta')],
    ], colWidths=[28 * mm, CW - 28 * mm], cornerRadii=[3 * mm] * 4)
    meta.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (0, -1), BLUE),
        ('BACKGROUND', (1, 0), (1, -1), HexColor('#0B2949')),
        ('GRID', (0, 0), (-1, -1), 0.5, HexColor('#264665')),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 4 * mm),
        ('RIGHTPADDING', (0, 0), (-1, -1), 4 * mm),
        ('TOPPADDING', (0, 0), (-1, -1), 3 * mm),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3 * mm),
    ]))
    return [
        Spacer(1, 11 * mm), logo(light=True, width=66 * mm), Spacer(1, 17 * mm),
        P(f'NANOWORK SALES SYSTEM · {doc_no}', 'cover_eyebrow'),
        P(title, 'cover_title'), P(subtitle, 'cover_sub'), Spacer(1, 12 * mm), meta,
        Spacer(1, 19 * mm), P('让方法复杂在总部，让动作简单在一线。', 'cover_sub'),
    ]


def build(path: Path, title: str, no: str, story: list, confidentiality='内部销售使用'):
    NanoDoc(path, title, no, confidentiality=confidentiality).build(story)


MARKET_SOURCES = [
    ('Salesforce Value Selling', 'https://www.salesforce.com/blog/sales/value-selling/'),
    ('Salesforce Solution Selling', 'https://www.salesforce.com/blog/sales/what-is-solution-selling/'),
    ('HubSpot Sales Prospecting', 'https://blog.hubspot.com/sales/effective-sales-prospecting-techniques-you-should-be-using'),
    ('Microsoft Copilot Adoption', 'https://adoption.microsoft.com/en-us/Copilot/'),
    ('Microsoft AI Adoption Journey', 'https://adoption.microsoft.com/files/agents/MicrosoftFoundryAIAdoptionJourney.pdf'),
    ('Salesforce Partner Cloud', 'https://help.salesforce.com/s/articleView?id=xcloud.pc_parent.htm&language=en_US&type=5'),
    ('Gainsight Customer Success', 'https://www.gainsight.com/blog/customer-adoption/'),
    ('OpenAI Enterprise AI Scaling', 'https://openai.com/business/guides-and-resources/how-enterprises-are-scaling-ai/'),
]


FIVE_ROUTES = [
    ('01', '存量客户盘点', '最快的钱', '筛“抱怨过成本问题、能触达老板、关系未破裂”的老客户。每位销售先列 20 个，本周约 5 个。'),
    ('02', '会销', '批量验证', '行业活动或单商圈 8-10 位老板小场。电话、微信图文、会前一天确认三次触达。'),
    ('03', '陌拜', '练兵与补量', '商圈扫街、园区扫楼、批发市场。选有店面、有员工、老板在场的对象。'),
    ('04', '转介绍', '成本最低', '客户第一次确认“结果有用”后立即提出具体引荐请求，并登记介绍关系。'),
    ('05', '协会商会', '借背书', '餐饮协会、物业协会、律协和本地商会，以“AI 能干什么、不能干什么”科普课切入。'),
]


def page_title(kicker: str, title: str, sub: str):
    return [*chapter(kicker, title, sub)]


def action_bar(text: str):
    return card('这一页的销售动作', text, accent=ORANGE, fill=ORANGE_L)


def policy_grid(rows: Sequence[Sequence[str]]):
    return rich_table(['客户听到的话', '可出示的证据', '适用条件', '禁止说法'], rows,
                      [43 * mm, 48 * mm, 43 * mm, CW - 134 * mm], font=6.9)


def metric_strip(items: Sequence[tuple[str, str]], colorset=(BLUE, GREEN, ORANGE)):
    cells = []
    col_w = CW / len(items)
    for i, (big, small) in enumerate(items):
        bg = colorset[i % len(colorset)]
        cell = Table([[P(big, 'card_num')], [P(small, 'center')]], colWidths=[col_w - 2 * mm])
        cell.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), PANEL),
            ('BOX', (0, 0), (-1, -1), 0.6, LINE),
            ('LINEABOVE', (0, 0), (-1, 0), 4, bg),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
            ('TOPPADDING', (0, 0), (-1, -1), 3 * mm),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3 * mm),
        ]))
        cells.append(cell)
    t = Table([cells], colWidths=[col_w] * len(cells))
    t.setStyle(TableStyle([('LEFTPADDING', (0, 0), (-1, -1), 1 * mm), ('RIGHTPADDING', (0, 0), (-1, -1), 1 * mm)]))
    return t


def doc01_story():
    st = cover('01', '信任背书、承诺边界与销售政策',
               '销售说的每一句话，都有证据、条件和下一步。',
               '纳米 Work 销售、渠道伙伴、销售管理者', '内部资料，不对外转发')
    st += [PageBreak(), *toolkit_map('01'), PageBreak()]
    st += page_title('01 / POSITIONING', '我们卖的不是“一次 AI 回答”',
                     '纳米 Work 把餐饮老板的经营问题，变成可派活、可验收、可复用的数字员工任务。')
    st += [metric_strip([('经营问题', '用真实门店资料输入'), ('专业交付', '任务、文档、图片、视频'), ('长期使用', '记录、反馈、采纳、复用')]), Spacer(1, 5 * mm)]
    st += [bento([
        ('对老板', '少盯过程，直接看结果、风险与下一步。'),
        ('对员工', '用明确岗位和任务模板，少从空白开始。'),
        ('对企业', '把账号、权限、任务与交付放在同一个工作台。'),
        ('对销售', '不靠夸张承诺，用真实页面和客户自己的任务证明价值。'),
    ], accent=BLUE)]
    st += [action_bar('先问客户“每周哪件事最费时”，只挑一个真实任务做首演。'), PageBreak()]

    st += page_title('02 / EVIDENCE', '不空讲能力，先给证据',
                     '演示时只使用当前线上页面、真实任务交付和经客户授权的材料。')
    st += [evidence(SHOT / '官网首页首屏-2026-09-17.png', '证据 01｜完整产品官网与行业定位', [
        '开场先说“面向餐饮实体门店”，不把客户带进模型参数。',
        '用官网展示完整产品，体验码只是快速试用入口。',
        '数字员工数量以当天线上目录为准，不固定承诺一个永不变的数字。',
    ], max_h=81 * mm), PageBreak()]
    st += page_title('02 / EVIDENCE', '证据不是“我们说可以”，是客户看到可交付',
                     '一次演示最少要走完：真实输入 → 数字员工处理 → 任务中心 → 可采纳的交付。')
    st += [evidence(BRAND / '13-document-focus.png', '证据 02｜可阅读、可导出的正文交付', [
        '先看老板摘要，再看执行正文，不把 JSON 当成客户结果。',
        '可用的交付必须有结论、理由、下一步和待核实项。',
        '支持的任务可下载 PDF、Word、Excel、图片、视频或打包文件，以页面当前按钮为准。',
    ], max_h=105 * mm), PageBreak()]

    st += page_title('03 / CLAIMS', '销售话术的四格证据卡',
                     '一句话能不能说，看证据、条件和风险，不看情绪。')
    st += [policy_grid([
        ('“用老板的问题直接派给数字员工”', '数字员工页、派活页、任务详情', '账号有对应权限且通道配置可用', '“任何事都会做”'),
        ('“结果能在任务中心回看和反馈”', '任务中心、采纳/不采纳、历史记录', '实际任务已成功交付', '“完全不会丢数据”'),
        ('“没有可交付成果的失败任务按规则退回平台余额”', '任务状态、费用记录、当期退款政策', '最终无可交付成果，以平台当期规则为准', '“任何情况都退钱”'),
        ('“从一个高频场景开始，不需要一次学完”', '首周使用计划、专属服务群', '客户指定输入人和验收人', '“不用学，全自动”'),
        ('“可支持内容、门店、选址、活动等多类任务”', '当前数字员工目录与实际交付', '只讲已上线、已验证的岗位', '“等于雇了几十个真人”'),
    ]), Spacer(1, 4 * mm), action_bar('想说一句新承诺时，先把证据页、适用条件和禁止说法填齐。'), PageBreak()]

    st += page_title('04 / PROMISES', '对客户可以明确说的五项承诺',
                     '承诺工具、服务和处理方式，不把经营结果包装成保证。')
    st += [bento([
        ('01｜真实演示', '用客户自己的一项真实任务做价值验证，不用静态样例冒充运行结果。'),
        ('02｜失败可处理', '可重试、补资料、保留已生成部分；最终无成果时按当期规则处理费用。'),
        ('03｜有人带上手', '标准客户建服务群，完成开通、培训和首批场景陪跑。'),
        ('04｜权限可管', '账号和功能按角色授权；API Key 等高风险配置仅对指定角色开放。'),
        ('05｜结果有边界', '在结果中区分事实、来源、假设和待核实项，关键动作仍由客户确认。'),
        ('不作的承诺', '不保证营业额、利润、爆款、客流；不保证 AI 永不出错；不以口头代替合同。'),
    ], accent=GREEN, fills=(GREEN_L, PANEL)), PageBreak()]

    st += page_title('05 / COMMERCIAL', '统一商务口径', '先把服务费、用量、席位、服务和结果边界说清，再说优惠。')
    st += [rich_table(['项目', '当前口径', '销售要确认的事'], [
        ('年度服务', '9,800 元/年，以正式合同为准', '签约主体、开票、开通时间'),
        ('现场政策', '现场签约交 1,000 元，成交款按 2,000 元抵扣', '必须在有效期内写入书面订单/合同'),
        ('模型/API 用量', '与年度服务分开说明，按任务和当期价格记录', '客户自带 Key 还是使用平台余额'),
        ('席位', '标准为 1 个主账号+4 个副账号；新增席位需申请付费', '使用人、角色、门店和权限'),
        ('交付服务', '开通、专属服务群、基础培训、首批场景陪跑', '客户的输入人、验收人和首训时间'),
        ('扩展/定制', '未发布价格和功能不当场承诺，由商务与产品评估', '定义目标、输入、交付、频次和验收'),
    ], [31 * mm, 77 * mm, CW - 108 * mm], font=7.2), Spacer(1, 4 * mm), action_bar('报价后请客户复述一遍：年费包含什么、用量怎么算、第一周谁使用。'), PageBreak()]

    st += page_title('06 / INCENTIVE', '激励要奖“客户真用”，不只奖签字',
                     '用里程碑管理销售质量，避免只追求扫码、注册和口头意向。')
    st += [rich_table(['里程碑', '可验证定义', '建议激励侧重', '不能当成'], [
        ('PQL 有效体验', '目标客户+真实资料+成功交付+客户确认有用', '低', '只填手机号/只打开页面'),
        ('成交开通', '合同+实收+账号开通+服务群', '中', '口头答应/未回款'),
        ('30 天采用', '两个固定场景+第二使用人+采纳或复用记录', '中高', '只登录/只生成一次'),
        ('续费/扩展', '有价值复盘+续费回款或新店/席位扩展', '高', '临到期才问'),
        ('转介绍', '被推荐人同意联系+完成有效体验/开通', '按阶段', '只交一个未授权的电话'),
    ], [28 * mm, 72 * mm, 30 * mm, CW - 130 * mm], font=6.9), Spacer(1, 5 * mm)]
    st += [card('管理者每周问三题', '1）哪个场景最容易形成 PQL？ 2）已成交客户是否完成首周任务？ 3）哪个承诺在一线被说错了？', accent=GREEN, fill=GREEN_L), PageBreak()]

    st += page_title('07 / RED LINES', '签约前 60 秒红线检查', '任何一项没说清，都不要用“先签了再说”跳过。')
    st += [rich_table(['检查项', '签约前必须听到的确认'], [
        ('客户目标', '客户能说出第一周要跑的 1-2 个真实场景。'),
        ('结果边界', '客户知道不保证爆款、营收、利润，关键决策由人确认。'),
        ('价格结构', '客户知道年度服务与模型/API 用量的关系。'),
        ('账号与席位', '确认使用人、权限、新增席位申请和离职处理。'),
        ('实施责任', '客户已指定资料输入人、结果验收人和首训时间。'),
        ('书面一致', '合同、订单和当期政策一致，没有未确认的口头承诺。'),
    ], [42 * mm, CW - 42 * mm], font=7.5), Spacer(1, 4 * mm)]
    st += [card('红线话术', '如果客户要求保证营收、流量或零风险：“这个结果我们不做虚假保证。我们可以把一个真实任务当场跑完，由您判断结果能不能用。”', accent=RED, fill=RED_L), PageBreak()]
    st += page_title('METHOD SOURCES', '这套政策的方法来源', '借鉴价值销售、产品资格线索、客户采用和伙伴管理；实际政策以纳米 Work 当期书面版本为准。')
    st += [source_list(MARKET_SOURCES)]
    return st


def doc02_story():
    st = cover('02', '产品使用与价值手册',
               '先用一件真事看见价值，再把价值变成团队的使用习惯。',
               '餐饮老板、店长、运营与管理团队', '客户可分享版')
    st += [PageBreak(), *toolkit_map('02'), PageBreak()]
    st += page_title('01 / START', '不要先学 AI，先选一件每周都要做的事',
                     '好的首个场景有三个特征：反复发生、现在很费时、结果容易验收。')
    st += [bento([
        ('开店', '选址、租金与保本测算、开业倒排、证照清单。'),
        ('管店', '巡店整改、排班、会议行动项、店长周报。'),
        ('获客', '小红书图文、带货视频、活动方案、私域内容。'),
        ('留客', '评价回复、会员分层、复购触达、流失风险复盘。'),
        ('复盘', '营业数据解读、活动复盘、问题清单、下周行动。'),
        ('首次优先', '选“一周内会再发生”的事，不选几年才发生一次的大项目。'),
    ], accent=BLUE), action_bar('请写下：我们店每周最费时的事是 ______；现在由 ______ 做；什么结果算能用 ______。'), PageBreak()]
    st += page_title('02 / WORKFLOW', '一个任务的完整路径', '用一句话说需求，补上真实材料，然后只看进度和交付。')
    st += [rich_table(['步骤', '您做什么', '系统做什么', '验收标准'], [
        ('1 选员工', '按问题选对岗位，不确定可用一句话找人', '展示员工自我介绍、用法和交付', '能说清这位员工要解决什么'),
        ('2 说需求', '说门店、问题、已有资料、要什么结果、不能编什么', '理解任务并提示必需材料', '输入中没有假价格、假地址和假经营数据'),
        ('3 上传资料', '只上传有权使用、与任务相关的文件/图片', '在授权范围内读取并处理', '敏感信息已脱敏，素材授权清晰'),
        ('4 等待交付', '关注进度条，不需要盯每个中间过程', '调用所需能力，保留任务状态', '成功、需补资料或失败原因一目了然'),
        ('5 验收反馈', '看摘要、正文和附件，点采纳/不采纳并写理由', '保留结果与反馈，支持复用与下载', '结果有人负责使用，修改意见具体'),
    ], [22 * mm, 54 * mm, 55 * mm, CW - 131 * mm], font=6.8), PageBreak()]
    st += page_title('03 / REAL SCREEN', '数字员工不是菜单，是一句话能派活的岗位',
                     '老板不用理解模型和工作流，只需要知道“谁能帮我做什么”。')
    st += [evidence(IMG / '06-capabilities.png', '真实产品证据｜能力从问题出发', [
        '用问题找岗位，不要求老板先学会分类。',
        '每位员工都应有自我介绍、一句话用法和输入示例。',
        '实际岗位数量与可用能力以当天线上页面为准。',
    ], max_h=94 * mm), PageBreak()]

    st += page_title('04 / CONTENT', '小红书种草：从真实门店素材出发',
                     '门头、菜品、环境、品牌名和目标客群，比一句“帮我写文案”更重要。')
    st += [evidence(IMG / '08-xhs-output.png', '真实交付证据｜标题、正文、标签、首评与配图统一', [
        '可按当前页面选择 6/9/12 图和可用风格。',
        '封面先解决“有没有食欲、有没有信息点”，再做内页。',
        '优先使用客户有权使用的真实图片；AI 配图不冒充真实门店实拍。',
    ], max_h=90 * mm), PageBreak()]
    st += page_title('05 / CONTENT', 'AI 带货：先让口播说得明白，再追求画面炫技',
                     '主题、门店、菜品、目标顾客和不能编造的信息，是一条视频的底稿。')
    st += [rich_table(['时长', '适用场景', '推荐结构', '验收'], [
        ('15 秒（默认）', '单品、单卖点、门店引流', '2 秒钩子 + 9 秒菜品/利益点 + 4 秒行动', '音色一致、中文口播清晰、字幕不遮主体'),
        ('30 秒（可选）', '多菜品、故事、活动解释', '钩子 + 问题 + 2-3 个卖点 + 证据 + 行动', '分段音色、转场、字幕和品牌一致'),
    ], [28 * mm, 43 * mm, 66 * mm, CW - 137 * mm], font=7.1), Spacer(1, 4 * mm)]
    st += [card('输入模板', '“我是成都火锅店，主推手切鲜牛肉，想让附近上班族晚餐到店。用我上传的门头和菜品图，做 15 秒中文口播视频；不要编价格和折扣。”', accent=ORANGE, fill=ORANGE_L), PageBreak()]

    st += page_title('06 / RESULT', '任务中心是所有工作的历史档案',
                     '内容生产、经营工具和数字员工的任务，最终都应回到同一个地方查看。')
    st += [evidence(BRAND / '13-spreadsheet-focus.png', '真实交付证据｜表格是用来执行，不是用来看热闹', [
        '结果记录应包含原始输入、最终正文、附件和任务费用。',
        '采纳时写清“哪里好”，不采纳时写清“怎么改”。',
        '开会时直接打开任务历史，不再从微信里翻文件。',
    ], max_h=105 * mm), PageBreak()]

    st += page_title('07 / FIRST VALUE', '什么才算“体验成功”',
                     '打开了页面、注册了手机号、问了一句话，都不等于已经获得价值。')
    st += [rich_table(['判定项', '通过标准', '谁确认'], [
        ('客户匹配', '餐饮/实体门店相关，有真实使用人和问题', '销售'),
        ('真实输入', '使用客户的门店、菜品、记录或目标，不是通用样例', '客户+销售'),
        ('成功交付', '任务真实成功，有可阅读/可下载成果', '系统状态'),
        ('客户确认有用', '客户指出哪一部分可以直接使用或经修改可使用', '客户'),
        ('再使用', '7 天内再次使用，或邀请第二位同事进入', '客户成功/系统'),
    ], [35 * mm, 94 * mm, CW - 129 * mm], font=7.2), Spacer(1, 4 * mm), action_bar('体验结束后只问两句：“哪一部分能直接用？你下一次什么时候还会做这件事？”'), PageBreak()]

    st += page_title('08 / ADOPTION', 'D0–D30 从开通到形成习惯',
                     '买了账号只是开始。价值来自真实任务被采纳、再次使用和团队共用。')
    st += [rich_table(['时间', '客户动作', '纳米 Work/服务动作', '验收'], [
        ('D0 开通', '确认使用人、验收人、两个固定场景', '账号、权限、服务群、基础设置', '可登录，责任人清晰'),
        ('D1 首批任务', '提供真实资料，完成 1 个经营+1 个内容任务', '陪跑首次输入、验收和反馈', '至少 1 项采纳/明确修改'),
        ('D3 复用', '用同一模板处理第二次真实任务', '把首次反馈固化进下一轮', '首个场景可重复'),
        ('D7 团队化', '第二位使用人完成任务', '按角色培训派活、验收和任务中心', '不依赖唯一使用人'),
        ('D14 价值复盘', '确认采纳、复用、节省时间和缺口', '调整模板、权限和第二场景', '客户能说出具体价值'),
        ('D30 固化', '把两个场景写入周/月工作节奏', '形成使用健康表和下月目标', '有频次、责任人、验收标准'),
    ], [25 * mm, 55 * mm, 64 * mm, CW - 144 * mm], font=6.7), PageBreak()]

    st += page_title('09 / HEALTH', '不用登录次数骗自己',
                     '判断产品是否真正进入经营，要看部署、参与、采用和价值四类信号。')
    st += [rich_table(['维度', '看什么', '红色信号', '处理'], [
        ('部署', '账号、权限、资料、责任人', '没人验收，只有老板一个账号', '重新定输入人和验收人'),
        ('参与', '任务发起人、第二使用人、反馈', '只生成不采纳，无修改意见', '培训如何验收与反馈'),
        ('采用', '固定场景、采纳、复用、下载', '14 天无真实任务', '回到一个高频小场景'),
        ('价值', '节省时间、交付完整、决策更清楚、使用扩展', '客户只说“看着不错”', '追问哪一步改变了，用记录复盘'),
    ], [24 * mm, 54 * mm, 55 * mm, CW - 133 * mm], font=7.0), Spacer(1, 5 * mm), action_bar('每月与服务群复盘：最常用的 2 个场景、一个被采纳的结果、一个需要改的问题。'), PageBreak()]
    st += page_title('10 / TROUBLESHOOTING', '出错时先分类，不要反复盲点',
                     '保留任务编号、发生时间、页面提示和操作步骤，不要发送完整 API Key。')
    st += [rich_table(['现象', '先检查', '正确处理'], [
        ('登录超时', '网络、账号状态、浏览器会话', '刷新登录/重新登录；仍失败时提供时间与账号'),
        ('上游超时', '任务大小、通道状态、素材', '保留原任务重试；长内容分段继续，不丢已生成部分'),
        ('结果不准', '是否缺真实资料，是否有未标注假设', '补资料+写清验收标准+带原要求重新派活'),
        ('没有图片/视频', '所在的是体验 H5 还是正式工作台，模型与 Key 是否可用', '在正式产品的对应员工页完成多媒体流程'),
        ('失败扣费', '最终是否有可交付成果，费用记录状态', '按当期失败退回规则处理，保留任务编号'),
    ], [35 * mm, 62 * mm, CW - 97 * mm], font=7.2), PageBreak()]
    st += page_title('QUICK START', '第一次使用清单', '五分钟准备，一次真实交付，一个下次复用时间。')
    st += [rich_table(['已完成', '检查项'], [
        ('□', '选定一件每周重复、当前费时、容易验收的事。'),
        ('□', '用一句话说清门店、问题、已有资料、要什么交付、不能编什么。'),
        ('□', '上传有权使用、已脱敏、与任务有关的真实材料。'),
        ('□', '指定谁验收，并在结果后点采纳/不采纳，写明原因。'),
        ('□', '在日历里定下一次复用时间，把这件事变成团队节奏。'),
    ], [22 * mm, CW - 22 * mm], font=8.0)]
    return st


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(mod)
    return mod


def html_list(items: Sequence[str]) -> str:
    return '<br/>'.join(f'• {x}' for x in items)


def doc03_story():
    mod = _load_module('five_routes_v2', ROOT / 'tmp/pdfs/five_routes_module.py')
    routes = mod.FIVE_ROUTE_PLAYBOOK
    campaign = mod.CAMPAIGN_30D
    tiers = mod.LEAD_TIERS
    abm = mod.ABM_OVERLAY
    st = cover('03', '五路获客与宣传推广手册',
               '名单从哪里来、第一句话怎么说、七天怎么跟，全部写成可执行动作。',
               '一线销售、销售主管、渠道伙伴、活动运营', '内部销售使用')
    st += [PageBreak(), *toolkit_map('03'), PageBreak()]
    st += page_title('01 / FIVE ROUTES', '客人不会自动来，五路同时建流水线',
                     '每一路都要记名单、客户原话、真实体验、采纳和下一步，不用加微信数量假装商机。')
    st += [bento([(f'{r["id"]}｜{r["name"]}', f'<b>{r["positioning"]}</b><br/>{r["principle"]}') for r in routes], accent=ORANGE, fills=(PANEL, ORANGE_L)),
           card('五路分工', '老销售主攻存量客户和转介绍；新销售用陌拜练行业观察；公司统一组织会销和协会商会资源。周报分路统计，不混成一个总数。', accent=GREEN, fill=GREEN_L), PageBreak()]
    st += page_title('02 / PIPELINE', '五路最后要汇成同一条成交路径',
                     '来源可以不同，资格判断、真实体验、价值确认和首周采用必须一致。')
    st += [rich_table(['阶段', '客户行为', '销售证据', '不算通过'], [
        ('名单', '符合目标画像并可合法触达', '来源、角色、问题、授权状态', '买来的无授权手机号'),
        ('对话', '确认一个真实问题和使用人', '客户原话和下一步日期', '只互换名片'),
        ('体验', '用本店资料完成一次任务', '真实输入、交付、采纳/修改', '看通用案例视频'),
        ('PQL', '确认有用并在 7 天内复用/邀请同事', '第二次任务或第二使用人', '只扫码注册'),
        ('商务', '范围、价格、用量、责任人和时间一致', '报价、决策人、决策日期', '只发过价格'),
        ('采用', '完成 D0–D30 两个固定场景', '采纳、复用、参与人和价值记录', '只开通了账号'),
    ], [23 * mm, 58 * mm, 61 * mm, CW - 142 * mm], font=7.4), PageBreak()]

    for idx, r in enumerate(routes, 1):
        st += page_title(f'ROUTE {r["id"]}', f'{r["name"]}｜{r["positioning"]}', r['principle'])
        st += [card('30 秒开场', r['opening_30s'], accent=ORANGE, fill=ORANGE_L), Spacer(1, 3 * mm)]
        st += [rich_table(['适用对象', '名单从哪来'], [[html_list(r['suitable_for']), html_list(r['list_sources'])]], [CW / 2, CW / 2], font=7.1), Spacer(1, 3 * mm)]
        st += [rich_table(['价值诱因', '单一下一步'], [[html_list(r['value_bait']), r['cta']]], [CW / 2, CW / 2], font=7.1),
               action_bar('完成本页后，把客户原话、联系许可和下一步日期当场写入名单。'), PageBreak()]
        cadence_rows = [(x['day'], x['channel'], x['action'], x['asset']) for x in r['cadence_7d']]
        st += page_title(f'ROUTE {r["id"]} / 7 DAYS', f'{r["name"]}｜七天触达节奏', '每次只推进一个动作，用客户行为决定下一步。')
        st += [rich_table(['时点', '渠道', '动作', '资产'], cadence_rows,
                          [18 * mm, 25 * mm, 96 * mm, CW - 139 * mm], font=7.4), PageBreak()]
        st += page_title(f'ROUTE {r["id"]} / REVIEW', f'{r["name"]}｜复盘与红线', '指标用于学习和改进，不把团队训练目标说成客户结果保证。')
        st += [rich_table(['复盘指标', '合规与禁区'], [[html_list(r['metrics']), html_list(r['compliance'])]], [CW / 2, CW / 2], font=7.6),
               action_bar('请在周复盘中记录：本路的有效名单、真实体验、采纳、二次使用和失败原因。'), PageBreak()]

    st += page_title('13 / LEAD TIERS', '会后不是都打一样的电话',
                     '按真实行为分热、温、冷，明确服务时限、内容和退出条件。')
    for i, key in enumerate(('hot', 'warm', 'cold')):
        t = tiers[key]
        st += [card(t['label'], html_list(t['definition']), accent=ORANGE if key == 'hot' else (BLUE if key == 'warm' else SLATE), fill=ORANGE_L if key == 'hot' else (BLUE_L if key == 'warm' else PANEL)), Spacer(1, 4 * mm)]
        st += [rich_table(['SLA', '跟进序列', '退出条件'], [[t['sla'], html_list(t['sequence']), t['exit']]], [42 * mm, 82 * mm, CW - 124 * mm], font=7.5)]
        if i != 2:
            st += [PageBreak(), P('线索分层｜续', 'h1')]
    st += [Spacer(1, 4 * mm), card('行为评分提示', tiers['scoring_hint']['rule'] + '<br/>' + tiers['scoring_hint']['thresholds'], accent=GREEN, fill=GREEN_L), PageBreak()]

    st += page_title('14 / 30 DAYS', '30 天五路联动作战', campaign['objective'])
    cal_rows = [(x['phase'], x['days'], html_list(x['actions']), x['deliverables'], x['checkpoint']) for x in campaign['calendar']]
    st += [rich_table(['阶段', '日期', '核心动作', '必须交付', '检查点'], cal_rows[:2],
                      [29 * mm, 18 * mm, 68 * mm, 37 * mm, CW - 152 * mm], font=7.3), PageBreak()]
    st += page_title('14 / 30 DAYS / CONTINUED', '30 天五路联动作战｜第 3–4 周', '按行为分层，用二次使用和采用证据推动成交。')
    st += [rich_table(['阶段', '日期', '核心动作', '必须交付', '检查点'], cal_rows[2:],
                      [29 * mm, 18 * mm, 68 * mm, 37 * mm, CW - 152 * mm], font=7.3), Spacer(1, 4 * mm),
           card('北极星指标', campaign['north_star'], accent=ORANGE, fill=ORANGE_L), PageBreak()]
    st += page_title('15 / OPERATING RHYTHM', '每周节奏与全漏斗', '把客户来源、销售动作和产品使用连成一条可复盘链路。')
    st += [rich_table(['周节奏', '执行要求'], [[x.split('：', 1)[0], x.split('：', 1)[1] if '：' in x else x] for x in campaign['weekly_rhythm']], [35 * mm, CW - 35 * mm], font=7.2), Spacer(1, 4 * mm)]
    funnel = ' → '.join(campaign['funnel'])
    st += [card('完整漏斗', funnel, accent=BLUE, fill=BLUE_L), action_bar('每周分别统计五路的名单、对话、体验、采纳、二次使用、成交和 D30 采用。'), PageBreak()]

    st += page_title('16 / ABM', '连锁客户才启用 ABM 叠加层', abm['when_to_use'])
    st += [rich_table(['购买角色', '关心的事', '需要的证据'], [(x['role'], x['concern'], x['evidence']) for x in abm['buying_committee']], [37 * mm, 65 * mm, CW - 102 * mm], font=7.1), Spacer(1, 4 * mm)]
    st += [rich_table(['阶段', '退出条件'], [(x['stage'], x['exit']) for x in abm['stages']], [35 * mm, CW - 35 * mm], font=7.0), PageBreak()]
    st += page_title('17 / ABM', '五路怎么进入同一个连锁账户', '一线门店可以帮你看见问题，但不等于总部授权。')
    st += [rich_table(['入口', '连锁打法'], [[x.split('：', 1)[0], x.split('：', 1)[1]] for x in abm['five_route_entry']], [35 * mm, CW - 35 * mm], font=7.2), Spacer(1, 3 * mm)]
    st += [rich_table(['14 天节奏', '动作'], [[f'D{i + 1}', x] for i, x in enumerate(abm['cadence_14d'])], [25 * mm, CW - 25 * mm], font=7.0), Spacer(1, 3 * mm),
           card('红线', html_list(abm['red_lines']), accent=RED, fill=RED_L), PageBreak()]
    st += page_title('METHOD SOURCES', '五路不是五套孤立话术', '我们结合多渠道客户开发、会销行为分层、产品体验、账户营销和伙伴管理，最终用纳米 Work 的真实证据收口。')
    st += [source_list([
        ('HubSpot Sales Prospecting', 'https://blog.hubspot.com/sales/effective-sales-prospecting-techniques-you-should-be-using'),
        ('Salesforce Account-Based Marketing', 'https://www.salesforce.com/marketing/account-based-marketing-guide/'),
        ('Salesforce Partner Cloud', 'https://help.salesforce.com/s/articleView?id=xcloud.pc_parent.htm&language=en_US&type=5'),
        ('Microsoft Copilot Adoption', 'https://adoption.microsoft.com/en-us/Copilot/'),
        ('工信部综合整治骚扰电话专项行动', 'https://www.miit.gov.cn/zwgk/zcwj/wjfb/tz/art/2018/art_779ce18204e34f35a899cef26b2432fa.html'),
        ('个人信息保护法', 'https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm'),
    ])]
    return st


def deep_qa_card(item: dict):
    data = [
        [P(item['id'], 'center'), P(item['customer_words'], 'card_title')],
        [P('真实顾虑', 'table'), P(item['real_concern'], 'small')],
        [P('20 秒回答', 'table'), P(item['answer_20s'], 'body')],
        [P('证据动作', 'table'), P(item['evidence_action'], 'small')],
        [P('接着问', 'table'), P(item['next_question'], 'small')],
    ]
    t = Table(data, colWidths=[25 * mm, CW - 25 * mm], hAlign='LEFT', cornerRadii=[3 * mm] * 4)
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (0, 0), BLUE), ('TEXTCOLOR', (0, 0), (0, 0), WHITE),
        ('BACKGROUND', (1, 0), (1, 0), BLUE_L), ('BACKGROUND', (0, 1), (0, -1), BLUE_XL),
        ('BOX', (0, 0), (-1, -1), 0.65, LINE), ('INNERGRID', (0, 0), (-1, -1), 0.35, LINE),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 3 * mm), ('RIGHTPADDING', (0, 0), (-1, -1), 3 * mm),
        ('TOPPADDING', (0, 0), (-1, -1), 2 * mm), ('BOTTOMPADDING', (0, 0), (-1, -1), 2 * mm),
    ]))
    return KeepTogether([t, Spacer(1, 3 * mm)])


def doc04_story():
    mod = _load_module('deep_qa_v2', ROOT / 'tmp/pdfs/deep_qa_module.py')
    items = mod.DEEP_QA_LIST
    st = cover('04', '高频异议与代理商客户对话手册',
               '不急着反驳，先找到顾虑，再用证据推进一个下一步。',
               '直销、代理商、渠道经理、客户成功、销售管理者', '内部销售使用')
    st += [PageBreak(), *toolkit_map('04'), PageBreak()]
    st += page_title('01 / FRAMEWORK', '处理异议的四步：接住、澄清、举证、推进',
                     '异议不是一句需要压过去的话，它是客户告诉你“哪个证据还不够”。')
    st += [rich_table(['步骤', '目标', '可直接使用的句子', '禁区'], [
        ('1 接住', '让客户知道你听到了', '“这个担心很正常，您更在意的是……对吗？”', '立刻反驳'),
        ('2 澄清', '找真正顾虑和决策条件', '“如果这一点说清，还有别的阻碍吗？”', '自己猜'),
        ('3 举证', '用一个真实页面/交付/政策回答', '“我不用口头解释，我们现场看这一项。”', '用新承诺遮住旧疑问'),
        ('4 推进', '从解释回到一个具体动作', '“那么下一步我们用您的真实资料跑一次，可以吗？”', '只回答不约下一步'),
    ], [23 * mm, 43 * mm, 77 * mm, CW - 143 * mm], font=7.0), PageBreak()]
    cats = []
    for x in items:
        if x['category'] not in cats:
            cats.append(x['category'])
    st += page_title('02 / INDEX', '30 个高频异议，按客户真正担心的事来查',
                     '先找类别，再找客户原话；回答后必须做证据动作和下一问。')
    counts = [(c, str(sum(1 for x in items if x['category'] == c))) for c in cats]
    st += [bento([(f'{c}｜{n} 题', '按“原话—顾虑—20秒回答—证据—下一问”处理。') for c, n in counts], accent=BLUE), PageBreak()]
    for cat in cats:
        group = [x for x in items if x['category'] == cat]
        st += page_title('OBJECTION CARDS', cat, '直接说结论，并当场出示证据；如果没有证据，就说清需要回去核实。')
        for i, item in enumerate(group):
            st += [deep_qa_card(item)]
            if i % 2 == 1 and i != len(group) - 1:
                st += [PageBreak(), P(f'{cat}｜续', 'h1')]
        st += [PageBreak()]

    st += page_title('ESCALATION', '什么时候不能再靠话术', '越权事项必须留记录、指定负责人和回复时间。')
    st += [rich_table(['客户要求', '升级给谁', '销售当场说什么', '必须记录'], [
        ('特殊折扣、月付、额外席位', '销售主管/商务', '“我不越权承诺，今天把范围带回书面确认。”', '范围、数量、截止日期'),
        ('定制、集成、数据迁移', '产品/技术+商务', '“先定义输入、交付、频次和验收，再评估。”', '现系统、接口、数据、安全要求'),
        ('特殊安全/法务条款', '管理员/法务/技术', '“我们按您的条款逐项回复，不当场作绝对承诺。”', '条款原文、数据类型、使用场景'),
        ('代理独家、返点、撞单', '渠道负责人', '“以正式渠道政策和报备结果为准。”', '区域、期限、客户、贡献证据'),
        ('要求保证营收/爆款/回本', '不批准；改做真实体验', '“经营结果不做虚假保证，我们用真实任务证明可见价值。”', '客户原话和回应'),
    ], [42 * mm, 35 * mm, 69 * mm, CW - 146 * mm], font=6.7), PageBreak()]
    st += page_title('POCKET CARD', '销售现场只记住这十句', '回答不在于长，在于真实、有证据、能推进。')
    st += [rich_table(['#', '句子'], [(str(i + 1), s) for i, s in enumerate([
        '“我先确认一下，您最担心的是……对吗？”',
        '“如果这一点说清，还有别的阻碍吗？”',
        '“我不用口头解释，我们现场看真实页面。”',
        '“我们不承诺爆款或营收，可以先证明一份交付能不能用。”',
        '“年度服务与模型/API 用量要分开说清。”',
        '“我们不用客户的敏感数据冒险，先做脱敏输入。”',
        '“失败没有交付的任务，按当期规则处理积分。”',
        '“未发布的折扣、返点和独家我不越权承诺。”',
        '“这次只跑您的一个真实问题，做完您再判断。”',
        '“那我们把下一步的资料、责任人和时间定下来。”',
    ])], [12 * mm, CW - 12 * mm], font=8.1)]
    return st


def doc05_story():
    st = cover('05', '销售方法论与成交作战手册',
               '从一条线索到真实使用：每一阶段都有退出条件，每一次跟进都有明确下一步。',
               '一线销售、销售主管、渠道经理、客户成功', '内部销售使用')
    st += [PageBreak(), *toolkit_map('05'), PageBreak()]
    st += page_title('01 / CLOSED LOOP', '一条统一成交闭环',
                     '销售的任务不是“把功能讲完”，而是推动客户用真实任务完成一次价值判断。')
    closed_loop_rows = [
        ('1 五路获客', '从哪里找到匹配客户？', '来源、角色、问题、授权', '取得联系许可和下一步'),
        ('2 资格判断', '值不值得双方继续花时间？', '业态、角色、场景、时点', '有真实使用人和验收标准'),
        ('3 痛点诊断', '问题发生多频，不解决会怎样？', '客户原话、现状基线、影响', '选定一个首演场景'),
        ('4 真实体验', '用本店资料能不能出可用结果？', '输入、交付、采纳/修改', '客户明确哪一部分有用'),
        ('5 PQL', '价值能不能在七天内重现？', '二次使用/第二使用人', '客户愿意谈长期使用'),
        ('6 价值确认', '对谁、在什么场景有什么可见改变？', '客户确认的基线与改变', '决策人认可成功标准'),
        ('7 商务成交', '范围、价格、用量、风险和时间是否一致？', '报价、合同、决策日期', '回款、开通、实施责任人'),
        ('8 D0–D30 采用', '买了以后是否形成使用节奏？', '固定场景、采纳、复用、团队参与', '客户能自己跑完并确认价值'),
        ('9 续费/转介绍', '价值能否继续、扩展并被客户转述？', '周期复盘、健康度、推荐原话', '续费、扩店/扩场景或有效引荐'),
    ]
    st += [rich_table(['阶段', '核心问题', '必须证据', '进入下一阶段的条件'], closed_loop_rows[:5], [24 * mm, 52 * mm, 50 * mm, CW - 126 * mm], font=7.5), PageBreak()]
    st += page_title('01 / CLOSED LOOP / CONTINUED', '统一成交闭环｜从价值确认到续费', '后半程不靠“快签了”，靠决策证据、上线责任和持续采用。')
    st += [rich_table(['阶段', '核心问题', '必须证据', '进入下一阶段的条件'], closed_loop_rows[5:], [24 * mm, 52 * mm, 50 * mm, CW - 126 * mm], font=7.5), PageBreak()]

    st += page_title('02 / MARKET METHODS', '市场上的好方法，在纳米 Work 中各自解决一个问题',
                     '不把方法论当黑话；只保留对一线动作有帮助的部分。')
    market_rows = [
        ('价值/诊断式销售', '所有客户', '从现状、问题、影响、理想结果开始', '用功能清单代替诊断'),
        ('PLG / PQL', '体验和试用', '用真实交付、采纳和二次使用判断意向', '把扫码、注册当 PQL'),
        ('SPIN', '深挖高频痛点', '问现状、问题、影响、解决后的价值', '像审问一样连发问题'),
        ('MEDDPICC-lite', '连锁/多店/集团', '补决策人、决策标准、流程、推动者和竞争方案', '给 9,800 元单店套重流程'),
        ('ABM', '高价值连锁账户', '围绕一家企业组织多角色、专属证据和试点', '把群发改名字就叫 ABM'),
        ('伙伴生命周期', '代理商/渠道', '招募、认证、演示、报备、联合销售、交付和复盘', '只签协议不培训不交付'),
        ('客户成功', '回款后到续费', '看部署、参与、采用和价值', '只看登录次数'),
    ]
    st += [rich_table(['方法', '何时使用', '纳米 Work 的落地', '不要用错'], market_rows[:4], [30 * mm, 32 * mm, 74 * mm, CW - 136 * mm], font=7.5), PageBreak()]
    st += page_title('02 / MARKET METHODS / CONTINUED', '市场方法如何用在连锁、渠道和客户采用', '复杂方法只用在值得的客户和阶段，不给标准单店交易增加无效负担。')
    st += [rich_table(['方法', '何时使用', '纳米 Work 的落地', '不要用错'], market_rows[4:], [30 * mm, 32 * mm, 74 * mm, CW - 136 * mm], font=7.5), PageBreak()]

    st += page_title('03 / ICP', '先判断值不值得跟，再说产品',
                     '好客户不是“对 AI 感兴趣”，是有真实问题、真实使用人和近期动作时点。')
    st += [rich_table(['资格问题', '好信号', '风险信号'], [
        ('是什么店、几家店？', '餐饮/实体门店，组织与使用人明确', '与产品场景无关或只想套方案'),
        ('哪件事反复发生又费时？', '有周/月频次，能说出现流程', '“就想看看”，无场景'),
        ('谁提供资料，谁验收？', '有实际使用人和验收人', '只有围观者，没人使用'),
        ('什么结果算能用？', '客户能描述具体交付和标准', '要求“保证赚钱”'),
        ('什么时候要开始？', '开店、活动、旺季、管理改造等时点', '无时点、无负责人'),
        ('谁决定和付款？', '决策人或明确引荐路径', '一直无法触达决策人'),
    ], [48 * mm, 67 * mm, CW - 115 * mm], font=7.5), Spacer(1, 4 * mm), action_bar('不符合的线索进入培育或关闭，不用更多演示和折扣弥补不匹配。'), PageBreak()]

    st += page_title('04 / DISCOVERY', 'SPIN 诊断：让客户自己说出影响和成功标准',
                     '不需要问很多，需要追问到现在怎么做、为什么痛、不改会怎样、什么叫能用。')
    st += [rich_table(['层次', '问法', '记录内容', '示例'], [
        ('S 现状', '“现在这件事是谁、多久做一次？”', '流程、人、频次、工具', '每周 3 次内容，运营一人'),
        ('P 问题', '“哪一步最容易卡住/返工？”', '时间、质量、协作断点', '找选题和写初稿花 6 小时'),
        ('I 影响', '“不解决，下个月会损失什么？”', '事件次数、延误、人工、外包', '连续断更，活动常临时做'),
        ('N 价值', '“如果解决，什么结果算能用？”', '交付、完成时间、验收人', '周一取得 3 组可审核初稿'),
    ], [22 * mm, 55 * mm, 48 * mm, CW - 125 * mm], font=7.5), Spacer(1, 5 * mm)]
    st += [card('诊断结论句', '“我听到的是：这件事每月发生 ___ 次，现在由 ___ 做，主要卡在 ___，你希望第一次交付至少达到 ___。我理解对吗？”', accent=ORANGE, fill=ORANGE_L), PageBreak()]

    st += page_title('05 / PQL', '产品资格线索：客户已经从产品中拿到意义',
                     '注册是身份，PQL 是行为和价值证据。')
    st += [metric_strip([('真实资料', '本店问题和输入'), ('成功交付', '不是模板或静态稿'), ('客户确认', '指出哪里可使用'), ('七天复现', '再用或邀请同事')], colorset=(BLUE, GREEN, ORANGE, GOLD)), Spacer(1, 5 * mm)]
    st += [rich_table(['不是 PQL', '是 PQL 证据'], [
        ('扫了体验码', '扫码后用真实问题跑出结果并确认用途'),
        ('看过演示', '客户自己提供资料并验收'),
        ('说“有点意思”', '说出会给谁用、什么时候用'),
        ('问了价格', '价值确认后询问价格、上线、权限或用量'),
    ], [CW / 2, CW / 2], font=7.5), PageBreak()]

    st += page_title('06 / DEMO', '15 分钟真实演示：只演一个闭环',
                     '不追求把整个系统点一遍，追求客户能回答“这份结果能不能用”。')
    st += [rich_table(['分钟', '动作', '销售话术', '证据'], [
        ('0–2', '复述问题和验收标准', '“我先确认：您最想解决的是……”', '客户点头/补充'),
        ('2–4', '选对数字员工', '“这位岗位需要什么输入，会交付什么。”', '岗位页'),
        ('4–7', '输入真实任务', '“价格、地址、数据缺失时不编。”', '真实输入'),
        ('7–10', '等待并解释进度', '“老板不需要盯中间步骤，完成后看交付。”', '任务状态'),
        ('10–13', '先看摘要，再看正文/文件', '“这里是结论，这里是执行表和待核实项。”', '真实交付'),
        ('13–15', '让客户作判断', '“哪一部分能直接用？哪一部分要改？”', '采纳/修改+下一步'),
    ], [18 * mm, 46 * mm, 78 * mm, CW - 142 * mm], font=7.5), Spacer(1, 4 * mm)]
    st += [evidence(BRAND / '13-spreadsheet-focus.png', '演示必须落到一份可执行交付', ['让客户指出一项可直接做的动作。', '让客户说出会把结果发给谁。', '当场记录修改意见和下一次使用时间。'], max_h=94 * mm), PageBreak()]

    st += page_title('07 / VALUE', '价值算账：只计客户能确认的数字',
                     '不把“可能节省”包装成保证回报；先建现状基线，使用后再复盘。')
    st += [rich_table(['基线', '客户填写', '使用后记录', '价值类型'], [
        ('任务频次', '____ 次/周或月', '实际重复次数', '稳定性'),
        ('每次人工时间', '____ 小时 × ____ 人', '准备、修改、协作的实际时间', '效率'),
        ('返工/延误', '____ 次/月', '任务历史和修改记录', '质量'),
        ('外包/试错', '____ 元/月（只填真实账单）', '实际保留或取代的成本', '成本'),
        ('结果利用', '现在谁看、谁执行', '采纳、复用、下载、执行负责人', '采用'),
    ], [37 * mm, 45 * mm, 59 * mm, CW - 141 * mm], font=7.5), Spacer(1, 4 * mm),
           card('价值表达', '“这项工作一年发生多少次，现在需要几个人花多久，我们先看是否能把资料准备、初稿和整理时间降下来。具体节省以使用后记录为准。”', accent=ORANGE, fill=ORANGE_L), PageBreak()]

    st += page_title('08 / SINGLE STORE', '单店 7–14 天快路径',
                     '单店决策链较短，不需要把一个标准产品卖成六个月咨询项目。')
    st += [rich_table(['时间', '目标', '动作', '退出条件'], [
        ('D0–D1', '资格+诊断', '确认业态、使用人、一个高频问题和时点', '选定首演场景'),
        ('D2–D3', '真实体验', '用客户资料跑一次，记录采纳/修改', '客户明确哪里能用'),
        ('D4–D7', 'PQL', '同一场景再用一次，或让店长/运营加入', '出现二次使用或第二使用人'),
        ('D7–D10', '价值+商务', '复盘现状、交付和两个首周场景；说清价格与用量', '决策人确认范围与时间'),
        ('D10–D14', '签约上线', '合同、回款、开通、服务群、首训和 D0–D7 计划', '客户真正开始使用'),
    ], [25 * mm, 39 * mm, 73 * mm, CW - 137 * mm], font=7.5), PageBreak()]

    st += page_title('09 / CHAIN', '连锁 30–90 天试点路径',
                     '连锁的关键不是“功能更多”，是多角色一起定试点范围、成功标准和扩展条件。')
    st += [rich_table(['阶段', '时间', '关键产出', '必须参与的人'], [
        ('账户选择', 'D0–D7', '业务问题、角色地图、价值假设、进入路径', '销售+业务联系人'),
        ('多角色诊断', 'D7–D21', '现状基线、影响、决策标准、成功标准', '业务负责人+使用人+推动者'),
        ('限定试点', 'D21–D45', '门店/场景/周期/双方投入/退出条件书面化', '业务+使用+技术/数据'),
        ('价值复盘', 'D45–D60', '采纳、复用、角色参与、基线变化和风险', '经济决策人+业务负责人'),
        ('商务上线', 'D60–D90', '范围、价格、合同、数据边界、实施和扩展计划', '决策、采购/法务、业务、项目负责人'),
    ], [32 * mm, 25 * mm, 76 * mm, CW - 133 * mm], font=7.5), PageBreak()]

    st += page_title('10 / MEDDPICC-LITE', '连锁商机的轻量资格卡',
                     '没有答案的格子不是文书缺口，是交易风险。')
    st += [rich_table(['要素', '要记录什么', '没有时的动作'], [
        ('Metrics 指标', '客户确认的基线、试点指标和周期', '与业务负责人定可测的成功标准'),
        ('Economic buyer 决策人', '谁承担预算和最终风险', '通过推动者安排价值复盘'),
        ('Decision criteria 标准', '价值、体验、安全、集成、服务、价格的权重', '要求客户按重要性排序'),
        ('Decision process 流程', '谁评估、谁审批、什么时候决策', '创建共同时间线'),
        ('Paper process 合同', '主体、采购、法务、安全、发票、付款', '提前拿到模板和材料清单'),
        ('Pain 痛点', '业务问题、影响和不改的代价', '回到不同角色重做诊断'),
        ('Champion 推动者', '愿意内部推动、能讲价值、有影响力的人', '给他一页内部汇报材料'),
        ('Competition 竞争', '现状、不做、通用 AI、人工/外包或其他产品', '对比客户购买标准，不贬低他人'),
    ], [38 * mm, 79 * mm, CW - 117 * mm], font=7.5), PageBreak()]

    st += page_title('11 / ABM', '连锁客户不能只跟一个联系人',
                     '同一个产品，经济决策人、业务负责人、使用人和技术法务看到的价值不同。')
    st += [rich_table(['角色', '关心', '证据', '要推动的动作'], [
        ('经济决策人', '投入、风险、战略价值', '价值测算、范围、价格、采用计划', '参加试点复盘和决策会'),
        ('业务负责人', '跨店标准、效率、执行', '真实流程、任务结果、管理记录', '定试点场景和成功标准'),
        ('一线使用人', '好不好用、会不会增加工作', '15 分钟真实体验、首周任务', '完成二次使用并反馈'),
        ('IT/数据/法务', '权限、数据、供应商、审计、合同', '配置、数据边界、权限和协议', '提前完成风险问题清单'),
        ('内部推动者', '怎么让内部同意', '一页内部汇报、试点证据、决策时间线', '帮助安排多角色会议'),
    ], [32 * mm, 47 * mm, 62 * mm, CW - 141 * mm], font=7.5), PageBreak()]

    st += page_title('12 / COMMERCIAL', '报价和成交：先对齐结构，再说活动',
                     '价格异议往往不只是价格，而是客户还没看见价值、范围或使用计划。')
    st += [rich_table(['必须对齐', '当前口径', '成交前问句'], [
        ('年度服务', '9,800 元/年，以合同为准', '“年度服务范围您理解了吗？”'),
        ('现场政策', '支付 1,000 元，成交款按 2,000 元抵扣，以书面有效期为准', '“活动条件是否与合同一致？”'),
        ('账号与席位', '标准为 1 主账号+4 副账号；新增需申请付费', '“五个账号分别由谁使用？”'),
        ('模型/API 用量', '与年度服务分开，按任务和当期价格记录', '“您用自己的 Key 还是平台余额？”'),
        ('实施', '开通、服务群、培训、首批场景陪跑', '“谁提供资料，谁验收，首训什么时候？”'),
        ('结果边界', '不保证营业额、利润、爆款；关键动作由客户确认', '“这些边界您接受吗？”'),
    ], [39 * mm, 77 * mm, CW - 116 * mm], font=7.5), Spacer(1, 4 * mm)]
    st += [card('成交四问', '1）今天结果哪里能用？ 2）第一周谁给资料、谁验收？ 3）还有哪一个问题会阻止您确认？ 4）如果解决，我们定合同、付款和首训时间，可以吗？', accent=ORANGE, fill=ORANGE_L), PageBreak()]

    st += page_title('13 / FOLLOW-UP', '不同客源的追销不能一个模板',
                     '每次跟进都应带着上次的客户原话、一份证据和一个单一 CTA。')
    st += [rich_table(['来源', '第一次跟进', '主要证据', '下一步'], [
        ('存量客户', '重述过去的具体问题，确认现在是否仍存在', '同场景真实交付', '约 15 分钟本店体验'),
        ('会销', '按是否到场、提问、体验、采纳分热温冷', '现场原话+专属复盘', '热线索 24 小时内真实体验'),
        ('陌拜', '重述门店现场观察，只联系已同意的人', '一页场景卡', '确认决策人和具体时间'),
        ('转介绍', '感谢推荐人，获得被推荐人同意后单独诊断', '推荐人允许转述的价值', '用被推荐人自己的问题体验'),
        ('协会商会', '根据会员共性问题做一对一诊断，不借组织名义施压', '授权的活动内容+个体问题', '自愿预约真实体验'),
    ], [29 * mm, 64 * mm, 49 * mm, CW - 142 * mm], font=7.5), PageBreak()]

    st += page_title('14 / PARTNER', '代理商要走完生命周期，不是签完协议就放养',
                     '渠道的价值是找对客户、完成真实体验、正确交付和长期采用。')
    st += [rich_table(['阶段', '总部提供', '伙伴完成', '通过标准'], [
        ('招募筛选', '画像、政策、合规红线', '提供区域、客群、团队和服务能力', '匹配而非只有人脉'),
        ('培训认证', '产品、诊断、演示、政策和考试', '完成真实演示与边界考核', '能独立完成 15 分钟闭环'),
        ('演示环境', '测试账号、证据卡、标准案例', '使用授权材料，不伪造演示', '能处理失败和异议'),
        ('商机报备', '统一入口、撞单规则、阶段定义', '填真实客户、问题、联系许可和下一步', '有效不重复不越权'),
        ('联合销售', '前几单共诊断、共演示、共复盘', '掌握客户关系并负责动作', '客户形成 PQL'),
        ('交付与复盘', '交接、服务和价值模板', '陪跑开通、采用、续费和转介绍', 'D30 有采用证据'),
    ], [29 * mm, 52 * mm, 60 * mm, CW - 141 * mm], font=7.4), PageBreak()]

    st += page_title('15 / CUSTOMER SUCCESS', 'D0–D90 采用、扩展与续费',
                     '续费不是到期前一个月才问，而是从第一个可用结果开始累积证据。')
    st += [rich_table(['时间', '目标', '健康信号', '动作'], [
        ('D0', '部署', '账号、权限、输入人、验收人、两个场景', '建群、开通、定首训'),
        ('D1–D7', '首次价值', '真实交付、采纳/修改、二次使用', '陪跑两个固定场景'),
        ('D14', '参与', '第二使用人、反馈、复用模板', '角色培训和卡点处理'),
        ('D30', '采用', '固定频次、采纳、复用、任务类型扩展', '首月价值复盘'),
        ('D60', '扩展', '新门店、新角色或新场景基于已有证据启动', '复制模板、验收标准和培训'),
        ('D90', '战略复盘', '客户能说出实际价值、风险和下一季度目标', '为续费/扩展/转介绍建证据'),
        ('续费前 90 天', '价值确认', '累计场景、使用人、采纳、复用、价值变化', '提前处理未实现价值和决策风险'),
    ], [29 * mm, 36 * mm, 76 * mm, CW - 141 * mm], font=7.4), PageBreak()]

    st += page_title('16 / FORECAST', '主管看证据，不看“感觉很有意向”',
                     '销售漏斗的每个数字都应能点开到真实记录。')
    st += [rich_table(['阶段', '核心指标', '不能混淆', '复盘问题'], [
        ('线索', '有效名单、决策/使用人触达、联系授权', '加微信不等于有效线索', '哪一路客源质量最高？'),
        ('诊断', '问题、影响、现状基线、验收标准', '有兴趣不等于有问题', '是否追问到不改的代价？'),
        ('体验', '真实输入、成功交付、采纳/修改', '生成完成不等于客户认可', '客户说哪里可用？'),
        ('PQL', '七天二次使用、第二使用人、主动购买行为', '扫码/注册不等于 PQL', '价值能否重现？'),
        ('商务', '决策人、价格范围、决策日期、合同流程', '发过报价不等于进入采购', '下一个客户承诺的行为是什么？'),
        ('成交', '合同、实收、开通、实施责任人', '口头同意不等于成交', '能否按计划进入 D0？'),
        ('采用', '固定场景、采纳、复用、使用人、价值确认', '登录不等于采用', '哪个红色健康信号需要处理？'),
    ], [28 * mm, 64 * mm, 53 * mm, CW - 145 * mm], font=7.4), PageBreak()]

    st += page_title('17 / POCKET CARD', '开场、诊断、演示、成交：一页现场卡',
                     '销售不需要背一百句话，只需要始终拿到客户的真实行为和下一步。')
    st += [rich_table(['时机', '一句话', '要拿到的事'], [
        ('开场', '“您店里哪件事每周都要做，但总是占用您本人时间？”', '一个高频问题'),
        ('诊断', '“现在谁做、多久一次、卡在哪、不解决会怎样？”', '现状、影响、验收'),
        ('体验', '“我们不讲假设，现在就用您的真实资料做一次。”', '真实输入授权'),
        ('验收', '“哪一部分可以直接用？哪一部分要改？”', '采纳/修改原因'),
        ('复用', '“这件事下次什么时候再发生？谁会用这个结果？”', '二次使用时间/第二使用人'),
        ('商务', '“如果价值、范围和边界都确认，我们定合同、付款和首训时间，可以吗？”', '决策人承诺的下一步'),
    ], [26 * mm, 105 * mm, CW - 131 * mm], font=7.5), PageBreak()]
    st += page_title('METHOD SOURCES', '方法来源与适用边界', '外部方法用于完善流程；实际交易以纳米 Work 的产品能力、当期政策和书面合同为准。')
    st += [source_list(MARKET_SOURCES + [
        ('ProductLed PQL', 'https://productled.com/blog/product-qualified-leads'),
        ('Huthwaite SPIN', 'https://www.huthwaiteinternational.com/spin-sales-conversations-that-create-value'),
        ('MEDDPICC', 'https://meddicc.com/meddpicc-sales-methodology-and-process'),
        ('Salesforce ABM', 'https://www.salesforce.com/marketing/account-based-marketing-guide/'),
    ])]
    return st


def qa_next_action(category: str) -> str:
    mapping = {
        '认识产品': '打开一位对应数字员工，用本店问题演示',
        '功能与场景': '让客户选一个 7 天内会再发生的场景',
        '内容与获客': '收一组有授权的门头/菜品素材，现场做一次',
        '结果与使用': '打开任务中心，展示正文、附件和反馈',
        '准确性与失败处理': '明确真实资料、待核实项和失败后的任务处理',
        '账号、权限与安全': '画出老板、管理层、店长、员工的权限表',
        '体验与销售流程': '发体验码并约定完成和回访时间',
        '价格、用量与合同': '对齐年费、用量、席位、服务和合同边界',
        '上线与服务': '定输入人、验收人、两个首周场景和首训时间',
        '效果与长期价值': '建现状基线，约 D7/D30 价值复盘',
    }
    for k, v in mapping.items():
        if k in category:
            return v
    return '用真实页面或任务结果回答，并确认下一步'


def doc06_story():
    old = _load_module('old_sales_kit', ROOT / 'tmp/pdfs/build_sales_kit.py')
    cats = old.QA_CATEGORIES
    total = sum(len(qas) for _, qas in cats)
    assert total == 100, total
    st = cover('06', '销售答客 100 问｜内部速查',
               '先答客户真正问的那一题，再用一个真实证据推动下一步。',
               '一线销售、代理商、客户成功、销售主管', '内部销售使用')
    st += [PageBreak(), *toolkit_map('06'), PageBreak()]
    st += page_title('01 / HOW TO USE', '这不是背诵题库，是对话索引',
                     '客户问什么就答什么；答完就打开证据、做动作、约时间。')
    st += [bento([
        ('1｜听完', '不要客户说一半就开始讲功能。'),
        ('2｜复述', '“您更担心的是 ___，对吗？”'),
        ('3｜短答', '先给 20–40 秒结论，不做长讲座。'),
        ('4｜举证', '打开当前产品、真实交付、任务记录或书面政策。'),
        ('5｜推进', '每题后都有一个建议动作，不停在“我解释完了”。'),
        ('6｜升级', '价格、折扣、定制、安全和渠道政策无书面时不承诺。'),
    ], accent=BLUE), PageBreak()]

    st += page_title('02 / INDEX', '按客户购买阶段找问题', '客户在不同阶段问同一句话，背后意图可能不同。')
    start = 1
    idx_rows = []
    for cat, qas in cats:
        stage = '理解产品'
        if '价格' in cat or '合同' in cat:
            stage = '商务决策'
        elif '上线' in cat or '效果' in cat:
            stage = '采用与续费'
        elif '体验' in cat or '功能' in cat or '内容' in cat or '结果' in cat:
            stage = '体验与价值判断'
        elif '准确' in cat or '安全' in cat:
            stage = '信任与风险'
        idx_rows.append((cat, f'{start}–{start + len(qas) - 1}', stage, qa_next_action(cat)))
        start += len(qas)
    st += [rich_table(['类别', '题号', '常见阶段', '回答后的动作'], idx_rows, [45 * mm, 22 * mm, 46 * mm, CW - 113 * mm], font=7.2), PageBreak()]

    qn = 1
    for ci, (cat, qas) in enumerate(cats, 1):
        range_start = qn
        range_end = qn + len(qas) - 1
        st += page_title(f'{ci:02d} / QUESTIONS {range_start}–{range_end}', cat, '涉及功能、价格、用量、供应商和政策时，以当天线上产品和书面版本为准。')
        rows = []
        action = qa_next_action(cat)
        for q, a in qas:
            if '73 位' in q:
                q = '这么多数字员工都是真人吗？'
                a = '不是。它代表多类岗位能力覆盖，不等于同数量真人编制；具体岗位以线上目录为准。'
            rows.append((str(qn), q, a, action))
            qn += 1
        midpoint = (len(rows) + 1) // 2
        first_rows, second_rows = rows[:midpoint], rows[midpoint:]
        st += [rich_table(['#', '餐饮老板会问', '销售统一回答', '现在就做'], first_rows,
                          [11 * mm, 50 * mm, 76 * mm, CW - 137 * mm], font=7.5), PageBreak()]
        st += page_title(f'{ci:02d} / CONTINUED', f'{cat}｜续', f'问题 {range_start + midpoint}–{range_end}；先短答，再打开真实证据推进下一步。')
        st += [rich_table(['#', '餐饮老板会问', '销售统一回答', '现在就做'], second_rows,
                          [11 * mm, 50 * mm, 76 * mm, CW - 137 * mm], font=7.5), PageBreak()]
    assert qn == 101

    st += page_title('TOP 20', '最常用的 20 个入口', '不是频率排名，是建议一线先熟练的问题类型。')
    top = [
        ('这和 ChatGPT 有什么区别？', '岗位、任务、权限、历史、交付和服务的工作台'),
        ('我会用 AI，为什么还要买？', '团队持续使用和经营任务闭环'),
        ('能不能保证营业额？', '不保证经营结果，用真实交付证明可见价值'),
        ('单店用得上吗？', '从每周内容、巡店或活动中一个场景开始'),
        ('有 ERP 了还要吗？', '业务系统管交易数据，纳米 Work 管任务和交付'),
        ('不会提示词怎么办？', '说清门店、问题、资料、交付和禁止编造'),
        ('结果会不会乱编？', '真实资料+来源+假设+待核实+人工验收'),
        ('失败会扣钱吗？', '最终无可交付成果时按当期规则处理平台积分'),
        ('数据安全吗？', '最小必要、权限、脱敏、供应商和协议边界'),
        ('能生图和视频吗？', '在正式产品对应流程中按当前模型与配置生成'),
        ('结果在哪里？', '任务中心统一回看输入、状态、结果、附件和反馈'),
        ('可以下载吗？', '支持的任务按页面提供 PDF/Word/Excel/图片/视频/打包'),
        ('体验包含什么？', '当前固定五项场景，次数由测试员生成码时设置'),
        ('价格是多少？', '当前标准年度服务价 9,800 元/年，以合同为准'),
        ('9,800 包所有调用吗？', '年度服务和模型/API 用量分开说明'),
        ('有几个账号？', '标准为 1 主账号+4 副账号，新增席位申请付费'),
        ('签约后谁教？', '专属服务群、开通、基础培训和首批场景陪跑'),
        ('多久能看到效果？', '首周看交付效率，经营效果需持续执行与观察'),
        ('怎么避免买了不用？', '签约时定两个固定场景、输入人、验收人和频次'),
        ('现在下一步做什么？', '用一个真实问题做一次交付，做完客户再判断'),
    ]
    st += [rich_table(['客户常问', '统一回答核心'], top, [65 * mm, CW - 65 * mm], font=7.1), PageBreak()]
    st += page_title('POLICY MATRIX', '易变政策一页记清', '以下内容涉及时间版本，销售对外前要核对当天页面、公告或书面合同。')
    st += [rich_table(['政策项', '当前已知口径', '需二次确认的内容'], [
        ('年度服务', '9,800 元/年', '签约主体、发票、服务范围'),
        ('现场活动', '支付 1,000 元，成交款按 2,000 元抵扣', '有效期、适用对象、是否可叠加'),
        ('账号', '1 主+4 副', '新增席位当期价格'),
        ('模型/API 用量', '与年度服务分开', '供应商、模型、计费、客户 Key/平台余额'),
        ('失败任务', '最终无可交付成果时按当期规则处理平台积分', '任务终态、部分成果、退回时点'),
        ('体验', '固定五项场景，次数可由测试员配置', '当前 H5 功能、次数、使用 Key 和审核状态'),
        ('渠道政策', '以当期正式文件为准', '返点、报备、撞单、独家、区域和期限'),
    ], [39 * mm, 79 * mm, CW - 118 * mm], font=7.0), Spacer(1, 4 * mm),
           card('不确定时的标准回答', '“这一项会随版本/政策变化，我不现场编答案。我把您的具体需求、数量和时间记下，在 ___ 点前给您书面确认。”', accent=ORANGE, fill=ORANGE_L)]
    return st


def main():
    outputs = [
        ('01_信任背书承诺边界与销售政策.pdf', '信任背书、承诺边界与销售政策', '01', doc01_story(), '内部销售使用'),
        ('02_产品使用与价值手册_客户版.pdf', '产品使用与价值手册', '02', doc02_story(), '客户可分享版'),
        ('03_五路获客与宣传推广手册.pdf', '五路获客与宣传推广手册', '03', doc03_story(), '内部销售使用'),
        ('04_高频异议与代理商客户对话手册.pdf', '高频异议与代理商客户对话手册', '04', doc04_story(), '内部销售使用'),
        ('05_销售方法论与成交作战手册.pdf', '销售方法论与成交作战手册', '05', doc05_story(), '内部销售使用'),
        ('06_销售答客100问_内部速查.pdf', '销售答客 100 问', '06', doc06_story(), '内部销售使用'),
    ]
    for name, title, no, story, conf in outputs:
        path = OUT / name
        build(path, title, no, story, confidentiality=conf)
        shutil.copy2(path, DESKTOP / name)
        print(path)


if __name__ == '__main__':
    main()
