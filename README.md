# Generic Encrypted Sync Hub (GESH)

A minimal Node.js implementation of the GESH v1 HTTP service for syncing encrypted blobs between devices.

## Getting started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Configure a secret registry so the server can authenticate requests. The registry maps `appId` and `rootId` pairs to a `root_secret`. Use `data/secrets.example.json` as a template and save the real secrets at `data/secrets.json` (or point `SECRET_REGISTRY_PATH` to a different file).

   ```json
   {
     "fattern": {
       "root_7c5e1bb3-fca2-4e24-8c15-0fbb72e4f121": "example-root-secret"
     }
   }
   ```

3. Start the server:

   ```bash
   npm start
   ```

   The service listens on `PORT` (default `3000`).

## API

All endpoints require `Authorization: Bearer <root_secret>` that matches the configured `(appId, rootId)` pair.

### Upload blob

```http
PUT /v1/sync/{appId}/{rootId}/{deviceId}/{eventId}
Content-Type: application/octet-stream
```

Uploads or overwrites a blob for the device/event. Returns `201 Created` on new blobs or `200 OK` when overwriting.

### List blobs

```http
GET /v1/sync/{appId}/{rootId}?deviceId={optionalDeviceId}
```

Returns metadata for blobs in the root. Filter by `deviceId` to only return events from a specific device.

### Download blob

```http
GET /v1/sync/{appId}/{rootId}/{deviceId}/{eventId}
```

Responds with the encrypted bytes for the requested blob or `404` if missing.

### Delete blob

```http
DELETE /v1/sync/{appId}/{rootId}/{deviceId}/{eventId}
```

Removes the blob and its metadata. Always responds with `204 No Content` even if the blob was already absent.

## Configuration

Environment variables:

- `PORT` – Port to listen on (default `3000`).
- `BLOB_BASE_DIR` – Filesystem base directory for blob storage (default `data/blobs`).
- `METADATA_BASE_DIR` – Directory for metadata indexes (default `data/metadata`).
- `SECRET_REGISTRY_PATH` – Path to the JSON file containing root secrets (default `data/secrets.json`).
- `UPLOAD_LIMIT` – Max upload size for blobs (default `32mb`).

## Notes

- Blobs are stored at `BLOB_BASE_DIR/{appId}/{rootId}/{deviceId}/{eventId}.blob`.
- Metadata is stored per root at `METADATA_BASE_DIR/{appId}/{rootId}.json` and contains `device_id`, `event_id`, `created_at`, and `size` for quick listing.
- The service does not implement pairing or any plaintext handling; clients are responsible for encryption and lifecycle management.
