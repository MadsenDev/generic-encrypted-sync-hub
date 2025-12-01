const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const PORT = process.env.PORT || 3000;
const BLOB_BASE_DIR = process.env.BLOB_BASE_DIR || path.join(__dirname, '..', 'data', 'blobs');
const METADATA_BASE_DIR = process.env.METADATA_BASE_DIR || path.join(__dirname, '..', 'data', 'metadata');
const SECRET_REGISTRY_PATH = process.env.SECRET_REGISTRY_PATH || path.join(__dirname, '..', 'data', 'secrets.json');
const UPLOAD_LIMIT = process.env.UPLOAD_LIMIT || '32mb';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: UPLOAD_LIMIT }));

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function loadSecretRegistry() {
  try {
    const raw = await fs.readFile(SECRET_REGISTRY_PATH, 'utf8');
    const data = JSON.parse(raw);
    return data;
  } catch (err) {
    console.error('Failed to load secret registry:', err.message);
    throw new Error('Secret registry missing or invalid. Set SECRET_REGISTRY_PATH.');
  }
}

function getRootSecret(registry, appId, rootId) {
  return registry?.[appId]?.[rootId];
}

function blobPath(appId, rootId, deviceId, eventId) {
  return path.join(BLOB_BASE_DIR, appId, rootId, deviceId, `${eventId}.blob`);
}

function metadataPath(appId, rootId) {
  return path.join(METADATA_BASE_DIR, appId, `${rootId}.json`);
}

async function readMetadata(appId, rootId) {
  const metaPath = metadataPath(appId, rootId);
  try {
    const raw = await fs.readFile(metaPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {};
    }
    throw err;
  }
}

async function writeMetadata(appId, rootId, metadata) {
  const metaPath = metadataPath(appId, rootId);
  await ensureDir(path.dirname(metaPath));
  await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2), 'utf8');
}

function toMetadataEntry(deviceId, eventId, createdAt, size) {
  return {
    device_id: deviceId,
    event_id: eventId,
    created_at: createdAt,
    size
  };
}

async function authorize(registry, req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }

  const { appId, rootId } = req.params;
  const storedSecret = getRootSecret(registry, appId, rootId);
  if (!storedSecret || storedSecret !== token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}

function buildRootRouter(registry) {
  const router = express.Router({ mergeParams: true });

  router.use((req, res, next) => authorize(registry, req, res, next));

  router.get('/:deviceId/:eventId', async (req, res) => {
    const { appId, rootId, deviceId, eventId } = req.params;
    const filePath = blobPath(appId, rootId, deviceId, eventId);
    try {
      const stat = await fs.stat(filePath);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', stat.size);
      return res.sendFile(path.resolve(filePath));
    } catch (err) {
      if (err.code === 'ENOENT') {
        return res.status(404).json({ error: 'Blob not found' });
      }
      console.error(err);
      return res.status(500).json({ error: 'Failed to read blob' });
    }
  });

  router.delete('/:deviceId/:eventId', async (req, res) => {
    const { appId, rootId, deviceId, eventId } = req.params;
    const filePath = blobPath(appId, rootId, deviceId, eventId);
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(err);
        return res.status(500).json({ error: 'Failed to delete blob' });
      }
    }

    try {
      const metadata = await readMetadata(appId, rootId);
      if (metadata[deviceId]) {
        delete metadata[deviceId][eventId];
        if (Object.keys(metadata[deviceId]).length === 0) {
          delete metadata[deviceId];
        }
        await writeMetadata(appId, rootId, metadata);
      }
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to update metadata' });
    }

    return res.status(204).send();
  });

  router.put('/:deviceId/:eventId', async (req, res) => {
    const { appId, rootId, deviceId, eventId } = req.params;
    const body = req.body;
    if (!Buffer.isBuffer(body)) {
      return res.status(400).json({ error: 'Binary body required' });
    }

    const filePath = blobPath(appId, rootId, deviceId, eventId);
    const createdAt = new Date().toISOString();

    try {
      await ensureDir(path.dirname(filePath));
      const exists = await fs
        .stat(filePath)
        .then(() => true)
        .catch((err) => {
          if (err.code === 'ENOENT') return false;
          throw err;
        });

      await fs.writeFile(filePath, body);
      const size = Buffer.byteLength(body);
      const metadata = await readMetadata(appId, rootId);
      if (!metadata[deviceId]) {
        metadata[deviceId] = {};
      }
      metadata[deviceId][eventId] = toMetadataEntry(deviceId, eventId, createdAt, size);
      await writeMetadata(appId, rootId, metadata);

      return res.status(exists ? 200 : 201).json({ created_at: createdAt, size });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to store blob' });
    }
  });

  router.get('/', async (req, res) => {
    const { appId, rootId } = req.params;
    const { deviceId } = req.query;
    try {
      const metadata = await readMetadata(appId, rootId);
      const flat = Object.values(metadata)
        .flatMap((byDevice) => Object.values(byDevice))
        .filter((entry) => {
          if (!deviceId) return true;
          return entry.device_id === deviceId;
        });
      return res.json(flat);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to read metadata' });
    }
  });

  return router;
}

async function start() {
  await ensureDir(BLOB_BASE_DIR);
  await ensureDir(METADATA_BASE_DIR);
  const registry = await loadSecretRegistry();
  const rootRouter = buildRootRouter(registry);
  app.use('/v1/sync/:appId/:rootId', rootRouter);

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.listen(PORT, () => {
    console.log(`GESH listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
