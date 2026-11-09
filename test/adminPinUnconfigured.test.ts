// ADMIN_ACCESS_PIN 未配置时 admin-verify 应返回 unconfigured（503）
// 运行：npx tsx test/adminPinUnconfigured.test.ts
delete process.env.ADMIN_ACCESS_PIN;

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
}

(async () => {
  const { checkAdminPin } = await import('../src/services/adminPin');
  check('未配置环境变量时任何输入都返回 unconfigured', checkAdminPin('123456') === 'unconfigured');
  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
