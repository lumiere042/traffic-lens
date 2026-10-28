'use server';
import { api, authHeaders } from '../../lib/api';

export async function addToCart(token: string, productId: string, qty: number) {
  return api.post('/cart', { productId, qty }, authHeaders(token));
}

export async function removeFromCart(token: string, itemId: string) {
  return api.delete(`/cart/${itemId}`, authHeaders(token));
}

export async function checkout(token: string) {
  const { data } = await api.post('/cart/checkout', {}, authHeaders(token));
  return data.orderId;
}
