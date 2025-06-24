import { logger } from '../logger.js';

export const requestLogger = (req, res, next) => {
  const startTime = Date.now();
  
  // Generate request ID if not present
  if (!req.headers['x-request-id']) {
    req.headers['x-request-id'] = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  const requestId = req.headers['x-request-id'];
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  
  // Log request start
  logger.info('Request started', {
    requestId,
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    contentLength: req.get('Content-Length'),
    contentType: req.get('Content-Type')
  });
  
  // Capture response details
  const originalSend = res.send;
  res.send = function(data) {
    const duration = Date.now() - startTime;
    
    logger.info('Request completed', {
      requestId,
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration,
      responseSize: data ? data.length : 0
    });
    
    return originalSend.call(this, data);
  };
  
  next();
};