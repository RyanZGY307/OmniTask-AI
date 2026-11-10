import RunPageClient from './RunPageClient';

export const dynamic = 'force-static';
export const dynamicParams = false;
export function generateStaticParams() {
  return [{ runId: '__spa__' }];
}

export default function Page({ params }: { params: { runId: string } }) {
  return <RunPageClient runId={params.runId} />;
}
