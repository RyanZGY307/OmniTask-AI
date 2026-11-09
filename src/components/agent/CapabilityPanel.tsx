'use client';
// S6 能力面开关面板：五布尔来自 GET /agent/capabilities（= AgentLoop.capabilities()）。
// 红线：未注入的能力显示「不可用」，不得伪造为可用。
import type { AgentCapabilities } from '@/lib/agentTypes';

const LABELS: { key: keyof AgentCapabilities; name: string; desc: string }[] = [
  { key: 'checkpoints', name: 'Checkpoints', desc: '运行期快照与恢复' },
  { key: 'subagents', name: 'Subagents', desc: '子代理并行执行' },
  { key: 'skills', name: 'Skills', desc: '技能注册表注入' },
  { key: 'advisor', name: 'Advisor', desc: '运行期顾问（独立 chatWithFallback 调用）' },
  { key: 'mcp', name: 'MCP', desc: '宿主真 MCP client 注入' },
];

export default function CapabilityPanel({ caps }: { caps: AgentCapabilities | null }) {
  if (!caps) return <p className="text-sm text-gray-400">能力状态加载中…</p>;
  return (
    <div className="border rounded-lg p-3 bg-white shadow-sm">
      <div className="text-sm font-medium text-gray-800 mb-2">Agent 能力面</div>
      <ul className="space-y-1">
        {LABELS.map(({ key, name, desc }) => {
          const on = caps[key] === true;
          return (
            <li key={key} className="flex items-center gap-2 text-sm">
              <span className={`inline-block w-2 h-2 rounded-full ${on ? 'bg-green-500' : 'bg-gray-300'}`} />
              <span className="w-28 font-medium text-gray-700">{name}</span>
              <span className={on ? 'text-green-700' : 'text-gray-400'}>{on ? '可用' : '不可用（未注入）'}</span>
              <span className="text-xs text-gray-400">{desc}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
