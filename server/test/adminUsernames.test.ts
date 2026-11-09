// ADMIN_USERNAMES 环境变量管理员名单：解析 + isEnvAdmin + effectiveRole
// 运行：npx tsx test/adminUsernames.test.ts
process.env.ADMIN_USERNAMES = 'ryan, admin ,bob,';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
}

(async () => {
  const { env } = await import('../src/config');
  const { isEnvAdmin, effectiveRole } = await import('../src/services/adminRole');

  console.log('\n1. ADMIN_USERNAMES 解析（逗号分隔、去空白、去空项）');
  check('解析为三人名单', JSON.stringify(env.ADMIN_USERNAMES) === JSON.stringify(['ryan', 'admin', 'bob']), JSON.stringify(env.ADMIN_USERNAMES));

  console.log('\n2. isEnvAdmin');
  check('名单内 ryan 是管理员', isEnvAdmin('ryan') === true);
  check('名单内 admin 是管理员', isEnvAdmin('admin') === true);
  check('名单外 alice 不是', isEnvAdmin('alice') === false);
  check('空串不是', isEnvAdmin('') === false);
  check('null/undefined 不是', isEnvAdmin(null) === false && isEnvAdmin(undefined) === false);
  check('大小写敏感（Ryan 不匹配 ryan）', isEnvAdmin('Ryan') === false);

  console.log('\n3. effectiveRole 提权规则');
  check('名单内 USER 提升为 ADMIN', effectiveRole('ryan', 'USER') === 'ADMIN');
  check('名单内已有 ADMIN 保持 ADMIN', effectiveRole('bob', 'ADMIN') === 'ADMIN');
  check('SUPER_ADMIN 不降级', effectiveRole('ryan', 'SUPER_ADMIN') === 'SUPER_ADMIN');
  check('名单外 role 不变', effectiveRole('alice', 'USER') === 'USER');

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
