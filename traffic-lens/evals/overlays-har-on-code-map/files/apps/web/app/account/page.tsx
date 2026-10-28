import { api, authHeaders } from '../../lib/api';

export default async function AccountPage({ token, userId }: { token: string; userId: string }) {
  const { data: profile } = await api.get(`/users/${userId}/profile`, authHeaders(token));
  return <h1>{profile.name}</h1>;
}
