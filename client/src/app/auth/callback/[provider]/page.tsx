import CallbackPageClient from './CallbackPageClient';

export const dynamic = 'force-static';
export const dynamicParams = false;
export function generateStaticParams() {
  return [{ provider: '__spa__' }];
}

export default function Page({ params }: { params: { provider: string } }) {
  return <CallbackPageClient provider={params.provider} />;
}
