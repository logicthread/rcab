import dynamic from 'next/dynamic';

const BookClient = dynamic(() => import('./book-client'), { ssr: false });

export default function BookPage() {
  return <BookClient />;
}
