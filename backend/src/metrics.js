import client from 'prom-client';

// Create a Registry which registers the metrics
const register = new client.Registry();

// Add a default label which is added to all metrics
register.setDefaultLabels({
  app: 'balanced-news-backend',
  version: process.env.npm_package_version || '1.0.0',
  environment: process.env.NODE_ENV || 'development'
});

// Enable the collection of default metrics
client.collectDefaultMetrics({ register });

// Custom metrics for the application

// HTTP Request metrics
const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_ms',
  help: 'Duration of HTTP requests in ms',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.1, 5, 15, 50, 100, 500, 1000, 5000, 10000]
});

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code']
});

// Feed endpoint metrics
const feedRequests = new client.Counter({
  name: 'feed_requests_total',
  help: 'Total number of feed requests',
  labelNames: ['status', 'cached']
});

const feedResponseTime = new client.Histogram({
  name: 'feed_response_time_ms',
  help: 'Feed response time in milliseconds',
  buckets: [50, 100, 500, 1000, 2000, 5000, 10000]
});

// Article endpoint metrics
const articleRequests = new client.Counter({
  name: 'article_requests_total',
  help: 'Total number of article requests',
  labelNames: ['status', 'cached']
});

const articleResponseTime = new client.Histogram({
  name: 'article_response_time_ms',
  help: 'Article response time in milliseconds',
  buckets: [100, 500, 1000, 2000, 5000, 10000, 20000]
});

const articleParsingTime = new client.Histogram({
  name: 'article_parsing_time_ms',
  help: 'Article parsing time in milliseconds',
  buckets: [500, 1000, 2000, 5000, 10000, 20000, 30000]
});

const articleParsingRequests = new client.Counter({
  name: 'article_parsing_requests_total',
  help: 'Total number of article parsing requests',
  labelNames: ['status', 'domain', 'errorType']
});

// Reaction endpoint metrics
const reactionRequests = new client.Counter({
  name: 'reaction_requests_total',
  help: 'Total number of reaction requests',
  labelNames: ['status', 'emoji']
});

const reactionResponseTime = new client.Histogram({
  name: 'reaction_response_time_ms',
  help: 'Reaction response time in milliseconds',
  buckets: [10, 50, 100, 500, 1000, 2000]
});

// Cache metrics
const cacheHits = new client.Counter({
  name: 'cache_hits_total',
  help: 'Total number of cache hits',
  labelNames: ['backend']
});

const cacheMisses = new client.Counter({
  name: 'cache_misses_total',
  help: 'Total number of cache misses',
  labelNames: ['backend']
});

const cacheOperationDuration = new client.Histogram({
  name: 'cache_operation_duration_ms',
  help: 'Cache operation duration in milliseconds',
  labelNames: ['operation', 'backend'],
  buckets: [1, 5, 10, 50, 100, 500, 1000]
});

const cacheSize = new client.Gauge({
  name: 'cache_size',
  help: 'Current cache size',
  labelNames: ['backend']
});

const cacheErrors = new client.Counter({
  name: 'cache_errors_total',
  help: 'Total number of cache errors',
  labelNames: ['type', 'operation']
});

// Database metrics
const dbOperations = new client.Counter({
  name: 'db_operations_total',
  help: 'Total number of database operations',
  labelNames: ['operation', 'status']
});

const dbOperationDuration = new client.Histogram({
  name: 'db_operation_duration_ms',
  help: 'Database operation duration in milliseconds',
  labelNames: ['operation'],
  buckets: [1, 10, 50, 100, 500, 1000, 5000]
});

const dbPoolConnections = new client.Gauge({
  name: 'db_pool_connections',
  help: 'Current database pool connections',
  labelNames: ['state']
});

const dbErrors = new client.Counter({
  name: 'db_errors_total',
  help: 'Total number of database errors',
  labelNames: ['type']
});

// NewsAPI metrics
const newsApiRequests = new client.Counter({
  name: 'newsapi_requests_total',
  help: 'Total number of NewsAPI requests',
  labelNames: ['status', 'endpoint']
});

const newsApiResponseTime = new client.Histogram({
  name: 'newsapi_response_time_ms',
  help: 'NewsAPI response time in milliseconds',
  buckets: [100, 500, 1000, 2000, 5000, 10000]
});

const newsApiArticlesReturned = new client.Histogram({
  name: 'newsapi_articles_returned',
  help: 'Number of articles returned by NewsAPI',
  buckets: [0, 1, 5, 10, 25, 50, 100]
});

const newsApiErrors = new client.Counter({
  name: 'newsapi_errors_total',
  help: 'Total number of NewsAPI errors',
  labelNames: ['status', 'endpoint']
});

const newsApiRetries = new client.Counter({
  name: 'newsapi_retries_total',
  help: 'Total number of NewsAPI retries',
  labelNames: ['status']
});

const newsApiHealthStatus = new client.Gauge({
  name: 'newsapi_health_status',
  help: 'NewsAPI health status (1 = healthy, 0 = unhealthy)'
});

const newsApiHealthResponseTime = new client.Histogram({
  name: 'newsapi_health_response_time_ms',
  help: 'NewsAPI health check response time in milliseconds',
  buckets: [100, 500, 1000, 2000, 5000]
});

// Source selection metrics
const sourcesCount = new client.Gauge({
  name: 'sources_count',
  help: 'Total number of available sources'
});

const sourceSelectionDuration = new client.Histogram({
  name: 'source_selection_duration_ms',
  help: 'Source selection duration in milliseconds',
  buckets: [1, 5, 10, 50, 100, 500]
});

const sourcePickingDuration = new client.Histogram({
  name: 'source_picking_duration_ms',
  help: 'Source picking duration in milliseconds',
  buckets: [1, 5, 10, 50, 100, 500]
});

const sourcesPickedCount = new client.Histogram({
  name: 'sources_picked_count',
  help: 'Number of sources picked per request',
  buckets: [1, 2, 3, 4, 5, 6]
});

const sourcePickingErrors = new client.Counter({
  name: 'source_picking_errors_total',
  help: 'Total number of source picking errors'
});

// Health check metrics
const healthChecks = new client.Counter({
  name: 'health_checks_total',
  help: 'Total number of health checks',
  labelNames: ['status']
});

const healthCheckDuration = new client.Histogram({
  name: 'health_check_duration_ms',
  help: 'Health check duration in milliseconds',
  buckets: [1, 10, 50, 100, 500, 1000]
});

// Memory usage metrics
const memoryUsage = new client.Gauge({
  name: 'memory_usage_bytes',
  help: 'Memory usage in bytes',
  labelNames: ['type']
});

// Register all metrics
register.registerMetric(httpRequestDuration);
register.registerMetric(httpRequestsTotal);
register.registerMetric(feedRequests);
register.registerMetric(feedResponseTime);
register.registerMetric(articleRequests);
register.registerMetric(articleResponseTime);
register.registerMetric(articleParsingTime);
register.registerMetric(articleParsingRequests);
register.registerMetric(reactionRequests);
register.registerMetric(reactionResponseTime);
register.registerMetric(cacheHits);
register.registerMetric(cacheMisses);
register.registerMetric(cacheOperationDuration);
register.registerMetric(cacheSize);
register.registerMetric(cacheErrors);
register.registerMetric(dbOperations);
register.registerMetric(dbOperationDuration);
register.registerMetric(dbPoolConnections);
register.registerMetric(dbErrors);
register.registerMetric(newsApiRequests);
register.registerMetric(newsApiResponseTime);
register.registerMetric(newsApiArticlesReturned);
register.registerMetric(newsApiErrors);
register.registerMetric(newsApiRetries);
register.registerMetric(newsApiHealthStatus);
register.registerMetric(newsApiHealthResponseTime);
register.registerMetric(sourcesCount);
register.registerMetric(sourceSelectionDuration);
register.registerMetric(sourcePickingDuration);
register.registerMetric(sourcesPickedCount);
register.registerMetric(sourcePickingErrors);
register.registerMetric(healthChecks);
register.registerMetric(healthCheckDuration);
register.registerMetric(memoryUsage);

// Middleware to track HTTP requests
export const promMiddleware = (req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    const route = req.route?.path || req.path || 'unknown';
    const method = req.method;
    const statusCode = res.statusCode;
    
    httpRequestDuration
      .labels(method, route, statusCode)
      .observe(duration);
      
    httpRequestsTotal
      .labels(method, route, statusCode)
      .inc();
  });
  
  next();
};

// Export all metrics
export const metrics = {
  register,
  httpRequestDuration,
  httpRequestsTotal,
  feedRequests,
  feedResponseTime,
  articleRequests,
  articleResponseTime,
  articleParsingTime,
  articleParsingRequests,
  reactionRequests,
  reactionResponseTime,
  cacheHits,
  cacheMisses,
  cacheOperationDuration,
  cacheSize,
  cacheErrors,
  dbOperations,
  dbOperationDuration,
  dbPoolConnections,
  dbErrors,
  newsApiRequests,
  newsApiResponseTime,
  newsApiArticlesReturned,
  newsApiErrors,
  newsApiRetries,
  newsApiHealthStatus,
  newsApiHealthResponseTime,
  sourcesCount,
  sourceSelectionDuration,
  sourcePickingDuration,
  sourcesPickedCount,
  sourcePickingErrors,
  healthChecks,
  healthCheckDuration,
  memoryUsage
};

export default metrics;