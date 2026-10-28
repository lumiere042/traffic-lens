import axios from 'axios';

export const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
  withCredentials: true,
});

export function authHeaders(token: string) {
  return { headers: { Authorization: `Bearer ${token}` } };
}
