'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isLoggedIn } from '@/lib/auth';
import { apiGet, apiPost } from '@/lib/api';

export default function FeedbackPage() {
  const router = useRouter();
  const [type, setType] = useState('bug');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [attachments, setAttachments] = useState<any[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [feedbacks, setFeedbacks] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isLoggedIn()) { router.replace('/onboarding'); return; }
    fetchFeedbacks();
  }, []);

  const fetchFeedbacks = async () => {
    try { const data = await apiGet('/feedback'); setFeedbacks(data.feedbacks); } catch {}
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    setError('');
    for (let i = 0; i < files.length; i++) {
      if (attachments.length >= 5) { setError('最多5个附件'); break; }
      const file = files[i];
      const maxSize = file.type.startsWith('video/') ? 20 * 1024 * 1024 : 5 * 1024 * 1024;
      if (file.size > maxSize) { setError(`${file.name} 超过限制（${file.type.startsWith('video/') ? '20MB' : '5MB'}）`); continue; }
      const reader = new FileReader();
      reader.onload = () => {
        setAttachments(prev => [...prev, { name: file.name, type: file.type.startsWith('video/') ? 'video' : 'image', size: file.size, data: reader.result as string }]);
      };
      reader.readAsDataURL(file);
    }
    e.target.value = '';
  };

  const removeAttachment = (index: number) => { setAttachments(prev => prev.filter((_, i) => i !== index)); };

  const handleSubmit = async () => {
    if (!title.trim() || !content.trim()) { setError('标题和内容必填'); return; }
    setSubmitting(true); setError('');
    try {
      await apiPost('/feedback', { type, title, content, attachments });
      setTitle(''); setContent(''); setAttachments([]); setShowForm(false);
      fetchFeedbacks();
    } catch (err: any) { setError(err.message || '提交失败'); }
    finally { setSubmitting(false); }
  };

  const typeLabels: Record<string, string> = { bug: 'Bug 反馈', feature: '功能建议', other: '其他' };
  const statusLabels: Record<string, string> = { pending: '待处理', processing: '处理中', resolved: '已解决' };
  const statusColors: Record<string, string> = { pending: 'text-warning', processing: 'text-accent', resolved: 'text-success' };

  return (
    <div className="min-h-screen bg-bg pb-20">
      <div className="max-w-lg mx-auto px-4 py-6">
        <div className="flex items-center gap-4 mb-6 anim-fade-up">
          <button onClick={() => router.push('/settings')} className="p-2 hover:bg-surface-hover rounded-card transition-colors anim-press">
            <svg className="w-5 h-5 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          <h1 className="text-xl font-display font-bold text-primary">问题反馈</h1>
          {!showForm && <button onClick={() => setShowForm(true)} className="ml-auto px-3 py-1.5 bg-accent text-on-accent text-xs rounded-card anim-hover-scale">+ 新反馈</button>}
        </div>

        {showForm && (
          <div className="glass-card p-5 mb-6 anim-scale-in">
            {error && <div className="bg-error/10 border border-error/20 text-error text-sm px-4 py-2 rounded-card mb-3 anim-fade-down">{error}</div>}

            <div className="mb-4">
              <label className="block text-sm text-muted mb-2">反馈类型</label>
              <div className="flex gap-2">
                {[{ key: 'bug', label: 'Bug 反馈' }, { key: 'feature', label: '功能建议' }, { key: 'other', label: '其他' }].map(t => (
                  <button key={t.key} onClick={() => setType(t.key)}
                    className={`px-3 py-1.5 rounded-capsule text-xs transition-[background-color,border-color,box-shadow,opacity,transform,color] anim-press ${type === t.key ? 'bg-accent text-on-accent' : 'glass-card-sm text-muted hover:text-primary'}`}>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mb-4">
              <label className="block text-sm text-muted mb-1.5">标题</label>
              <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="简要描述问题..."
                className="w-full bg-bg border border-border rounded-card px-4 py-2.5 text-sm text-primary placeholder-muted focus:outline-none focus:border-accent/50 transition-[background-color,border-color,box-shadow,opacity,transform,color]" />
            </div>

            <div className="mb-4">
              <label className="block text-sm text-muted mb-1.5">详细描述</label>
              <textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="请详细描述遇到的问题、复现步骤等..."
                className="w-full bg-bg border border-border rounded-card px-4 py-2.5 text-sm text-primary placeholder-muted focus:outline-none focus:border-accent/50 h-32 resize-none transition-[background-color,border-color,box-shadow,opacity,transform,color]" />
            </div>

            <div className="mb-4">
              <label className="block text-sm text-muted mb-2">附件（可选，最多5个）</label>
              <div className="flex flex-wrap gap-2 mb-2">
                {attachments.map((att, i) => (
                  <div key={i} className="relative group">
                    {att.type === 'image' ? (
                      <img src={att.data} alt={att.name} className="w-20 h-20 object-cover rounded-card border border-border" />
                    ) : (
                      <div className="w-20 h-20 bg-surface rounded-card border border-border flex items-center justify-center"><span className="text-2xl">🎬</span></div>
                    )}
                    <button onClick={() => removeAttachment(i)} className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-error text-white rounded-full text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">✕</button>
                    <div className="text-xs text-muted truncate w-20 mt-0.5">{att.name}</div>
                  </div>
                ))}
                {attachments.length < 5 && (
                  <label className="w-20 h-20 border-2 border-dashed border-border rounded-card flex flex-col items-center justify-center cursor-pointer hover:border-accent/50 transition-colors">
                    <span className="text-xl text-muted">+</span>
                    <span className="text-xs text-muted">添加</span>
                    <input type="file" accept="image/*,video/*" multiple onChange={handleFileSelect} className="hidden" />
                  </label>
                )}
              </div>
              <div className="text-xs text-muted">图片 ≤5MB，视频 ≤20MB</div>
            </div>

            <button onClick={handleSubmit} disabled={submitting}
              className="w-full py-2.5 bg-accent hover:bg-accent-hover text-on-accent font-medium rounded-capsule transition-[background-color,border-color,box-shadow,opacity,transform,color] disabled:opacity-50 anim-hover-scale">
              {submitting ? '提交中...' : '提交反馈'}
            </button>
          </div>
        )}

        <h2 className="text-lg font-display font-semibold text-primary mb-3 anim-fade-up">我的反馈</h2>
        {feedbacks.length === 0 ? (
          <div className="text-center text-muted py-8 glass-card-sm anim-fade-up">暂无反馈</div>
        ) : (
          <div className="space-y-3">
            {feedbacks.map((fb, i) => (
              <div key={fb.id} className="glass-card-sm p-4 anim-fade-up" style={{ animationDelay: `${i * 0.04}s`, opacity: 0 }}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-primary">{fb.title}</span>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-surface-hover text-muted">{typeLabels[fb.type]}</span>
                  </div>
                  <span className={`text-xs ${statusColors[fb.status]}`}>{statusLabels[fb.status]}</span>
                </div>
                <p className="text-xs text-muted mb-2 line-clamp-2">{fb.content}</p>
                {fb.attachments && fb.attachments.length > 0 && (
                  <div className="flex gap-1 mb-2">
                    {fb.attachments.map((att: any, j: number) => (
                      att.type === 'image' ? (
                        <img key={j} src={att.data} alt={att.name} className="w-12 h-12 object-cover rounded border border-border" />
                      ) : (
                        <div key={j} className="w-12 h-12 bg-surface rounded border border-border flex items-center justify-center"><span>🎬</span></div>
                      )
                    ))}
                  </div>
                )}
                {fb.reply && (
                  <div className="bg-accent/5 border border-accent/10 rounded-card p-2 mt-2">
                    <div className="text-xs text-accent mb-0.5">管理员回复：</div>
                    <div className="text-xs text-muted">{fb.reply}</div>
                  </div>
                )}
                <div className="text-xs text-muted mt-1">{new Date(fb.createdAt).toLocaleString('zh-CN')}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}