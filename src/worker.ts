// Cloudflare Workers 入口：把请求转发给 Containers 里的 Express 服务。
// 需要安装 @cloudflare/containers（见 package.json）。
import { Container, getContainer } from '@cloudflare/containers';

export class OmniTaskAPI extends Container {
  // 容器默认监听 3001（Dockerfile EXPOSE / ENV PORT），无需覆写。
}

export default {
  async fetch(request: Request, env: { OMNITASK_API: DurableObjectNamespace }): Promise<Response> {
    return getContainer(env.OMNITASK_API).fetch(request);
  },
};
