import { useState } from 'react';

export type RateLimitBlock = {
  rpm?: string; tpm?: string; rpd?: string;
  maxParallel?: string; tpd?: string;
  tpdLimitRpm?: string;
  tpdBehavior?: 'block' | 'limitRpm';
};

/** 把用户输入规整成限额字符串：空/'-' = 无限制；纯数字安全整数 = 数字串；其余为非法。 */
function limitText(raw: string): string | null {
  const t = String(raw ?? '').trim();
  if (t === '' || t === '-') return '';
  if (!/^\d+$/.test(t)) return null;
  if (!Number.isSafeInteger(Number(t))) return null;
  return String(Number(t));
}

export function RateLimitEditor({ value, onChange, showModelHint }: {
  value: RateLimitBlock; onChange: (v: RateLimitBlock) => void; showModelHint?: boolean;
}) {
  const [err, setErr] = useState('');
  const set = (patch: Partial<RateLimitBlock>) => { setErr(''); onChange({ ...value, ...patch }); };
  const num = (k: 'rpm' | 'tpm' | 'rpd' | 'maxParallel' | 'tpd' | 'tpdLimitRpm') => (
    <input type="text" inputMode="numeric" placeholder="-" value={(value[k] as string) ?? ''}
      onChange={(e) => {
        const v = limitText(e.target.value);
        if (v === null) { setErr('只能填数字或『-』（留空/『-』= 不限制）'); return; }
        set({ [k]: v });
      }}
      className="w-full bg-bg border border-border rounded-card px-2 py-1.5 text-xs font-mono text-primary placeholder-muted focus:outline-none focus:border-accent/50" />
  );
  const isBlock = value.tpdBehavior !== 'limitRpm';
  return (
    <div className="space-y-2 border border-border/60 rounded-card p-2.5">
      <div className="grid grid-cols-2 gap-2">
        <Field label="RPM">{num('rpm')}</Field>
        <Field label="TPM">{num('tpm')}</Field>
        <Field label="RPD">{num('rpd')}</Field>
        <Field label="最大并行">{num('maxParallel')}</Field>
        <Field label="TPD">{num('tpd')}</Field>
      </div>
      <div className="flex items-center gap-2">
        <div className="text-[11px] text-muted">TPD 到达后</div>
        <div className="flex gap-1">
          <button onClick={() => set({ tpdBehavior: 'block' })} className={`px-2 py-0.5 text-[11px] rounded-capsule border ${isBlock ? 'border-accent text-accent' : 'border-border text-muted'}`}>不可使用</button>
          <button onClick={() => set({ tpdBehavior: 'limitRpm' })} className={`px-2 py-0.5 text-[11px] rounded-capsule border ${!isBlock ? 'border-accent text-accent' : 'border-border text-muted'}`}>限制RPM</button>
        </div>
        {!isBlock && <div className="flex items-center gap-1 text-[11px] text-muted">RPM：{num('tpdLimitRpm')}</div>}
      </div>
      {err && <div className="text-[10px] text-error">{err}</div>}
      {showModelHint && <div className="text-[10px] text-muted/60">填『-』或留空 = 不限制（针对上方所选模型）</div>}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] text-muted/70 mb-0.5">{label}</div>
      {children}
    </div>
  );
}
