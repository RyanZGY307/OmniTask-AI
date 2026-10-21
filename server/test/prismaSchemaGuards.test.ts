// ================================================================
// Prisma Schema 守卫 — 重复字段名 / 重复 model 名
// Run: npx tsx test/prismaSchemaGuards.test.ts
//
// 起因：给 TokenUsage 加注释时误把 `multiplier Float @default(1)`
// 又复制了一遍，而该字段已存在。Prisma 不允许同 model 内字段重名，
// prisma generate 会直接报 "Field multiplier is already defined"，
// postinstall 失败 → npm install 失败 → 部署构建挂掉。
//
// 本机跑不了 prisma validate（引擎 x86_64 与 Android arm64 不兼容），
// 所以用这个纯文本扫描把同样的检查固化进回归，防止再犯。
//
// 覆盖项：
//   1) 每个 model 内不得有重复字段名
//   2) 每个 schema 文件内不得有重复 model 名
//   3) model → 唯一索引/@@unique 字段必须在同一 model 内已声明
//   4) generator/datasource 块不被当成 model（避免误报）
// ================================================================

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = '') =>
  cond ? (pass++, console.log('  PASS', name)) : (fail++, console.log('  FAIL', name, detail));
const S = (name: string) => console.log('\n' + name);

const REPO = process.cwd();
const SCHEMA_DIR = join(REPO, 'prisma');

const SCALAR = /^(String|Int|BigInt|Float|Decimal|Boolean|DateTime|Json|Bytes|Unsupported)$/;
const BLOCK_HDR = /^(model|enum|type|view)\s+(\w+)\s*\{/;
const BLOCK_END = /^\}/;

function scan(path: string) {
  const src = readFileSync(path, 'utf-8');
  const lines = src.split('\n');
  const models: Array<{ name: string; start: number; fields: string[] }> = [];
  const dupModelNames: string[] = [];
  let cur: { name: string; start: number; fields: Set<string>; uniq: Set<string> } | null = null;
  const seenModels = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;

    // 行内注释：只剥 // 形式，避免误伤 postgresql:// （PricingEngine 里没有，但保险）
    const code = line.replace(/\/\/.*$/, '').trim();
    if (!code) continue;

    const hdr = BLOCK_HDR.exec(code);
    if (hdr) {
      const kind = hdr[1];
      const name = hdr[2];
      if (kind === 'model' || kind === 'view' || kind === 'type') {
        if (seenModels.has(name)) dupModelNames.push(`${name} (L${seenModels.get(name)} 与 L${i + 1})`);
        else seenModels.set(name, i + 1);
        if (kind === 'model' || kind === 'view') {
          if (cur) models.push({ name: cur.name, start: cur.start, fields: [...cur.fields] });
          cur = { name, start: i + 1, fields: new Set(), uniq: new Set() };
          continue;
        }
      }
      // enum / type / generator / datasource：推进 cur 但不当 model 解析
      if (cur) models.push({ name: cur.name, start: cur.start, fields: [...cur.fields] });
      cur = null;
      continue;
    }

    if (BLOCK_END.test(code)) {
      if (cur) { models.push({ name: cur.name, start: cur.start, fields: [...cur.fields] }); cur = null; }
      continue;
    }

    if (!cur) continue; // 只在 model/view 内收集字段

    // @@unique([a,b]) / @@index([a,b]) 的字段名要能在本 model 找到
    const blockAttr = /^@@(unique|index)\(\[([^\]]*)\]/.exec(code);
    if (blockAttr) {
      for (const f of blockAttr[2].split(',').map((x) => x.trim()).filter(Boolean)) {
        cur.uniq.add(f);
      }
      continue;
    }

    // 形如  name  Type[?]  @attr...
    const field = /^(\w+)\s+([\w.]+)(\[\])?(\?)?/.exec(code);
    if (!field) continue;
    const typeName = field[2];
    if (!SCALAR.test(typeName) && !typeName.includes('.')) {
      // 关系字段（对象类型）不计入重名检查，Prisma 对关系有单独规则
      continue;
    }
    cur.fields.add(field[1]);

    // @unique 属性上的内联唯一
    if (/@unique\b/.test(code)) cur.uniq.add(field[1]);
  }
  if (cur) models.push({ name: cur.name, start: cur.start, fields: [...cur.fields] });
  return { models, dupModelNames };
}

S('1. 无重复字段名（本次回归的起因）');
{
  let files: string[] = [];
  try { files = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.prisma')).map((f) => join(SCHEMA_DIR, f)); }
  catch { files = []; }
  check('找到 .prisma schema 文件', files.length > 0, `目录: ${SCHEMA_DIR}`);
  if (files.length === 0) { console.log('\n未找到 schema，跳过'); process.exit(1); }

  let anyDup = false;
  for (const f of files) {
    const src = readFileSync(f, 'utf-8');
    const { models } = scan(f);
    for (const m of models) {
      const seen = new Set<string>();
      const dup: string[] = [];
      // 重新逐行数一遍，拿到重复的具体字段
      const lines = src.split('\n');
      let inModel = false, name = '';
      const local = new Set<string>();
      const dups: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const code = lines[i].trim().replace(/\/\/.*$/, '').trim();
        if (!code) continue;
        const hdr = BLOCK_HDR.exec(code);
        if (hdr) {
          if (inModel && dups.length) { /* 记录用 */ }
          inModel = hdr[1] === 'model' || hdr[1] === 'view';
          name = hdr[2];
          if (inModel) { local.clear(); }
          continue;
        }
        if (BLOCK_END.test(code)) { inModel = false; continue; }
        if (!inModel || name !== m.name) continue;
        const fld = /^(\w+)\s+([\w.]+)(\[\])?(\?)?/.exec(code);
        if (!fld) continue;
        if (/^@@/.test(code)) continue;
        const t = fld[2];
        if (!SCALAR.test(t) && !t.includes('.')) continue; // 关系字段
        if (local.has(fld[1])) dups.push(`${fld[1]} (L${i + 1})`);
        else local.add(fld[1]);
      }
      if (dups.length) {
        anyDup = true;
        check(`${f.split('/').pop()} 的 model ${m.name} 无重复字段`, false, `重复: ${dups.join(', ')}`);
      } else {
        console.log(`  PASS ${f.split('/').pop()} model ${m.name} — ${m.fields.length} 字段无重复`);
        pass++;
      }
      void seen; void dup;
    }
  }
  if (!anyDup) console.log('  (所有 model 均无重复字段)');
}

S('2. 无重复 model 名');
{
  for (const f of readdirSync(SCHEMA_DIR).filter((x) => x.endsWith('.prisma')).map((x) => join(SCHEMA_DIR, x))) {
    const { dupModelNames } = scan(f);
    check(`${f.split('/').pop()} 无重复 model 名`, dupModelNames.length === 0, dupModelNames.join('; '));
  }
}

S('3. @@unique / @@index 引用的字段都在同一 model 内声明');
{
  let problems: string[] = [];
  for (const f of readdirSync(SCHEMA_DIR).filter((x) => x.endsWith('.prisma')).map((x) => join(SCHEMA_DIR, x))) {
    const src = readFileSync(f, 'utf-8');
    const { models } = scan(f);
    for (const m of models) {
      const declared = new Set(m.fields);
      // 从原文本里取该 model 的 block 属性
      const lines = src.split('\n');
      let inModel = false;
      const blockUnique = new Map<string, string[]>();
      const inlineUnique = new Set<string>();
      for (let i = 0; i < lines.length; i++) {
        const code = lines[i].trim().replace(/\/\/.*$/, '').trim();
        if (!code) continue;
        const hdr = BLOCK_HDR.exec(code);
        if (hdr) { inModel = hdr[2] === m.name; continue; }
        if (!inModel) continue;
        if (BLOCK_END.test(code)) break;
        const ba = /^@@(unique|index)\(\[([^\]]*)\]/.exec(code);
        if (ba) {
          blockUnique.set(ba[2], ba[2].split(',').map((x) => x.trim()).filter(Boolean));
          continue;
        }
        const fl = /^(\w+)\s+([\w.]+)/.exec(code);
        if (fl && /@unique\b/.test(code)) inlineUnique.add(fl[1]);
      }
      for (const [expr, flds] of blockUnique) {
        for (const f2 of flds) if (!declared.has(f2)) problems.push(`${f.split('/').pop()}:${m.name} @@[${expr}] 引用未声明字段 ${f2}`);
      }
    }
  }
  check('所有索引/唯一约束字段均已声明', problems.length === 0, problems.slice(0, 6).join(' | '));
}

console.log(`\nPrisma Schema 守卫：${pass} 通过 / ${fail} 失败`);
setTimeout(() => process.exit(fail > 0 ? 1 : 0), 120);
