import RealDebridClient from 'real-debrid-api';
import Fuse from 'fuse.js';
import PTT from './util/parse-torrent-title.js';
import Cinemeta from './util/cinemeta.js';
import RdLimiter from './util/rd-rate-limit.js';
const rdCall = (fn) => RdLimiter.schedule(fn);
import * as config from './config.js';
import * as scrapers from './common/scrapers.js';
import * as torrentUtils from './common/torrent-utils.js';
import { processAndFilterTorrents } from './common/debrid-cache-processor.js';
import { matchesSeriesTitle, hasEpisodeMarker } from './util/seriesTitleMatcher.js';
import { buildSeriesContext, matchesCandidateTitle } from './util/episodeMatcher.js';
import * as mongoCache from './common/mongo-cache.js';

const { isValidVideo, isValidTorrentTitle, getResolutionFromName, resolutionOrder, delay, filterByYear } = torrentUtils;
const LOG_PREFIX = 'RD';

// ---------------------------------------------------------------------------------
// Global state & Cache
// ---------------------------------------------------------------------------------

// Define quality category function locally since it's also defined in debrid-cache-processor.js
function getQualityCategory(torrentName) {
    const name = (torrentName || '').toLowerCase();
    
    if (config.PRIORITY_PENALTY_AAC_OPUS_ENABLED && /(\s|\.)(aac|opus)\b/.test(name)) {
        return 'Audio-Focused';
    }
    
    if (/\bremux\b/.test(name)) {
        return 'Remux';
    }

    if (/\b(web-?rip|brrip|dlrip|bluray\s*rip)\b/.test(name)) {
        return 'BRRip/WEBRip';
    }
    
    if (/\b(blu-?ray|bdrip)\b/.test(name)) {
        return 'BluRay';
    }

    if (/\b(web-?\.?dl|web\b)/.test(name)) {
        return 'WEB/WEB-DL';
    }

    return 'Other';
}
let globalAbortController = null;
// file cache removed

function createAbortController() {
  if (globalAbortController) globalAbortController.abort();
  globalAbortController = new AbortController();
  return globalAbortController;
}

function addHashToMongo(hash, fileName = null, size = null, data = null) {
  try {
    if (!hash || !mongoCache?.isEnabled()) return;
    const payload = { service: 'realdebrid', hash: String(hash).toLowerCase(), fileName, size, data };
    setImmediate(() => { mongoCache.upsertCachedMagnet(payload).catch(() => {}); });
  } catch (_) {}
}

function deferMongoUpserts(payloads = []) {
  try {
    if (!mongoCache?.isEnabled() || !Array.isArray(payloads) || payloads.length === 0) {
      return;
    }
    // Use setImmediate to defer the execution to the next I/O cycle
    setImmediate(() => {
      mongoCache.upsertCachedMagnets(payloads).catch(err => {
        console.error(`[RD MONGO] Background bulk upsert failed: ${err.message}`);
      });
    });
  } catch (err) {
    console.error(`[RD MONGO] Error deferring mongo upserts: ${err.message}`);
  }
}

function uniqueUpserts(payloads = []) {
  const seen = new Set();
  const out = [];
  for (const p of payloads) {
    const key = `${p.service || ''}:${(p.hash || '').toLowerCase()}`;
    if (!p.hash || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------
async function buildPersonalHashCache(apiKey) {
  try {
    const RD = new RealDebridClient(apiKey);
    const existingTorrents = await getAllTorrents(RD);
    const personalHashCache = new Set();
    existingTorrents.forEach(t => { if (t.hash) personalHashCache.add(t.hash.toLowerCase()); });
    console.log(`[RD CACHE] Built personal hash cache with ${personalHashCache.size} torrents`);
    return personalHashCache;
  } catch (error) {
    console.error(`[RD CACHE] Error building personal cache: ${error.message}`);
    return new Set();
  }
}

async function cleanupTemporaryTorrents(RD, torrentIds) {
  if (torrentIds.size === 0) return;
  console.log(`[RD CLEANUP] 🧹 Starting background deletion of ${torrentIds.size} temporary torrents.`);
  for (const torrentId of torrentIds) {
    try {
      await rdCall(() => RD.torrents.delete(torrentId));
    } catch (deleteError) {
      if (deleteError.response?.status === 429) {
        console.warn(`[RD CLEANUP] Rate limited. Pausing for 7 seconds...`);
        await delay(3000);
        await rdCall(() => RD.torrents.delete(torrentId)).catch(retryError => {
          console.error(`[RD CLEANUP] ❌ Failed to delete torrent ${torrentId} on retry: ${retryError.message}`);
        });
      } else {
        console.error(`[RD CLEANUP] ❌ Error deleting torrent ${torrentId}: ${deleteError.message}`);
      }
    }
  }
  console.log(`[RD CLEANUP] ✅ Finished background deletion task.`);
}

function norm(s) {
  return (s || '').replace(/[’'`]/g, '').replace(/\s+/g, ' ').toLowerCase().trim();
}

// ---------------------------------------------------------------------------------
// File cache removed: define no-ops to keep call sites harmless
// ---------------------------------------------------------------------------------
async function loadHashCache() { return; }
async function saveHashCache() { return; }
function addHashToCache(hash) { return; }
function isHashInCache(hash) { return false; }

// ---------------------------------------------------------------------------------
// Formatting & combining results
// ---------------------------------------------------------------------------------
function formatCachedResult(torrent, isCached) {
    const episodeHint = torrent.episodeFileHint || null;
    const definitiveTitle = episodeHint?.filePath || torrent.Title || torrent.name || 'Unknown Title';
    const definitiveSize = (episodeHint && typeof episodeHint.fileBytes === 'number' && episodeHint.fileBytes > 0)
        ? episodeHint.fileBytes
        : (torrent.Size || torrent.size || torrent.filesize || 0);

    let url;
    if (torrent.isPersonal) {
        url = `magnet:?xt=urn:btih:${torrent.hash}`;
    } else {
        const baseMagnet = `magnet:?xt=urn:btih:${torrent.InfoHash}`;
        if (episodeHint && torrent.InfoHash) {
            try {
                const hintPayload = { hash: (torrent.InfoHash || '').toLowerCase(), ...episodeHint };
                const encodedHint = Buffer.from(JSON.stringify(hintPayload)).toString('base64');
                url = `${baseMagnet}||HINT||${encodedHint}`;
            } catch { url = baseMagnet; }
        } else {
            url = baseMagnet;
        }
    }

    const searchableTitle = torrent.searchableName || definitiveTitle;

    return {
        name: definitiveTitle,
        info: PTT.parse(definitiveTitle) || { title: definitiveTitle },
        size: definitiveSize,
        seeders: torrent.Seeders || torrent.seeders || 0,
        url,
        source: 'realdebrid',
        hash: (torrent.InfoHash || torrent.hash || '').toLowerCase(),
        tracker: torrent.Tracker || (torrent.isPersonal ? 'Personal' : 'Cached'),
        isPersonal: torrent.isPersonal || false,
        isCached,
        languages: Array.isArray(torrent.Langs) ? torrent.Langs : [],
        ...(episodeHint?.filePath ? { searchableName: searchableTitle } : {}),
        ...(episodeHint ? { episodeHint } : {}),
        ...(torrent.id && { id: torrent.id }),
        ...(torrent.torrentId && { torrentId: torrent.torrentId }),
        ...(torrent.fileId && { fileId: torrent.fileId })
    };
}

function combineAndMarkResults(apiKey, personalFiles, externalSources, specificSearchKey) {
    const markedPersonal = personalFiles.map(file => ({ ...file, isPersonal: true, tracker: 'Personal' }));
    const externalTorrents = [].concat(...externalSources).map(t => ({ ...t, isPersonal: false }));
    const uniqueExternalTorrents = [...new Map(externalTorrents.map(t => [t.InfoHash?.toLowerCase(), t])).values()];
    const personalHashes = new Set(personalFiles.map(f => f.hash?.toLowerCase()).filter(Boolean));
    const newExternalTorrents = uniqueExternalTorrents.filter(t => t.InfoHash && !personalHashes.has(t.InfoHash.toLowerCase()));

    const saneResults = newExternalTorrents;
    
    const validTitleResults = saneResults.filter(t => isValidTorrentTitle(t.Title, LOG_PREFIX));

    return [...markedPersonal, ...validTitleResults];
}

async function inspectAndFilterNonCached(torrents, rdHandler) {
    console.log(`[RD] Inspecting ${torrents.length} top non-cached torrents for validity...`);
    const validTorrents = [];
    for (const torrent of torrents) {
        const isValid = await rdHandler.liveCheckHash(torrent.InfoHash);
        if (isValid) {
            console.log(`[RD] -> VALID: ${torrent.Title}`);
            validTorrents.push(torrent);
        } else {
            console.log(`[RD] -> REJECTED (see CACHE-CHECK logs for reason): ${torrent.Title}`);
        }
    }
    return validTorrents;
}

// ---------------------------------------------------------------------------------
// Main search functions
// ---------------------------------------------------------------------------------

async function searchRealDebridTorrents(apiKey, type, id, userConfig = {}) {
  if (!id || typeof id !== 'string') {
    return [];
  }

  const imdbId = id.split(':')[0];
  const [season, episode] = id.split(':').slice(1);
  const cinemetaDetails = await Cinemeta.getMeta(type, imdbId);
  if (!cinemetaDetails) return [];

  const searchKey = cinemetaDetails.name;
  const selectedLanguages = Array.isArray(userConfig.Languages) ? userConfig.Languages : [];
  const baseSearchKey = type === 'series'
    ? `${searchKey} s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`
    : `${searchKey} ${cinemetaDetails.year || ''}`.trim();
  
  const specificSearchKey = baseSearchKey;

  let episodeInfo = null;
  if (type === 'series' && season && episode) {
    episodeInfo = { season: parseInt(season, 10), episode: parseInt(episode, 10) };
  }
  const seriesCtx = type === 'series' ? buildSeriesContext({ search: specificSearchKey, cinemetaTitle: cinemetaDetails.name }) : null;

  console.log(`[${LOG_PREFIX}] Comprehensive search for: "${specificSearchKey}"`);
  const abortController = createAbortController();
  const signal = abortController.signal;

  const torrentIdsToDelete = new Set();

  try {
    // Phase 1: fetch personal files first
    let personalFiles = await searchPersonalFiles(apiKey, searchKey, 0.3);

    const isLikelyEpisode = (t) => seriesCtx ? matchesCandidateTitle(t, { ...seriesCtx }) : true;

    if (type === 'series' && episodeInfo) {
        const originalCount = personalFiles.length;
        personalFiles = personalFiles.filter(file => {
            const parsed = PTT.parse(file.name || '');
            return parsed.season === episodeInfo.season && parsed.episode === episodeInfo.episode;
        });
        if (personalFiles.length < originalCount) {
            console.log(`[${LOG_PREFIX}] Filtered personal files for S${episodeInfo.season}E${episodeInfo.episode}: ${originalCount} -> ${personalFiles.length}`);
        }
    }

    // Ensure personal files have category/resolution for quota checking
    const enrichedPersonalFiles = personalFiles.map(file => {
        if (!file.category) {
            return {
                ...file,
                category: getQualityCategory(file.name || file.Title),
                resolution: torrentUtils.getResolutionFromName(file.name || file.Title)
            };
        }
        return file;
    });

    // Compute personal quotas (category + per-resolution)
    const personalByCategory = {};
    const personalByCategoryResolution = {};
    for (const file of enrichedPersonalFiles) {
        if (!file.category) continue;
        personalByCategory[file.category] = (personalByCategory[file.category] || 0) + 1;
        if (file.resolution) {
            personalByCategoryResolution[file.category] = personalByCategoryResolution[file.category] || {};
            personalByCategoryResolution[file.category][file.resolution] = (personalByCategoryResolution[file.category][file.resolution] || 0) + 1;
        }
    }

    // Phase 1.5: if Mongo enabled, check release-level counts to potentially skip scrapers
    const releaseKey = makeReleaseKey(type, imdbId, episodeInfo?.season, episodeInfo?.episode);
    let mongoCounts = { byCategory: {}, byCategoryResolution: {}, total: 0 };
    if (mongoCache?.isEnabled()) {
      try {
        mongoCounts = await mongoCache.getReleaseCounts('realdebrid', releaseKey);
      } catch {}
    }

    // Combine personal + mongo counts per category+resolution
    const combinedByCategory = { ...mongoCounts.byCategory };
    const combinedByCategoryResolution = JSON.parse(JSON.stringify(mongoCounts.byCategoryResolution || {}));
    for (const [cat, count] of Object.entries(personalByCategory)) {
      combinedByCategory[cat] = (combinedByCategory[cat] || 0) + count;
    }
    for (const [cat, byRes] of Object.entries(personalByCategoryResolution)) {
      combinedByCategoryResolution[cat] = combinedByCategoryResolution[cat] || {};
      for (const [res, c] of Object.entries(byRes)) {
        combinedByCategoryResolution[cat][res] = (combinedByCategoryResolution[cat][res] || 0) + c;
      }
    }

    // Per-release-type limits (applied per resolution)
    const rdDefaultMax = parseInt(process.env.MAX_RESULTS_PER_QUALITY, 10) || 2;
    const rdQualityLimits = {
        'Remux': parseInt(process.env.MAX_RESULTS_REMUX, 10) || rdDefaultMax,
        'BluRay': parseInt(process.env.MAX_RESULTS_BLURAY, 10) || rdDefaultMax,
        'WEB/WEB-DL': parseInt(process.env.MAX_RESULTS_WEBDL, 10) || rdDefaultMax,
        'BRRip/WEBRip': parseInt(process.env.MAX_RESULTS_WEBRIP, 10) || 1,
        'Audio-Focused': parseInt(process.env.MAX_RESULTS_AUDIO, 10) || 1,
        'Other': parseInt(process.env.MAX_RESULTS_OTHER, 10) || 10
    };

    const HQ_CATEGORIES = ['Remux', 'BluRay', 'WEB/WEB-DL'];
    const HQ_RES = ['2160p', '1080p'];
    // Only allow early-exit when PERSONAL files alone satisfy high-res per-resolution quotas
    const personalHighResSatisfied = HQ_CATEGORIES.every(cat => {
      const limit = rdQualityLimits[cat];
      if (typeof limit !== 'number' || limit <= 0) return true;
      return HQ_RES.every(res => (personalByCategoryResolution?.[cat]?.[res] || 0) >= limit);
    });

    if (personalHighResSatisfied) {
      console.log(`[${LOG_PREFIX}] Personal quotas satisfy high-res limits for ${releaseKey}. Skipping torrent scrapers.`);
      // Opportunistically record personal files to Mongo for future runs
      try {
        if (mongoCache?.isEnabled()) {
          const upserts = [];
          for (const file of enrichedPersonalFiles) {
            if (!file.hash) continue;
            upserts.push({
              service: 'realdebrid',
              hash: String(file.hash).toLowerCase(),
              fileName: file.name || null,
              size: file.size || null,
              releaseKey,
              category: file.category || null,
              resolution: file.resolution || null,
              data: { source: 'personal' }
            });
          }
          deferMongoUpserts(uniqueUpserts(upserts));
        }
      } catch {}

      // Return only personal results (no scrapers)
      const combined = [...personalFiles];
      let allResults = combined.map(torrent => formatCachedResult(torrent, true));
      allResults.sort((a, b) => {
        const rankA = resolutionOrder[getResolutionFromName(a.name)];
        const rankB = resolutionOrder[getResolutionFromName(b.name)];
        if (rankA !== rankB) return rankB - rankA;
        return (b.size || 0) - (a.size || 0);
      });
      console.log(`[${LOG_PREFIX}] Early exit: ${allResults.length} personal streams (sorted)`);
      return allResults;
    }

    // Phase 2: build scrapers only if needed
    const scraperPromises = [];
    if (selectedLanguages.length === 0) {
      const cfg = { ...userConfig, Languages: [] };
      const key = baseSearchKey;
      if (config.BITMAGNET_ENABLED) scraperPromises.push(scrapers.searchBitmagnet(key, signal, LOG_PREFIX, cfg));
      if (config.JACKETT_ENABLED) scraperPromises.push(scrapers.searchJackett(key, signal, LOG_PREFIX, cfg));
      if (config.TORRENTIO_ENABLED) scraperPromises.push(scrapers.searchTorrentio(type, imdbId, signal, LOG_PREFIX, cfg));
      if (config.ZILEAN_ENABLED) scraperPromises.push(scrapers.searchZilean(searchKey, season, episode, signal, LOG_PREFIX, cfg));
      if (config.COMET_ENABLED) scraperPromises.push(scrapers.searchComet(type, imdbId, signal, season, episode, LOG_PREFIX, cfg));
      if (config.STREMTHRU_ENABLED) scraperPromises.push(scrapers.searchStremthru(key, signal, LOG_PREFIX, cfg));
      if (config.BT4G_ENABLED) scraperPromises.push(scrapers.searchBt4g(key, signal, LOG_PREFIX, cfg));
      if (config.TORRENT_GALAXY_ENABLED) scraperPromises.push(scrapers.searchTorrentGalaxy(key, signal, LOG_PREFIX, cfg));
      if (config.TORRENT_DOWNLOAD_ENABLED) scraperPromises.push(scrapers.searchTorrentDownload(key, signal, LOG_PREFIX, cfg));
      if (config.SNOWFL_ENABLED) scraperPromises.push(scrapers.searchSnowfl(key, signal, LOG_PREFIX, cfg));
    } else {
      for (const lang of selectedLanguages) {
        const cfg = { ...userConfig, Languages: [lang] };
        const key = baseSearchKey;
        if (config.BITMAGNET_ENABLED) scraperPromises.push(scrapers.searchBitmagnet(key, signal, LOG_PREFIX, cfg));
        if (config.JACKETT_ENABLED) scraperPromises.push(scrapers.searchJackett(key, signal, LOG_PREFIX, cfg));
        if (config.TORRENTIO_ENABLED) scraperPromises.push(scrapers.searchTorrentio(type, imdbId, signal, LOG_PREFIX, cfg));
        if (config.ZILEAN_ENABLED) scraperPromises.push(scrapers.searchZilean(searchKey, season, episode, signal, LOG_PREFIX, cfg));
        if (config.COMET_ENABLED) scraperPromises.push(scrapers.searchComet(type, imdbId, signal, season, episode, LOG_PREFIX, cfg));
        if (config.STREMTHRU_ENABLED) scraperPromises.push(scrapers.searchStremthru(key, signal, LOG_PREFIX, cfg));
        if (config.BT4G_ENABLED) scraperPromises.push(scrapers.searchBt4g(key, signal, LOG_PREFIX, cfg));
        if (config.TORRENT_GALAXY_ENABLED) scraperPromises.push(scrapers.searchTorrentGalaxy(key, signal, LOG_PREFIX, cfg));
        if (config.TORRENT_DOWNLOAD_ENABLED) scraperPromises.push(scrapers.searchTorrentDownload(key, signal, LOG_PREFIX, cfg));
        if (config.SNOWFL_ENABLED) scraperPromises.push(scrapers.searchSnowfl(key, signal, LOG_PREFIX, cfg));
      }
    }

    const scraperResults = await Promise.all(scraperPromises);
    let combinedResults = combineAndMarkResults(apiKey, personalFiles, scraperResults, specificSearchKey);
    let externalTorrents = combinedResults.filter(t => !t.isPersonal);
    
    if (episodeInfo) {
        externalTorrents = externalTorrents.filter(t => isLikelyEpisode(t));
        // Strict gate: if an explicit S/E is present in title, require exact match; allow season-only packs
        const s = episodeInfo.season, e = episodeInfo.episode;
        externalTorrents = externalTorrents.filter(t => {
            try {
                const p = PTT.parse(t.Title || t.name || '');
                if (p && p.season != null && p.episode != null) {
                    return Number(p.season) === Number(s) && Number(p.episode) === Number(e);
                }
                if (p && p.season != null && (p.episode === undefined || Array.isArray(p.episode))) {
                    return Number(p.season) === Number(s);
                }
            } catch {}
            return true;
        });
    }
    
    if (type === 'movie') {
        // 1) Exclude season packs/episodes outright for movie searches
        externalTorrents = externalTorrents.filter(t => {
            try {
                const title = t.Title || t.name || '';
                if (torrentUtils.isSeriesLikeTitle(title)) return false;
                const parsed = PTT.parse(title) || {};
                if (parsed.season != null || parsed.seasons) return false;
            } catch {}
            return true;
        });
        // 2) Apply year sanity when available
        if (cinemetaDetails.year) {
            externalTorrents = externalTorrents.filter(torrent => filterByYear(torrent, cinemetaDetails, LOG_PREFIX));
        }
    }

    await loadHashCache();
    const RD = new RealDebridClient(apiKey);
    const failedPackHashes = new Set();
    const successfulPackResults = new Map();

    const rdHandler = {
        getIdentifier: () => LOG_PREFIX,
        checkCachedHashes: async (hashes) => {
            const cached = new Set();
            // Prefer Mongo cache when enabled
            try {
              if (mongoCache?.isEnabled()) {
                return await mongoCache.getCachedHashes('realdebrid', hashes);
              }
            } catch {}
            // File cache removed; rely on Mongo only
            return cached;
        },
        liveCheckHash: async (hash) => {
            let torrentId;
            try {
                const magnet = `magnet:?xt=urn:btih:${hash}`;
                const addResponse = await rdCall(() => RD.torrents.addMagnet(magnet).catch(() => null));
                if (!addResponse?.data?.id) {
                  console.log(`[${LOG_PREFIX} CACHE-CHECK] addMagnet failed for ${hash}`);
                  return false;
                }
                torrentId = addResponse.data.id;
                torrentIdsToDelete.add(torrentId);
                await rdCall(() => RD.torrents.selectFiles(torrentId, 'all'));
                const torrentInfo = await rdCall(() => RD.torrents.info(torrentId).catch(() => null));
                const status = torrentInfo?.data?.status || 'unknown';
                if (!['downloaded', 'finished'].includes(status)) {
                  console.log(`[${LOG_PREFIX} CACHE-CHECK] ${hash} not cached (status=${status}).`);
                  return false;
                }
                const files = torrentInfo?.data?.files || [];
                const JUNK_EXTENSIONS = ['.iso', '.exe', '.zip', '.rar', '.7z', '.scr'];
                const hasJunk = files.some(f => JUNK_EXTENSIONS.some(ext => f.path.toLowerCase().endsWith(ext)));
                const hasVideo = files.some(f => isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX));
                if (!hasVideo) {
                  console.log(`[${LOG_PREFIX} CACHE-CHECK] ${hash} has no valid video files after finish.`);
                  return false;
                }
                if (hasJunk) {
                  const sample = files.find(f => JUNK_EXTENSIONS.some(ext => f.path.toLowerCase().endsWith(ext)))?.path || 'unknown';
                  console.log(`[${LOG_PREFIX} CACHE-CHECK] ${hash} contains junk file(s) e.g. ${sample}.`);
                  return false;
                }
                // Persist to Mongo only (file cache removed)
                try {
                  const largestVideo = files
                    .filter(f => isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX))
                    .sort((a,b) => (b.bytes||0)-(a.bytes||0))[0] || null;
                  await addHashToMongo(hash, largestVideo?.path || null, largestVideo?.bytes || null, { status });
                } catch {}
                return true;
            } catch (e) {
              console.log(`[${LOG_PREFIX} CACHE-CHECK] Exception during live check for ${hash}: ${e?.message || e}`);
            }
            return false;
        },
        batchCheckSeasonPacks: async (hashes, season, episode) => {
            const MAX_PACKS_TO_INSPECT = config.MAX_PACKS_TO_INSPECT || 3;
            const packResults = new Map();
            let inspectedCount = 0;
            
            for (const hash of hashes) {
                if (inspectedCount >= MAX_PACKS_TO_INSPECT) break;
                try {
                    let torrentId;
                    const torrentsResponse = await rdCall(() => RD.torrents.get(0, 1, 100));
                    const existingTorrent = (torrentsResponse.data || []).find(t => t.hash && t.hash.toLowerCase() === hash.toLowerCase());
                    
                    if (existingTorrent) {
                        torrentId = existingTorrent.id;
                    } else {
                        const magnet = `magnet:?xt=urn:btih:${hash}`;
                        const addResponse = await rdCall(() => RD.torrents.addMagnet(magnet));
                        if (!addResponse?.data?.id) continue;
                        torrentId = addResponse.data.id;
                        torrentIdsToDelete.add(torrentId);
                        await rdCall(() => RD.torrents.selectFiles(torrentId, 'all'));
                    }
                    const info = await rdCall(() => RD.torrents.info(torrentId));
                    if (!info?.data?.files) continue;

                    const JUNK_EXTENSIONS = ['.iso', '.exe', '.zip', '.rar', '.7z', '.scr'];
                    const matchingFiles = info.data.files.filter(file => {
                        const isJunk = JUNK_EXTENSIONS.some(ext => file.path.toLowerCase().endsWith(ext));
                        if (isJunk) return false; // Reject junk files

                        const parsed = PTT.parse(file.path) || {};
                        return parsed.season === season && parsed.episode === episode;
                    });

                    if (matchingFiles.length > 0) {
                        matchingFiles.sort((a, b) => b.bytes - a.bytes);
                        const bestFile = matchingFiles[0];
                        const episodeResult = {
                            InfoHash: hash, Title: bestFile.path, name: bestFile.path, Size: bestFile.bytes,
                            size: bestFile.bytes, Seeders: 0, Tracker: 'Pack Inspection',
                            episodeFileHint: { filePath: bestFile.path, fileBytes: bestFile.bytes, torrentId: torrentId, fileId: bestFile.id },
                            isCached: true, isFromPack: true, packHash: hash, searchableName: info.data.filename
                        };
                        successfulPackResults.set(hash.toLowerCase(), episodeResult);
                        packResults.set(hash, [episodeResult]);
                        inspectedCount++;
                    }
                } catch (error) {
                    if (error.response?.status === 429) {
                        console.warn(`[RD PACK INSPECT] Rate limited on pack ${hash.substring(0,8)}. Pausing for 2s.`);
                        await delay(2000);
                    }
                    console.error(`[RD PACK INSPECT] 💥 Error inspecting pack ${hash}: ${error.message}`);
                    failedPackHashes.add(hash.toLowerCase());
                }
            }
            return packResults;
        },
        cleanup: async () => {}
    };

    // Check if personal files already satisfy quality quotas before checking external cache
    // (Limits rdDefaultMax/rdQualityLimits already defined above in this function)

    // Compose combined quotas (personal + mongo) for processor to only fill the delta
    const combinedQuotas = { byCategory: combinedByCategory, byCategoryResolution: combinedByCategoryResolution };

    // Record personal files to Mongo (release-aware)
    try {
      if (mongoCache?.isEnabled()) {
        const upserts = [];
        for (const file of enrichedPersonalFiles) {
          if (!file.hash) continue;
          upserts.push({
            service: 'realdebrid',
            hash: String(file.hash).toLowerCase(),
            fileName: file.name || null,
            size: file.size || null,
            releaseKey,
            category: file.category || null,
            resolution: file.resolution || null,
            data: { source: 'personal' }
          });
        }
        deferMongoUpserts(upserts);
      }
    } catch {}

    let cachedResults = [];
    let nonCachedTorrents = [];
    
    let shouldProcessExternalTorrents = true; // we only got here if not early-exit
    if (shouldProcessExternalTorrents) {
        cachedResults = await processAndFilterTorrents(externalTorrents, rdHandler, episodeInfo, combinedQuotas);
        nonCachedTorrents = externalTorrents.filter(t => !cachedResults.some(c => c.InfoHash === t.InfoHash));
    } else {
        console.log(`[RD] Skipping external torrent cache checks - personal files already meet quality quotas`);
        nonCachedTorrents = externalTorrents;
    }
    
    if (nonCachedTorrents.length > 0) {
      const topNonCached = nonCachedTorrents
        .sort((a, b) => (b.Seeders || 0) - (a.Seeders || 0))
        .slice(0, 5);
      
      const verifiedNonCached = await inspectAndFilterNonCached(topNonCached, rdHandler);
      cachedResults.push(...verifiedNonCached.map(t => ({ ...t, isCached: false })));

      // Persist newly confirmed cached results to Mongo with release metadata for future runs
      try {
        if (mongoCache?.isEnabled()) {
          const upserts = [];
          for (const t of cachedResults) {
            const hash = (t.InfoHash || t.hash || '').toLowerCase();
            if (!hash) continue;
            upserts.push({
              service: 'realdebrid',
              hash,
              fileName: t.name || t.Title || null,
              size: t.size || t.Size || null,
              releaseKey,
              category: t.category || getQualityCategory(t.name || t.Title || ''),
              resolution: torrentUtils.getResolutionFromName(t.name || t.Title || ''),
              data: { source: t.isPersonal ? 'personal' : (t.isCached ? 'cached' : 'checked') }
            });
          }
          deferMongoUpserts(uniqueUpserts(upserts));
        }
      } catch {}
    }

    // No extra safety-net write here to avoid duplicate upserts/logs

    const combined = [...personalFiles, ...cachedResults];
    let allResults = combined.map(torrent => formatCachedResult(torrent, torrent.isCached));

    allResults.sort((a, b) => {
      const rankA = resolutionOrder[getResolutionFromName(a.name)];
      const rankB = resolutionOrder[getResolutionFromName(b.name)];
      if (rankA !== rankB) return rankB - rankA;
      return (b.size || 0) - (a.size || 0);
    });

    console.log(`[${LOG_PREFIX}] Comprehensive total: ${allResults.length} streams (sorted)`);
    return allResults;

  } catch (error) {
    console.error(`[${LOG_PREFIX}] Comprehensive search failed: ${error.message}`);
    return [];
  } finally {
    await saveHashCache();
    if (abortController === globalAbortController) globalAbortController = null;
    cleanupTemporaryTorrents(new RealDebridClient(apiKey), torrentIdsToDelete);
  }
}

async function searchTorrents(apiKey, searchKey = null, threshold = 0.3) {
  await loadHashCache(); // no-op; file cache removed
  const RD = new RealDebridClient(apiKey);
  const torrentIdsToDelete = new Set();
  const rdHandler = {
    getIdentifier: () => LOG_PREFIX,
    checkCachedHashes: async (hashes) => {
      const cached = new Set();
      try {
        if (mongoCache?.isEnabled()) {
          return await mongoCache.getCachedHashes('realdebrid', hashes);
        }
      } catch {}
      return cached;
    },
    liveCheckHash: async (hash) => {
      let torrentId;
      try {
        const magnet = `magnet:?xt=urn:btih:${hash}`;
        const addResponse = await rdCall(() => RD.torrents.addMagnet(magnet).catch(() => null));
        if (!addResponse?.data?.id) {
          console.log(`[${LOG_PREFIX} CACHE-CHECK] addMagnet failed for ${hash}`);
          return false;
        }
        torrentId = addResponse.data.id;
        torrentIdsToDelete.add(torrentId);
        await rdCall(() => RD.torrents.selectFiles(torrentId, 'all'));
        const torrentInfo = await rdCall(() => RD.torrents.info(torrentId).catch(() => null));
        const status = torrentInfo?.data?.status || 'unknown';
        if (!['downloaded', 'finished'].includes(status)) {
          console.log(`[${LOG_PREFIX} CACHE-CHECK] ${hash} not cached (status=${status}).`);
          return false;
        }
        const files = torrentInfo?.data?.files || [];
        const hasVideo = files.some(f => f.selected && isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX));
        const hasJunk = files.some(f => /\.(iso|exe|zip|rar|7z)$/i.test(f.path));
        if (!hasVideo) {
          console.log(`[${LOG_PREFIX} CACHE-CHECK] ${hash} has no valid video files after finish.`);
          return false;
        }
        if (hasJunk) {
          const sample = files.find(f => /(\.iso|\.exe|\.zip|\.rar|\.7z)$/i.test(f.path))?.path || 'unknown';
          console.log(`[${LOG_PREFIX} CACHE-CHECK] ${hash} contains junk file(s) e.g. ${sample}.`);
          return false;
        }
        return true;
      } catch (e) {
        console.log(`[${LOG_PREFIX} CACHE-CHECK] Exception during live check for ${hash}: ${e?.message || e}`);
      }
      return false;
    },
    cleanup: async () => {
      await saveHashCache(); // no-op; file cache removed
      if (torrentIdsToDelete.size > 0) cleanupTemporaryTorrents(RD, Array.from(torrentIdsToDelete));
    }
  };
  let cachedResults = await processAndFilterTorrents(externalTorrents, rdHandler, null);
  if (externalTorrents.length > 0) {
      const nonCached = externalTorrents.filter(t => !cachedResults.some(c => c.InfoHash === t.InfoHash));
      const verifiedNonCached = await inspectAndFilterNonCached(nonCached.sort((a,b) => (b.Seeders||0) - (a.Seeders||0)).slice(0,5), rdHandler);
      cachedResults.push(...verifiedNonCached.map(t => ({...t, isCached: false})));
  }
  return cachedResults;
}

// ---------------------------------------------------------------------------------
// Other functions
// ---------------------------------------------------------------------------------

async function searchPersonalFiles(apiKey, searchKey, threshold = 0.3) {
  const RD = new RealDebridClient(apiKey);
  try {
    const [existingTorrents, existingDownloads] = await Promise.all([
      getAllTorrents(RD).catch(() => []),
      getAllDownloads(RD).catch(() => [])
    ]);
    const relevantTorrents = filterFilesByKeywords(existingTorrents, searchKey);
    const relevantDownloads = filterFilesByKeywords(existingDownloads, searchKey);
    const torrentFiles = await processTorrents(RD, relevantTorrents.slice(0, 5));
    const allFiles = [...torrentFiles, ...relevantDownloads.map(d => formatDownloadFile(d))];
    if (allFiles.length === 0) return [];
    const uniqueFiles = [...new Map(allFiles.map(file => [file.url, file])).values()];
    const enhancedFiles = uniqueFiles.map(file => ({ ...file, isPersonal: true, info: PTT.parse(file.name) }));
    const fuse = new Fuse(enhancedFiles, { keys: ['info.title', 'name'], threshold, minMatchCharLength: 2 });
    return fuse.search(searchKey).map(r => r.item);
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Personal files error: ${error.message}`);
    return [];
  }
}

async function resolveStreamUrl(apiKey, encodedUrl, clientIp) {
    try {
        let decodedUrl = decodeURIComponent(encodedUrl).trim();
        if (decodedUrl.includes('magnet:')) {
            const result = await resolveMagnetUrl(apiKey, decodedUrl, clientIp);
            if (!result) return null;
            if (result.startsWith('http')) return result;
            if (result.startsWith('realdebrid:')) return await unrestrictUrl(apiKey, result, clientIp);
            if (result.includes('magnet:')) return await processMagnetAlternative(apiKey, result, clientIp);
            return result;
        } else {
            return await unrestrictUrl(apiKey, decodedUrl, clientIp);
        }
    } catch (error) {
        console.error(`[${LOG_PREFIX}] Error in resolveStreamUrl: ${error.message}`);
        return null;
    }
}

async function processMagnetAlternative(apiKey, magnetUrl, clientIp) {
  const RD = new RealDebridClient(apiKey, { ip: clientIp });
  try {
    const hashMatch = magnetUrl.match(/urn:btih:([a-fA-F0-9]+)/);
    if (!hashMatch?.[1]) return null;
    const hash = hashMatch[1].toLowerCase();
    // file cache removed; try API directly
    const addResponse = await rdCall(() => RD.torrents.addMagnet(magnetUrl));
    if (!addResponse?.data?.id) return null;
    const torrentId = addResponse.data.id;
    await rdCall(() => RD.torrents.selectFiles(torrentId, 'all'));
    let info = await rdCall(() => RD.torrents.info(torrentId));
    if (!info.data.files || !info.data.links) return null;
    const withLinks = info.data.files
      .map((f, i) => ({ ...f, link: info.data.links[i], i }))
      .filter(f => (f.selected !== false) && f.link && f.link !== 'undefined');
    if (withLinks.length === 0) return null;
    let selected = withLinks.find(f => isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX));
    if (!selected) { withLinks.sort((a, b) => b.bytes - a.bytes); selected = withLinks[0]; }
    // file cache removed; rely on Mongo upsert only
    try { await addHashToMongo(hash, selected?.path || null, selected?.bytes || null, { torrentId }); } catch {}
    return `realdebrid:${torrentId}:${selected.id}`;
  } catch {
    return null;
  }
}

async function resolveMagnetUrl(apiKey, magnetUrl, clientIp) {
  const RD = new RealDebridClient(apiKey, { ip: clientIp });
  try {
    const m = magnetUrl.match(/urn:btih:([a-fA-F0-9]+)/);
    if (!m?.[1]) return null;
    const hash = m[1].toLowerCase();
    let torrentId = null;
    try {
      const torrentsResponse = await rdCall(() => RD.torrents.get(0, 1, 100));
      const hit = (torrentsResponse.data || []).find(t => t.hash && t.hash.toLowerCase() === hash && ['downloaded', 'finished', 'uploading'].includes(t.status));
      if (hit) torrentId = hit.id;
    } catch {}
    if (!torrentId) {
      const addResponse = await rdCall(() => RD.torrents.addMagnet(magnetUrl));
      if (!addResponse?.data?.id) return null;
      torrentId = addResponse.data.id;
    }
    await rdCall(() => RD.torrents.selectFiles(torrentId, 'all'));
    let info = await rdCall(() => RD.torrents.info(torrentId));
    if (!info?.data?.files) return null;
    if (!info.data.links || !Array.isArray(info.data.links)) {
        await delay(200);
        info = await rdCall(() => RD.torrents.info(torrentId));
        if (!info.data.links || !Array.isArray(info.data.links)) return null;
    }
    const filesWithLinks = info.data.files
      .map((file, index) => ({ ...file, link: info.data.links[index], index }))
      .filter(f => f.selected !== false && f.link && f.link !== 'undefined');
    if (filesWithLinks.length === 0) return null;
    let selected = filesWithLinks.find(f => isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX));
    if (!selected) { filesWithLinks.sort((a, b) => b.bytes - a.bytes); selected = filesWithLinks[0]; }
    // file cache removed; rely on Mongo upsert only
    try { await addHashToMongo(hash, selected?.path || null, selected?.bytes || null, { torrentId }); } catch {}
    return `realdebrid:${torrentId}:${selected.id}`;
  } catch {
    return null;
  }
}

async function unrestrictUrl(apiKey, hostUrl, clientIp) {
  const RD = new RealDebridClient(apiKey, { ip: clientIp });
  try {
    if (!hostUrl || hostUrl.includes('undefined')) return null;
    if (hostUrl.startsWith('realdebrid:')) {
      const parts = hostUrl.split(':');
      const torrentId = parts[1];
      const fileId = parts[2];
      if (!torrentId || !fileId) return null;
      const info = await rdCall(() => RD.torrents.info(torrentId));
      if (!info?.data?.links) return null;
      const idx = info.data.files.findIndex(f => f.id.toString() === fileId.toString());
      if (idx === -1) return null;
      const directLink = info.data.links[idx];
      if (!directLink || directLink === 'undefined') return null;
      const response = await rdCall(() => RD.unrestrict.link(directLink));
      return response?.data?.download || null;
    } else if (hostUrl.includes('magnet:')) {
      const fileReference = await resolveMagnetUrl(apiKey, hostUrl, clientIp);
      if (!fileReference) return null;
      if (fileReference.startsWith('http')) return fileReference;
      return await unrestrictUrl(apiKey, fileReference, clientIp);
    } else {
      const response = await rdCall(() => RD.unrestrict.link(hostUrl));
      return response?.data?.download || null;
    }
  } catch {
    return null;
  }
}

async function getAllTorrents(RD) {
  const allTorrents = [];
  try {
    for (let page = 1; page <= 2; page++) {
      const response = await rdCall(() => RD.torrents.get(0, page, 100));
      const torrents = response.data;
      if (!torrents || torrents.length === 0) break;
      allTorrents.push(...torrents);
      if (torrents.length < 50) break;
    }
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error fetching torrents: ${error.message}`);
  }
  return allTorrents;
}

async function getAllDownloads(RD) {
  try {
    const response = await rdCall(() => RD.downloads.get(0, 1, 100));
    return (response.data || []).filter(d => d.host !== 'real-debrid.com');
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error fetching downloads: ${error.message}`);
    return [];
  }
}

async function processTorrents(RD, torrents) {
  const allVideoFiles = [];
  for (const torrent of torrents.slice(0, 3)) {
    try {
      const info = await rdCall(() => RD.torrents.info(torrent.id));
      if (!info?.data?.files || !info.data.links) continue;
      const videoFiles = info.data.files.filter(file => file.selected && isValidVideo(file.path, file.bytes, 50 * 1024 * 1024, LOG_PREFIX));
      for (const file of videoFiles) {
        const fileReference = `realdebrid:${torrent.id}:${file.id}`;
        allVideoFiles.push({
            id: `${torrent.id}:${file.id}`,
            name: file.path,
            info: PTT.parse(file.path),
            size: file.bytes,
            hash: torrent.hash,
            url: fileReference,
            isPersonal: true,
            isCached: true,
            tracker: 'Personal',
            category: getQualityCategory(file.path),
            resolution: torrentUtils.getResolutionFromName(file.path),
            torrentId: torrent.id,
            fileId: file.id
        });
      }
    } catch (error) {
      console.error(`[${LOG_PREFIX}] Error processing torrent ${torrent.id}: ${error.message}`);
    }
  }
  return allVideoFiles;
}

function formatDownloadFile(download) {
  return {
    id: download.id,
    name: download.filename,
    info: PTT.parse(download.filename),
    size: download.filesize,
    url: download.download,
    isPersonal: true,
    isCached: true,
    tracker: 'Personal',
    category: getQualityCategory(download.filename),
    resolution: torrentUtils.getResolutionFromName(download.filename)
  };
}

function filterFilesByKeywords(files, searchKey) {
  const keywords = (searchKey || '').toLowerCase().split(' ').filter(w => w.length > 2);
  return files.filter(file => {
    const fileName = (file.filename || '').toLowerCase();
    return keywords.some(k => fileName.includes(k));
  });
}

async function listTorrents(apiKey, skip = 0) {
  const RD = new RealDebridClient(apiKey);
  const page = Math.floor(skip / 50) + 1;
  try {
    const response = await rdCall(() => RD.torrents.get(0, page, 100));
    const metas = (response.data || []).map(torrent => ({
      id: 'realdebrid:' + torrent.id,
      name: torrent.filename || 'Unknown',
      type: 'other',
      poster: null,
      background: null
    }));
    console.log(`[${LOG_PREFIX}] Returning ${metas.length} catalog items`);
    return metas;
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Catalog error: ${error.message}`);
    return [];
  }
}

async function getTorrentDetails(apiKey, id) {
  const RD = new RealDebridClient(apiKey);
  const torrentId = id.includes(':') ? id.split(':')[0] : id;
  try {
    const response = await rdCall(() => RD.torrents.info(torrentId));
    return toTorrentDetails(apiKey, response.data);
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Torrent details error: ${error.message}`);
    return {
      source: 'realdebrid',
      id: torrentId,
      name: 'Unknown Torrent',
      type: 'other',
      hash: null,
      info: { title: 'Unknown' },
      size: 0,
      created: new Date(),
      videos: []
    };
  }
}

async function toTorrentDetails(apiKey, item) {
  if (!item || !item.files) {
    return {
      source: 'realdebrid',
      id: item?.id || 'unknown',
      name: item?.filename || 'Unknown Torrent',
      type: 'other',
      hash: item?.hash || null,
      info: PTT.parse(item?.filename || '') || { title: 'Unknown' },
      size: item?.bytes || 0,
      created: new Date(item?.added || Date.now()),
      videos: []
    };
  }
  const videos = item.files
    .filter(file => file.selected && isValidVideo(file.path, file.bytes, 50 * 1024 * 1024, LOG_PREFIX))
    .map((file, index) => {
      const idx = item.files.findIndex(f => f.id === file.id);
      const hostUrl = item.links?.[idx];
      if (!hostUrl || hostUrl === 'undefined') return null;
      return {
        id: `${item.id}:${file.id}`,
        name: file.path,
        url: hostUrl,
        size: file.bytes,
        created: new Date(item.added),
        info: PTT.parse(file.path)
      };
    })
    .filter(Boolean);
  return {
    source: 'realdebrid',
    id: item.id,
    name: item.filename,
    type: 'other',
    hash: item.hash,
    info: PTT.parse(item.filename),
    size: item.bytes,
    created: new Date(item.added),
    videos: videos || []
  };
}

async function searchDownloads(apiKey, searchKey = null, threshold = 0.3) {
  if (!searchKey) return [];
  try {
    const RD = new RealDebridClient(apiKey);
    const downloads = await getAllDownloads(RD);
    const relevant = filterFilesByKeywords(downloads, searchKey).map(d => formatDownloadFile(d));
    const fuse = new Fuse(relevant, { keys: ['info.title', 'name'], threshold });
    return fuse.search(searchKey).map(r => r.item);
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Downloads search error: ${error.message}`);
    return [];
  }
}

async function checkAndProcessCache(apiKey, externalTorrents) {
  await loadHashCache(); // no-op; file cache removed
  const RD = new RealDebridClient(apiKey);
  const torrentIdsToDelete = new Set();
  const rdHandler = {
    getIdentifier: () => LOG_PREFIX,
    checkCachedHashes: async (hashes) => {
      const cached = new Set();
      try {
        if (mongoCache?.isEnabled()) {
          return await mongoGetCachedHashes('realdebrid', hashes);
        }
      } catch {}
      return cached;
    },
    liveCheckHash: async (hash) => {
      let torrentId;
      try {
        const magnet = `magnet:?xt=urn:btih:${hash}`;
        const addResponse = await rdCall(() => RD.torrents.addMagnet(magnet).catch(() => null));
        if (!addResponse?.data?.id) return false;
        torrentId = addResponse.data.id;
        torrentIdsToDelete.add(torrentId);
        await rdCall(() => RD.torrents.selectFiles(torrentId, 'all'));
        const torrentInfo = await rdCall(() => RD.torrents.info(torrentId).catch(() => null));
        if (['downloaded', 'finished'].includes(torrentInfo?.data?.status)) {
          const files = torrentInfo.data.files || [];
          const hasVideo = files.some(f => f.selected && isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX));
          const hasJunk = files.some(f => /\.(iso|exe|zip|rar|7z)$/i.test(f.path));
          if (hasVideo && !hasJunk) {
        // file cache removed; rely on Mongo upsert (if used elsewhere)
        return true;
          }
        }
      } catch {}
      return false;
    },
    cleanup: async () => {
      await saveHashCache(); // no-op; file cache removed
      if (torrentIdsToDelete.size > 0) cleanupTemporaryTorrents(RD, Array.from(torrentIdsToDelete));
    }
  };
  let cachedResults = await processAndFilterTorrents(externalTorrents, rdHandler, null);
  if (externalTorrents.length > 0) {
      const nonCached = externalTorrents.filter(t => !cachedResults.some(c => c.InfoHash === t.InfoHash));
      const verifiedNonCached = await inspectAndFilterNonCached(nonCached.sort((a,b) => (b.Seeders||0) - (a.Seeders||0)).slice(0,5), rdHandler);
      cachedResults.push(...verifiedNonCached.map(t => ({...t, isCached: false})));
  }
  return cachedResults;
}


export default {
  listTorrents,
  searchTorrents,
  searchDownloads,
  getTorrentDetails,
  unrestrictUrl,
  searchRealDebridTorrents,
  buildPersonalHashCache,
  resolveStreamUrl,
  validatePersonalStreams
};
function makeReleaseKey(type, imdbId, season = null, episode = null) {
  if (type === 'series' && season != null && episode != null) {
    return `${type}:${imdbId}:S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}`;
  }
  return `${type}:${imdbId}`;
}

async function validatePersonalStreams(apiKey, streams) {
    if (!apiKey || !Array.isArray(streams) || streams.length === 0) {
        return streams;
    }

    // Helper to extract hash from a Stremio stream object
    const getHash = (stream) => {
        if (stream.url && stream.url.includes('btih:')) {
            const match = stream.url.match(/btih:([a-fA-F0-9]{40})/i);
            if (match) return match[1].toLowerCase();
        }
        if (stream.behaviorHints && stream.behaviorHints.bingeGroup) {
            const parts = stream.behaviorHints.bingeGroup.split('|');
            if (parts.length > 1 && parts[1].length === 40) {
                return parts[1].toLowerCase();
            }
        }
        return null;
    };

    const streamsToValidate = streams.filter(s => s.title && s.title.includes('| Personal'));
    if (streamsToValidate.length === 0) {
        return streams;
    }

    console.log(`[RD VALIDATE] Validating ${streamsToValidate.length} personal streams...`);

    try {
        const RD = new RealDebridClient(apiKey);
        const userTorrents = await getAllTorrents(RD).catch(() => []);
        const userHashes = new Set(userTorrents.map(t => t.hash.toLowerCase()));

        let validatedCount = 0;
        const updatedStreams = streams.map(stream => {
            if (stream.title && stream.title.includes('| Personal')) {
                const streamHash = getHash(stream);

                // We can only validate torrents with a hash.
                if (streamHash && !userHashes.has(streamHash)) {
                    validatedCount++;

                    // Re-format the title from "Personal" to "Cached"
                    let newTitle = stream.title.replace('[Cloud]', '').trim();
                    newTitle = newTitle.replace(/☁️/g, '💾');
                    newTitle = newTitle.replace('| Personal', '| Cached');

                    return { ...stream, title: newTitle };
                }
            }
            return stream;
        });

        if (validatedCount > 0) {
            console.log(`[RD VALIDATE] ${validatedCount} streams updated from Personal to Cached.`);
        }

        return updatedStreams;
    } catch (error) {
        console.error(`[RD VALIDATE] Error validating personal streams: ${error.message}`);
        return streams;
    }
}
