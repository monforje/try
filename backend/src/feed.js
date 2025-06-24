import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { metrics } from './metrics.js';

// Get __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const SOURCES_FILE = process.env.SOURCES_FILE || 'sources.json';
const MIN_SOURCES_COUNT = parseInt(process.env.MIN_SOURCES_COUNT) || 4;
const MAX_SEARCH_RADIUS = parseFloat(process.env.MAX_SEARCH_RADIUS) || 2.0;
const BIAS_COORDINATE_PRECISION = parseInt(process.env.BIAS_COORDINATE_PRECISION) || 3;

// Load sources with error handling and validation
let sources = [];
let sourcesLoadTime = null;

function loadSources() {
  try {
    const sourcesPath = path.join(process.cwd(), 'src', SOURCES_FILE);
    const sourcesData = fs.readFileSync(sourcesPath, 'utf-8');
    const parsedSources = JSON.parse(sourcesData);
    
    // Validate sources structure
    const validatedSources = validateSources(parsedSources);
    
    sources = validatedSources;
    sourcesLoadTime = new Date();
    
    logger.info('News sources loaded successfully', {
      count: sources.length,
      file: SOURCES_FILE,
      loadTime: sourcesLoadTime.toISOString()
    });
    
    // Update metrics
    metrics.sourcesCount.set(sources.length);
    
    return sources;
    
  } catch (error) {
    logger.error('Failed to load news sources', {
      error: error.message,
      file: SOURCES_FILE,
      stack: error.stack
    });
    
    // Fallback to empty array or default sources
    sources = getDefaultSources();
    logger.warn('Using default fallback sources', { count: sources.length });
    
    return sources;
  }
}

// Validate sources data structure and coordinates
function validateSources(sourcesData) {
  if (!Array.isArray(sourcesData)) {
    throw new Error('Sources data must be an array');
  }
  
  const validSources = sourcesData
    .filter((source, index) => {
      try {
        // Required fields validation
        if (!source.id || typeof source.id !== 'string') {
          logger.warn(`Source at index ${index}: missing or invalid 'id'`, { source });
          return false;
        }
        
        if (!source.name || typeof source.name !== 'string') {
          logger.warn(`Source at index ${index}: missing or invalid 'name'`, { source });
          return false;
        }
        
        // Coordinate validation
        if (typeof source.x !== 'number' || typeof source.y !== 'number') {
          logger.warn(`Source at index ${index}: missing or invalid coordinates`, { source });
          return false;
        }
        
        if (source.x < -1 || source.x > 1 || source.y < -1 || source.y > 1) {
          logger.warn(`Source at index ${index}: coordinates out of range [-1, 1]`, { source });
          return false;
        }
        
        // Optional fields with defaults
        source.category = source.category || 'general';
        source.language = source.language || 'en';
        source.country = source.country || 'us';
        source.active = source.active !== false; // Default to true unless explicitly false
        
        return true;
      } catch (validationError) {
        logger.warn(`Source validation failed at index ${index}`, { 
          error: validationError.message,
          source 
        });
        return false;
      }
    })
    .filter(source => source.active); // Only include active sources
  
  if (validSources.length < MIN_SOURCES_COUNT) {
    throw new Error(`Insufficient valid sources: ${validSources.length} (minimum: ${MIN_SOURCES_COUNT})`);
  }
  
  // Check for duplicate IDs
  const sourceIds = new Set();
  const duplicates = [];
  
  validSources.forEach(source => {
    if (sourceIds.has(source.id)) {
      duplicates.push(source.id);
    } else {
      sourceIds.add(source.id);
    }
  });
  
  if (duplicates.length > 0) {
    logger.warn('Duplicate source IDs found', { duplicates });
  }
  
  logger.info('Sources validation completed', {
    total: sourcesData.length,
    valid: validSources.length,
    filtered: sourcesData.length - validSources.length,
    duplicates: duplicates.length
  });
  
  return validSources;
}

// Fallback sources in case of file loading failure
function getDefaultSources() {
  return [
    { id: 'bbc-news', name: 'BBC News', x: -0.2, y: 0.1, category: 'general', active: true },
    { id: 'cnn', name: 'CNN', x: -0.5, y: 0.3, category: 'general', active: true },
    { id: 'fox-news', name: 'Fox News', x: 0.7, y: -0.2, category: 'general', active: true },
    { id: 'reuters', name: 'Reuters', x: 0.1, y: 0.4, category: 'general', active: true },
    { id: 'associated-press', name: 'Associated Press', x: 0.0, y: 0.2, category: 'general', active: true },
    { id: 'usa-today', name: 'USA Today', x: 0.0, y: 0.0, category: 'general', active: true }
  ];
}

// Enhanced euclidean distance calculation
function calculateDistance(pointA, pointB) {
  if (!pointA || !pointB || 
      typeof pointA.x !== 'number' || typeof pointA.y !== 'number' ||
      typeof pointB.x !== 'number' || typeof pointB.y !== 'number') {
    return Infinity;
  }
  
  const dx = pointA.x - pointB.x;
  const dy = pointA.y - pointB.y;
  
  return Math.sqrt(dx * dx + dy * dy);
}

// Find N closest sources to a point with enhanced filtering
function findClosestSources(x, y, n = 2, excludeIds = [], categoryFilter = null) {
  const startTime = Date.now();
  
  try {
    // Validate input coordinates
    if (typeof x !== 'number' || typeof y !== 'number') {
      throw new Error(`Invalid coordinates: x=${x}, y=${y}`);
    }
    
    if (x < -1 || x > 1 || y < -1 || y > 1) {
      logger.warn('Coordinates outside normal range', { x, y });
    }
    
    const targetPoint = { x, y };
    
    // Filter and calculate distances
    const candidateSources = sources
      .filter(source => {
        // Exclude sources in excludeIds
        if (excludeIds.includes(source.id)) {
          return false;
        }
        
        // Category filter if provided
        if (categoryFilter && source.category !== categoryFilter) {
          return false;
        }
        
        // Only include active sources
        return source.active !== false;
      })
      .map(source => {
        const distance = calculateDistance(targetPoint, source);
        return {
          ...source,
          distance,
          coordinates: { x: source.x, y: source.y }
        };
      })
      .filter(source => {
        // Filter out sources that are too far away
        return source.distance <= MAX_SEARCH_RADIUS;
      })
      .sort((a, b) => a.distance - b.distance)
      .slice(0, n);
    
    const duration = Date.now() - startTime;
    
    logger.debug('Found closest sources', {
      targetPoint,
      requestedCount: n,
      foundCount: candidateSources.length,
      excludedCount: excludeIds.length,
      categoryFilter,
      duration,
      sources: candidateSources.map(s => ({
        id: s.id,
        name: s.name,
        distance: s.distance.toFixed(3),
        coordinates: s.coordinates
      }))
    });
    
    metrics.sourceSelectionDuration.observe(duration);
    
    return candidateSources;
    
  } catch (error) {
    logger.error('Error finding closest sources', {
      error: error.message,
      coordinates: { x, y },
      requestedCount: n,
      excludeIds,
      categoryFilter
    });
    
    // Return empty array on error
    return [];
  }
}

// Enhanced source picker with improved logic
export function pickSources(x, y, options = {}) {
  const startTime = Date.now();
  
  try {
    const {
      friendlyCount = 2,
      opposingCount = 2,
      categoryFilter = null,
      ensureDiversity = true,
      fallbackStrategy = 'fill_remaining'
    } = options;
    
    // Validate inputs
    if (typeof x !== 'number' || typeof y !== 'number') {
      throw new Error(`Invalid bias coordinates: x=${x}, y=${y}`);
    }
    
    // Ensure sources are loaded
    if (sources.length === 0) {
      loadSources();
    }
    
    logger.debug('Picking sources for bias coordinates', {
      coordinates: { x: x.toFixed(BIAS_COORDINATE_PRECISION), y: y.toFixed(BIAS_COORDINATE_PRECISION) },
      friendlyCount,
      opposingCount,
      categoryFilter,
      ensureDiversity,
      totalSources: sources.length
    });
    
    // Find friendly sources (close to user's bias)
    const friendlySources = findClosestSources(x, y, friendlyCount, [], categoryFilter);
    
    // Find opposing sources (close to inverted bias)
    const opposingPoint = { x: -x, y: -y };
    const usedSourceIds = friendlySources.map(s => s.id);
    const opposingSources = findClosestSources(
      opposingPoint.x, 
      opposingPoint.y, 
      opposingCount, 
      usedSourceIds, 
      categoryFilter
    );
    
    // Combine all sources
    let allSources = [
      ...friendlySources.map(src => ({ ...src, side: 'friendly' })),
      ...opposingSources.map(src => ({ ...src, side: 'opposing' }))
    ];
    
    // Apply fallback strategy if we don't have enough sources
    const totalRequested = friendlyCount + opposingCount;
    if (allSources.length < totalRequested && fallbackStrategy === 'fill_remaining') {
      const remainingCount = totalRequested - allSources.length;
      const allUsedIds = allSources.map(s => s.id);
      
      // Find any remaining sources to fill the gaps
      const fallbackSources = findClosestSources(0, 0, remainingCount, allUsedIds, categoryFilter);
      
      allSources.push(
        ...fallbackSources.map(src => ({
          ...src,
          side: 'neutral',
          isFallback: true
        }))
      );
      
      if (fallbackSources.length > 0) {
        logger.warn('Used fallback sources to fill remaining slots', {
          fallbackCount: fallbackSources.length,
          fallbackSources: fallbackSources.map(s => ({ id: s.id, name: s.name }))
        });
      }
    }
    
    // Ensure diversity if requested
    if (ensureDiversity && allSources.length > 1) {
      allSources = ensureSourceDiversity(allSources);
    }
    
    // Final source mapping
    const finalSources = allSources.slice(0, totalRequested).map(source => ({
      id: source.id,
      name: source.name,
      side: source.side,
      x: source.x,
      y: source.y,
      distance: source.distance,
      category: source.category,
      isFallback: source.isFallback || false
    }));
    
    const duration = Date.now() - startTime;
    
    // Update metrics
    metrics.sourcePickingDuration.observe(duration);
    metrics.sourcesPickedCount.observe(finalSources.length);
    
    // Count by side
    const sideCount = finalSources.reduce((acc, src) => {
      acc[src.side] = (acc[src.side] || 0) + 1;
      return acc;
    }, {});
    
    logger.info('Sources picked successfully', {
      coordinates: { x: x.toFixed(BIAS_COORDINATE_PRECISION), y: y.toFixed(BIAS_COORDINATE_PRECISION) },
      totalPicked: finalSources.length,
      sideDistribution: sideCount,
      duration,
      sources: finalSources.map(s => ({
        id: s.id,
        name: s.name,
        side: s.side,
        distance: s.distance?.toFixed(3),
        isFallback: s.isFallback
      }))
    });
    
    return finalSources;
    
  } catch (error) {
    const duration = Date.now() - startTime;
    
    logger.error('Error picking sources', {
      error: error.message,
      coordinates: { x, y },
      options,
      duration,
      stack: error.stack
    });
    
    metrics.sourcePickingDuration.observe(duration);
    metrics.sourcePickingErrors.inc();
    
    // Return fallback sources on error
    return getEmergencyFallbackSources();
  }
}

// Ensure source diversity by avoiding too many similar sources
function ensureSourceDiversity(sources) {
  const seen = new Set();
  const diverse = [];
  
  // Priority: different organizations, then different categories
  for (const source of sources) {
    const orgKey = extractOrganization(source.name);
    const categoryKey = source.category || 'general';
    const diversityKey = `${orgKey}:${categoryKey}`;
    
    if (!seen.has(diversityKey) || diverse.length < 2) {
      diverse.push(source);
      seen.add(diversityKey);
    }
  }
  
  // Fill remaining slots if needed
  for (const source of sources) {
    if (diverse.length >= sources.length) break;
    if (!diverse.find(s => s.id === source.id)) {
      diverse.push(source);
    }
  }
  
  return diverse;
}

// Extract organization name for diversity checking
function extractOrganization(sourceName) {
  return sourceName
    .toLowerCase()
    .replace(/\s+(news|media|network|corporation|inc|corp|llc)$/i, '')
    .replace(/^(the|a|an)\s+/i, '')
    .trim();
}

// Emergency fallback when all else fails
function getEmergencyFallbackSources() {
  const fallback = getDefaultSources().slice(0, 4);
  
  logger.warn('Using emergency fallback sources', {
    count: fallback.length,
    sources: fallback.map(s => ({ id: s.id, name: s.name }))
  });
  
  return fallback.map((source, index) => ({
    ...source,
    side: index < 2 ? 'friendly' : 'opposing',
    distance: 0,
    isFallback: true,
    isEmergencyFallback: true
  }));
}

// Get all available sources (for admin/debugging)
export function getAllSources() {
  if (sources.length === 0) {
    loadSources();
  }
  
  return sources.map(source => ({
    id: source.id,
    name: source.name,
    coordinates: { x: source.x, y: source.y },
    category: source.category,
    language: source.language,
    country: source.country,
    active: source.active
  }));
}

// Get sources statistics
export function getSourcesStats() {
  if (sources.length === 0) {
    loadSources();
  }
  
  const stats = {
    total: sources.length,
    active: sources.filter(s => s.active !== false).length,
    byCategory: {},
    byLanguage: {},
    byCountry: {},
    coordinateRanges: {
      x: { min: Math.min(...sources.map(s => s.x)), max: Math.max(...sources.map(s => s.x)) },
      y: { min: Math.min(...sources.map(s => s.y)), max: Math.max(...sources.map(s => s.y)) }
    },
    loadTime: sourcesLoadTime?.toISOString(),
    lastReloaded: sourcesLoadTime
  };
  
  // Group by category, language, country
  sources.forEach(source => {
    const category = source.category || 'general';
    const language = source.language || 'unknown';
    const country = source.country || 'unknown';
    
    stats.byCategory[category] = (stats.byCategory[category] || 0) + 1;
    stats.byLanguage[language] = (stats.byLanguage[language] || 0) + 1;
    stats.byCountry[country] = (stats.byCountry[country] || 0) + 1;
  });
  
  return stats;
}

// Reload sources from file
export function reloadSources() {
  logger.info('Reloading sources from file');
  return loadSources();
}

// Health check for feed service
export function checkFeedHealth() {
  try {
    const stats = getSourcesStats();
    
    return {
      status: stats.active >= MIN_SOURCES_COUNT ? 'healthy' : 'unhealthy',
      sourcesCount: stats.total,
      activeSources: stats.active,
      minRequired: MIN_SOURCES_COUNT,
      lastLoaded: stats.loadTime,
      coordinateRanges: stats.coordinateRanges,
      categories: Object.keys(stats.byCategory).length,
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

// Load sources on module initialization
loadSources();

// Watch for sources file changes in development
if (process.env.NODE_ENV === 'development') {
  try {
    const sourcesPath = path.join(process.cwd(), 'src', SOURCES_FILE);
    fs.watchFile(sourcesPath, { interval: 5000 }, (curr, prev) => {
      if (curr.mtime !== prev.mtime) {
        logger.info('Sources file changed, reloading');
        reloadSources();
      }
    });
  } catch (error) {
    logger.warn('Could not watch sources file for changes', { error: error.message });
  }
}