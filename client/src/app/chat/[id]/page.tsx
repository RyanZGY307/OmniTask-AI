import ChatPageClient from './ChatPageClient';

export const dynamic = 'force-static';
export const dynamicParams = false;
export function generateStaticParams() {
  return [{ id: '__spa__' }];
}

export default function Page({ params }: { params: { id: string } }) {
  return <ChatPageClient id={params.id} />;
}
