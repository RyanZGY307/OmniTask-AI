// DATABASE_URL_* 环境变量直读：dbUrlFromEnv + isDbSetupRequired
// 运行：npx tsx test/dbEnv.test.ts
delete process.env.DATABASE_URL_USER;
delete process.env.DATABASE_URL_CONVERSATION;
delete process.env.DATABASE_URL_KNOWLEDGE;
delete process.env.DATABASE_URL_OVERFLOW;

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
}

(async () => {
  const { dbUrlFromEnv, isDbSetupRequired, DB_DOMAINS } = await import('../src/services/dbEnv');

  console.log('\n1. 全部未配置 → setupRequired');
  check('四个域都读不到', DB_DOMAINS.every((d) => dbUrlFromEnv(d) === null));
  check('isDbSetupRequired 为 true', isDbSetupRequired() === true);

  console.log('\n2. 仅配置 user 域');
  process.env.DATABASE_URL_USER = '  postgresql://u:p@host:5432/db  ';
  check('user 域读取并去空白', dbUrlFromEnv('user') === 'postgresql://u:p@host:5432/db', String(dbUrlFromEnv('user')));
  check('isDbSetupRequired 为 false', isDbSetupRequired() === false);
  check('其他域仍为空', dbUrlFromEnv('conversation') === null && dbUrlFromEnv('overflow') === null);

  console.log('\n3. user 域为空白字符串 → 仍视为未配置');
  process.env.DATABASE_URL_USER = '   ';
  check('空白不算配置', isDbSetupRequired() === true);

  console.log('\n4. 删除 user 配置 → 回到 setupRequired');
  delete process.env.DATABASE_URL_USER;
  check('删除后 isDbSetupRequired 为 true', isDbSetupRequired() === true);

  console.log('\n5. 其余域独立读取（多数据库混合）');
  process.env.DATABASE_URL_CONVERSATION = 'postgresql://c:c@h1:5432/c';
  process.env.DATABASE_URL_KNOWLEDGE = 'postgresql://k:k@h2:5432/k';
  process.env.DATABASE_URL_OVERFLOW = 'postgresql://o:o@h3:5432/o';
  check('conversation 独立读取', dbUrlFromEnv('conversation') === 'postgresql://c:c@h1:5432/c');
  check('knowledge 独立读取', dbUrlFromEnv('knowledge') === 'postgresql://k:k@h2:5432/k');
  check('overflow 独立读取', dbUrlFromEnv('overflow') === 'postgresql://o:o@h3:5432/o');
  check('user 缺失时即使其他域齐全仍 setupRequired', isDbSetupRequired() === true);

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
