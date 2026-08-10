import { redirect } from 'next/navigation';

/**
 * The Query Console lives here in the finished app (§4). Module B was built
 * first, so for now the root sends you to the screen that exists.
 */
export default function HomePage() {
  redirect('/deploy');
}
