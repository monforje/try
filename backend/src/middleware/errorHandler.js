import { logger } from '../logger.js';

const IS_DEVELOPMENT = process.env.NODE_ENV === 'development';

// 404 Not Found handler
export const notFoundHandler = (req, res, next) => {
  const error = new Error(`Route not found: ${req.method} ${req.originalUrl}`);
  error.status = 404;
  
  logger.warn('Route not found', {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.originalUrl} not found`,
    timestamp: new Date().toISOString()
  });
};

// Global error handler
export const errorHandler = (err, req, res, next) => {
  // Default to 500 server error
  let error = {
    status: err.status || err.statusCode || 500,
    message: err.message || 'Internal Server Error',
    timestamp: new Date().toISOString()
  };
  
  // Log the error
  const logContext = {
    error: err.message,
    status: error.status,
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    requestId: req.headers['x-request-id']
  };
  
  if (error.status >= 500) {
    logger.error('Server error', {
      ...logContext,
      stack: err.stack
    });
  } else {
    logger.warn('Client error', logContext);
  }
  
  // Don't leak error details in production
  if (!IS_DEVELOPMENT && error.status >= 500) {
    error.message = 'Internal Server Error';
  }
  
  // Add stack trace in development
  if (IS_DEVELOPMENT) {
    error.stack = err.stack;
  }
  
  // Handle specific error types
  if (err.name === 'ValidationError') {
    error.status = 400;
    error.message = 'Validation Error';
    error.details = err.details;
  } else if (err.name === 'CastError') {
    error.status = 400;
    error.message = 'Invalid ID format';
  } else if (err.code === 11000) {
    error.status = 400;
    error.message = 'Duplicate field value';
  }
  
  res.status(error.status).json({
    error: error.message,
    status: error.status,
    timestamp: error.timestamp,
    ...(error.details && { details: error.details }),
    ...(error.stack && { stack: error.stack })
  });
};