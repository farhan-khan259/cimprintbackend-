const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = Number(process.env.PORT || 4000);
const MONGO_URIS = [process.env.MONGO_URI, process.env.MONGO_URI_DIRECT].filter(Boolean);
const CLIENT_BUILD_PATH = path.resolve(__dirname, '../cimprints-frontend/build');
const CLIENT_INDEX_PATH = path.join(CLIENT_BUILD_PATH, 'index.html');
const LOCAL_CONTENT_PATH = path.join(__dirname, 'data', 'site-content.json');
const SITE_KEY = 'site-content';
const configuredOrigins = (process.env.FRONTEND_ORIGINS || process.env.FRONTEND_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const devOrigins = ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:3001', 'http://127.0.0.1:3001'];
const allowedOrigins = process.env.NODE_ENV === 'production'
  ? configuredOrigins
  : [...new Set([...configuredOrigins, ...devOrigins])];

app.use(
  cors(
    allowedOrigins.length
      ? {
          origin(origin, callback) {
            if (!origin || allowedOrigins.includes(origin)) {
              return callback(null, true);
            }

            return callback(new Error('Origin not allowed by CORS'));
          }
        }
      : {}
  )
);
app.use(express.json({ limit: '50mb' }));

if (fs.existsSync(CLIENT_BUILD_PATH)) {
  app.use(express.static(CLIENT_BUILD_PATH));
}

const siteContentSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    content: { type: mongoose.Schema.Types.Mixed, default: null },
    updatedAt: { type: Date, default: Date.now }
  },
  { minimize: false, collection: 'site_contents' }
);

const SiteContent = mongoose.models.SiteContent || mongoose.model('SiteContent', siteContentSchema);

function ensureLocalContentDir() {
  fs.mkdirSync(path.dirname(LOCAL_CONTENT_PATH), { recursive: true });
}

function readLocalContent() {
  try {
    if (!fs.existsSync(LOCAL_CONTENT_PATH)) {
      return { content: null, updatedAt: null };
    }

    const raw = fs.readFileSync(LOCAL_CONTENT_PATH, 'utf8');
    const parsed = JSON.parse(raw);

    return {
      content: parsed?.content ?? null,
      updatedAt: parsed?.updatedAt ?? null,
    };
  } catch (error) {
    console.error('Failed to read local content fallback', error);
    return { content: null, updatedAt: null };
  }
}

function writeLocalContent(content, updatedAt) {
  try {
    ensureLocalContentDir();
    fs.writeFileSync(
      LOCAL_CONTENT_PATH,
      JSON.stringify({ content, updatedAt: updatedAt.toISOString() }, null, 2),
      'utf8'
    );
  } catch (error) {
    console.error('Failed to write local content fallback', error);
    throw error;
  }
}

function isMongoReady() {
  return mongoose.connection.readyState === 1;
}

async function connectDatabase() {
  if (!MONGO_URIS.length) {
    console.warn('MONGO_URI is not set. API will still start, but persistence is disabled.');
    return;
  }

  for (const mongoUri of MONGO_URIS) {
    try {
      await mongoose.connect(mongoUri, {
        dbName: 'cimprints',
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000
      });

      console.log('Connected to MongoDB');
      return;
    } catch (error) {
      console.warn(`MongoDB connection failed for one URI: ${error.message}`);
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect().catch(() => {});
      }
    }
  }

  console.warn('MongoDB persistence is unavailable. The API will continue without saving to the database.');
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

app.get('/api/content', async (_req, res) => {
  try {
    if (isMongoReady()) {
      const document = await SiteContent.findOne({ key: SITE_KEY }).lean();
      if (!document) {
        return res.json({ content: null, updatedAt: null });
      }

      return res.json({
        content: document.content,
        updatedAt: document.updatedAt ? document.updatedAt.toISOString() : null
      });
    }

    return res.json(readLocalContent());
  } catch (error) {
    console.error('Failed to read content', error);
    return res.status(500).json({ error: 'Failed to read content' });
  }
});

app.put('/api/content', async (req, res) => {
  try {
    if (!req.body || typeof req.body.content !== 'object' || req.body.content === null) {
      return res.status(400).json({ error: 'content object is required' });
    }

    const updatedAt = new Date();
    if (isMongoReady()) {
      const document = await SiteContent.findOneAndUpdate(
        { key: SITE_KEY },
        { key: SITE_KEY, content: req.body.content, updatedAt },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean();

      return res.json({
        ok: true,
        updatedAt: document.updatedAt ? document.updatedAt.toISOString() : updatedAt.toISOString(),
        storage: 'mongo'
      });
    }

    writeLocalContent(req.body.content, updatedAt);

    return res.json({
      ok: true,
      updatedAt: updatedAt.toISOString(),
      storage: 'file'
    });
  } catch (error) {
    console.error('Failed to save content', error);
    return res.status(500).json({ error: 'Failed to save content' });
  }
});

app.get('/admin', (_req, res) => {
  if (fs.existsSync(CLIENT_INDEX_PATH)) {
    return res.sendFile(CLIENT_INDEX_PATH);
  }

  return res.status(404).json({ error: 'Frontend build not found' });
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }

  if (fs.existsSync(CLIENT_INDEX_PATH)) {
    return res.sendFile(CLIENT_INDEX_PATH);
  }

  return res.status(200).json({
    ok: true,
    message: 'Backend is running. Build the frontend to serve the landing page from this server.'
  });
});

connectDatabase()
  .catch((error) => {
    console.error('MongoDB connection error:', error.message);
  })
  .finally(() => {
    if (!MONGO_URIS.length) {
      console.warn(`Using local file persistence at ${LOCAL_CONTENT_PATH}`);
    }

    const server = app.listen(PORT, () => {
      console.log(`Cimprints backend running on http://localhost:${PORT}`);
    });

    server.on('error', (error) => {
      if (error && error.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Another backend process is already running.`);
        console.error('Stop the existing process on this port or change PORT in your environment, then start again.');
        process.exit(1);
      }

      console.error('Server failed to start:', error.message);
      process.exit(1);
    });
  });
