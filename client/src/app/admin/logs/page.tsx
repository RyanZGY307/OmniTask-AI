'use client';
import { useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';

export default function AdminLogsPage() {
  const [logs, setLogs] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [level, setLevel] = useState('');
  const [userId, setUserId] = useState('');
  const [loading, setLoading] = useState(true);

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (level) params.set('level', level);
      if (userId) params.set('userId', userId);
      const data = await apiGet(`/admin/logs?${params}`);
      setLogs(data.logs); setTotal(data.total);
    } catch {} finally { setLoading(false); }
  };

  useEffect(() => { fetchLogs(); }, []);

  const levelColors: Record<string, string> = { DEBUG: 'text-muted', INFO: 'text-accent', WARN: 'text-warning', ERROR: 'text-error' };

  return (
    <div>
      <div className="flex items-center justify-between mb-6 anim-fade-up">
        <h1 className="text-2xl font-display font-bold text-primary">日志系统</h1>
        <span className="text-sm text-muted">共 {total} 条 | 30天自动删除</span>
      </div>
      <div className="flex gap-2 mb-4 anim-fade-up anim-delay-1">
        <select value={level} onChange={(e) => setLevel(e.target.value)} className="bg-bg border border-border rounded-card px-3 py-2 text-sm text-primary focus:outline-none">
          <option value="">全部等级</option><option value="DEBUG">DEBUG</option><option value="INFO">INFO</option><option value="WARN">WARN</option><option value="ERROR">ERROR</option>
        </select>
        <input type="text" value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="用户ID..." className="flex-1 bg-bg border border-border rounded-card px-4 py-2 text-sm text-primary placeholder-muted focus:outline-none" />
        <button onClick={fetchLogs} className="px-4 py-2 bg-accent hover:bg-accent-hover text-on-accent text-sm rounded-card anim-press">筛选</button>
      </div>
      {loading ? <div className="flex justify-center py-12"><div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full anim-spin" /></div> : (
        <div className="glass-card-sm overflow-hidden anim-fade-up anim-delay-2">
          <div className="max-h-[600px] overflow-y-auto">
            {logs.length === 0 ? <div className="text-center text-muted py-8">暂无日志</div> : logs.map((log, i) => (
              <div key={log.id} className="px-4 py-3 border-b border-border/50 hover:bg-surface-hover/30 anim-fade-up" style={{ animationDelay: `${i * 0.03}s` }}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs text-muted font-mono">{new Date(log.createdAt).toLocaleString('zh-CN')}</span>
                  <span className={`text-xs font-bold ${levelColors[log.level]}`}>{log.level}</span>
                  <span className="text-xs text-primary">{log.action}</span>
                  {log.model && <span className="text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent">{log.model}</span>}
                  {log.credits && <span className="text-xs text-muted font-mono">{log.credits.toFixed(3)}积分</span>}
                </div>
                {log.detail && <div className="text-xs text-muted pl-2">{log.detail}</div>}
                <div className="flex gap-3 mt-1">
                  {log.duration && <span className="text-xs text-muted">耗时:{log.duration}ms</span>}
                  {log.tokens && <span className="text-xs text-muted">Token:{log.tokens}</span>}
                  {log.userId && <span className="text-xs text-muted">用户:{log.userId.substring(0, 8)}...</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}