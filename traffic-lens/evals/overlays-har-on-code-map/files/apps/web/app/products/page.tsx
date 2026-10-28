import { api } from '../../lib/api';
import { track } from '../../lib/analytics';

export default async function ProductsPage() {
  const { data: products } = await api.get('/products');
  track('products_viewed', { count: products.length });
  return <ul>{products.map((p: any) => <li key={p.id}><a href={`/products/${p.id}`}>{p.name}</a></li>)}</ul>;
}

export async function getProduct(id: string) {
  const { data } = await api.get(`/products/${id}`);
  return data;
}
