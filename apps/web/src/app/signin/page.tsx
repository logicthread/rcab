import dynamic from 'next/dynamic';

const SignInClient = dynamic(() => import('./sign-in-client'), { ssr: false });

export default function SignInPage() {
  return <SignInClient />;
}
