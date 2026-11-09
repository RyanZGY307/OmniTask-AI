// ADMIN_ACCESS_PIN 六位密码校验：正确/错误/格式错误
// 运行：npx tsx test/adminPin.test.ts
process.env.ADMIN_ACCESS_PIN = '246810';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
}

(async () => {
  const { checkAdminPin } = await import('../src/services/adminPin');

  console.log('\n1. 正确密码');
  check('246810 通过', checkAdminPin('246810') === 'ok');

  console.log('\n2. 错误密码');
  check('000000 被拒', checkAdminPin('000000') === 'wrong');
  check('246811 差一位被拒', checkAdminPin('246811') === 'wrong');

  console.log('\n3. 格式错误');
  check('五位被拒', checkAdminPin('24681') === 'wrong');
  check('七位被拒', checkAdminPin('2468100') === 'wrong');
  check('含字母被拒', checkAdminPin('2468a0') === 'wrong');
  check('undefined 被拒', checkAdminPin(undefined) === 'wrong');
  check('空串被拒', checkAdminPin('') === 'wrong');

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
