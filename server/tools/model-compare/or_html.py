import json, csv

rows = list(csv.DictReader(open('openrouter_vs_official.csv')))
data = json.dumps(rows, ensure_ascii=False)

html = """<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenRouter 全量模型价格 vs 官方价格对比</title>
<style>
:root{--bg:#0f1115;--card:#171a21;--bd:#2a2f3a;--tx:#e6e9ef;--mut:#8a93a3;--ok:#3fb950;--hi:#f85149;--lo:#58a6ff;--un:#6e7683;--ac:#7c8cff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial}
header{position:sticky;top:0;background:var(--card);border-bottom:1px solid var(--bd);padding:14px 20px;z-index:5}
h1{margin:0 0 4px;font-size:17px}
.meta{color:var(--mut);font-size:12px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.chip{background:var(--bg);border:1px solid var(--bd);border-radius:20px;padding:4px 12px;font-size:12px;cursor:pointer;user-select:none}
.chip.active{background:var(--ac);border-color:var(--ac);color:#fff}
.chip b{font-weight:700}
#search{width:100%;max-width:420px;margin-top:10px;padding:8px 12px;border:1px solid var(--bd);border-radius:8px;background:var(--bg);color:var(--tx)}
main{padding:16px 20px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{padding:7px 10px;text-align:left;border-bottom:1px solid var(--bd);white-space:nowrap}
th{position:sticky;top:0;background:var(--card);cursor:pointer;user-select:none;color:var(--mut)}
th:hover{color:var(--tx)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
tr:hover td{background:#1c212b}
.tag{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:600}
.t-ok{background:rgba(63,185,80,.15);color:var(--ok)}
.t-hi{background:rgba(248,81,73,.15);color:var(--hi)}
.t-lo{background:rgba(88,166,255,.15);color:var(--lo)}
.t-un{background:rgba(110,118,131,.15);color:var(--un)}
.note{color:var(--mut);font-size:12px;margin:14px 0;padding:12px;border:1px solid var(--bd);border-radius:8px;background:var(--card)}
.model{font-family:ui-monospace,monospace;color:var(--tx)}
.vend{color:var(--mut)}
.delta-hi{color:var(--hi)}.delta-lo{color:var(--lo)}
@media(max-width:720px){main{padding:10px}}
</style></head>
<body>
<header>
<h1>OpenRouter 全量模型价格 vs 官方价格对比</h1>
<div class="meta">共 <span id="tot"></span> 个模型 · OpenRouter 价格来自官方 API(实时) · 官方价:仅对官网有公开标价的经典模型核实,其余标注「未核实」(多为尚未发布官网价的最新/专属模型)</div>
<div class="chips" id="chips"></div>
<input id="search" placeholder="搜索模型名 / 厂商…">
</header>
<main>
<div class="note">
口径:价格单位均为 <b>USD / 1M tokens</b>(输入 / 输出)。OpenRouter 按供应商<b>官网标价</b>透传,对主力厂商(OpenAI / Anthropic / Google / Mistral 等)经核实 <b>完全一致,无加价无折扣</b>。DeepSeek 官方价以人民币计价,表中为折算近似值。标「未核实」的模型(多为 GPT-6 / Claude-5.5 / Gemini-3.x / Grok-4.x 等新一代或厂商私有模型)在本环境无公开官方价,未做对比,绝不编造。点击表头排序,点顶部筛选,输入框搜索。
</div>
<table id="tb"><thead><tr>
<th data-k="vendor">厂商</th><th data-k="model">模型</th>
<th class="num" data-k="or_in">OR 输入</th><th class="num" data-k="or_out">OR 输出</th>
<th class="num" data-k="off_in">官方 输入</th><th class="num" data-k="off_out">官方 输出</th>
<th class="num" data-k="in_delta">Δ输入</th><th class="num" data-k="out_delta">Δ输出</th>
<th data-k="status">状态</th>
</tr></thead><tbody id="tb"></tbody></table>
</main>
<script>
var DATA=__DATA__;
document.getElementById('tot').textContent=DATA.length;
var statuses=['全部','一致','OR更贵','OR更便宜','未核实'];
var curStatus='全部',curSearch='',sortK='status',sortDir=1;
function tagClass(s){if(s.indexOf('一致')==0)return 't-ok';if(s.indexOf('更贵')>0)return 't-hi';if(s.indexOf('更便宜')>0)return 't-lo';return 't-un';}
function buildChips(){
 var c=document.getElementById('chips');c.innerHTML='';
 statuses.forEach(function(s){
  var n=s==='全部'?DATA.length:DATA.filter(function(r){return s==='未核实'?r.status==='未核实':r.status.indexOf(s)>-1;}).length;
  var e=document.createElement('span');e.className='chip'+(curStatus===s?' active':'');
  e.innerHTML=s+' <b>'+n+'</b>';e.onclick=function(){curStatus=s;buildChips();render();};
  c.appendChild(e);
 });
}
function fmt(v){return (v===null||v===undefined||v==='')?'—':v;}
function dlt(v){if(v===null||v===undefined||v==='')return '<span class="vend">—</span>';
 var f=parseFloat(v);if(f>0)return '<span class="delta-hi">+'+f+'</span>';if(f<0)return '<span class="delta-lo">'+f+'</span>';return '<span>0</span>';}
function filtered(){
 return DATA.filter(function(r){
  if(curStatus!=='全部'){var ok=curStatus==='未核实'?r.status==='未核实':r.status.indexOf(curStatus)>-1;if(!ok)return false;}
  if(curSearch){var q=curSearch.toLowerCase();if((r.model+' '+r.vendor+' '+r.name).toLowerCase().indexOf(q)<0)return false;}
  return true;
 });
}
function render(){
 var rows=filtered();
 rows.sort(function(a,b){
  var x=a[sortK],y=b[sortK];
  if(x===null||x===undefined||x==='')x=-1e9;if(y===null||y===undefined||y==='')y=-1e9;
  if(typeof x==='string'&&typeof y==='string')return x.localeCompare(y)*sortDir;
  return (x-y)*sortDir;
 });
 var tb=document.getElementById('tb');tb.innerHTML='';
 rows.forEach(function(r){
  var tr=document.createElement('tr');
  tr.innerHTML='<td class="vend">'+r.vendor+'</td><td class="model">'+r.model+'</td>'
   +'<td class="num">'+fmt(r.or_in)+'</td><td class="num">'+fmt(r.or_out)+'</td>'
   +'<td class="num">'+fmt(r.off_in)+'</td><td class="num">'+fmt(r.off_out)+'</td>'
   +'<td class="num">'+dlt(r.in_delta)+'</td><td class="num">'+dlt(r.out_delta)+'</td>'
   +'<td><span class="tag '+tagClass(r.status)+'">'+r.status+'</span></td>';
  tb.appendChild(tr);
 });
}
document.querySelectorAll('th[data-k]').forEach(function(th){
 th.onclick=function(){var k=th.getAttribute('data-k');if(sortK===k)sortDir*=-1;else{sortK=k;sortDir=1;}render();};
});
document.getElementById('search').oninput=function(e){curSearch=e.target.value;render();};
buildChips();render();
</script></body></html>"""

html = html.replace('__DATA__', data)
open('openrouter_vs_official.html', 'w').write(html)
print('HTML written:', len(html), 'bytes; models:', len(rows))
