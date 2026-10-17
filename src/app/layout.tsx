import type { Metadata, Viewport } from 'next';
import './globals.css';
import { sans, display, mono } from '@/lib/fonts';
import ConnectionGate from '@/components/ConnectionGate';
import { I18nProvider } from '@/lib/i18n';

export const metadata: Metadata = {
  title: 'OmniTask',
  description: 'OmniTask — Your intelligent interface',
  manifest: '/manifest.json',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#f8f9fc',
};

const themeScript = `
(function() {
  try {
    var s = JSON.parse(localStorage.getItem('cortex-settings') || '{}');
    var st = s.state || {};
    var a = st.appearance || 'light';
    document.documentElement.className = a;
    // 语言：刷新后保持，供各页面在 hydration 后同步 <html lang>
    var lang = st.language || localStorage.getItem('cortex_language') || 'en';
    document.documentElement.lang = lang;
    // meta theme-color 跟随主题：避免移动端浏览器 UI / 状态栏在深色模式下露出浅色底
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) { meta.setAttribute('content', a === 'dark' ? '#0a0a0c' : '#f8f9fc'); }
  } catch (e) {
    document.documentElement.className = 'light';
  }
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="light">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <meta name="theme-color" content="#f8f9fc" />
      </head>
      <body className={sans.className + ' font-body antialiased'}>
        <I18nProvider>
          <ConnectionGate>{children}</ConnectionGate>
        </I18nProvider>
      </body>
    </html>
  );
}