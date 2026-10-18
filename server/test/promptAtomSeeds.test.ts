// Default prompt-atom seed behavior (no live DB required).
// Public seam under test: seedDefaultPromptAtoms().
import Module from 'module';

const atoms = new Map<string, any>();
const versions = new Map<string, any>();
let atomCreateCalls = 0;
let versionCreateCalls = 0;

const tx = {
  promptAtom: {
    findUnique: async ({ where }: any) => atoms.get(where.id) ?? null,
    create: async ({ data }: any) => {
      if (atoms.has(data.id)) throw Object.assign(new Error('unique atom'), { code: 'P2002' });
      atomCreateCalls++;
      atoms.set(data.id, { ...data });
      return atoms.get(data.id);
    },
  },
  promptAtomVersion: {
    create: async ({ data }: any) => {
      const key = `${data.atomId}@${data.version}`;
      if (versions.has(key)) throw Object.assign(new Error('unique version'), { code: 'P2002' });
      versionCreateCalls++;
      versions.set(key, { ...data });
      return versions.get(key);
    },
  },
};

const fakeDb = {
  prismaKnowledge: {
    ...tx,
    $transaction: async (callback: (client: typeof tx) => Promise<any>) => callback(tx),
  },
};
const origLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any) {
  if (request === './db' && parent && String(parent.filename).includes('services')) return fakeDb;
  return origLoad.apply(this, arguments as any);
};

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, extra = '') {
  if (condition) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
}

(async () => {
  const { seedDefaultPromptAtoms } = await import('../src/services/promptRegistry');

  // Existing administrator-owned atom is not overwritten by a built-in seed.
  atoms.set('task.creative', {
    id: 'task.creative', category: 'task', purpose: 'admin-custom-purpose', priority: 99,
    status: 'disabled', version: '7.0.0',
  });

  const created = await seedDefaultPromptAtoms();
  const expectedIds = [
    'task.data_analysis',
    'task.anomaly_detection',
    'task.explanation',
  ];
  check('seeds data, anomaly, explanation; preserves pre-existing creative atom',
    JSON.stringify(created) === JSON.stringify(expectedIds), JSON.stringify(created));
  check('creates three atom rows', atomCreateCalls === 3, `calls=${atomCreateCalls}`);
  check('creates three published version rows', versionCreateCalls === 3, `calls=${versionCreateCalls}`);

  for (const id of expectedIds) {
    const atom = atoms.get(id);
    const version = versions.get(`${id}@1.0.0`);
    check(`${id} atom is published task category`, atom?.category === 'task' && atom?.status === 'published');
    check(`${id} has useful published instruction`,
      !!version && version.status === 'published' && version.instruction.trim().length >= 40);
  }
  check('existing atom metadata remains unchanged',
    atoms.get('task.creative').purpose === 'admin-custom-purpose' &&
    atoms.get('task.creative').status === 'disabled' &&
    atoms.get('task.creative').version === '7.0.0');

  const createdAgain = await seedDefaultPromptAtoms();
  check('repeat startup seed is idempotent', createdAgain.length === 0);
  check('repeat does not create duplicate atom/version rows', atomCreateCalls === 3 && versionCreateCalls === 3);

  // Simulate a fresh installation with no administrator-owned creative atom.
  atoms.delete('task.creative');
  const createdCreative = await seedDefaultPromptAtoms();
  check('seeds task.creative when absent', JSON.stringify(createdCreative) === '["task.creative"]');
  check('creative seed also has published version',
    atoms.get('task.creative')?.status === 'published' &&
    versions.get('task.creative@1.0.0')?.status === 'published');
  check('created exactly four built-in atoms total', atomCreateCalls === 4 && versionCreateCalls === 4);

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => { console.error('FATAL', error); process.exit(1); });
