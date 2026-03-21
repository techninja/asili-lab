import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.CACHE_DIR || path.resolve(__dirname, '../../cache');
const PGS_FILES_DIR = path.join(CACHE_DIR, 'pgs_files');
const RATE_LIMIT = 30; // requests per minute
const RATE_WINDOW = 60 * 1000; // 1 minute in ms
const MIN_DELAY = 100; // minimum 100ms between requests

const MAX_CONCURRENT_DOWNLOADS = 5;

class PGSApiClient {
  constructor() {
    this.requestTimes = [];
    this._downloadQueue = [];
    this._activeDownloads = 0;
  }

  _acquireDownloadSlot() {
    if (this._activeDownloads < MAX_CONCURRENT_DOWNLOADS) {
      this._activeDownloads++;
      return Promise.resolve();
    }
    return new Promise(resolve => this._downloadQueue.push(resolve));
  }

  _releaseDownloadSlot() {
    if (this._downloadQueue.length > 0) {
      this._downloadQueue.shift()();
    } else {
      this._activeDownloads--;
    }
  }

  async ensureCacheDir() {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.mkdir(PGS_FILES_DIR, { recursive: true });
  }

  getCacheFilePath(url) {
    const urlObj = new URL(url);
    const domain = urlObj.hostname;
    const pathParts = urlObj.pathname.split('/').filter(p => p);
    const endpoint = pathParts.join('_').replace(/:/g, '_');

    // Create hash from query parameters for unique filenames
    const queryHash = urlObj.search
      ? crypto
          .createHash('md5')
          .update(urlObj.search)
          .digest('hex')
          .substring(0, 8)
      : 'no-params';

    const cacheDir = path.join(CACHE_DIR, domain, endpoint);
    const fileName = `${queryHash}.json`;

    return { dir: cacheDir, file: path.join(cacheDir, fileName) };
  }

  async loadFromCache(url) {
    const { file: filePath } = this.getCacheFilePath(url);
    try {
      const data = await fs.readFile(filePath, 'utf8');
      const cached = JSON.parse(data);

      // Check if cache is less than 6 months old
      const age = Date.now() - cached.timestamp;
      const ageInDays = Math.floor(age / (24 * 60 * 60 * 1000));
      if (age < 180 * 24 * 60 * 60 * 1000) {
        // console.log(`        ✓ Cache HIT: ${url.split('/').pop()} (${ageInDays} days old)`);
        return cached.data;
      } else {
        console.log(`        ⚠ Cache EXPIRED: ${url.split('/').pop()} (${ageInDays} days old) - ${filePath}`);
      }
    } catch (_err) {
      // console.log(`        ✗ Cache MISS: ${url.split('/').pop()} (${err.code || err.message}) - ${filePath}`);
    }
    return null;
  }

  async saveToCache(url, data) {
    const { dir: cacheDir, file: filePath } = this.getCacheFilePath(url);
    await fs.mkdir(cacheDir, { recursive: true });

    const cached = {
      data,
      timestamp: Date.now(),
      url
    };

    await fs.writeFile(filePath, JSON.stringify(cached, null, 2));
  }

  async waitForRateLimit() {
    const now = Date.now();

    // Remove requests older than 1 minute
    this.requestTimes = this.requestTimes.filter(
      time => now - time < RATE_WINDOW
    );

    // If we're at the limit, wait
    if (this.requestTimes.length >= RATE_LIMIT) {
      const oldestRequest = Math.min(...this.requestTimes);
      const waitTime = RATE_WINDOW - (now - oldestRequest) + 100;

      if (waitTime > 0) {
        console.log(
          `Rate limit reached, waiting ${Math.ceil(waitTime / 1000)}s...`
        );
        await new Promise(resolve => setTimeout(resolve, waitTime));
        // Clear old requests after waiting
        this.requestTimes = this.requestTimes.filter(
          time => Date.now() - time < RATE_WINDOW
        );
      }
    } else if (this.requestTimes.length > 0) {
      // Add small delay between requests to avoid bursts
      const lastRequest = Math.max(...this.requestTimes);
      const timeSinceLastRequest = now - lastRequest;
      if (timeSinceLastRequest < MIN_DELAY) {
        await new Promise(resolve => setTimeout(resolve, MIN_DELAY - timeSinceLastRequest));
      }
    }

    this.requestTimes.push(Date.now());
  }

  async fetchWithCache(url, cacheKey, retries = 3) {
    await this.ensureCacheDir();

    // Check cache first
    const cachedData = await this.loadFromCache(url);
    if (cachedData) {
      return cachedData;
    }

    // Rate limit ONLY for actual network requests
    await this.waitForRateLimit();

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url, {
          headers: { accept: 'application/json' }
        });

        if (!response.ok) {
          let responseText = '';
          try {
            responseText = await response.text();
          } catch { /* ignore */ }

          console.log(
            `❌ HTTP ${response.status} ${response.statusText} - ${url}`
          );
          console.log(`Response: ${responseText.substring(0, 500)}`);
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        // Cache the result
        await this.saveToCache(url, data);
        return data;
      } catch (error) {
        console.log(`❌ RETRY ${attempt}/${retries} - ${url}`);
        console.log(`Error: ${error.message}`);
        console.log(`Error code: ${error.code || 'none'}`);
        console.log(`Error cause: ${error.cause || 'none'}`);

        const isNetworkError =
          error.message.includes('fetch failed') ||
          error.message.includes('ECONNRESET') ||
          error.message.includes('ENOTFOUND') ||
          error.message.includes('ETIMEDOUT');

        if (attempt === retries) {
          console.log(`❌ FINAL FAILURE after ${retries} attempts`);
          throw error;
        }

        const backoffTime = isNetworkError ? 30000 * attempt : 5000 * attempt;
        console.log(`Backing off ${backoffTime / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, backoffTime));
      }
    }
  }

  async searchTraits(query) {
    const url = `https://www.pgscatalog.org/rest/trait/search?term=${encodeURIComponent(query)}&exact=0&include_children=1`;
    return this.fetchWithCache(url);
  }

  async searchTraitsByTrait(traitId) {
    const url = `https://www.pgscatalog.org/rest/trait/search?term=${encodeURIComponent(traitId)}&exact=1`;
    return this.fetchWithCache(url);
  }

  async getTraitInfo(traitId) {
    // Handle both TRAIT and EFO formats
    let url;
    if (traitId.startsWith('TRAIT:')) {
      url = `https://www.pgscatalog.org/rest/trait/${traitId}`;
    } else if (traitId.startsWith('EFO_')) {
      url = `https://www.pgscatalog.org/rest/trait/${traitId}`;
    } else {
      // Try as direct ID
      url = `https://www.pgscatalog.org/rest/trait/${traitId}`;
    }
    return this.fetchWithCache(url);
  }

  async getScoresByTrait(traitId) {
    const url = `https://www.pgscatalog.org/rest/score/search?trait_id=${encodeURIComponent(traitId)}`;
    return this.fetchWithCache(url);
  }

  async getScore(pgsId) {
    const url = `https://www.pgscatalog.org/rest/score/${pgsId}`;
    return this.fetchWithCache(url);
  }

  async getScoreFile(pgsId) {
    const url = `https://www.pgscatalog.org/rest/score/${pgsId}/scoring_file/`;
    return this.fetchWithCache(url);
  }

  getHarmonizedUrl(scoreData) {
    return scoreData?.ftp_harmonized_scoring_files?.GRCh38?.positions || null;
  }

  async _downloadWithRetry(url, destPath, label, retries = 3) {
    await this._acquireDownloadSlot();
    try {
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const response = await fetch(url);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }
          const buffer = await response.arrayBuffer();
          await fs.writeFile(destPath, new Uint8Array(buffer));
          return true;
        } catch (err) {
          const cause = err.cause?.code || err.cause?.message || err.message;
          if (attempt === retries) {
            throw new Error(`${label}: ${cause} (after ${retries} attempts)`);
          }
          const backoff = 2000 * attempt;
          console.log(`        ⚠ ${label}: ${cause}, retry ${attempt}/${retries} in ${backoff / 1000}s...`);
          await new Promise(r => setTimeout(r, backoff));
        }
      }
    } finally {
      this._releaseDownloadSlot();
    }
  }

  async downloadPGSFile(pgsId, downloadUrl) {
    const harmonizedPath = path.join(PGS_FILES_DIR, `${pgsId}_hmPOS_GRCh38.txt.gz`);
    const rawPath = path.join(PGS_FILES_DIR, `${pgsId}.txt.gz`);
    await fs.mkdir(PGS_FILES_DIR, { recursive: true });

    // 1. Check harmonized cache
    try {
      await fs.access(harmonizedPath);
      console.log(`        Using cached harmonized file: ${pgsId}_hmPOS_GRCh38.txt.gz`);
      return harmonizedPath;
    } catch { /* ignore */ }

    // 2. Try downloading harmonized if API provides one
    let harmonizedUrl = null;
    try {
      const scoreData = await this.getScore(pgsId);
      harmonizedUrl = this.getHarmonizedUrl(scoreData);
    } catch { /* ignore */ }

    if (harmonizedUrl) {
      try {
        console.log(`        Downloading harmonized GRCh38: ${pgsId}`);
        await this._downloadWithRetry(harmonizedUrl, harmonizedPath, pgsId);
        return harmonizedPath;
      } catch (err) {
        console.log(`        ❌ ${err.message}`);
      }
    }

    // 3. Fall back to raw cache
    try {
      await fs.access(rawPath);
      console.log(`        Using cached PGS file: ${pgsId}.txt.gz`);
      return rawPath;
    } catch { /* ignore */ }

    // 4. Download raw
    console.log(`        Downloading PGS file: ${pgsId}.txt.gz`);
    await this._downloadWithRetry(downloadUrl, rawPath, pgsId);
    return rawPath;
  }

  async getPGSFile(pgsId) {
    // Check for harmonized file first
    const harmonizedPath = path.join(PGS_FILES_DIR, `${pgsId}_hmPOS_GRCh38.txt.gz`);
    try {
      await fs.access(harmonizedPath);
      return harmonizedPath;
    } catch { /* ignore */ }

    const rawPath = path.join(PGS_FILES_DIR, `${pgsId}.txt.gz`);
    try {
      await fs.access(rawPath);
      return rawPath;
    } catch { /* ignore */ }

    // Download - downloadPGSFile will prefer harmonized
    const scoreData = await this.getScore(pgsId);
    return this.downloadPGSFile(pgsId, scoreData.ftp_scoring_file);
  }

  async getPerformanceMetrics(ppmIds) {
    if (!ppmIds || ppmIds.length === 0) return { results: [] };
    const ids = Array.isArray(ppmIds) ? ppmIds.join(',') : ppmIds;
    const url = `https://www.pgscatalog.org/rest/performance/all?filter_ids=${ids}`;
    return this.fetchWithCache(url);
  }

  async searchPerformanceMetrics(pgsId) {
    const url = `https://www.pgscatalog.org/rest/performance/search?pgs_id=${pgsId}`;
    return this.fetchWithCache(url);
  }
}

// Singleton instance
const pgsApiClient = new PGSApiClient();
export default pgsApiClient;
