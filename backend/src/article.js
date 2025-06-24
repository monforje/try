import axios from 'axios';
import axiosRetry from 'axios-retry';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import sanitizeHtml from 'sanitize-html';
import { URL } from 'url';
import { logger } from './logger.js';
import { metrics } from './metrics.js';

// Configure axios with retry logic
const axiosInstance = axios.create({
  timeout: 30000, // 30 seconds
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; BalancedNewsBot/1.0; +https://balancednews.com)',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
  },
});

// Configure retry logic
axiosRetry(axiosInstance, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) => {
    return axiosRetry.isNetworkOrIdempotentRequestError(error) ||
           (error.response?.status >= 500 && error.response?.status < 600);
  },
});

// Sanitization configuration
const sanitizeOptions = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'strong', 'em', 'u', 'i', 'b',
    'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
    'a', 'img', 'figure', 'figcaption',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'div', 'span', 'article', 'section'
  ],
  allowedAttributes: {
    'a': ['href', 'title'],
    'img': ['src', 'alt', 'title', 'width', 'height'],
    'blockquote': ['cite'],
    '*': ['class']
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: {
    'img': ['http', 'https', 'data']
  },
  transformTags: {
    'a': (tagName, attribs) => {
      // Make all links open in new tab and add security
      return {
        tagName: 'a',
        attribs: {
          ...attribs,
          target: '_blank',
          rel: 'noopener noreferrer'
        }
      };
    }
  }
};

// URL validation
function isValidUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// Extract domain from URL
function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return 'unknown';
  }
}

// Calculate reading time based on word count
function calculateReadingTime(text) {
  if (!text) return 0;
  
  const wordsPerMinute = 200; // Average reading speed
  const words = text.trim().split(/\s+/).length;
  const minutes = words / wordsPerMinute;
  
  return Math.max(1, Math.ceil(minutes * 60)); // Return seconds, minimum 1 minute
}

// Extract metadata from HTML
function extractMetadata(dom, url) {
  const document = dom.window.document;
  const metadata = {};

  // Title extraction priority: og:title -> twitter:title -> title tag -> h1
  metadata.title = 
    document.querySelector('meta[property="og:title"]')?.content ||
    document.querySelector('meta[name="twitter:title"]')?.content ||
    document.querySelector('title')?.textContent ||
    document.querySelector('h1')?.textContent ||
    'Article Title Not Found';

  // Author extraction
  metadata.author = 
    document.querySelector('meta[name="author"]')?.content ||
    document.querySelector('meta[property="article:author"]')?.content ||
    document.querySelector('[rel="author"]')?.textContent ||
    document.querySelector('.author')?.textContent ||
    document.querySelector('.byline')?.textContent ||
    '';

  // Publication date
  metadata.publishedAt = 
    document.querySelector('meta[property="article:published_time"]')?.content ||
    document.querySelector('meta[name="publish-date"]')?.content ||
    document.querySelector('meta[name="date"]')?.content ||
    document.querySelector('time[datetime]')?.getAttribute('datetime') ||
    document.querySelector('time')?.textContent ||
    '';

  // Description
  metadata.description = 
    document.querySelector('meta[property="og:description"]')?.content ||
    document.querySelector('meta[name="description"]')?.content ||
    document.querySelector('meta[name="twitter:description"]')?.content ||
    '';

  // Image
  metadata.image = 
    document.querySelector('meta[property="og:image"]')?.content ||
    document.querySelector('meta[name="twitter:image"]')?.content ||
    document.querySelector('img')?.src ||
    '';

  // Clean up the data
  metadata.title = metadata.title.trim().substring(0, 500);
  metadata.author = metadata.author.trim().substring(0, 200);
  metadata.description = metadata.description.trim().substring(0, 1000);

  // Validate and clean dates
  if (metadata.publishedAt) {
    const date = new Date(metadata.publishedAt);
    if (isNaN(date.getTime())) {
      metadata.publishedAt = '';
    } else {
      metadata.publishedAt = date.toISOString();
    }
  }

  // Resolve relative image URLs
  if (metadata.image && !metadata.image.startsWith('http')) {
    try {
      metadata.image = new URL(metadata.image, url).href;
    } catch (_) {
      metadata.image = '';
    }
  }

  return metadata;
}

// Main article parsing function
export async function parseArticle(url) {
  const startTime = Date.now();
  const domain = getDomain(url);
  
  logger.info('Starting article parsing', { url: url.substring(0, 100) + '...', domain });

  // Validate URL
  if (!isValidUrl(url)) {
    throw new Error(`Invalid URL provided: ${url}`);
  }

  try {
    // Fetch the webpage
    logger.debug('Fetching webpage', { url: url.substring(0, 100) + '...' });
    
    const response = await axiosInstance.get(url, {
      validateStatus: (status) => status < 400, // Accept redirects
      maxRedirects: 5,
    });

    const html = response.data;
    const finalUrl = response.request.res.responseUrl || url;

    logger.debug('Webpage fetched successfully', { 
      statusCode: response.status,
      contentLength: html.length,
      finalUrl: finalUrl !== url ? finalUrl.substring(0, 100) + '...' : 'same'
    });

    // Parse HTML with JSDOM
    const dom = new JSDOM(html, { url: finalUrl });
    const document = dom.window.document;

    // Extract metadata
    const metadata = extractMetadata(dom, finalUrl);
    logger.debug('Metadata extracted', { 
      hasTitle: !!metadata.title,
      hasAuthor: !!metadata.author,
      hasDate: !!metadata.publishedAt,
      hasDescription: !!metadata.description
    });

    // Use Readability to extract main content
    const reader = new Readability(document, {
      debug: false,
      charThreshold: 500, // Minimum character count
      classesToPreserve: ['caption', 'quote', 'highlight']
    });

    const article = reader.parse();
    
    if (!article) {
      logger.warn('Readability failed to parse article', { url: url.substring(0, 100) + '...' });
      
      // Fallback: try to extract content manually
      const contentSelectors = [
        'article',
        '[role="main"]',
        '.content',
        '.article-content',
        '.post-content',
        '.entry-content',
        'main',
        '.main-content'
      ];

      let fallbackContent = '';
      for (const selector of contentSelectors) {
        const element = document.querySelector(selector);
        if (element && element.textContent.length > 500) {
          fallbackContent = element.innerHTML;
          break;
        }
      }

      if (!fallbackContent) {
        // Last resort: get all paragraphs
        const paragraphs = Array.from(document.querySelectorAll('p'))
          .map(p => p.innerHTML)
          .filter(p => p.length > 50);
        
        fallbackContent = paragraphs.join('\n\n');
      }

      if (!fallbackContent) {
        throw new Error('Could not extract article content');
      }

      article = {
        title: metadata.title,
        content: fallbackContent,
        textContent: document.body.textContent || '',
        length: fallbackContent.length,
        excerpt: metadata.description
      };
    }

    // Sanitize the HTML content
    const sanitizedContent = sanitizeHtml(article.content, sanitizeOptions);
    
    // Calculate reading time
    const readingTimeSec = calculateReadingTime(article.textContent || sanitizedContent);

    // Build final result
    const result = {
      title: article.title || metadata.title,
      author: metadata.author,
      publishedAt: metadata.publishedAt,
      htmlContent: sanitizedContent,
      readingTimeSec,
      description: article.excerpt || metadata.description,
      wordCount: article.textContent ? article.textContent.trim().split(/\s+/).length : 0,
      domain,
      originalUrl: url,
      finalUrl: finalUrl !== url ? finalUrl : undefined,
      extractedAt: new Date().toISOString(),
    };

    const processingTime = Date.now() - startTime;
    
    metrics.articleParsingTime.observe(processingTime);
    metrics.articleParsingRequests.inc({ status: 'success', domain });

    logger.info('Article parsing completed', {
      url: url.substring(0, 100) + '...',
      domain,
      processingTime,
      contentLength: sanitizedContent.length,
      wordCount: result.wordCount,
      readingTimeSec: result.readingTimeSec
    });

    return result;

  } catch (error) {
    const processingTime = Date.now() - startTime;
    
    metrics.articleParsingTime.observe(processingTime);
    metrics.articleParsingRequests.inc({ 
      status: 'error', 
      domain,
      errorType: error.code || 'unknown'
    });

    logger.error('Article parsing failed', {
      url: url.substring(0, 100) + '...',
      domain,
      processingTime,
      error: error.message,
      errorCode: error.code,
      statusCode: error.response?.status
    });

    // Enhanced error handling
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      throw new Error(`Website ${domain} is not accessible`);
    } else if (error.code === 'ETIMEDOUT') {
      throw new Error(`Timeout while fetching article from ${domain}`);
    } else if (error.response?.status === 403) {
      throw new Error(`Access denied to ${domain} (403 Forbidden)`);
    } else if (error.response?.status === 404) {
      throw new Error(`Article not found (404) at ${domain}`);
    } else if (error.response?.status === 429) {
      throw new Error(`Rate limited by ${domain} (429 Too Many Requests)`);
    } else if (error.response?.status >= 500) {
      throw new Error(`Server error at ${domain} (${error.response.status})`);
    } else if (error.message.includes('Could not extract')) {
      throw new Error(`Could not extract readable content from ${domain}`);
    } else {
      throw new Error(`Failed to parse article: ${error.message}`);
    }
  }
}

// Health check for article parsing service
export async function checkArticleParsingHealth() {
  try {
    // Test with a simple, reliable URL
    const testUrl = 'https://httpbin.org/html';
    const testResult = await parseArticle(testUrl);
    
    return {
      status: 'healthy',
      testParsed: !!testResult.htmlContent,
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