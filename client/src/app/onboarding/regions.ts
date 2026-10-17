export interface Region {
  code: string;
  name: string;
  localName: string;
  flag: string;
  continent: string;
}

export const REGIONS: Region[] = [
  // Asia
  { code: 'CN', name: 'China', localName: '中国', flag: '🇨🇳', continent: 'Asia' },
  { code: 'HK', name: 'Hong Kong', localName: '中国香港', flag: '🇭🇰', continent: 'Asia' },
  { code: 'TW', name: 'Taiwan', localName: '中国台湾', flag: '🇹🇼', continent: 'Asia' },
  { code: 'JP', name: 'Japan', localName: '日本', flag: '🇯🇵', continent: 'Asia' },
  { code: 'KR', name: 'South Korea', localName: '한국', flag: '🇰🇷', continent: 'Asia' },
  { code: 'SG', name: 'Singapore', localName: 'Singapore', flag: '🇸🇬', continent: 'Asia' },
  { code: 'MY', name: 'Malaysia', localName: 'Malaysia', flag: '🇲🇾', continent: 'Asia' },
  { code: 'TH', name: 'Thailand', localName: 'ไทย', flag: '🇹🇭', continent: 'Asia' },
  { code: 'VN', name: 'Vietnam', localName: 'Việt Nam', flag: '🇻🇳', continent: 'Asia' },
  { code: 'ID', name: 'Indonesia', localName: 'Indonesia', flag: '🇮🇩', continent: 'Asia' },
  { code: 'PH', name: 'Philippines', localName: 'Philippines', flag: '🇵🇭', continent: 'Asia' },
  { code: 'IN', name: 'India', localName: 'India', flag: '🇮🇳', continent: 'Asia' },
  { code: 'PK', name: 'Pakistan', localName: 'Pakistan', flag: '🇵🇰', continent: 'Asia' },
  { code: 'BD', name: 'Bangladesh', localName: 'Bangladesh', flag: '🇧🇩', continent: 'Asia' },
  { code: 'AE', name: 'UAE', localName: 'الإمارات', flag: '🇦🇪', continent: 'Asia' },
  { code: 'SA', name: 'Saudi Arabia', localName: 'السعودية', flag: '🇸🇦', continent: 'Asia' },
  { code: 'IL', name: 'Israel', localName: 'ישראל', flag: '🇮🇱', continent: 'Asia' },
  { code: 'TR', name: 'Turkey', localName: 'Türkiye', flag: '🇹🇷', continent: 'Asia' },
  // Europe
  { code: 'GB', name: 'United Kingdom', localName: 'United Kingdom', flag: '🇬🇧', continent: 'Europe' },
  { code: 'DE', name: 'Germany', localName: 'Deutschland', flag: '🇩🇪', continent: 'Europe' },
  { code: 'FR', name: 'France', localName: 'France', flag: '🇫🇷', continent: 'Europe' },
  { code: 'IT', name: 'Italy', localName: 'Italia', flag: '🇮🇹', continent: 'Europe' },
  { code: 'ES', name: 'Spain', localName: 'España', flag: '🇪🇸', continent: 'Europe' },
  { code: 'PT', name: 'Portugal', localName: 'Portugal', flag: '🇵🇹', continent: 'Europe' },
  { code: 'NL', name: 'Netherlands', localName: 'Nederland', flag: '🇳🇱', continent: 'Europe' },
  { code: 'BE', name: 'Belgium', localName: 'Belgique', flag: '🇧🇪', continent: 'Europe' },
  { code: 'CH', name: 'Switzerland', localName: 'Schweiz', flag: '🇨🇭', continent: 'Europe' },
  { code: 'AT', name: 'Austria', localName: 'Österreich', flag: '🇦🇹', continent: 'Europe' },
  { code: 'SE', name: 'Sweden', localName: 'Sverige', flag: '🇸🇪', continent: 'Europe' },
  { code: 'NO', name: 'Norway', localName: 'Norge', flag: '🇳🇴', continent: 'Europe' },
  { code: 'DK', name: 'Denmark', localName: 'Danmark', flag: '🇩🇰', continent: 'Europe' },
  { code: 'FI', name: 'Finland', localName: 'Suomi', flag: '🇫🇮', continent: 'Europe' },
  { code: 'PL', name: 'Poland', localName: 'Polska', flag: '🇵🇱', continent: 'Europe' },
  { code: 'CZ', name: 'Czechia', localName: 'Česko', flag: '🇨🇿', continent: 'Europe' },
  { code: 'RU', name: 'Russia', localName: 'Россия', flag: '🇷🇺', continent: 'Europe' },
  { code: 'UA', name: 'Ukraine', localName: 'Україна', flag: '🇺🇦', continent: 'Europe' },
  { code: 'GR', name: 'Greece', localName: 'Ελλάδα', flag: '🇬🇷', continent: 'Europe' },
  // Americas
  { code: 'US', name: 'United States', localName: 'United States', flag: '🇺🇸', continent: 'Americas' },
  { code: 'CA', name: 'Canada', localName: 'Canada', flag: '🇨🇦', continent: 'Americas' },
  { code: 'MX', name: 'Mexico', localName: 'México', flag: '🇲🇽', continent: 'Americas' },
  { code: 'BR', name: 'Brazil', localName: 'Brasil', flag: '🇧🇷', continent: 'Americas' },
  { code: 'AR', name: 'Argentina', localName: 'Argentina', flag: '🇦🇷', continent: 'Americas' },
  { code: 'CL', name: 'Chile', localName: 'Chile', flag: '🇨🇱', continent: 'Americas' },
  { code: 'CO', name: 'Colombia', localName: 'Colombia', flag: '🇨🇴', continent: 'Americas' },
  { code: 'PE', name: 'Peru', localName: 'Perú', flag: '🇵🇪', continent: 'Americas' },
  // Oceania
  { code: 'AU', name: 'Australia', localName: 'Australia', flag: '🇦🇺', continent: 'Oceania' },
  { code: 'NZ', name: 'New Zealand', localName: 'New Zealand', flag: '🇳🇿', continent: 'Oceania' },
  // Africa
  { code: 'ZA', name: 'South Africa', localName: 'South Africa', flag: '🇿🇦', continent: 'Africa' },
  { code: 'EG', name: 'Egypt', localName: 'مصر', flag: '🇪🇬', continent: 'Africa' },
  { code: 'NG', name: 'Nigeria', localName: 'Nigeria', flag: '🇳🇬', continent: 'Africa' },
  { code: 'KE', name: 'Kenya', localName: 'Kenya', flag: '🇰🇪', continent: 'Africa' },
];