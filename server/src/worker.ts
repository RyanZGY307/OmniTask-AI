// Cloudflare Workers 入口：把请求转发给 Containers 里的 Express 服务。
// 需要安装 @cloudflare/containers（见 package.json）。
// @ts-ignore -- @cloudflare/containers 的类型需要 bundler moduleResolution，tsc 用 node10 时忽略类型错误，运行时由 wrangler 打包解析
// eslint-disable-next-line
const { Container, getContainer } = require('@cloudflare/containers');

export class OmniTaskAPI extends Container {
  // 容器默认监听 3001（Dockerfile EXPOSE / ENV PORT），无需覆写。
}

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    return getContainer(env.OMNITASK_API).fetch(request);
  },
};
