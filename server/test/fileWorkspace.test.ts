// File workspace — pure logic tests (no DB, no network).
// Covers: path safety (traversal/absolute rejected, never silently dropped),
// filename inference (declared > heading > fallback), duplicate handling,
// tree building, ZIP structure, and the multi-file / directory selection rules.
import AdmZip from 'adm-zip';
import {
  buildFileTree,
  flattenTree,
  normalizeLanguage,
  normalizeWorkspacePath,
  parseWorkspaceFiles,
  workspaceBytes,
  zipWorkspaceFiles,
  type WorkspaceFileRef,
} from '../src/services/fileWorkspace';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
}

(async () => {
  console.log('\n1. Path safety — a rejecting path never reaches the filesystem layer');
  const BAD = ['../secret.txt', '../../etc/passwd', '/etc/passwd', 'C:\\Windows\\win.ini', '//unc/share/x.txt',
    'a/../../b.txt', '', '   ', '.\t', 'x\u0000y.txt', 'a/../b/c.txt', './', '/'];
  for (const p of BAD) {
    const r = normalizeWorkspacePath(p);
    check(`rejects ${JSON.stringify(p)} (${r.reason ?? 'ACCEPTED as ' + r.path})`, !r.ok, r.path ?? '');
  }
  const GOOD: Array<[string, string]> = [
    ['src/index.ts', 'src/index.ts'],
    ['./src/index.ts', 'src/index.ts'],
    ['src//index.ts', 'src/index.ts'],
    ['a\\b\\c.py', 'a/b/c.py'],
    ['Dockerfile', 'Dockerfile'],
    ['deep/nested/dir/file.json', 'deep/nested/dir/file.json'],
  ];
  for (const [inp, want] of GOOD) {
    const r = normalizeWorkspacePath(inp);
    check(`normalizes ${JSON.stringify(inp)} → ${JSON.stringify(want)}`, r.ok && r.path === want, `${r.path ?? 'REJECTED'}`);
  }
  check('rejection reports a reason, not a silent null',
    !normalizeWorkspacePath('../x').ok && typeof normalizeWorkspacePath('../x').reason === 'string');

  console.log('\n2. Extraction — declared filename wins, then heading, then fallback');
  const msg = [
    '可以，下面是完整项目。',
    '',
    '### `src/index.ts`',
    '```ts',
    'export const a = 1;',
    '```',
    '',
    '主入口：',
    '```js title="src/main.js"',
    'console.log(1);',
    '```',
    '',
    '```py filename="scripts/run.py"',
    'print(1)',
    '```',
    '',
    '```',
    'no hint here',
    '```',
  ].join('\n');
  const parsed = parseWorkspaceFiles(msg);
  check('extracted 4 files from 4 fences', parsed.files.length === 4, String(parsed.files.length));
  check('heading hint → src/index.ts', parsed.files[0].path === 'src/index.ts', parsed.files[0].path);
  check('title= hint → src/main.js', parsed.files[1].path === 'src/main.js', parsed.files[1].path);
  check('filename= hint → scripts/run.py', parsed.files[2].path === 'scripts/run.py', parsed.files[2].path);
  check('no hint → file-4.txt (language from fence)', parsed.files[3].path === 'file-4.txt', parsed.files[3].path);
  check('inferred flag is false only for declared names',
    parsed.files[0].inferred === true && parsed.files[1].inferred === false
    && parsed.files[2].inferred === false && parsed.files[3].inferred === true);
  check('file bodies carry the code, without the fence markers',
    parsed.files[0].content === 'export const a = 1;', JSON.stringify(parsed.files[0].content));
  check('prose is separated out (kept for an optional README)',
    parsed.prose.includes('可以') && !parsed.prose.includes('export const'), parsed.prose.slice(0, 40));
  check('blockIndex traces each file back to its fence',
    parsed.files.map((f) => f.blockIndex).join(',') === '1,2,3,4', parsed.files.map((f) => f.blockIndex).join(','));

  console.log('\n3. A declared traversal path is REJECTED and reported (not silently fixed)');
  const evil = parseWorkspaceFiles('```ts title="../escape.ts"\nx\n```');
  check('no file produced from a traversal name', evil.files.length === 0, JSON.stringify(evil.files));
  check('the rejection is reported with its reason', evil.rejected.length === 1 && /traversal/.test(evil.rejected[0].reason),
    JSON.stringify(evil.rejected));
  const evilAbs = parseWorkspaceFiles('```sh title="/etc/cron.d.log"\necho hi\n```');
  check('absolute declared path is also rejected and reported',
    evilAbs.files.length === 0 && /absolute/.test(evilAbs.rejected[0].reason), JSON.stringify(evilAbs.rejected));
  // 设计取舍：声明名"看不出是文件名"（无扩展名、含空格等）时不入 rejected——文件
  // 仍在，只是改用推断名，并在 inferred 标记里体现；只有能构成路径安全的坏名字才
  // 走 rejected。这样既不丢文件，也不把"名字不像文件"误报成"安全问题"。
  const vague = parseWorkspaceFiles('```sh title="the main entry point"\necho hi\n```');
  check('a vague declared name falls back to an inferred name (file is NOT lost)',
    vague.files.length === 1 && vague.files[0].path === 'file-1.sh' && vague.files[0].inferred === true,
    JSON.stringify(vague.files));
  check('and that fallback is not reported as a security rejection', vague.rejected.length === 0);

  console.log('\n4. Duplicate names get suffixed, never silently overwritten');
  const dup = parseWorkspaceFiles('```ts title="a.ts"\nfirst\n```\n\n```ts title="a.ts"\nsecond\n```');
  check('two identical names → a.ts and a-2.ts', dup.files.map((f) => f.path).join('|') === 'a.ts|a-2.ts',
    dup.files.map((f) => f.path).join('|'));
  check('both bodies preserved (no overwrite)',
    dup.files[0].content === 'first' && dup.files[1].content === 'second');

  console.log('\n5. Language handling');
  check('aliases normalize', normalizeLanguage('TypeScript') === 'ts' && normalizeLanguage('Python') === 'py');
  check('unknown language still yields a usable file', normalizeLanguage('brainfuck') === 'brainfuck');
  check('empty language → txt', normalizeLanguage('') === 'txt');
  const poly = parseWorkspaceFiles('```typescript\nx\n```\n\n```Vue\ny\n```');
  check('language is lowercased and aliased', poly.files.map((f) => f.language).join(',') === 'ts,vue',
    poly.files.map((f) => f.language).join(','));

  console.log('\n6. Tree building');
  const files: WorkspaceFileRef[] = [
    { path: 'src/index.ts', content: 'a', language: 'ts' },
    { path: 'src/lib/util.ts', content: 'bb', language: 'ts' },
    { path: 'README.md', content: 'ccc', language: 'md' },
  ];
  const tree = buildFileTree(files);
  check('top level has src (dir) and README.md (file)', tree.length === 2 && tree[0].name === 'src' && tree[1].name === 'README.md',
    tree.map((n) => n.name).join(','));
  check('dir sorts before file', tree[0].type === 'dir' && tree[1].type === 'file');
  check('nested files are under src (dir sorts before file)',
    (tree[0].children ?? []).map((c) => c.name).join(',') === 'lib,index.ts',
    (tree[0].children ?? []).map((c) => c.name).join(','));
  check('file nodes carry size + language',
    tree[1].size === 3 && tree[1].language === 'md', JSON.stringify({ s: tree[1].size, l: tree[1].language }));
  const flat = flattenTree(tree);
  check('flatten preserves depth for indented rendering (5 nodes: 2 top + 2 mid + 1 leaf)',
    flat.length === 5 && flat.filter((n) => n.depth === 1).length === 2 && flat.filter((n) => n.depth === 2).length === 1,
    JSON.stringify(flat.map((n) => `${n.depth}:${n.name}`)));

  console.log('\n7. ZIP — real PK archive, structure preserved');
  const zip = zipWorkspaceFiles([
    { path: 'src/index.ts', content: 'export const a=1;', language: 'ts' },
    { path: 'src/lib/util.ts', content: 'export const b=2;', language: 'ts' },
    { path: 'README.md', content: '# hello', language: 'md' },
  ]);
  check('output is a real ZIP (PK signature)',
    zip.length > 4 && zip[0] === 0x50 && zip[1] === 0x4b, zip.slice(0, 2).toString('hex'));
  const reopened = new AdmZip(zip);
  const names = reopened.getEntries().map((e) => e.entryName);
  check('all three files present, paths kept',
    names.length === 3 && names.includes('src/index.ts') && names.includes('src/lib/util.ts') && names.includes('README.md'),
    names.join(','));
  check('entry content round-trips exactly',
    reopened.getEntry('src/index.ts')!.getData().toString('utf8') === 'export const a=1;');
  check('empty file set still produces a valid (empty) archive', new AdmZip(zipWorkspaceFiles([])).getEntries().length === 0);

  console.log('\n8. Multi-file and directory selection');
  const proj: WorkspaceFileRef[] = [
    { path: 'src/index.ts', content: 'a', language: 'ts' },
    { path: 'src/lib/util.ts', content: 'b', language: 'ts' },
    { path: 'README.md', content: 'c', language: 'md' },
  ];
  const one = zipWorkspaceFiles(proj, { paths: ['README.md'] });
  check('single path → single entry',
    new AdmZip(one).getEntries().map((e) => e.entryName).join(',') === 'README.md');
  const many = zipWorkspaceFiles(proj, { paths: ['README.md', 'src/index.ts'] });
  check('multiple paths → exactly those entries',
    new AdmZip(many).getEntries().map((e) => e.entryName).sort().join(',') === 'README.md,src/index.ts');
  const dir = zipWorkspaceFiles(proj, { paths: ['src'] });
  check('a directory path pulls the whole subtree (2 files)',
    new AdmZip(dir).getEntries().map((e) => e.entryName).sort().join(',') === 'src/index.ts,src/lib/util.ts');
  const trailing = zipWorkspaceFiles(proj, { paths: ['src/'] });
  check('trailing slash tolerated for directories',
    new AdmZip(trailing).getEntries().length === 2);
  const rooted = zipWorkspaceFiles(proj, { rootName: 'omnitask-project' });
  check('rootName prefixes every entry for a clean top folder',
    new AdmZip(rooted).getEntries().every((e) => e.entryName.startsWith('omnitask-project/')),
    new AdmZip(rooted).getEntries().map((e) => e.entryName).join(','));
  const rootSlash = zipWorkspaceFiles(proj, { rootName: '/p/' });
  check('rootName is trimmed of slashes (no double prefix)',
    new AdmZip(rootSlash).getEntries().every((e) => e.entryName.startsWith('p/')));

  console.log('\n9. Sizing and degenerate input');
  check('byte count sums file sizes', workspaceBytes(proj) === 3, String(workspaceBytes(proj)));
  check('empty content parses to zero files with no rejection', parseWorkspaceFiles('').files.length === 0);
  check('content without any fence yields zero files (prose only)',
    parseWorkspaceFiles('just words').files.length === 0 && parseWorkspaceFiles('just words').prose === 'just words');
  check('an unclosed fence does not hang and still yields its body',
    parseWorkspaceFiles('```ts\nnever closed').files.length === 1
    && parseWorkspaceFiles('```ts\nnever closed').files[0].content === 'never closed');
  check('a 4-backtick fence is matched and closed by 4 backticks',
    parseWorkspaceFiles('````md\ntitle\n````').files.length === 1);

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
