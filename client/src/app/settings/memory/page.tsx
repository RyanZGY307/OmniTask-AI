'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet, apiDelete } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Row { id: string; [k: string]: any }

// 用户可查看并删除自己的资料与记忆（偏好 / 需求 / 长期记忆 / 对话记忆 / 领域熟悉程度）。
// 所有请求都由后端按登录身份过滤，前端不传 userId。
export default function MemorySettingsPage() {
  const router = useRouter();
  const t = useT();
  const [longTerm, setLongTerm] = useState<Row[]>([]);
  const [preferences, setPreferences] = useState<Row[]>([]);
  const [requirements, setRequirements] = useState<Row[]>([]);
  const [domains, setDomains] = useState<Row[]>([]);
  const [overview, setOverview] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const [lt, pf, rq, dm, ov] = await Promise.all([
      apiGet('/memory/long-term').catch(() => ({ entries: [] })),
      apiGet('/user/profile/preferences').catch(() => ({ preferences: [] })),
      apiGet('/user/profile/requirements').catch(() => ({ requirements: [] })),
      apiGet('/user/profile/domains').catch(() => ({ domains: [] })),
      apiGet('/memory').catch(() => ({ entries: [] })),
    ]);
    setLongTerm(lt?.entries || []);
    setPreferences(pf?.preferences || []);
    setRequirements(rq?.requirements || []);
    setDomains(dm?.domains || []);
    setOverview(ov?.entries || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const remove = async (path: string) => {
    try {
      await apiDelete(path);
      setNotice(t('mem.deleted'));
      await load();
    } catch {
      setNotice(t('mem.deleteFailed'));
    }
  };

  const Section = ({ title, rows, render, removePath }: {
    title: string; rows: Row[]; render: (r: Row) => string; removePath?: (r: Row) => string;
  }) => (
    <section className="liquid-glass p-5 mb-5 anim-fade-up">
      <h2 className="text-base font-display font-semibold text-primary mb-3">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted py-2">{t('mem.empty')}</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r) => (
            <div key={r.id} className="flex items-start gap-3 px-3 py-2.5 rounded-card bg-bg/40 border border-border/50">
              <span className="text-sm text-primary flex-1 break-words">{render(r)}</span>
              {removePath && (
                <button
                  onClick={() => remove(removePath(r))}
                  className="shrink-0 text-xs text-error hover:text-error/80 transition-colors min-h-[32px] px-2"
                >
                  {t('mem.delete')}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );

  return (
    <div className="min-h-screen bg-bg pb-20">
      <div className="max-w-2xl mx-auto px-4 py-6">
        <button onClick={() => router.back()}
          className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-primary transition-colors mb-3 anim-press">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          {t('common.back')}
        </button>
        <h1 className="text-2xl font-display font-bold text-primary mb-1 anim-fade-up">{t('mem.title')}</h1>
        <p className="text-sm text-muted mb-5 anim-fade-up">{t('mem.hint')}</p>

        {notice && <p className="text-xs text-muted mb-3">{notice}</p>}
        {loading && <p className="text-sm text-muted">{t('common.loading')}</p>}

        <Section title={t('mem.longTerm')} rows={longTerm} removePath={(r) => `/memory/long-term/${r.id}`}
          render={(r) => `${r.content}${r.type ? ` · ${r.type}` : ''}`} />
        <Section title={t('mem.preferences')} rows={preferences} removePath={(r) => `/user/profile/preferences/${r.id}`}
          render={(r) => `${r.content}${r.type ? ` · ${r.type}` : ''}`} />
        <Section title={t('mem.requirements')} rows={requirements} removePath={(r) => `/user/profile/requirements/${r.id}`}
          render={(r) => `${r.content}${r.category ? ` · ${r.category}` : ''}`} />
        <Section title={t('mem.overview')} rows={overview} removePath={(r) => `/memory/${r.id}`}
          render={(r) => `${r.content}${r.category ? ` · ${r.category}` : ''}`} />
        <Section title={t('mem.domains')} rows={domains} removePath={undefined}
          render={(r) => `${r.domain} · ${r.level}`} />
      </div>
    </div>
  );
}
