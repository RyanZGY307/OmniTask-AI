import { DM_Sans, Inter, Sora, JetBrains_Mono } from 'next/font/google';

// Sans-serif 主字体（全局应用），使用 Inter 作为 fallback
export const sans = Inter({
  weight: ['400', '500', '600', '700'],
  subsets: ['latin'],
  display: 'swap',
});

// 标题/强调字体 - 使用 next/font/google 自动下载并自托管
export const display = DM_Sans({
  weight: ['400', '500', '600', '700'],
  subsets: ['latin'],
  display: 'swap',
});

// 思考等级/代码字体
export const mono = JetBrains_Mono({
  weight: ['400', '500'],
  subsets: ['latin'],
  display: 'swap',
})

// 中文支持备注：如需引入中文请自行添加 subset 或使用 `next/font/google` 配合 `subsets: ['chinese']`。
// 目前只使用拉丁字形，文件体积更小。