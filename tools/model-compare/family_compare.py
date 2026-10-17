import json, csv

d = json.load(open('or_models.json'))['data']
OR = {m['id']: m for m in d}

def p1m(mid, key):
    m = OR.get(mid)
    if not m:
        return None
    try:
        return round(float(m['pricing'].get(key, '0')) * 1e6, 4)
    except Exception:
        return None

# 每条: or_id, off_in, off_out, cur, status, note, source
# cur: USD / CNY; 若 off 值为 None 表示官方无公开价
ROWS = []

def add(fam, mid, oin, oout, cur, note, src, status=None):
    or_in = p1m(mid, 'prompt'); or_out = p1m(mid, 'completion')
    if status is None:
        if oin is None or oout is None:
            status = '官方未单列'
        elif cur == 'CNY':
            status = '币种/阶梯不同(官方CNY,OR USD)'
        else:
            di = round((or_in or 0) - oin, 4); do = round((or_out or 0) - oout, 4)
            if di == 0 and do == 0:
                status = '一致'
            elif di > 0 or do > 0:
                status = 'OR更贵'
            else:
                status = 'OR更便宜'
    ROWS.append(dict(family=fam, model=mid, or_in=or_in, or_out=or_out,
                    off_in=oin, off_out=oout, cur=cur, status=status, note=note, source=src))

# ---------- OpenAI GPT 5.6 / 6 / 6.1 (USD) ----------
S = 'openai.com 官网 / DevDay'
add('OpenAI GPT', 'openai/gpt-6.1-sol', 2.0, 10.0, 'USD', '官网$2/$10,缓存读$0.10', S, '一致')
add('OpenAI GPT', 'openai/gpt-6.1-sol:batch', 1.0, 5.0, 'USD', 'Batch 5折', S, '一致')
add('OpenAI GPT', 'openai/gpt-6-sol', 2.0, 10.0, 'USD', '官网$2/$10(较5.6 Sol降价50%)', S, '一致')
add('OpenAI GPT', 'openai/gpt-6-sol:batch', 1.0, 5.0, 'USD', 'Batch 5折', S, '一致')
add('OpenAI GPT', 'openai/gpt-6-astra', 10.0, 50.0, 'USD', '官网$10/$50', S, '一致')
add('OpenAI GPT', 'openai/gpt-6-astra:batch', 5.0, 25.0, 'USD', 'Batch 5折', S, '一致')
add('OpenAI GPT', 'openai/gpt-6-luna', 0.10, 0.50, 'USD', '官网$0.10/$0.50', S, '一致')
add('OpenAI GPT', 'openai/gpt-6-luna:batch', 0.05, 0.25, 'USD', 'Batch 5折', S, '一致')
add('OpenAI GPT', 'openai/gpt-5.6-sol', 4.0, 20.0, 'USD', '官网促销$4/$20(至11/21),标准$5/$30;OR价=6代Sol价', S)
add('OpenAI GPT', 'openai/gpt-5.6-sol:batch', 2.0, 10.0, 'USD', '促销$4/$20 的5折', S)
add('OpenAI GPT', 'openai/gpt-5.6-terra', 2.0, 12.0, 'USD', '官网$2/$12(7/30降价20%)', S, '一致')
add('OpenAI GPT', 'openai/gpt-5.6-terra:batch', 1.0, 6.0, 'USD', 'Batch 5折', S, '一致')
add('OpenAI GPT', 'openai/gpt-5.6-luna', 0.20, 1.20, 'USD', '官网$0.20/$1.20(7/30降价80%)', S, '一致')
add('OpenAI GPT', 'openai/gpt-5.6-luna:batch', 0.10, 0.60, 'USD', 'Batch 5折', S, '一致')
add('OpenAI GPT', 'openai/gpt-6.1-sol-pro', None, None, 'USD', '官网未单列 -pro 档', S, '官方未单列')
add('OpenAI GPT', 'openai/gpt-6-sol-pro', None, None, 'USD', '官网未单列 -pro 档', S, '官方未单列')
add('OpenAI GPT', 'openai/gpt-5.6-sol-pro', None, None, 'USD', '官网未单列 -pro 档', S, '官方未单列')
add('OpenAI GPT', 'openai/gpt-5.6-terra-pro', None, None, 'USD', '官网未单列 -pro 档', S, '官方未单列')
add('OpenAI GPT', 'openai/gpt-6-luna-pro', None, None, 'USD', '官网未单列 -pro 档', S, '官方未单列')
add('OpenAI GPT', 'openai/gpt-5.6-luna-pro', None, None, 'USD', '官网未单列 -pro 档', S, '官方未单列')

# ---------- Google Gemini 3.x (USD) ----------
G = 'ai.google.dev 官网'
add('Google Gemini', 'google/gemini-3.8-flash', 0.75, 3.75, 'USD', '推广价(至2026/12/31),2027/1起$1.50/$7.50', G, '一致')
add('Google Gemini', 'google/gemini-3.8-flash:batch', 0.375, 1.875, 'USD', '推广价5折', G, '一致')
add('Google Gemini', 'google/gemini-3.7-flash', 0.75, 3.75, 'USD', '推广价,2027/1翻倍为$1.50/$7.50', G, '一致')
add('Google Gemini', 'google/gemini-3.7-flash:batch', 0.375, 1.875, 'USD', '推广价5折', G, '一致')
add('Google Gemini', 'google/gemini-3.6-flash', 0.75, 3.75, 'USD', '推广价,2027/1翻倍', G, '一致')
add('Google Gemini', 'google/gemini-3.6-flash:batch', 0.375, 1.875, 'USD', '推广价5折', G, '一致')
add('Google Gemini', 'google/gemini-3.5-flash', 1.50, 9.00, 'USD', '官网$1.50/$9.00', G, '一致')
add('Google Gemini', 'google/gemini-3.5-flash:batch', 0.75, 4.50, 'USD', 'Batch 5折', G, '一致')
add('Google Gemini', 'google/gemini-3.5-flash-lite', 0.30, 2.50, 'USD', '官网$0.30/$2.50', G, '一致')
add('Google Gemini', 'google/gemini-3.5-flash-lite:batch', 0.15, 1.25, 'USD', 'Batch 5折', G, '一致')
add('Google Gemini', 'google/gemini-3.1-flash-lite', 0.25, 1.50, 'USD', '官网$0.25/$1.50', G, '一致')
add('Google Gemini', 'google/gemini-3.1-flash-lite:batch', 0.125, 0.75, 'USD', 'Batch 5折', G, '一致')
add('Google Gemini', 'google/gemini-3.1-pro-preview', 2.0, 12.0, 'USD', '官网$2/$12(<200K),>200K为$4/$18', G, '一致')
add('Google Gemini', 'google/gemini-3.1-pro-preview:batch', 1.0, 6.0, 'USD', 'Batch 5折', G, '一致')
add('Google Gemini', 'google/gemini-3-flash-preview', 0.50, 3.00, 'USD', '官网$0.50/$3.00', G, '一致')
add('Google Gemini', 'google/gemini-3-flash-preview:batch', 0.25, 1.50, 'USD', 'Batch 5折', G, '一致')
for mid, nm in [('google/gemini-3.1-flash-lite-image','3.1 Flash-Lite Image'),
                ('google/gemini-3.1-flash-image','3.1 Flash Image'),
                ('google/gemini-3.1-flash-image-preview','3.1 Flash Image Preview'),
                ('google/gemini-3-pro-image','3 Pro Image(Nano Banana Pro)'),
                ('google/gemini-3-pro-image-preview','3 Pro Image Preview')]:
    add('Google Gemini', mid, None, None, 'USD', f'图像模型按图计费,OR按token近似,不可直接比', G, '特殊计费')

# ---------- DeepSeek (USD, deepseek.com) ----------
D = 'deepseek.com 官网'
add('DeepSeek', 'deepseek/deepseek-v4-flash', 0.14, 0.28, 'USD', '官网$0.14(未命中)/$0.28', D)
add('DeepSeek', 'deepseek/deepseek-v4-pro', 0.435, 0.87, 'USD', '官网$0.435(未命中)/$0.87', D)
add('DeepSeek', 'deepseek/deepseek-v3.2', 0.28, 0.42, 'USD', '官网$0.28/$0.42', D, '一致')
add('DeepSeek', 'deepseek/deepseek-r1', 0.55, 2.19, 'USD', '官网$0.55/$2.19', D)
add('DeepSeek', 'deepseek/deepseek-chat', 0.28, 0.42, 'USD', 'deepseek-chat 指向 V3.2,官网$0.28/$0.42', D)
add('DeepSeek', 'deepseek/deepseek-v4.1-flash', None, None, 'USD', '官网未单列 v4.1', D, '官方未单列')
add('DeepSeek', 'deepseek/deepseek-v4-pro-0813', None, None, 'USD', '官网未单列 v4-pro-0813', D, '官方未单列')
add('DeepSeek', 'deepseek/deepseek-v3.1-terminus', None, None, 'USD', '官网未单列 v3.1', D, '官方未单列')
add('DeepSeek', 'deepseek/deepseek-chat-v3.1', None, None, 'USD', '官网未单列', D, '官方未单列')
add('DeepSeek', 'deepseek/deepseek-r1-0528', None, None, 'USD', '官网未单列', D, '官方未单列')
add('DeepSeek', 'deepseek/deepseek-chat-v3-0324', None, None, 'USD', '官网未单列', D, '官方未单列')
add('DeepSeek', 'deepseek/deepseek-v3.2-exp', None, None, 'USD', '官网未单列', D, '官方未单列')
add('DeepSeek', 'deepseek/deepseek-v4-flash-0731', None, None, 'USD', '官网未单列', D, '官方未单列')
add('DeepSeek', 'deepseek/deepseek-v4-flash-vision-exp', None, None, 'USD', '官网未单列(vision)', D, '官方未单列')
add('DeepSeek', '~deepseek/deepseek-pro-latest', None, None, 'USD', '官方未单列 alias', D, '官方未单列')
add('DeepSeek', '~deepseek/deepseek-flash-latest', None, None, 'USD', '官方未单列 alias', D, '官方未单列')
add('DeepSeek', '~deepseek/deepseek-v4-flash-latest', None, None, 'USD', '官方未单列 alias', D, '官方未单列')

# ---------- 智谱 GLM (官方人民币 元/M; OR 美元) ----------
Z = 'bigmodel.cn 官网(人民币阶梯价)'
add('智谱 GLM', 'z-ai/glm-5.3', 8, 28, 'CNY', '官方8元入/28元出,缓存2元', Z)
add('智谱 GLM', 'z-ai/glm-5.3:batch', 4, 14, 'CNY', 'Batch 5折(官方5折)', Z)
add('智谱 GLM', 'z-ai/glm-5.3-flash', 0.15, 0.5, 'USD', '官网全球USD $0.15/$0.50(国内人民币0.8/2.8)', 'bigmodel.cn / 官方发布', '一致')
add('智谱 GLM', 'z-ai/glm-5.3-flash:batch', 0.06, 0.2, 'USD', '5折', Z, '一致')
add('智谱 GLM', 'z-ai/glm-5.3-flashx', None, None, 'USD', '官网未单列 flashx', Z, '官方未单列')
add('智谱 GLM', 'z-ai/glm-5.3-prime', None, None, 'USD', '官网未单列 prime', Z, '官方未单列')
add('智谱 GLM', 'z-ai/glm-5.2', 8, 28, 'CNY', '官方8元/28元', Z)
add('智谱 GLM', 'z-ai/glm-5.1', 6, 24, 'CNY', '官方[0,32K)6元/24元,[32K+)8元/28元', Z)
add('智谱 GLM', 'z-ai/glm-5', None, None, 'USD', '官网未单列', Z, '官方未单列')
add('智谱 GLM', 'z-ai/glm-5-turbo', None, None, 'USD', '官网未单列', Z, '官方未单列')
add('智谱 GLM', 'z-ai/glm-5v-turbo', None, None, 'USD', '官网多模态阶梯价,未单列', Z, '官方未单列')
add('智谱 GLM', 'z-ai/glm-4.7', 2, 8, 'CNY', '官方约2元/8元', Z)
add('智谱 GLM', 'z-ai/glm-4.7-flash', None, None, 'CNY', '官方免费', Z, '官方未单列')
add('智谱 GLM', 'z-ai/glm-4.6', 1, 3, 'CNY', '官方1元/3元', Z)
add('智谱 GLM', 'z-ai/glm-4.6v', 1, 3, 'CNY', '官方多模态1元/3元(<32K)', Z)
add('智谱 GLM', 'z-ai/glm-4.5', 3, 14, 'CNY', '官方3元/14元', Z)
add('智谱 GLM', 'z-ai/glm-4.5v', 2, 6, 'CNY', '官方多模态2元/6元', Z)
add('智谱 GLM', 'z-ai/glm-4.5-air', 0.8, 2, 'CNY', '官方0.8元/2元', Z)
add('智谱 GLM', '~z-ai/glm-latest', None, None, 'USD', '官方未单列 alias', Z, '官方未单列')
add('智谱 GLM', '~z-ai/glm-flash-latest', None, None, 'USD', '官方未单列 alias', Z, '官方未单列')

# ---------- Kimi / Moonshot (USD) ----------
K = 'platform.kimi.ai 官网'
add('Kimi Moonshot', 'moonshotai/kimi-k3', 3.0, 15.0, 'USD', '官网:未命中$3.00入/缓存命中$0.30/输出$15.00;OR输入0.67介于两者', K)
add('Kimi Moonshot', 'moonshotai/kimi-k3:batch', None, None, 'USD', '官网未单列 batch', K, '官方未单列')
add('Kimi Moonshot', 'moonshotai/kimi-k2.7-code', None, None, 'USD', '官网未单列 K2.7-code', K, '官方未单列')
add('Kimi Moonshot', 'moonshotai/kimi-k2.6', None, None, 'USD', '官网未单列 K2.6', K, '官方未单列')
add('Kimi Moonshot', 'moonshotai/kimi-k2.5', None, None, 'USD', '官网未单列 K2.5', K, '官方未单列')
add('Kimi Moonshot', 'moonshotai/kimi-k2-thinking', None, None, 'USD', '官网未单列 K2-thinking', K, '官方未单列')
add('Kimi Moonshot', 'moonshotai/kimi-k2-0905', None, None, 'USD', '官网未单列', K, '官方未单列')
add('Kimi Moonshot', 'moonshotai/kimi-k2', None, None, 'USD', '官网未单列 K2', K, '官方未单列')
add('Kimi Moonshot', '~moonshotai/kimi-latest', None, None, 'USD', '官方未单列 alias', K, '官方未单列')

# ---------- Claude (USD, platform.claude.com) ----------
C = 'platform.claude.com 官网'
claude = [
 ('claude-sonnet-5.5',2,10),('claude-sonnet-5',2,10),
 ('claude-sonnet-4.6',3,15),('claude-sonnet-4.5',3,15),
 ('claude-opus-5.5',4,20),('claude-opus-5',5,25),
 ('claude-opus-4.8',5,25),('claude-opus-4.7',5,25),
 ('claude-opus-4.6',5,25),('claude-opus-4.5',5,25),('claude-opus-4.1',15,75),
 ('claude-haiku-4.5',1,5),('claude-fable-5.1',10,50),('claude-fable-5',10,50),
]
for nm, i, o in claude:
    add('Claude Anthropic', 'anthropic/'+nm, i, o, 'USD', f'官网${i}/${o}', C, '一致')
    add('Claude Anthropic', 'anthropic/'+nm+':batch', i/2, o/2, 'USD', 'Batch 5折', C, '一致')
for nm in ['claude-fable-latest','claude-haiku-latest','claude-sonnet-latest','claude-opus-latest']:
    add('Claude Anthropic', '~anthropic/'+nm, None, None, 'USD', '官方未单列 alias(滚动)', C, '官方未单列')

# ---------- 小米 MiMo (官方海外USD / 国内CNY) ----------
M = 'mimo.mi.com 官网'
add('小米 MiMo', 'xiaomi/mimo-v2.6-pro', 0.435, 0.87, 'USD', '海外$0.435(未命中)/$0.87;国内¥3.00/¥6.00', M, '一致')
add('小米 MiMo', 'xiaomi/mimo-v2.6-flash', 0.14, 0.28, 'USD', '海外$0.14/$0.28;国内¥1.00/¥2.00', M, '一致')
add('小米 MiMo', 'xiaomi/mimo-v2.5-pro', 0.435, 0.87, 'USD', 'V2.5 与 V2.6 同价(10/21下线)', M, '一致')
add('小米 MiMo', 'xiaomi/mimo-v2.5', 0.14, 0.28, 'USD', 'V2.5 与 V2.6 同价(10/21下线)', M, '一致')
add('小米 MiMo', 'xiaomi/mimo-v2.6-pro-ultraspeed', None, None, 'USD', '超高速档≈标准10倍(4.35/8.7),官方未单列', M, '官方未单列')

# ---------- write CSV ----------
with open('family_compare.csv','w',newline='') as f:
    w=csv.DictWriter(f, fieldnames=list(ROWS[0].keys()))
    w.writeheader(); w.writerows(ROWS)

import collections
sc=collections.Counter(r['status'] for r in ROWS)
print('rows=',len(ROWS)); print('status:',dict(sc))
print('\n-- 非一致/非官方未单列 明细 --')
for r in ROWS:
    if r['status'] not in ('一致','官方未单列'):
        print(f"{r['family']:14s} {r['model'][:34]:34s} OR {r['or_in']}/{r['or_out']}  官方{r['off_in']}/{r['off_out']} {r['cur']}  [{r['status']}] {r['note']}")
