import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import hpp from 'hpp';
import rateLimit from 'express-rate-limit';

import authRoutes from './routes/auth';
import me from './routes/me';
import { auth } from './middleware/auth';
import funds from './routes/funds';
import transactions from './routes/transactions';
import categories from './routes/categories';
import clients from './routes/clients';
import providers from './routes/providers';
import liquidaciones from './routes/liquidaciones';

import cuentasLosPipinos from './routes/cuentas_los_pipinos';
import facturas from './routes/facturas';
import transactions_import from './routes/transactions_import';
import payments from './routes/payments';

const app = express();
const isProd = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1);
app.use(helmet());
app.use(hpp());
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3000'],
  methods: ['GET','POST','PUT','PATCH','DELETE'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
app.use(express.json());

// (opcional) logger simple para ver las rutas
app.use((req, _res, next) => { console.log(req.method, req.path); next(); });

// Rate limiters
const globalLimiter = rateLimit({
  windowMs: 60_000,
  max: isProd ? 300 : 10_000,
  standardHeaders: true,
  legacyHeaders: false,
});
const loginLimiter = rateLimit({
  windowMs: 60_000,
  max: isProd ? 10 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
});

if (isProd) app.use(globalLimiter);

// Públicas
app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/auth/login', loginLimiter);
app.use('/auth', authRoutes);

// Protegidas (con JWT)
app.use('/me', auth, me);
app.use('/funds', auth, funds);
app.use('/transactions', auth, transactions);
app.use('/categories', auth, categories);
app.use('/clients', auth, clients);
app.use('/providers', auth, providers);
app.use('/liquidaciones', auth, liquidaciones);
app.use('/cuentas-lospipinos', auth, cuentasLosPipinos);
app.use('/facturas', auth, facturas );
app.use('/payments', auth, payments );
app.use(transactions_import);

const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, () => console.log(`API listening on http://localhost:${PORT}`));
