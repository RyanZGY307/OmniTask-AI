/** @type {import('next').NextConfig} */

// Same-origin /api proxy. The browser always calls /api/* on its own origin;
// Next's rewrites forward those to the real backend.
//
// Dev (Vercel local preview / container): backend sits on 127.0.0.1:3001.
// Production (Vercel serverless): there is no local backend, so the
// destination must be the public backend URL (Railway). NEXT_PUBLIC_API_URL
// points at the backend origin (e.g. https://cortex-api.up.railway.app/api)
// and is read at build time on Vercel.
//
// Keeping the proxy in production (not just dev) is what fixes the Vercel
// login page: previously prod rewrites returned [] and the same-origin
// /api/auth/enter 404'd because NEXT_PUBLIC_API_URL was unset.
// Production default: proxy same-origin /api to the Render backend at the
// Vercel edge. This keeps the browser from dialing onrender.com directly
// (some user networks can't reach it); only Vercel's edge does.
// NEXT_PUBLIC_API_URL, when set on Vercel, overrides this default.
const PROD_BACKEND = 'https://cortexai-ublk.onrender.com/api';
// 域名迁移：新 api 域 api.cortex-ai-neurovanta.com 就绪并验证后，
// 在 Vercel 项目 Settings→Environment Variables 设 NEXT_PUBLIC_API_URL=https://api.cortex-ai-neurovanta.com/api
// （会自动覆盖上面的回退默认值；删除该 env 即可回滚）。
const BACKEND = process.env.NEXT_PUBLIC_API_URL || PROD_BACKEND;
const isDev = process.env.NODE_ENV !== 'production';

const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  images: {
    unoptimized: true,
  },
  async rewrites() {
    // Dev always proxies to the local backend. Production proxies to the
    // backend only when NEXT_PUBLIC_API_URL is provided; otherwise there is
    // nothing to forward to and returning no rewrites is correct.
    const target = isDev ? 'http://127.0.0.1:3001' : BACKEND;
    if (isDev) {
      return [
        {
          source: '/api/:path*',
          destination: `${target}/api/:path*`,
        },
      ];
    }
    // Production: only add the rewrite when an external backend was given.
    // NEXT_PUBLIC_API_URL already includes the "/api" prefix (api.ts appends
    // paths to it), so the destination is the backend origin plus :path* —
    // NOT "/api/:path*", which would double the prefix to /api/api/*.
    const isExternalBackend = /^(https?:)?\/\//.test(BACKEND) && !BACKEND.startsWith('http://127.0.0.1');
    if (!isExternalBackend) return [];
    const origin = BACKEND.replace(/\/$/, '');
    return [
      {
        source: '/api/:path*',
        destination: `${origin}/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
