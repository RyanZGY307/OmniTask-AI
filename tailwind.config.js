import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        card: 'var(--card)',
        surface: 'var(--surface)',
        'surface-hover': 'var(--surface-hover)',
        'surface-light': 'var(--surface-light)',
        accent: 'var(--accent)',
        'accent-hover': 'var(--accent-hover)',
        'accent-dim': 'var(--accent-dim)',
        'accent-figure': 'var(--accent-figure)',
        'on-accent': 'var(--on-accent)',
        primary: 'var(--text-primary)',
        muted: 'var(--text-muted)',
        border: 'var(--border)',
        success: '#22c55e',
        error: '#ef4444',
        warning: '#f59e0b',
      },
      fontFamily: {
        display: ['Sora', 'sans-serif'],
        body: ['DM Sans', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      // ---- iOS 26 连续圆角刻度（超椭圆近似）：整体放大并统一弧度语言 ----
      borderRadius: {
        DEFAULT: '10px',
        lg: '14px',
        xl: '20px',
        '2xl': '28px',
        '3xl': '36px',
        card: '20px',
        'card-lg': '32px',
        hero: '44px',
        capsule: '9999px',
      },
      // ---- 弹性（spring）与非线性（nonlinear decel）缓动 ----
      transitionTimingFunction: {
        'ios-spring': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
        'ios-out': 'cubic-bezier(0.22, 1, 0.36, 1)',
        'ios-inout': 'cubic-bezier(0.65, 0, 0.35, 1)',
        'ios-elastic': 'cubic-bezier(0.68, -0.55, 0.27, 1.55)',
        'expo': 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
      // ---- 卡片柔和阴影（普通 UI）----
      boxShadow: {
        card: 'var(--card-shadow)',
        'card-lg': 'var(--card-shadow-lg)',
      },
      transitionDuration: {
        '450': '450ms',
      },
    },
  },
  plugins: [],
};

export default config;
