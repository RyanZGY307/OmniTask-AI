/** @type {import('next').NextConfig} */

// Cloudflare Pages 部署：静态导出（output: 'export'），构建产物在 out/。
// 注意：export 模式下 rewrites/headers/redirects 均不生效，因此前端
// 不再做同源 /api 代理，一律通过 NEXT_PUBLIC_API_URL 直连后端
// （Cloudflare Pages 项目环境变量里设置，必须包含 /api 后缀，
//  例如 https://omnitask-api.<你的账号>.workers.dev/api）。
// api.ts 未设置该变量时回落到 '/api'，仅供本地 dev（next dev 的
// rewrites 仅在 dev 下保留，见下方 dev 分支）。
const nextConfig = {
  output: 'export',
  reactStrictMode: true,
  images: {
    // 静态导出必须关闭图片优化（无服务端图片管线）
    unoptimized: true,
  },
  async rewrites() {
    // 仅本地开发走同源代理；生产构建（output: export）会忽略 rewrites。
    if (process.env.NODE_ENV !== 'production') {
      return [{ source: '/api/:path*', destination: 'http://127.0.0.1:3001/api/:path*' }];
    }
    return [];
  },
};

module.exports = nextConfig;
