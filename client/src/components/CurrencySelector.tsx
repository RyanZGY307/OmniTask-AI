'use client';
import { useState, useEffect } from 'react';
import { apiGet, apiPut } from '@/lib/api';

interface Currency {
  code: string; name: string; nameEn: string; symbol: string; region: string; rate: number | null;
}

interface Props {
  currentCurrency: string;
  onSelect: (currency: string) => void;
  showInline?: boolean;
}

export default function CurrencySelector({ currentCurrency, onSelect, showInline }: Props) {
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [search, setSearch] = useState('');
  const [selectedRegion, setSelectedRegion] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiGet('/currency/supported').then(d => setCurrencies(d.currencies)).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const regions = [...new Set(currencies.map(c => c.region))];

  const filtered = currencies.filter(c => {
    const matchSearch = !search || c.code.toLowerCase().includes(search.toLowerCase()) || c.name.includes(search) || c.nameEn.toLowerCase().includes(search.toLowerCase());
    const matchRegion = !selectedRegion || c.region === selectedRegion;
    return matchSearch && matchRegion;
  });

  const grouped = filtered.reduce((acc, c) => {
    if (!acc[c.region]) acc[c.region] = [];
    acc[c.region].push(c);
    return acc;
  }, {} as Record<string, Currency[]>);

  const handleSelect = async (code: string) => {
    try {
      await apiPut('/currency/preference', { currency: code });
      onSelect(code);
    } catch {}
  };

  if (loading) return <div className="text-center text-muted py-4"><div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full anim-spin mx-auto" /></div>;

  if (showInline) {
    return (
      <div className="space-y-3">
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索货币..."
          className="w-full bg-bg border border-border rounded-card px-3 py-2 text-sm text-primary placeholder-muted focus:outline-none focus:border-accent/50" />
        <div className="flex gap-1 flex-wrap mb-2">
          <button onClick={() => setSelectedRegion('')}
            className={`px-2 py-1 text-xs rounded-capsule ${!selectedRegion ? 'bg-accent text-on-accent' : 'bg-surface-hover text-muted'}`}>全部</button>
          {regions.map(r => (
            <button key={r} onClick={() => setSelectedRegion(r)}
              className={`px-2 py-1 text-xs rounded-capsule ${selectedRegion === r ? 'bg-accent text-on-accent' : 'bg-surface-hover text-muted'}`}>{r}</button>
          ))}
        </div>
        <div className="max-h-64 overflow-y-auto space-y-1">
          {Object.entries(grouped).map(([region, items]) => (
            <div key={region}>
              <div className="text-xs text-muted px-2 py-1 sticky top-0 bg-bg">{region}</div>
              {items.map(c => (
                <button key={c.code} onClick={() => handleSelect(c.code)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-card text-left transition-[background-color,border-color,box-shadow,opacity,transform,color] ${currentCurrency === c.code ? 'bg-accent/10 border border-accent/30' : 'hover:bg-surface-hover'}`}>
                  <span className="text-sm font-mono font-bold text-accent w-10">{c.code}</span>
                  <span className="text-sm text-primary flex-1">{c.name}</span>
                  <span className="text-xs text-muted">{c.symbol}</span>
                  {currentCurrency === c.code && <span className="text-accent">✓</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return null;
}