import axios from 'axios';
import axiosRetry from 'axios-retry';
import { logger } from './logger.js';
import { metrics } from './metrics.js';

// Configuration
const NEWSAPI_KEY = process.env.NEWSAPI_KEY;
const NEWSAPI_BASE_URL = process.env.NEWSAPI_BASE_URL || 'https://newsapi.org/v2';
const NEWSAPI_TIMEOUT = parseInt(process.env.NEWSAPI_TIMEOUT) || 10000;
const MAX_ARTICLES_PER_SOURCE = parseInt(process.env.MAX_ARTICLES_PER_SOURCE) || 25;
const ARTICLE_MAX_AGE_DAYS = parseInt(process.env.ARTICLE_MAX_AGE_DAYS) || 7;
const RATE_LIMIT_DELAY = parseInt(process.env.NEWSAPI_RATE_LIMIT_DELAY) || 1000;

// Available NewsAPI endpoints
const ENDPOINTS = {
  TOP_HEADLINES: `${NEWSAPI_BASE_URL}/top-headlines`,
  EVERYTHING: `${NEWSAPI_BASE_URL}/everything`,
  SOURCES: `${NEWSAPI_BASE_URL}/sources`
};

// Create axios instance with default configuration
const newsApiClient = axios.create({
  timeout: NEWSAPI_TIMEOUT,
  headers: {
    'User-Agent': 'BalancedNews/1.0 (+https://balancednews.com)',
    'Accept': 'application/json',
    'Accept-Encoding': 'gzip, deflate',
  },
});

// Configure retry logic for NewsAPI requests
axiosRetry(newsApiClient, {
  retries: 3,
  retryDelay: (retryCount) => {
    const delay = Math.min(1000 * Math.pow(2, retryCount), 10000);
    logger.debug('NewsAPI retry attempt', { retryCount, delay });
    return delay;
  },
  retryCondition: (error) => {
    // Retry on network errors and 5xx server errors
    if (axiosRetry.isNetworkOrIdempotentRequestError(error)) {
      return true;
    }
    
    // Don't retry on authentication or rate limit errors
    if (error.response?.status === 401 || error.response?.status === 429) {
      return false;
    }
    
    // Retry on server errors (5xx)
    return error.response?.status >= 500;
  },
  onRetry: (retryCount, error, requestConfig) => {
    logger.warn('NewsAPI request retry', {
      retryCount,
      error: error.message,
      status: error.response?.status,
      url: requestConfig.url
    });
    metrics.newsApiRetries.inc({ status: error.response?.status || 'network_error' });
  }
});

// Rate limiting for NewsAPI calls
let lastRequestTime = 0;

async function enforceRateLimit() {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  
  if (timeSinceLastRequest < RATE_LIMIT_DELAY) {
    const waitTime = RATE_LIMIT_DELAY - timeSinceLastRequest;
    logger.debug('Enforcing NewsAPI rate limit', { waitTime });
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  
  lastRequestTime = Date.now();
}

// Enhanced error handling for NewsAPI responses
function handleNewsApiError(error, context = {}) {
  const status = error.response?.status;
  const responseData = error.response?.data;
  
  logger.error('NewsAPI request failed', {
    error: error.message,
    status,
    responseData,
    context,
    requestUrl: error.config?.url,
    requestParams: error.config?.params
  });
  
  // Update metrics
  metrics.newsApiErrors.inc({ 
    status: status || 'network_error',
    endpoint: context.endpoint || 'unknown'
  });
  
  // Provide user-friendly error messages
  switch (status) {
    case 400:
      throw new Error(`Invalid NewsAPI request: ${responseData?.message || 'Bad request parameters'}`);
    case 401:
      throw new Error('Invalid NewsAPI key - please check your API configuration');
    case 429:
      throw new Error('NewsAPI rate limit exceeded - please upgrade your plan or try again later');
    case 500:
    case 502:
    case 503:
      throw new Error('NewsAPI service temporarily unavailable - please try again later');
    default:
      if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
        throw new Error('Cannot connect to NewsAPI - please check your internet connection');
      } else if (error.code === 'ETIMEDOUT') {
        throw new Error('NewsAPI request timeout - please try again');
      } else {
        throw new Error(`NewsAPI error: ${error.message}`);
      }
  }
}

// Validate and filter articles
function validateAndFilterArticles(articles, maxAge = ARTICLE_MAX_AGE_DAYS) {
  if (!Array.isArray(articles)) {
    logger.warn('Invalid articles response - not an array', { articles });
    return [];
  }
  
  const cutoffDate = new Date(Date.now() - maxAge * 24 * 60 * 60 * 1000);
  const validArticles = [];
  
  for (const article of articles) {
    try {
      // Basic structure validation
      if (!article || typeof article !== 'object') {
        continue;
      }
      
      // Required fields
      if (!article.title || !article.url) {
        logger.debug('Article missing required fields', { 
          hasTitle: !!article.title,
          hasUrl: !!article.url,
          article: article.title || 'no title'
        });
        continue;
      }
      
      // URL validation
      if (!isValidUrl(article.url)) {
        logger.debug('Article has invalid URL', { url: article.url });
        continue;
      }
      
      // Date validation and filtering
      if (article.publishedAt) {
        const publishedDate = new Date(article.publishedAt);
        
        if (isNaN(publishedDate.getTime())) {
          logger.debug('Article has invalid publish date', { 
            publishedAt: article.publishedAt,
            title: article.title
          });
          continue;
        }
        
        if (publishedDate < cutoffDate) {
          logger.debug('Article too old', { 
            publishedAt: article.publishedAt,
            cutoffDate: cutoffDate.toISOString(),
            title: article.title
          });
          continue;
        }
      }
      
      // Source validation
      if (!article.source || !article.source.id) {
        logger.debug('Article missing source information', { title: article.title });
        continue;
      }
      
      // Content quality checks
      if (article.title === '[Removed]' || article.description === '[Removed]') {
        logger.debug('Article content removed', { title: article.title });
        continue;
      }
      
      // Clean and enhance article data
      const cleanedArticle = {
        title: article.title.trim(),
        description: article.description?.trim() || '',
        url: article.url,
        urlToImage: isValidUrl(article.urlToImage) ? article.urlToImage : null,
        publishedAt: article.publishedAt,
        source: {
          id: article.source.id,
          name: article.source.name || article.source.id
        },
        author: article.author?.trim() || null,
        content: article.content?.trim() || null
      };
      
      validArticles.push(cleanedArticle);
      
    } catch (error) {
      logger.warn('Error validating article', { 
        error: error.message,
        article: article?.title || 'unknown'
      });
    }
  }
  
  logger.debug('Article validation completed', {
    total: articles.length,
    valid: validArticles.length,
    filtered: articles.length - validArticles.length,
    maxAgeDays: maxAge
  });
  
  return validArticles;
}

// URL validation helper
function isValidUrl(url) {
  if (!url || typeof url !== 'string') {
    return false;
  }
  
  try {
    const urlObj = new URL(url);
    return urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
  } catch {
    return false;
  }
}

// Main function to get articles by sources
export async function getArticlesBySources(sourceIds, options = {}) {
  const startTime = Date.now();
  
  // Validate inputs
  if (!NEWSAPI_KEY) {
    throw new Error('NEWSAPI_KEY environment variable is not configured');
  }
  
  if (!sourceIds || !Array.isArray(sourceIds) || sourceIds.length === 0) {
    logger.warn('No source IDs provided for NewsAPI request');
    return [];
  }
  
  const {
    pageSize = MAX_ARTICLES_PER_SOURCE,
    sortBy = 'publishedAt',
    language = 'en',
    maxAge = ARTICLE_MAX_AGE_DAYS
  } = options;
  
  logger.info('Fetching articles from NewsAPI', {
    sourceIds,
    pageSize,
    sortBy,
    language,
    maxAge
  });
  
  try {
    // Enforce rate limiting
    await enforceRateLimit();
    
    // Prepare request parameters
    const params = {
      sources: sourceIds.join(','),
      language,
      sortBy,
      pageSize: Math.min(pageSize, 100), // NewsAPI limit
      apiKey: NEWSAPI_KEY
    };
    
    // Add time filter for freshness
    if (maxAge > 0) {
      const fromDate = new Date(Date.now() - maxAge * 24 * 60 * 60 * 1000);
      params.from = fromDate.toISOString();
    }
    
    logger.debug('NewsAPI request parameters', {
      url: ENDPOINTS.TOP_HEADLINES,
      params: { ...params, apiKey: `${NEWSAPI_KEY.substring(0, 8)}...` }
    });
    
    // Make the request
    const response = await newsApiClient.get(ENDPOINTS.TOP_HEADLINES, { params });
    
    const duration = Date.now() - startTime;
    
    // Log response details
    logger.info('NewsAPI response received', {
      status: response.data.status,
      totalResults: response.data.totalResults,
      articlesCount: response.data.articles?.length || 0,
      duration,
      requestId: response.headers['x-request-id']
    });
    
    // Validate response
    if (response.data.status !== 'ok') {
      throw new Error(`NewsAPI returned status: ${response.data.status} - ${response.data.message || 'Unknown error'}`);
    }
    
    if (!response.data.articles) {
      logger.warn('NewsAPI response missing articles array');
      return [];
    }
    
    // Process and validate articles
    const validatedArticles = validateAndFilterArticles(response.data.articles, maxAge);
    
    // Log article breakdown by source
    if (validatedArticles.length > 0) {
      const sourceBreakdown = validatedArticles.reduce((acc, article) => {
        const sourceId = article.source.id;
        acc[sourceId] = (acc[sourceId] || 0) + 1;
        return acc;
      }, {});
      
      logger.debug('Articles by source', { sourceBreakdown });
      
      // Check for sources with no articles
      const sourcesWithNoArticles = sourceIds.filter(id => !sourceBreakdown[id]);
      if (sourcesWithNoArticles.length > 0) {
        logger.warn('Some sources returned no articles', { 
          sourcesWithNoArticles,
          totalRequested: sourceIds.length,
          sourcesWithArticles: Object.keys(sourceBreakdown).length
        });
      }
    }
    
    // Update metrics
    metrics.newsApiRequests.inc({ status: 'success', endpoint: 'top-headlines' });
    metrics.newsApiResponseTime.observe(duration);
    metrics.newsApiArticlesReturned.observe(validatedArticles.length);
    
    logger.info('NewsAPI articles processing completed', {
      sourceIds,
      totalArticles: response.data.articles.length,
      validArticles: validatedArticles.length,
      duration,
      efficiency: validatedArticles.length / response.data.articles.length
    });
    
    return validatedArticles;
    
  } catch (error) {
    const duration = Date.now() - startTime;
    
    // Handle and log the error
    handleNewsApiError(error, { 
      sourceIds, 
      endpoint: 'top-headlines',
      duration 
    });
  }
}

// Get everything articles (alternative endpoint)
export async function getEverythingArticles(query, options = {}) {
  const startTime = Date.now();
  
  if (!NEWSAPI_KEY) {
    throw new Error('NEWSAPI_KEY environment variable is not configured');
  }
  
  const {
    sources,
    domains,
    pageSize = MAX_ARTICLES_PER_SOURCE,
    sortBy = 'publishedAt',
    language = 'en',
    maxAge = ARTICLE_MAX_AGE_DAYS
  } = options;
  
  logger.info('Fetching articles from NewsAPI everything endpoint', {
    query,
    sources,
    domains,
    pageSize,
    sortBy,
    language
  });
  
  try {
    await enforceRateLimit();
    
    const params = {
      q: query,
      language,
      sortBy,
      pageSize: Math.min(pageSize, 100),
      apiKey: NEWSAPI_KEY
    };
    
    if (sources) {
      params.sources = Array.isArray(sources) ? sources.join(',') : sources;
    }
    
    if (domains) {
      params.domains = Array.isArray(domains) ? domains.join(',') : domains;
    }
    
    if (maxAge > 0) {
      const fromDate = new Date(Date.now() - maxAge * 24 * 60 * 60 * 1000);
      params.from = fromDate.toISOString();
    }
    
    logger.debug('NewsAPI everything request', {
      url: ENDPOINTS.EVERYTHING,
      params: { ...params, apiKey: `${NEWSAPI_KEY.substring(0, 8)}...` }
    });
    
    const response = await newsApiClient.get(ENDPOINTS.EVERYTHING, { params });
    const duration = Date.now() - startTime;
    
    logger.info('NewsAPI everything response received', {
      status: response.data.status,
      totalResults: response.data.totalResults,
      articlesCount: response.data.articles?.length || 0,
      duration
    });
    
    if (response.data.status !== 'ok') {
      throw new Error(`NewsAPI returned status: ${response.data.status} - ${response.data.message || 'Unknown error'}`);
    }
    
    const validatedArticles = validateAndFilterArticles(response.data.articles, maxAge);
    
    metrics.newsApiRequests.inc({ status: 'success', endpoint: 'everything' });
    metrics.newsApiResponseTime.observe(duration);
    metrics.newsApiArticlesReturned.observe(validatedArticles.length);
    
    return validatedArticles;
    
  } catch (error) {
    const duration = Date.now() - startTime;
    handleNewsApiError(error, { 
      query, 
      endpoint: 'everything',
      duration 
    });
  }
}

// Get available sources from NewsAPI
export async function getAvailableSources(options = {}) {
  const startTime = Date.now();
  
  if (!NEWSAPI_KEY) {
    throw new Error('NEWSAPI_KEY environment variable is not configured');
  }
  
  const {
    category,
    language = 'en',
    country
  } = options;
  
  logger.info('Fetching available sources from NewsAPI', {
    category,
    language,
    country
  });
  
  try {
    await enforceRateLimit();
    
    const params = {
      language,
      apiKey: NEWSAPI_KEY
    };
    
    if (category) params.category = category;
    if (country) params.country = country;
    
    const response = await newsApiClient.get(ENDPOINTS.SOURCES, { params });
    const duration = Date.now() - startTime;
    
    logger.info('NewsAPI sources response received', {
      status: response.data.status,
      sourcesCount: response.data.sources?.length || 0,
      duration
    });
    
    if (response.data.status !== 'ok') {
      throw new Error(`NewsAPI returned status: ${response.data.status} - ${response.data.message || 'Unknown error'}`);
    }
    
    metrics.newsApiRequests.inc({ status: 'success', endpoint: 'sources' });
    metrics.newsApiResponseTime.observe(duration);
    
    return response.data.sources || [];
    
  } catch (error) {
    const duration = Date.now() - startTime;
    handleNewsApiError(error, { 
      endpoint: 'sources',
      duration 
    });
  }
}

// Health check for NewsAPI service
export async function checkNewsApiHealth() {
  try {
    if (!NEWSAPI_KEY) {
      return {
        status: 'unhealthy',
        error: 'NewsAPI key not configured',
        timestamp: new Date().toISOString()
      };
    }
    
    // Test with a simple sources request
    const startTime = Date.now();
    await enforceRateLimit();
    
    const response = await newsApiClient.get(ENDPOINTS.SOURCES, {
      params: {
        language: 'en',
        pageSize: 1,
        apiKey: NEWSAPI_KEY
      },
      timeout: 5000
    });
    
    const duration = Date.now() - startTime;
    
    return {
      status: response.data.status === 'ok' ? 'healthy' : 'unhealthy',
      responseTime: duration,
      apiStatus: response.data.status,
      keyValid: true,
      sourcesAvailable: response.data.sources?.length || 0,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message,
      keyValid: error.response?.status !== 401,
      timestamp: new Date().toISOString()
    };
  }
}

// Get NewsAPI usage statistics (if available)
export async function getNewsApiStats() {
  return {
    keyConfigured: !!NEWSAPI_KEY,
    keyLength: NEWSAPI_KEY?.length || 0,
    baseUrl: NEWSAPI_BASE_URL,
    timeout: NEWSAPI_TIMEOUT,
    maxArticlesPerSource: MAX_ARTICLES_PER_SOURCE,
    maxAgeDays: ARTICLE_MAX_AGE_DAYS,
    rateLimitDelay: RATE_LIMIT_DELAY,
    lastRequestTime: lastRequestTime ? new Date(lastRequestTime).toISOString() : null,
    endpoints: ENDPOINTS
  };
}

// Batch request multiple sources efficiently
export async function getBatchArticles(sourceBatches, options = {}) {
  const allArticles = [];
  const errors = [];
  
  logger.info('Starting batch NewsAPI requests', {
    batchCount: sourceBatches.length,
    totalSources: sourceBatches.flat().length
  });
  
  for (let i = 0; i < sourceBatches.length; i++) {
    const batch = sourceBatches[i];
    
    try {
      logger.debug(`Processing batch ${i + 1}/${sourceBatches.length}`, {
        batchSize: batch.length,
        sources: batch
      });
      
      const articles = await getArticlesBySources(batch, options);
      allArticles.push(...articles);
      
      // Add delay between batches to respect rate limits
      if (i < sourceBatches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY));
      }
      
    } catch (error) {
      logger.error(`Batch ${i + 1} failed`, {
        batch,
        error: error.message
      });
      
      errors.push({
        batch: i + 1,
        sources: batch,
        error: error.message
      });
    }
  }
  
  logger.info('Batch NewsAPI requests completed', {
    totalArticles: allArticles.length,
    successfulBatches: sourceBatches.length - errors.length,
    failedBatches: errors.length
  });
  
  return {
    articles: allArticles,
    errors,
    totalBatches: sourceBatches.length,
    successfulBatches: sourceBatches.length - errors.length
  };
}

// Initialize NewsAPI client
function initializeNewsApi() {
  if (!NEWSAPI_KEY) {
    logger.warn('NewsAPI key not configured - some features will be unavailable');
    return false;
  }
  
  logger.info('NewsAPI client initialized', {
    baseUrl: NEWSAPI_BASE_URL,
    timeout: NEWSAPI_TIMEOUT,
    keyLength: NEWSAPI_KEY.length,
    retryAttempts: 3
  });
  
  return true;
}

// Initialize on module load
const isInitialized = initializeNewsApi();

// Export initialization status
export { isInitialized };

// Set up metrics collection
setInterval(async () => {
  try {
    const healthStatus = await checkNewsApiHealth();
    metrics.newsApiHealthStatus.set(healthStatus.status === 'healthy' ? 1 : 0);
    
    if (healthStatus.responseTime) {
      metrics.newsApiHealthResponseTime.observe(healthStatus.responseTime);
    }
  } catch (error) {
    logger.warn('Failed to update NewsAPI health metrics', { error: error.message });
  }
}, 60000); // Every minute