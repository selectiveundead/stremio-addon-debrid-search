import * as config from '../config.js';

let client = null;
let db = null;
let col = null;
let initPromise = null;

function isEnabled() {
  return Boolean(config.MONGO_CACHE_ENABLED && config.MONGO_URI);
}

async function initMongo() {
  if (!isEnabled()) return null;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const { MongoClient } = await import('mongodb');
    client = new MongoClient(config.MONGO_URI, { maxPoolSize: 5 });
    await client.connect();
    db = client.db(config.MONGO_DB_NAME);
    col = db.collection(config.MONGO_CACHE_COLLECTION);
    // TTL index on expiresAt (per-document expiry)
    await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    // Fast lookup + ensure uniqueness per service/hash
    await col.createIndex({ service: 1, hash: 1 }, { unique: true });
    // Release-level lookups
    await col.createIndex({ service: 1, releaseKey: 1 });
    await col.createIndex({ service: 1, releaseKey: 1, category: 1, resolution: 1 });
    return col;
  })();
  return initPromise;
}

async function getCollection() {
  if (!isEnabled()) return null;
  await initMongo();
  return col;
}

function ttlDate() {
  const days = Number(config.MONGO_CACHE_TTL_DAYS || 30);
  const ms = Date.now() + days * 24 * 60 * 60 * 1000;
  return new Date(ms);
}

// Upsert a cached magnet record
// record: { service, hash, fileName?, size?, data? }
export async function upsertCachedMagnet(record) {
  if (!isEnabled()) {
    console.log(`[MONGO CACHE] MongoDB cache is not enabled, skipping upsert for hash ${record.hash}`);
    return false;
  }
  try {
    const c = await getCollection();
    if (!c) return false;
    const service = String(record.service || '').toLowerCase();
    const hash = String(record.hash || '').toLowerCase();
    if (!service || !hash) {
      console.log(`[MONGO CACHE] Invalid service (${service}) or hash (${hash}) for upsert`);
      return false;
    }
    const now = new Date();
    const expiresAt = ttlDate();
    const update = {
      $set: {
        service,
        hash,
        fileName: record.fileName || null,
        size: typeof record.size === 'number' ? record.size : null,
        data: record.data || null,
        // Optional release-level metadata
        releaseKey: record.releaseKey || null,
        category: record.category || null,
        resolution: record.resolution || null,
        updatedAt: now,
        expiresAt
      },
      $setOnInsert: { createdAt: now }
    };
    console.log(`[MONGO CACHE] Upserting magnet record for service ${service}, hash ${hash}`);
    await c.updateOne({ service, hash }, update, { upsert: true });
    console.log(`[MONGO CACHE] Successfully upserted magnet record for service ${service}, hash ${hash}`);
    return true;
  } catch (error) {
    console.error(`[MONGO CACHE] Error upserting magnet record: ${error.message}`);
    return false;
  }
}

// Upsert multiple cached magnet records
export async function upsertCachedMagnets(records) {
  if (!isEnabled() || !Array.isArray(records) || records.length === 0) {
    return false;
  }
  try {
    const c = await getCollection();
    if (!c) return false;

    const now = new Date();
    const expiresAt = ttlDate();
    const operations = records.map(record => {
      const service = String(record.service || '').toLowerCase();
      const hash = String(record.hash || '').toLowerCase();
      if (!service || !hash) return null;

      return {
        updateOne: {
          filter: { service, hash },
          update: {
            $set: {
              service,
              hash,
              fileName: record.fileName || null,
              size: typeof record.size === 'number' ? record.size : null,
              data: record.data || null,
              releaseKey: record.releaseKey || null,
              category: record.category || null,
              resolution: record.resolution || null,
              updatedAt: now,
              expiresAt
            },
            $setOnInsert: { createdAt: now }
          },
          upsert: true
        }
      };
    }).filter(Boolean);

    if (operations.length > 0) {
      await c.bulkWrite(operations, { ordered: false });
    }
    return true;
  } catch (error) {
    console.error(`[MONGO CACHE] Error bulk upserting magnet records: ${error.message}`);
    return false;
  }
}

// Return Set of hashes known cached for the given service
export async function getCachedHashes(service, hashes) {
  if (!isEnabled()) {
    console.log(`[MONGO CACHE] MongoDB cache is not enabled, skipping check for ${hashes?.length || 0} hashes`);
    return new Set();
  }
  const c = await getCollection();
  if (!c || !Array.isArray(hashes) || hashes.length === 0) {
    console.log(`[MONGO CACHE] No collection or empty hashes array, returning empty set`);
    return new Set();
  }
  const lower = hashes.map(h => String(h || '').toLowerCase()).filter(Boolean);
  if (lower.length === 0) {
    console.log(`[MONGO CACHE] No valid hashes after normalization, returning empty set`);
    return new Set();
  }
  console.log(`[MONGO CACHE] Checking ${lower.length} hashes for service ${service}`);
  
  // Efficiently fetch all matching hashes in a single aggregation query
  const cursor = c.aggregate([
    { $match: { service: String(service || '').toLowerCase(), hash: { $in: lower } } },
    { $group: { _id: null, hashes: { $addToSet: "$hash" } } }
  ]);

  const result = await cursor.next();
  const foundHashes = result ? result.hashes : [];
  
  console.log(`[MONGO CACHE] Found ${foundHashes.length} cached hashes for service ${service}`);
  return new Set(foundHashes);
}

export async function getCachedRecord(service, hash) {
  if (!isEnabled()) {
    console.log(`[MONGO CACHE] MongoDB cache is not enabled, skipping single hash check for ${hash}`);
    return null;
  }
  const c = await getCollection();
  if (!c) return null;
  console.log(`[MONGO CACHE] Checking single hash ${hash} for service ${service}`);
  const result = c.findOne({ service: String(service || '').toLowerCase(), hash: String(hash || '').toLowerCase() });
  console.log(`[MONGO CACHE] Found cached record for hash ${hash}: ${result ? 'YES' : 'NO'}`);
  return result;
}

// Returns counts by category and by category+resolution for a given release key
// Shape: { byCategory: { Remux: n, BluRay: m, ... }, byCategoryResolution: { Remux: { '2160p': x, '1080p': y }, ... }, total: number }
export async function getReleaseCounts(service, releaseKey) {
  const empty = { byCategory: {}, byCategoryResolution: {}, total: 0 };
  if (!isEnabled()) return empty;
  const c = await getCollection();
  if (!c || !service || !releaseKey) return empty;
  const svc = String(service || '').toLowerCase();
  const rel = String(releaseKey);
  try {
    const cursor = c.find(
      { service: svc, releaseKey: rel },
      { projection: { _id: 0, category: 1, resolution: 1 } }
    );
    const byCategory = {};
    const byCategoryResolution = {};
    let total = 0;
    for await (const doc of cursor) {
      const cat = doc.category || 'Other';
      const res = doc.resolution || 'unknown';
      byCategory[cat] = (byCategory[cat] || 0) + 1;
      byCategoryResolution[cat] = byCategoryResolution[cat] || {};
      byCategoryResolution[cat][res] = (byCategoryResolution[cat][res] || 0) + 1;
      total += 1;
    }
    return { byCategory, byCategoryResolution, total };
  } catch (error) {
    console.error(`[MONGO CACHE] Error aggregating release counts for ${svc}/${rel}: ${error.message}`);
    return empty;
  }
}

export async function closeMongo() {
  try { await client?.close(); } catch (_) {}
  client = null; db = null; col = null; initPromise = null;
}

export default { isEnabled, initMongo, upsertCachedMagnet, upsertCachedMagnets, getCachedHashes, getCachedRecord, getReleaseCounts, closeMongo };
