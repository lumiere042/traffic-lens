import express from 'express';
import { requireAuth } from './lib/auth';
import products from './routes/products';
import cart from './routes/cart';
import users from './routes/users';
import admin from './routes/admin';

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.send('ok'));
app.use('/products', products);
app.use('/cart', requireAuth, cart);
app.use('/users', users);
app.use('/admin', admin);

app.listen(4000);
