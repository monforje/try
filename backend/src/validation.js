import Joi from 'joi';

// Feed query validation
export const validateFeedQuery = (query) => {
  const schema = Joi.object({
    x: Joi.number().min(-1).max(1).required()
      .messages({
        'number.min': 'x coordinate must be between -1 and 1',
        'number.max': 'x coordinate must be between -1 and 1',
        'any.required': 'x coordinate is required'
      }),
    y: Joi.number().min(-1).max(1).required()
      .messages({
        'number.min': 'y coordinate must be between -1 and 1', 
        'number.max': 'y coordinate must be between -1 and 1',
        'any.required': 'y coordinate is required'
      }),
    client_ts: Joi.number().integer().min(0).optional(),
    refresh: Joi.boolean().optional().default(false)
  });

  return schema.validate(query);
};

// Article query validation
export const validateArticleQuery = (query) => {
  const schema = Joi.object({
    url: Joi.string().uri().required()
      .messages({
        'string.uri': 'url must be a valid HTTP/HTTPS URL',
        'any.required': 'url is required'
      }),
    refresh: Joi.boolean().optional().default(false)
  });

  return schema.validate(query);
};

// Reaction body validation
export const validateReactionBody = (body) => {
  const schema = Joi.object({
    userId: Joi.string().min(1).max(255).required()
      .messages({
        'string.min': 'userId cannot be empty',
        'string.max': 'userId is too long',
        'any.required': 'userId is required'
      }),
    articleId: Joi.string().uri().required()
      .messages({
        'string.uri': 'articleId must be a valid URL',
        'any.required': 'articleId is required'
      }),
    emoji: Joi.string().valid('like', 'meh', 'dislike').required()
      .messages({
        'any.only': 'emoji must be one of: like, meh, dislike',
        'any.required': 'emoji is required'
      }),
    ts: Joi.number().integer().min(0).optional(),
    metadata: Joi.object().optional().default({})
  });

  return schema.validate(body);
};