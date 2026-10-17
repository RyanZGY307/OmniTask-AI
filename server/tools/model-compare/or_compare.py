import json, csv, collections

d = json.load(open('or_models.json'))['data']

def per1m(v):
    try:
        return round(float(v) * 1_000_000, 4)
    except Exception:
        return None

def vendor(mid):
    return mid.split('/')[0].lstrip('~') if '/' in mid else mid

# 仅收录官网有公开标价、且可核实的经典模型 (USD / 1M tokens)
OFF = {
    "openai/gpt-4o": (2.5, 10.0), "openai/gpt-4o-2024-05-13": (5.0, 15.0),
    "openai/gpt-4o-2024-08-06": (2.5, 10.0), "openai/gpt-4o-2024-11-20": (2.5, 10.0),
    "openai/gpt-4o:batch": (1.25, 5.0),
    "openai/gpt-4o-mini": (0.15, 0.60), "openai/gpt-4o-mini-2024-07-18": (0.15, 0.60),
    "openai/gpt-4o-mini:batch": (0.075, 0.30),
    "openai/gpt-4.1": (2.0, 8.0), "openai/gpt-4.1:batch": (1.0, 4.0),
    "openai/gpt-4.1-mini": (0.40, 1.60), "openai/gpt-4.1-mini:batch": (0.20, 0.80),
    "openai/gpt-4.1-nano": (0.10, 0.40), "openai/gpt-4.1-nano:batch": (0.05, 0.20),
    "openai/gpt-4": (30, 60), "openai/gpt-4-turbo": (10, 30), "openai/gpt-4-turbo:batch": (5, 15),
    "openai/gpt-3.5-turbo": (0.50, 1.50), "openai/gpt-3.5-turbo:batch": (0.25, 0.75),
    "openai/gpt-3.5-turbo-0613": (1.5, 2.0), "openai/gpt-3.5-turbo-16k": (3.0, 4.0),
    "openai/o1": (15, 60), "openai/o1-pro": (150, 600),
    "openai/o3": (2.0, 8.0), "openai/o3:batch": (1.0, 4.0),
    "openai/o4-mini": (1.1, 4.4), "openai/o4-mini:batch": (0.55, 2.2),
    "openai/o3-mini": (1.1, 4.4), "openai/o3-mini:batch": (0.55, 2.2), "openai/o3-mini-high": (1.1, 4.4),
    "anthropic/claude-sonnet-4": (3.0, 15.0),
    "anthropic/claude-sonnet-4.5": (3.0, 15.0), "anthropic/claude-sonnet-4.5:batch": (1.5, 7.5),
    "anthropic/claude-opus-4.1": (15.0, 75.0), "anthropic/claude-opus-4.1:batch": (7.5, 37.5),
    "anthropic/claude-opus-4.5": (5.0, 25.0), "anthropic/claude-opus-4.5:batch": (2.5, 12.5),
    "anthropic/claude-haiku-4.5": (1.0, 5.0), "anthropic/claude-haiku-4.5:batch": (0.5, 2.5),
    "google/gemini-2.5-flash": (0.30, 2.50), "google/gemini-2.5-flash:batch": (0.15, 1.25),
    "google/gemini-2.5-pro": (1.25, 10.00), "google/gemini-2.5-pro:batch": (0.625, 5.0),
    "google/gemini-2.5-flash-lite": (0.10, 0.40), "google/gemini-2.5-flash-lite:batch": (0.05, 0.20),
    "mistralai/mixtral-8x22b-instruct": (2.0, 6.0),
    "mistralai/mistral-nemo": (0.019, 0.03),
    "deepseek/deepseek-chat": (0.28, 1.10),
    "deepseek/deepseek-r1": (0.55, 2.19),
    # --- 联网核实(官网文档/发布公告,2026) ---
    "openai/gpt-6.1-sol": (2.0, 10.0), "openai/gpt-6.1-sol:batch": (1.0, 5.0),
    "anthropic/claude-sonnet-5.5": (2.0, 10.0), "anthropic/claude-sonnet-5.5:batch": (1.0, 5.0),
    "anthropic/claude-opus-5.5": (4.0, 20.0), "anthropic/claude-opus-5.5:batch": (2.0, 10.0),
    "google/gemini-3.8-flash": (0.75, 3.75), "google/gemini-3.8-flash:batch": (0.375, 1.875),
    "x-ai/grok-4.7": (2.0, 6.0), "x-ai/grok-4.6": (2.0, 6.0), "x-ai/grok-4.5": (2.0, 6.0),
}
# gemini-3.8-flash 官网为推广价($0.75/$3.75, 至2026/12/31), 2027/1 起 $1.50/$7.50
PROMO = {"google/gemini-3.8-flash", "google/gemini-3.8-flash:batch"}
# 深seek 价格来自官网人民币价折算 USD,属近似值
APPROX = {"deepseek/deepseek-chat", "deepseek/deepseek-r1"}

rows = []
for m in d:
    p = m.get('pricing', {})
    p1m = per1m(p.get('prompt', '0'))
    c1m = per1m(p.get('completion', '0'))
    mid = m['id']
    off = OFF.get(mid)
    if off:
        op, oc = off
        dp = round(p1m - off[0], 4) if p1m is not None else None
        dc = round(c1m - off[1], 4) if c1m is not None else None
        if dp == 0 and dc == 0:
            status = '一致'
        elif (dp or 0) > 0 or (dc or 0) > 0:
            status = 'OR更贵'
        else:
            status = 'OR更便宜'
        src = '官网标价(人民币折算,近似)' if mid in APPROX else '官网标价(联网核实)'
        if mid in APPROX:
            status = status + '(近似)'
        if mid in PROMO:
            status = status + '(推广价)'
    else:
        op = oc = dp = dc = None
        status = '未核实'
        src = '-'
    rows.append(dict(model=mid, vendor=vendor(mid), name=m.get('name', ''),
                     or_in=p1m, or_out=c1m, off_in=op, off_out=oc,
                     in_delta=dp, out_delta=dc, status=status, src=src))

with open('openrouter_vs_official.csv', 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=['model', 'vendor', 'name', 'or_in', 'or_out',
                                      'off_in', 'off_out', 'in_delta', 'out_delta', 'status', 'src'])
    w.writeheader()
    w.writerows(rows)

sc = collections.Counter(r['status'] for r in rows)
print('total=', len(rows))
print('status:', dict(sc))
print('\n-- 已核实模型明细 (OR in/out vs 官方 in/out, $/1M) --')
for r in rows:
    if r['status'] != '未核实':
        print(f"{r['model'][:42]:42s} OR {r['or_in']}/{r['or_out']}  OFF {r['off_in']}/{r['off_out']}  "
              f"dIn={r['in_delta']} dOut={r['out_delta']}  [{r['status']}]")
