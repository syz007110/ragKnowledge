const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

function buildStorageConfig() {
  const enabled = String(process.env.KB_OBJECT_STORAGE_ENABLED || 'false').toLowerCase() === 'true';
  const endpoint = String(process.env.KB_OBJECT_STORAGE_ENDPOINT || process.env.MINIO_ENDPOINT || '').trim();
  const region = String(process.env.KB_OBJECT_STORAGE_REGION || 'us-east-1').trim() || 'us-east-1';
  const bucket = String(process.env.KB_OBJECT_STORAGE_BUCKET || process.env.MINIO_BUCKET || '').trim();
  const accessKeyId = String(process.env.KB_OBJECT_STORAGE_ACCESS_KEY || process.env.MINIO_USER || '').trim();
  const secretAccessKey = String(process.env.KB_OBJECT_STORAGE_SECRET_KEY || process.env.MINIO_PASSWORD || '').trim();
  const forcePathStyle = String(process.env.KB_OBJECT_STORAGE_FORCE_PATH_STYLE || 'true').toLowerCase() !== 'false';
  return {
    enabled,
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle
  };
}

function ensureStorageConfig(config = buildStorageConfig()) {
  if (!config.enabled) return;
  const required = ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey'];
  const missing = required.filter((key) => !String(config[key] || '').trim());
  if (missing.length) {
    throw new Error(`kb.objectStorageConfigMissing:${missing.join(',')}`);
  }
}

function buildClient(config = buildStorageConfig()) {
  ensureStorageConfig(config);
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    },
    forcePathStyle: config.forcePathStyle
  });
}

function isS3Uri(uri = '') {
  return String(uri || '').toLowerCase().startsWith('s3://');
}

function parseS3Uri(uri = '') {
  const raw = String(uri || '').trim();
  if (!raw.toLowerCase().startsWith('s3://')) return null;
  const withoutSchema = raw.slice(5);
  const slashIndex = withoutSchema.indexOf('/');
  if (slashIndex < 0) return null;
  const bucket = withoutSchema.slice(0, slashIndex).trim();
  const key = withoutSchema.slice(slashIndex + 1).trim();
  if (!bucket || !key) return null;
  return { bucket, key };
}

function buildS3Uri(bucket, key) {
  return `s3://${bucket}/${key}`;
}

function safeObjectFileName(name = '') {
  const ext = path.extname(String(name || ''));
  const base = path.basename(String(name || ''), ext).replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 80) || 'kb';
  return `${base}${ext.toLowerCase()}`;
}

function buildUploadObjectKey({ collectionId, fileName }) {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const random = crypto.randomBytes(4).toString('hex');
  const safeName = safeObjectFileName(fileName);
  return `kb/${collectionId}/${timestamp}-${random}-${safeName}`;
}

async function uploadLocalFile({ localPath, objectKey, contentType = '' }) {
  const config = buildStorageConfig();
  const client = buildClient(config);
  const body = await fs.readFile(localPath);
  await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: objectKey,
    Body: body,
    ContentType: contentType || undefined
  }));
  return buildS3Uri(config.bucket, objectKey);
}

async function uploadBuffer({ buffer, objectKey, contentType = '' }) {
  const config = buildStorageConfig();
  const client = buildClient(config);
  const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: objectKey,
    Body: body,
    ContentType: contentType || undefined
  }));
  return buildS3Uri(config.bucket, objectKey);
}

async function getObjectBufferByUri(storageUri = '') {
  const parsed = parseS3Uri(storageUri);
  if (!parsed) {
    throw new Error('kb.objectStorageUriInvalid');
  }
  const config = buildStorageConfig();
  const client = buildClient(config);
  const response = await client.send(new GetObjectCommand({
    Bucket: parsed.bucket,
    Key: parsed.key
  }));
  if (!response?.Body) return Buffer.from('');
  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function deleteObjectByUri(storageUri = '') {
  const parsed = parseS3Uri(storageUri);
  if (!parsed) {
    return false;
  }
  const config = buildStorageConfig();
  const client = buildClient(config);
  await client.send(new DeleteObjectCommand({
    Bucket: parsed.bucket,
    Key: parsed.key
  }));
  return true;
}

async function presignPutObjectUrl({
  objectKey,
  contentType = 'application/octet-stream',
  expiresIn = 3600
} = {}) {
  const config = buildStorageConfig();
  ensureStorageConfig(config);
  const client = buildClient(config);
  const command = new PutObjectCommand({
    Bucket: config.bucket,
    Key: objectKey,
    ContentType: contentType
  });
  const url = await getSignedUrl(client, command, { expiresIn });
  return { uploadUrl: url, expiresIn, bucket: config.bucket };
}

async function headObjectMeta(objectKey = '') {
  const config = buildStorageConfig();
  ensureStorageConfig(config);
  const client = buildClient(config);
  try {
    const response = await client.send(new HeadObjectCommand({
      Bucket: config.bucket,
      Key: objectKey
    }));
    return {
      contentLength: Number(response.ContentLength ?? 0),
      contentType: String(response.ContentType || '')
    };
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    if (error?.name === 'NotFound' || status === 404) {
      const err = new Error('kb.presignObjectMissing');
      err.code = 'kb.presignObjectMissing';
      throw err;
    }
    throw error;
  }
}

module.exports = {
  buildStorageConfig,
  ensureStorageConfig,
  isS3Uri,
  parseS3Uri,
  buildS3Uri,
  buildUploadObjectKey,
  uploadLocalFile,
  uploadBuffer,
  getObjectBufferByUri,
  deleteObjectByUri,
  presignPutObjectUrl,
  headObjectMeta
};
