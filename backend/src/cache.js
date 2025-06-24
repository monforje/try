import { createClient } from 'redis';
import { logger } from './logger.js';
import { metrics } from './metrics.js';

// Configuration
const REDIS_URL = process.env.REDIS_URL;
const MAX_MEMORY_CACHE_SIZE = parseInt(process.env.MAX_MEMORY_CACHE_SIZE) || 1000;
const RECONNECT_DELAY = parseInt(process.env.REDIS_RECONNECT_DELAY) || 5000;
const MAX_RECONNECT_ATTEMPTS = parseInt(process.env.REDIS_MAX_RECONNECT_ATTEMPTS) || 10;

// Redis client state
let client = null;
let isRedisConnected = false;
let reconnectAttempts = 0;
let reconnectTimer = null;

// In-memory fallback cache with LRU eviction
class MemoryCache {
  constructor(maxSize = MAX_MEMORY_CACHE_SIZE) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;

    // Check expiration
    if (item.expires && item.expires < Date.now()) {
      this.cache.delete(key);
      return null;
    }

    // Move to end (LRU)
    this.cache.delete(key);
    this.cache.set(key, item);
    
    return item.value;
  }

  set(key, value, ttlSec) {
    // Remove oldest items if cache is full
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    const expires = ttlSec ? Date.now() + (ttlSec * 1000) : null;
    this.cache.set(key, { value, expires });
  }

  delete(key) {
    return this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  size() {
    return this.cache.size;
  }

  // Clean expired entries
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, item] of this.cache.entries()) {
      if (item.expires && item.expires <= now) {
        this.cache.delete(key);
        cleaned++;
      }
    }
    
    return cleaned;
  }

  // Get cache statistics
  getStats() {
    const now = Date.now();
    let expired = 0;
    let active = 0;

    for (const [, item] of this.cache.entries()) {
      if (item.expires && item.expires <= now) {
        expired++;
      } else {
        active++;
      }
    }

    return {
      total: this.cache.size,
      active,
      expired,
      maxSize: this.maxSize
    };
  }
}

const memoryCache = new MemoryCache();

// Redis connection management
async function connectRedis() {
  if (!REDIS_URL) {
    logger.info('Redis URL not configured, using in-memory cache only');
    return false;
  }

  try {
    client = createClient({ 
      url: REDIS_URL,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > MAX_RECONNECT_ATTEMPTS) {
            logger.error('Max Redis reconnection attempts reached, giving up');
            return false;
          }
          const delay = Math.min(retries * 1000, 10000); // Max 10 seconds
          logger.warn(`Redis reconnection attempt ${retries}, retrying in ${delay}ms`);
          return delay;
        }
      }
    });

    client.on('error', (err) => {
      logger.error('Redis error', { error: err.message, code: err.code });
      isRedisConnected = false;
      metrics.cacheErrors.inc({ type: 'redis', operation: 'connection' });
    });

    client.on('connect', () => {
      logger.info('Redis connected');
      isRedisConnected = true;
      reconnectAttempts = 0;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    });

    client.on('ready', () => {
      logger.info('Redis ready');
      isRedisConnected = true;
    });

    client.on('end', () => {
      logger.warn('Redis connection ended');
      isRedisConnected = false;
    });

    client.on('reconnecting', () => {
      logger.info('Redis reconnecting...');
      reconnectAttempts++;
    });

    await client.connect();
    return true;

  } catch (error) {
    logger.error('Failed to connect to Redis', { 
      error: error.message, 
      url: REDIS_URL?.replace(/:[^:@]*@/, ':***@') // Hide password in logs
    });
    isRedisConnected = false;
    
    // Schedule reconnection attempt
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectTimer = setTimeout(() => {
        reconnectAttempts++;
        logger.info(`Attempting Redis reconnection ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
        connectRedis();
      }, RECONNECT_DELAY);
    }
    
    return false;
  }
}

// Initialize Redis connection
connectRedis();

// Cache operations with metrics and fallback
export async function getCache(key) {
  const startTime = Date.now();
  
  try {
    // Try Redis first
    if (isRedisConnected && client) {
      const value = await client.get(key);
      const duration = Date.now() - startTime;
      
      if (value !== null) {
        metrics.cacheHits.inc({ backend: 'redis' });
        metrics.cacheOperationDuration.observe({ operation: 'get', backend: 'redis' }, duration);
        logger.debug('Cache hit (Redis)', { key: key.substring(0, 50) + '...', duration });
        return value;
      } else {
        metrics.cacheMisses.inc({ backend: 'redis' });
        metrics.cacheOperationDuration.observe({ operation: 'get', backend: 'redis' }, duration);
      }
    }
  } catch (error) {
    logger.warn('Redis get operation failed, falling back to memory cache', { 
      error: error.message,
      key: key.substring(0, 50) + '...'
    });
    metrics.cacheErrors.inc({ type: 'redis', operation: 'get' });
    isRedisConnected = false;
  }

  // Fallback to memory cache
  const value = memoryCache.get(key);
  const duration = Date.now() - startTime;
  
  if (value !== null) {
    metrics.cacheHits.inc({ backend: 'memory' });
    metrics.cacheOperationDuration.observe({ operation: 'get', backend: 'memory' }, duration);
    logger.debug('Cache hit (Memory)', { key: key.substring(0, 50) + '...', duration });
    return value;
  } else {
    metrics.cacheMisses.inc({ backend: 'memory' });
    metrics.cacheOperationDuration.observe({ operation: 'get', backend: 'memory' }, duration);
    logger.debug('Cache miss', { key: key.substring(0, 50) + '...', duration });
    return null;
  }
}

export async function setCache(key, value, ttlSec) {
  const startTime = Date.now();
  
  // Validate inputs
  if (!key || value === undefined) {
    logger.warn('Invalid cache set operation', { hasKey: !!key, hasValue: value !== undefined });
    return false;
  }

  // Try Redis first
  if (isRedisConnected && client) {
    try {
      await client.set(key, value, { EX: ttlSec });
      const duration = Date.now() - startTime;
      
      metrics.cacheOperationDuration.observe({ operation: 'set', backend: 'redis' }, duration);
      logger.debug('Cache set (Redis)', { 
        key: key.substring(0, 50) + '...', 
        valueLength: value.length,
        ttl: ttlSec,
        duration 
      });
      
      // Also store in memory cache for faster access
      memoryCache.set(key, value, ttlSec);
      return true;
      
    } catch (error) {
      logger.warn('Redis set operation failed, falling back to memory cache', { 
        error: error.message,
        key: key.substring(0, 50) + '...'
      });
      metrics.cacheErrors.inc({ type: 'redis', operation: 'set' });
      isRedisConnected = false;
    }
  }

  // Fallback to memory cache
  memoryCache.set(key, value, ttlSec);
  const duration = Date.now() - startTime;
  
  metrics.cacheOperationDuration.observe({ operation: 'set', backend: 'memory' }, duration);
  logger.debug('Cache set (Memory)', { 
    key: key.substring(0, 50) + '...', 
    valueLength: value.length,
    ttl: ttlSec,
    duration 
  });
  
  return true;
}

export async function deleteCache(key) {
  const startTime = Date.now();
  let deleted = false;

  // Delete from Redis
  if (isRedisConnected && client) {
    try {
      const result = await client.del(key);
      deleted = result > 0;
      
      const duration = Date.now() - startTime;
      metrics.cacheOperationDuration.observe({ operation: 'delete', backend: 'redis' }, duration);
      
    } catch (error) {
      logger.warn('Redis delete operation failed', { 
        error: error.message,
        key: key.substring(0, 50) + '...'
      });
      metrics.cacheErrors.inc({ type: 'redis', operation: 'delete' });
    }
  }

  // Delete from memory cache
  const memoryDeleted = memoryCache.delete(key);
  deleted = deleted || memoryDeleted;

  const duration = Date.now() - startTime;
  metrics.cacheOperationDuration.observe({ operation: 'delete', backend: 'memory' }, duration);

  logger.debug('Cache delete', { 
    key: key.substring(0, 50) + '...', 
    deleted,
    duration 
  });

  return deleted;
}

export async function clearCache(pattern) {
  const startTime = Date.now();
  let cleared = 0;

  // Clear from Redis
  if (isRedisConnected && client && pattern) {
    try {
      const keys = await client.keys(pattern);
      if (keys.length > 0) {
        cleared += await client.del(keys);
      }
      
      logger.info('Redis cache cleared', { pattern, count: cleared });
    } catch (error) {
      logger.warn('Redis clear operation failed', { error: error.message, pattern });
      metrics.cacheErrors.inc({ type: 'redis', operation: 'clear' });
    }
  }

  // Clear from memory cache (pattern matching is basic)
  if (pattern) {
    const regex = new RegExp(pattern.replace(/\*/g, '.*'));
    for (const key of memoryCache.cache.keys()) {
      if (regex.test(key)) {
        memoryCache.delete(key);
        cleared++;
      }
    }
  } else {
    // Clear all memory cache
    cleared += memoryCache.size();
    memoryCache.clear();
  }

  const duration = Date.now() - startTime;
  logger.info('Cache cleared', { pattern, count: cleared, duration });

  return cleared;
}

// Clean expired entries from memory cache
export async function clearExpiredCache() {
  const startTime = Date.now();
  const cleaned = memoryCache.cleanup();
  const duration = Date.now() - startTime;
  
  logger.info('Expired cache entries cleaned', { count: cleaned, duration });
  return cleaned;
}

// Get cache statistics
export async function getCacheStats() {
  const memoryStats = memoryCache.getStats();
  let redisStats = { connected: false };

  if (isRedisConnected && client) {
    try {
      const info = await client.info('memory');
      const dbsize = await client.dbSize();
      
      redisStats = {
        connected: true,
        dbSize: dbsize,
        memoryUsed: info.match(/used_memory:(\d+)/)?.[1] || 0,
        memoryPeak: info.match(/used_memory_peak:(\d+)/)?.[1] || 0,
      };
    } catch (error) {
      logger.warn('Failed to get Redis stats', { error: error.message });
      redisStats.error = error.message;
    }
  }

  return {
    memory: memoryStats,
    redis: redisStats,
    timestamp: new Date().toISOString()
  };
}

// Health check for cache system
export async function checkCacheHealth() {
  const testKey = 'health_check_' + Date.now();
  const testValue = 'test_value';
  
  try {
    // Test set operation
    await setCache(testKey, testValue, 60);
    
    // Test get operation
    const retrieved = await getCache(testKey);
    
    // Test delete operation
    await deleteCache(testKey);
    
    const isHealthy = retrieved === testValue;
    
    return {
      status: isHealthy ? 'healthy' : 'unhealthy',
      redis: {
        connected: isRedisConnected,
        url: REDIS_URL ? 'configured' : 'not_configured'
      },
      memory: {
        size: memoryCache.size(),
        maxSize: MAX_MEMORY_CACHE_SIZE
      },
      test: {
        success: isHealthy,
        value: retrieved
      },
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

// Graceful shutdown
export async function closeCache() {
  logger.info('Closing cache connections...');
  
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  
  if (client && isRedisConnected) {
    try {
      await client.quit();
      logger.info('Redis connection closed gracefully');
    } catch (error) {
      logger.warn('Error closing Redis connection', { error: error.message });
    }
  }
  
  memoryCache.clear();
  logger.info('Memory cache cleared');
}

// Periodic cleanup (call this from a cron job)
setInterval(() => {
  clearExpiredCache();
}, 5 * 60 * 1000); // Every 5 minutes

// Update metrics periodically
setInterval(async () => {
  try {
    const stats = await getCacheStats();
    metrics.cacheSize.set({ backend: 'memory' }, stats.memory.active);
    if (stats.redis.connected && stats.redis.dbSize !== undefined) {
      metrics.cacheSize.set({ backend: 'redis' }, stats.redis.dbSize);
    }
  } catch (error) {
    logger.warn('Failed to update cache metrics', { error: error.message });
  }
}, 30 * 1000); // Every 30 seconds