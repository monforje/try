import pkg from 'pg';
import { logger } from './logger.js';
import { metrics } from './metrics.js';

const { Pool } = pkg;

// Database configuration
const config = {
  connectionString: process.env.PG_CONNECTION_STRING,
  max: parseInt(process.env.DB_POOL_MAX) || 20,
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT) || 30000,
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT) || 2000,
  statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT) || 30000,
  query_timeout: parseInt(process.env.DB_QUERY_TIMEOUT) || 30000,
  application_name: 'balanced-news-backend',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
};

// Create connection pool
const pool = new Pool(config);

// Pool event handlers
pool.on('connect', (client) => {
  logger.debug('Database client connected', { 
    processId: client.processID,
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount
  });
});

pool.on('acquire', (client) => {
  logger.debug('Database client acquired', { 
    processId: client.processID,
    totalCount: pool.totalCount,
    idleCount: pool.idleCount
  });
});

pool.on('remove', (client) => {
  logger.debug('Database client removed', { 
    processId: client.processID,
    totalCount: pool.totalCount
  });
});

pool.on('error', (err, client) => {
  logger.error('Database pool error', { 
    error: err.message,
    processId: client?.processID,
    code: err.code
  });
  metrics.dbErrors.inc({ type: 'pool' });
});

// Database initialization
async function initializeDatabase() {
  try {
    logger.info('Initializing database...');
    
    // Create tables if they don't exist
    await createTables();
    
    // Create indexes
    await createIndexes();
    
    logger.info('Database initialization completed');
    return true;
  } catch (error) {
    logger.error('Database initialization failed', { error: error.message });
    throw error;
  }
}

// Create necessary tables
async function createTables() {
  const client = await pool.connect();
  
  try {
    // Reactions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS reactions (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        article_id TEXT NOT NULL,
        emoji VARCHAR(20) NOT NULL CHECK (emoji IN ('like', 'meh', 'dislike')),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        metadata JSONB DEFAULT '{}',
        CONSTRAINT unique_user_article UNIQUE (user_id, article_id)
      )
    `);

    // User sessions table (for analytics)
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        session_start TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        session_end TIMESTAMP WITH TIME ZONE,
        bias_x DECIMAL(3,2),
        bias_y DECIMAL(3,2),
        articles_viewed INTEGER DEFAULT 0,
        reactions_count INTEGER DEFAULT 0,
        user_agent TEXT,
        ip_address INET,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Feed requests log (for analytics and debugging)
    await client.query(`
      CREATE TABLE IF NOT EXISTS feed_requests (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        user_id VARCHAR(255),
        bias_x DECIMAL(3,2) NOT NULL,
        bias_y DECIMAL(3,2) NOT NULL,
        sources_selected TEXT[],
        articles_returned INTEGER,
        cache_hit BOOLEAN DEFAULT FALSE,
        response_time_ms INTEGER,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        ip_address INET,
        user_agent TEXT
      )
    `);

    // Article parsing cache (optional, for expensive operations)
    await client.query(`
      CREATE TABLE IF NOT EXISTS article_cache (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        url TEXT UNIQUE NOT NULL,
        title TEXT,
        author TEXT,
        published_at TIMESTAMP WITH TIME ZONE,
        html_content TEXT,
        word_count INTEGER,
        reading_time_sec INTEGER,
        parsed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP WITH TIME ZONE DEFAULT (CURRENT_TIMESTAMP + INTERVAL '24 hours'),
        parse_success BOOLEAN DEFAULT TRUE,
        error_message TEXT
      )
    `);

    logger.info('Database tables created/verified');
  } finally {
    client.release();
  }
}

// Create database indexes
async function createIndexes() {
  const client = await pool.connect();
  
  try {
    // Reactions indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reactions_user_id 
      ON reactions (user_id)
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reactions_article_id 
      ON reactions (article_id)
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reactions_created_at 
      ON reactions (created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reactions_emoji 
      ON reactions (emoji)
    `);

    // User sessions indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id 
      ON user_sessions (user_id)
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_sessions_created_at 
      ON user_sessions (created_at DESC)
    `);

    // Feed requests indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_feed_requests_user_id 
      ON feed_requests (user_id)
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_feed_requests_created_at 
      ON feed_requests (created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_feed_requests_bias 
      ON feed_requests (bias_x, bias_y)
    `);

    // Article cache indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_article_cache_url 
      ON article_cache (url)
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_article_cache_expires_at 
      ON article_cache (expires_at)
    `);

    logger.info('Database indexes created/verified');
  } finally {
    client.release();
  }
}

// Initialize database on module load
initializeDatabase().catch(error => {
  logger.error('Failed to initialize database', { error: error.message });
});

// Save user reaction with conflict handling
export async function saveReaction({ userId, articleId, emoji, ts, metadata = {} }) {
  const startTime = Date.now();
  const client = await pool.connect();
  
  try {
    const createdAt = ts ? new Date(ts) : new Date();
    
    // Use UPSERT to handle duplicate reactions
    const query = `
      INSERT INTO reactions (user_id, article_id, emoji, created_at, metadata)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id, article_id)
      DO UPDATE SET
        emoji = EXCLUDED.emoji,
        updated_at = CURRENT_TIMESTAMP,
        metadata = EXCLUDED.metadata
      RETURNING id, created_at, updated_at
    `;
    
    const values = [userId, articleId, emoji, createdAt, JSON.stringify(metadata)];
    const result = await client.query(query, values);
    
    const duration = Date.now() - startTime;
    metrics.dbOperationDuration.observe({ operation: 'save_reaction' }, duration);
    metrics.dbOperations.inc({ operation: 'save_reaction', status: 'success' });
    
    logger.debug('Reaction saved', {
      userId: userId.substring(0, 10) + '...',
      articleId: articleId.substring(0, 50) + '...',
      emoji,
      duration,
      wasUpdate: result.rows[0].created_at !== result.rows[0].updated_at
    });
    
    return result.rows[0];
    
  } catch (error) {
    const duration = Date.now() - startTime;
    metrics.dbOperationDuration.observe({ operation: 'save_reaction' }, duration);
    metrics.dbOperations.inc({ operation: 'save_reaction', status: 'error' });
    metrics.dbErrors.inc({ type: 'query' });
    
    logger.error('Failed to save reaction', {
      error: error.message,
      userId: userId.substring(0, 10) + '...',
      articleId: articleId.substring(0, 50) + '...',
      emoji,
      duration
    });
    
    throw error;
  } finally {
    client.release();
  }
}

// Get reaction statistics
export async function getReactionStats(timeframe = '24 hours') {
  const startTime = Date.now();
  const client = await pool.connect();
  
  try {
    // Overall stats
    const overallQuery = `
      SELECT 
        emoji,
        COUNT(*) as count,
        COUNT(DISTINCT user_id) as unique_users
      FROM reactions
      WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '${timeframe}'
      GROUP BY emoji
      ORDER BY count DESC
    `;
    
    const overallResult = await client.query(overallQuery);
    
    // Hourly breakdown for last 24 hours
    const hourlyQuery = `
      SELECT 
        DATE_TRUNC('hour', created_at) as hour,
        emoji,
        COUNT(*) as count
      FROM reactions
      WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
      GROUP BY DATE_TRUNC('hour', created_at), emoji
      ORDER BY hour DESC
    `;
    
    const hourlyResult = await client.query(hourlyQuery);
    
    // Top articles by reactions
    const topArticlesQuery = `
      SELECT 
        article_id,
        COUNT(*) as total_reactions,
        COUNT(CASE WHEN emoji = 'like' THEN 1 END) as likes,
        COUNT(CASE WHEN emoji = 'meh' THEN 1 END) as meh,
        COUNT(CASE WHEN emoji = 'dislike' THEN 1 END) as dislikes
      FROM reactions
      WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '${timeframe}'
      GROUP BY article_id
      HAVING COUNT(*) > 1
      ORDER BY total_reactions DESC
      LIMIT 10
    `;
    
    const topArticlesResult = await client.query(topArticlesQuery);
    
    const duration = Date.now() - startTime;
    metrics.dbOperationDuration.observe({ operation: 'get_reaction_stats' }, duration);
    metrics.dbOperations.inc({ operation: 'get_reaction_stats', status: 'success' });
    
    logger.debug('Reaction stats retrieved', { duration, timeframe });
    
    return {
      timeframe,
      overall: overallResult.rows,
      hourly: hourlyResult.rows,
      topArticles: topArticlesResult.rows,
      generatedAt: new Date().toISOString()
    };
    
  } catch (error) {
    const duration = Date.now() - startTime;
    metrics.dbOperationDuration.observe({ operation: 'get_reaction_stats' }, duration);
    metrics.dbOperations.inc({ operation: 'get_reaction_stats', status: 'error' });
    metrics.dbErrors.inc({ type: 'query' });
    
    logger.error('Failed to get reaction stats', { error: error.message, duration });
    throw error;
  } finally {
    client.release();
  }
}

// Log feed request for analytics
export async function logFeedRequest({ 
  userId, 
  biasX, 
  biasY, 
  sourcesSelected, 
  articlesReturned, 
  cacheHit, 
  responseTimeMs,
  ipAddress,
  userAgent 
}) {
  const client = await pool.connect();
  
  try {
    const query = `
      INSERT INTO feed_requests (
        user_id, bias_x, bias_y, sources_selected, 
        articles_returned, cache_hit, response_time_ms,
        ip_address, user_agent
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `;
    
    const values = [
      userId, biasX, biasY, sourcesSelected,
      articlesReturned, cacheHit, responseTimeMs,
      ipAddress, userAgent
    ];
    
    await client.query(query, values);
    
    metrics.dbOperations.inc({ operation: 'log_feed_request', status: 'success' });
    
  } catch (error) {
    metrics.dbOperations.inc({ operation: 'log_feed_request', status: 'error' });
    logger.warn('Failed to log feed request', { error: error.message });
    // Don't throw here - logging is not critical
  } finally {
    client.release();
  }
}

// Cache article parsing result in database
export async function cacheArticleResult({
  url,
  title,
  author,
  publishedAt,
  htmlContent,
  wordCount,
  readingTimeSec,
  parseSuccess = true,
  errorMessage = null
}) {
  const client = await pool.connect();
  
  try {
    const query = `
      INSERT INTO article_cache (
        url, title, author, published_at, html_content,
        word_count, reading_time_sec, parse_success, error_message
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (url)
      DO UPDATE SET
        title = EXCLUDED.title,
        author = EXCLUDED.author,
        published_at = EXCLUDED.published_at,
        html_content = EXCLUDED.html_content,
        word_count = EXCLUDED.word_count,
        reading_time_sec = EXCLUDED.reading_time_sec,
        parse_success = EXCLUDED.parse_success,
        error_message = EXCLUDED.error_message,
        parsed_at = CURRENT_TIMESTAMP,
        expires_at = CURRENT_TIMESTAMP + INTERVAL '24 hours'
    `;
    
    const values = [
      url, title, author, publishedAt, htmlContent,
      wordCount, readingTimeSec, parseSuccess, errorMessage
    ];
    
    await client.query(query, values);
    
    metrics.dbOperations.inc({ operation: 'cache_article', status: 'success' });
    
  } catch (error) {
    metrics.dbOperations.inc({ operation: 'cache_article', status: 'error' });
    logger.warn('Failed to cache article result', { 
      error: error.message,
      url: url.substring(0, 100) + '...'
    });
  } finally {
    client.release();
  }
}

// Get cached article result
export async function getCachedArticle(url) {
  const client = await pool.connect();
  
  try {
    const query = `
      SELECT * FROM article_cache
      WHERE url = $1 AND expires_at > CURRENT_TIMESTAMP AND parse_success = true
    `;
    
    const result = await client.query(query, [url]);
    
    metrics.dbOperations.inc({ operation: 'get_cached_article', status: 'success' });
    
    return result.rows[0] || null;
    
  } catch (error) {
    metrics.dbOperations.inc({ operation: 'get_cached_article', status: 'error' });
    logger.warn('Failed to get cached article', { 
      error: error.message,
      url: url.substring(0, 100) + '...'
    });
    return null;
  } finally {
    client.release();
  }
}

// Clean up expired cache entries
export async function cleanupExpiredCache() {
  const client = await pool.connect();
  
  try {
    const result = await client.query(`
      DELETE FROM article_cache
      WHERE expires_at <= CURRENT_TIMESTAMP
    `);
    
    logger.info('Cleaned up expired article cache entries', { count: result.rowCount });
    return result.rowCount;
    
  } catch (error) {
    logger.error('Failed to cleanup expired cache', { error: error.message });
    throw error;
  } finally {
    client.release();
  }
}

// Get database statistics
export async function getDatabaseStats() {
  const client = await pool.connect();
  
  try {
    // Table sizes
    const tablesQuery = `
      SELECT 
        schemaname,
        tablename,
        pg_total_relation_size(schemaname||'.'||tablename) as size_bytes,
        pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size_pretty
      FROM pg_tables 
      WHERE schemaname = 'public'
      ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
    `;
    
    const tablesResult = await client.query(tablesQuery);
    
    // Connection stats
    const connectionsQuery = `
      SELECT 
        state,
        COUNT(*) as count
      FROM pg_stat_activity 
      WHERE datname = current_database()
      GROUP BY state
    `;
    
    const connectionsResult = await client.query(connectionsQuery);
    
    // Recent activity
    const activityQuery = `
      SELECT 
        'reactions' as table_name,
        COUNT(*) as total_rows,
        COUNT(CASE WHEN created_at >= CURRENT_TIMESTAMP - INTERVAL '1 hour' THEN 1 END) as last_hour,
        COUNT(CASE WHEN created_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours' THEN 1 END) as last_24h
      FROM reactions
      UNION ALL
      SELECT 
        'feed_requests' as table_name,
        COUNT(*) as total_rows,
        COUNT(CASE WHEN created_at >= CURRENT_TIMESTAMP - INTERVAL '1 hour' THEN 1 END) as last_hour,
        COUNT(CASE WHEN created_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours' THEN 1 END) as last_24h
      FROM feed_requests
    `;
    
    const activityResult = await client.query(activityQuery);
    
    return {
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount
      },
      tables: tablesResult.rows,
      connections: connectionsResult.rows,
      activity: activityResult.rows,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    logger.error('Failed to get database stats', { error: error.message });
    throw error;
  } finally {
    client.release();
  }
}

// Database health check
export async function checkDbHealth() {
  const startTime = Date.now();
  
  try {
    const client = await pool.connect();
    
    try {
      // Simple query to test connection
      const result = await client.query('SELECT NOW() as current_time, version() as pg_version');
      const duration = Date.now() - startTime;
      
      return {
        status: 'healthy',
        responseTime: duration,
        postgresql: result.rows[0],
        pool: {
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount
        },
        timestamp: new Date().toISOString()
      };
    } finally {
      client.release();
    }
    
  } catch (error) {
    const duration = Date.now() - startTime;
    metrics.dbErrors.inc({ type: 'health_check' });
    
    return {
      status: 'unhealthy',
      error: error.message,
      responseTime: duration,
      timestamp: new Date().toISOString()
    };
  }
}

// Graceful shutdown
export async function closeDatabase() {
  logger.info('Closing database connection pool...');
  
  try {
    await pool.end();
    logger.info('Database connection pool closed gracefully');
  } catch (error) {
    logger.error('Error closing database connection pool', { error: error.message });
    throw error;
  }
}

// Update pool metrics periodically
setInterval(() => {
  metrics.dbPoolConnections.set({ state: 'total' }, pool.totalCount);
  metrics.dbPoolConnections.set({ state: 'idle' }, pool.idleCount);
  metrics.dbPoolConnections.set({ state: 'waiting' }, pool.waitingCount);
}, 30 * 1000); // Every 30 seconds