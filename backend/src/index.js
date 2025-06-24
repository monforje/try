import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import slowDown from 'express-slow-down';
import morgan from 'morgan';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';

// Internal modules
import { pickSources } from './feed.js';
import { getArticlesBySources } from './newsapi.js';
import { getCache, setCache, clearExpiredCache } from './cache.js';
import { parseArticle } from './article.js';
import { saveReaction, getReactionStats } from './db.js';
import { validateFeedQuery, validateArticleQuery, validateReactionBody } from './validation.js';
import { logger } from './logger.js';
import { metrics, promMiddleware } from './metrics.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requestLogger } from './middleware/requestLogger.js';
import { securityHeaders } from './middleware/security.js';

// Get __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from project root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Environment configuration
const NODE_ENV = process.env.NODE_ENV || 'development';
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';
const IS_PRODUCTION = NODE_ENV === 'production';
const IS_DEVELOPMENT = NODE_ENV === 'development';

// Log environment status
logger.info('Starting Balanced News Backend', {
  nodeEnv: NODE_ENV,
  port: PORT,
  host: HOST,
  newsApiKeyPresent: !!process.env.NEWSAPI_KEY,
  redisUrlPresent: !!process.env.REDIS_URL,
  pgConnectionPresent: !!process.env.PG_CONNECTION_STRING,
});

// Create Express app
const app = express();

// Trust proxy for rate limiting and security
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}));

// Compression
app.use(compression());

// CORS configuration
const corsOptions = {
  origin: IS_DEVELOPMENT 
    ? true 
    : process.env.ALLOWED_ORIGINS?.split(',') || ['https://yourdomain.com'],
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
};

app.use(cors(corsOptions));

// Rate limiting
const feedLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: IS_DEVELOPMENT ? 1000 : 100, // limit each IP to 100 requests per windowMs in production
  message: {
    error: 'Too many feed requests from this IP, please try again later.',
    retryAfter: 15 * 60,
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const articleLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes  
  max: IS_DEVELOPMENT ? 1000 : 200, // articles can be cached more aggressively
  message: {
    error: 'Too many article requests from this IP, please try again later.',
    retryAfter: 15 * 60,
  },
});

const reactionLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: IS_DEVELOPMENT ? 1000 : 60, // 60 reactions per minute max
  message: {
    error: 'Too many reactions from this IP, please slow down.',
    retryAfter: 60,
  },
});

// Slow down middleware for repeated requests
const speedLimiter = slowDown({
  windowMs: 15 * 60 * 1000, // 15 minutes
  delayAfter: IS_DEVELOPMENT ? 1000 : 50, // allow 50 requests per 15 minutes at full speed, then...
  delayMs: 500, // add 500ms of delay per request after delayAfter
  maxDelayMs: 20000, // max delay of 20 seconds
});

// Body parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Request logging
app.use(morgan(IS_DEVELOPMENT ? 'dev' : 'combined', {
  stream: { write: (message) => logger.info(message.trim()) }
}));

// Custom request logger middleware
app.use(requestLogger);

// Metrics middleware
app.use(promMiddleware);

// Security headers
app.use(securityHeaders);

// Health check endpoint (no rate limiting)
app.get('/health', async (req, res) => {
  const startTime = Date.now();
  
  try {
    // Basic health check
    const health = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: NODE_ENV,
      version: process.env.npm_package_version || '1.0.0',
      nodeVersion: process.version,
      memoryUsage: process.memoryUsage(),
      newsApiKeyPresent: !!process.env.NEWSAPI_KEY,
    };

    // Extended health check for internal requests
    if (req.query.extended === 'true') {
      const { checkCacheHealth } = await import('./cache.js');
      const { checkDbHealth } = await import('./db.js');
      
      const [cacheHealth, dbHealth] = await Promise.allSettled([
        checkCacheHealth(),
        checkDbHealth(),
      ]);

      health.services = {
        cache: cacheHealth.status === 'fulfilled' ? 'ok' : 'error',
        database: dbHealth.status === 'fulfilled' ? 'ok' : 'error',
      };

      if (cacheHealth.status === 'rejected') {
        health.services.cacheError = cacheHealth.reason?.message;
      }
      if (dbHealth.status === 'rejected') {
        health.services.dbError = dbHealth.reason?.message;
      }
    }

    const responseTime = Date.now() - startTime;
    metrics.healthCheckDuration.observe(responseTime);
    metrics.healthChecks.inc({ status: 'success' });

    res.json(health);
  } catch (error) {
    logger.error('Health check failed', { error: error.message, stack: error.stack });
    metrics.healthChecks.inc({ status: 'error' });
    
    res.status(500).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: 'Health check failed',
    });
  }
});

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', metrics.register.contentType);
  res.end(await metrics.register.metrics());
});

// Feed endpoint
app.get('/feed', feedLimiter, speedLimiter, async (req, res) => {
  const startTime = Date.now();
  const requestId = req.headers['x-request-id'] || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    // Validate input
    const { error, value } = validateFeedQuery(req.query);
    if (error) {
      metrics.feedRequests.inc({ status: 'validation_error', cached: 'false' });
      return res.status(400).json({
        error: 'Invalid request parameters',
        details: error.details.map(d => d.message),
        requestId,
      });
    }

    const { x, y, client_ts, refresh } = value;
    
    logger.info('Feed request', { requestId, x, y, client_ts, refresh });

    const cacheKey = `feed:${x.toFixed(3)}:${y.toFixed(3)}`;
    
    // Check cache unless refresh is requested
    if (!refresh) {
      const cached = await getCache(cacheKey);
      if (cached) {
        const cachedData = JSON.parse(cached);
        const responseTime = Date.now() - startTime;
        
        metrics.feedRequests.inc({ status: 'success', cached: 'true' });
        metrics.feedResponseTime.observe(responseTime);
        
        logger.info('Returning cached feed', { requestId, responseTime, cacheHit: true });
        return res.json(cachedData);
      }
    }

    logger.info('Fetching fresh articles', { requestId });

    // Get sources
    const sources = pickSources(x, y);
    logger.info('Selected sources', { requestId, sources: sources.map(s => s.id) });
    
    if (sources.length === 0) {
      metrics.feedRequests.inc({ status: 'no_sources', cached: 'false' });
      return res.json([]);
    }

    // Get articles
    const articles = await getArticlesBySources(sources.map(s => s.id));
    logger.info('Retrieved articles from NewsAPI', { 
      requestId, 
      articleCount: articles.length,
      sourceIds: sources.map(s => s.id),
    });

    // Build cards
    const cards = [];
    const usedArticles = new Set();
    
    for (const src of sources) {
      // Find article for this source
      const art = articles.find(a => 
        a.source && 
        a.source.id === src.id && 
        !usedArticles.has(a.url)
      );
      
      if (art) {
        cards.push({
          articleId: art.url,
          title: art.title,
          sourceId: src.id,
          sourceName: src.name,
          imageUrl: art.urlToImage,
          url: art.url,
          publishedAt: art.publishedAt,
          side: src.side,
          description: art.description,
        });
        usedArticles.add(art.url);
        logger.debug('Matched article to source', { requestId, sourceId: src.id, articleTitle: art.title });
      } else {
        // Fallback: use any available article
        const fallbackArticle = articles.find(a => !usedArticles.has(a.url));
        if (fallbackArticle) {
          cards.push({
            articleId: fallbackArticle.url,
            title: fallbackArticle.title,
            sourceId: src.id,
            sourceName: src.name,
            imageUrl: fallbackArticle.urlToImage,
            url: fallbackArticle.url,
            publishedAt: fallbackArticle.publishedAt,
            side: src.side,
            description: fallbackArticle.description,
            isFallback: true,
          });
          usedArticles.add(fallbackArticle.url);
          logger.warn('Used fallback article', { requestId, sourceId: src.id, articleTitle: fallbackArticle.title });
        } else {
          logger.warn('No articles available for source', { requestId, sourceId: src.id });
        }
      }
    }

    // Cache result
    if (cards.length > 0) {
      const ttl = process.env.CACHE_TTL_FEED || 1800; // 30 min default
      await setCache(cacheKey, JSON.stringify(cards), parseInt(ttl));
    }

    const responseTime = Date.now() - startTime;
    metrics.feedRequests.inc({ status: 'success', cached: 'false' });
    metrics.feedResponseTime.observe(responseTime);
    
    logger.info('Feed request completed', { 
      requestId, 
      cardCount: cards.length, 
      responseTime,
      cacheHit: false,
    });

    res.json(cards);
    
  } catch (error) {
    const responseTime = Date.now() - startTime;
    metrics.feedRequests.inc({ status: 'error', cached: 'false' });
    metrics.feedResponseTime.observe(responseTime);
    
    logger.error('Error in /feed endpoint', {
      requestId,
      error: error.message,
      stack: IS_DEVELOPMENT ? error.stack : undefined,
      responseTime,
    });

    res.status(500).json({
      error: 'Failed to fetch articles',
      details: IS_DEVELOPMENT ? error.message : 'Internal server error',
      requestId,
    });
  }
});

// Article endpoint
app.get('/article', articleLimiter, async (req, res) => {
  const startTime = Date.now();
  const requestId = req.headers['x-request-id'] || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    // Validate input
    const { error, value } = validateArticleQuery(req.query);
    if (error) {
      metrics.articleRequests.inc({ status: 'validation_error', cached: 'false' });
      return res.status(400).json({
        error: 'Invalid request parameters',
        details: error.details.map(d => d.message),
        requestId,
      });
    }

    const { url, refresh } = value;
    
    logger.info('Article request', { requestId, url: url.substring(0, 100) + '...' });

    const cacheKey = `article:${encodeURIComponent(url)}`;
    
    // Check cache unless refresh is requested
    if (!refresh) {
      const cached = await getCache(cacheKey);
      if (cached) {
        const cachedData = JSON.parse(cached);
        const responseTime = Date.now() - startTime;
        
        metrics.articleRequests.inc({ status: 'success', cached: 'true' });
        metrics.articleResponseTime.observe(responseTime);
        
        logger.info('Returning cached article', { requestId, responseTime, cacheHit: true });
        return res.json(cachedData);
      }
    }

    logger.info('Parsing fresh article', { requestId });

    const article = await parseArticle(url);
    
    // Cache result
    const ttl = process.env.CACHE_TTL_ARTICLE || 86400; // 24h default
    await setCache(cacheKey, JSON.stringify(article), parseInt(ttl));

    const responseTime = Date.now() - startTime;
    metrics.articleRequests.inc({ status: 'success', cached: 'false' });
    metrics.articleResponseTime.observe(responseTime);
    
    logger.info('Article request completed', { 
      requestId, 
      responseTime,
      cacheHit: false,
      articleLength: article.htmlContent?.length || 0,
    });

    res.json(article);
    
  } catch (error) {
    const responseTime = Date.now() - startTime;
    metrics.articleRequests.inc({ status: 'error', cached: 'false' });
    metrics.articleResponseTime.observe(responseTime);
    
    logger.error('Error in /article endpoint', {
      requestId,
      error: error.message,
      stack: IS_DEVELOPMENT ? error.stack : undefined,
      responseTime,
    });

    res.status(500).json({
      error: 'Failed to parse article',
      details: IS_DEVELOPMENT ? error.message : 'Internal server error',
      requestId,
    });
  }
});

// Reaction endpoint
app.post('/reaction', reactionLimiter, async (req, res) => {
  const startTime = Date.now();
  const requestId = req.headers['x-request-id'] || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    // Validate input
    const { error, value } = validateReactionBody(req.body);
    if (error) {
      metrics.reactionRequests.inc({ status: 'validation_error' });
      return res.status(400).json({
        error: 'Invalid request body',
        details: error.details.map(d => d.message),
        requestId,
      });
    }

    const { userId, articleId, emoji, ts } = value;
    
    logger.info('Reaction request', { 
      requestId, 
      userId: userId.substring(0, 10) + '...', 
      emoji,
      articleId: articleId.substring(0, 50) + '...',
    });

    await saveReaction({ userId, articleId, emoji, ts: ts || Date.now() });

    const responseTime = Date.now() - startTime;
    metrics.reactionRequests.inc({ status: 'success', emoji });
    metrics.reactionResponseTime.observe(responseTime);
    
    logger.info('Reaction saved successfully', { requestId, responseTime });

    res.json({ 
      status: 'ok',
      requestId,
    });
    
  } catch (error) {
    const responseTime = Date.now() - startTime;
    metrics.reactionRequests.inc({ status: 'error' });
    metrics.reactionResponseTime.observe(responseTime);
    
    logger.error('Error in /reaction endpoint', {
      requestId,
      error: error.message,
      stack: IS_DEVELOPMENT ? error.stack : undefined,
      responseTime,
    });

    res.status(500).json({
      error: 'Failed to save reaction',
      details: IS_DEVELOPMENT ? error.message : 'Internal server error',
      requestId,
    });
  }
});

// Stats endpoint (optional, for analytics)
app.get('/stats', async (req, res) => {
  try {
    const stats = await getReactionStats();
    res.json(stats);
  } catch (error) {
    logger.error('Error in /stats endpoint', { error: error.message });
    res.status(500).json({
      error: 'Failed to fetch stats',
      details: IS_DEVELOPMENT ? error.message : 'Internal server error',
    });
  }
});

// Error handling middleware
app.use(notFoundHandler);
app.use(errorHandler);

// Graceful shutdown
const gracefulShutdown = (signal) => {
  logger.info(`Received ${signal}, starting graceful shutdown`);
  
  server.close(() => {
    logger.info('HTTP server closed');
    
    // Close database connections, cache, etc.
    Promise.all([
      // Add cleanup functions here
    ]).then(() => {
      logger.info('All connections closed, exiting');
      process.exit(0);
    }).catch((error) => {
      logger.error('Error during shutdown', { error: error.message });
      process.exit(1);
    });
  });
};

// Handle graceful shutdown
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', { reason, promise });
  process.exit(1);
});

// Start server
const server = app.listen(PORT, HOST, () => {
  logger.info('Server started', {
    host: HOST,
    port: PORT,
    environment: NODE_ENV,
    processId: process.pid,
    nodeVersion: process.version,
  });
});

// Scheduled tasks
if (IS_PRODUCTION) {
  // Clean expired cache entries every hour
  cron.schedule('0 * * * *', async () => {
    try {
      await clearExpiredCache();
      logger.info('Scheduled cache cleanup completed');
    } catch (error) {
      logger.error('Scheduled cache cleanup failed', { error: error.message });
    }
  });

  // Health metrics every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    const usage = process.memoryUsage();
    metrics.memoryUsage.set({ type: 'rss' }, usage.rss);
    metrics.memoryUsage.set({ type: 'heapUsed' }, usage.heapUsed);
    metrics.memoryUsage.set({ type: 'heapTotal' }, usage.heapTotal);
    metrics.memoryUsage.set({ type: 'external' }, usage.external);
  });
}

export default app;