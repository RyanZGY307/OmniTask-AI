import csv, json, collections

rows = list(csv.DictReader(open('family_compare.csv')))
for r in rows:
    for k in ('or_in','or_out','off_in','off_out'):
        r[k] = None if r[k] in ('',) else r[k]
    r['cur'] = r.get('cur','USD')

fams = ['OpenAI GPT','Google Gemini','DeepSeek','智谱 GLM','Kimi Moonshot','Claude Anthropic','小米 MiMo']
data = collections.defaultdict(list)
for r in rows:
    data[r['family']].append(r)

def esc(s):
    return (s or '').replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')
def num(v):
    return '—' if v in (None,'') else v
def dlt(v,o,cur):
    if v in (None,'') or o in (None,''):
        return '<span class="mut">—</span>'
    d = round(float(v)-float(o),4)
    cls = 'hi' if d>0 else ('lo' if d<0 else 'ok')
    sym = {'USD':'$','CNY':'¥'}[cur]
    if d==0: return f'<span class="ok">0</span>'
    return f'<span class="{cls}">{sym}{d:+g}</span>'

def stcls(s):
    if s=='一致': return 't-ok'
    if s.startswith('OR更贵'): return 't-hi'
    if s.startswith('OR更便宜'): return 't-lo'
    if s.startswith('币种'): return 't-cn'
    if s.startswith('特殊'): return 't-sp'
    return 't-un'

body = []
for fam in fams:
    rs = data.get(fam, [])
    cnt = collections.Counter(r['status'] for r in rs)
    chips = ' '.join(f'<span class="pill">{esc(k)} <b>{v}</b></span>' for k,v in cnt.items())
    trs = []
    for r in rs:
        trs.append(f"""<tr>
<td class="mono">{esc(r['model'])}</td>
<td class="num">{num(r['or_in'])}</td><td class="num">{num(r['or_out'])}</td>
<td class="num">{num(r['off_in'])}</td><td class="num">{num(r['off_out'])}</td>
<td class="num">{r['cur']}</td>
<td class="num">{dlt(r['or_in'],r['off_in'],r['cur'])}</td>
<td><span class="tag {stcls(r['status'])}">{esc(r['status'])}</span></td>
<td class="note">{esc(r['note'])}</td>
</tr>""")
    body.append(f"""<section>
<h2>{esc(fam)} <span class="cnt">{len(rs)} 项 · {chips}</span></h2>
<p class="src">官方来源: {esc(rs[0]['source']) if rs else '—'} · 单位 每百万 tokens</p>
<table><thead><tr>
<th>模型</th><th class="num">OR 入</th><th class="num">OR 出</th>
<th class="num">官方 入</th><th class="num">官方 出</th><th>币种</th>
<th class="num">Δ入</th><th>状态</th><th>说明</th>
</tr></thead><tbody>{''.join(trs)}</tbody></table>
</section>""")

html = f"""<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>七大模型系 · OpenRouter vs 官方价格</title>
<style>
:root{{--bg:#0f1115;--card:#171a21;--bd:#2a2f3a;--tx:#e6e9ef;--mut:#8a93a3;--ok:#3fb950;--hi:#f85149;--lo:#58a6ff;--cn:#d29922;--sp:#bc8cff;--un:#6e7683}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--tx);font:14px/1.55 -apple-system,Segoe UI,Roboto,Arial}}
header{{position:sticky;top:0;background:var(--card);border-bottom:1px solid var(--bd);padding:14px 18px;z-index:5}}
h1{{margin:0 0 6px;font-size:16px}}.meta{{color:var(--mut);font-size:12px}}
main{{padding:14px 18px;max-width:1100px}}
section{{margin-bottom:26px}}h2{{font-size:15px;margin:0 0 4px}}
.cnt{{color:var(--mut);font-size:12px;font-weight:400;margin-left:8px}}
.pill{{display:inline-block;margin-left:6px;background:var(--bg);border:1px solid var(--bd);border-radius:12px;padding:1px 8px;font-size:11px;color:var(--mut)}}
.pill b{{color:var(--tx);font-weight:700}}.src{{color:var(--mut);font-size:11px;margin:0 0 8px}}
table{{border-collapse:collapse;width:100%;font-size:12.5px}}
th,td{{padding:6px 9px;text-align:left;border-bottom:1px solid var(--bd);vertical-align:top}}
th{{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.3px}}
td.num,th.num{{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}}
.mono{{font-family:ui-monospace,monospace}}tr:hover td{{background:#1c212b}}
.tag{{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:600;white-space:nowrap}}
.t-ok{{background:rgba(63,185,80,.15);color:var(--ok)}}.t-hi{{background:rgba(248,81,73,.15);color:var(--hi)}}
.t-lo{{background:rgba(88,166,255,.15);color:var(--lo)}}.t-cn{{background:rgba(210,153,34,.15);color:var(--cn)}}
.t-sp{{background:rgba(188,140,255,.15);color:var(--sp)}}.t-un{{background:rgba(110,118,131,.15);color:var(--un)}}
.note{{color:var(--mut);font-size:11.5px;max-width:320px}}
.ok{{color:var(--ok)}}.hi{{color:var(--hi)}}.lo{{color:var(--lo)}}.mut{{color:var(--un)}}
.legend{{margin:6px 0 18px;color:var(--mut);font-size:12px}}
</style></head><body>
<header><h1>七大模型系 · OpenRouter 价格 vs 官方价格</h1>
<div class="meta">单位:USD 或 CNY / 百万 tokens(输入 / 输出)。OpenRouter 价来自官方 API 实时;官方价经联网核实(各厂官网/发布公告,2026)。</div></header>
<main>
<div class="legend">状态图例:<span class="tag t-ok">一致</span> = OR 与官网相同 · <span class="tag t-lo">OR更便宜</span> · <span class="tag t-hi">OR更贵</span> · <span class="tag t-cn">币种/阶梯不同</span>(官方人民币阶梯价 vs OR 美元全球价)· <span class="tag t-sp">特殊计费</span>(图像按图计费)· <span class="tag t-un">官方未单列</span>(该变体官网无公开价,未做对比)</div>
{"".join(body)}
</main></body></html>"""

open('family_compare.html','w').write(html)
print('HTML bytes=', len(html), 'rows=', len(rows))
