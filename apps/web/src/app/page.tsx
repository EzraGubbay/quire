import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { homeOfSide, isSide, SIDE_COOKIE } from '@/lib/side';

export const dynamic = 'force-dynamic';

/** `/` opens whichever side this device used last; research until a side is chosen. */
export default async function Home() {
  const side = (await cookies()).get(SIDE_COOKIE)?.value;
  redirect(homeOfSide(isSide(side) ? side : 'research'));
}
