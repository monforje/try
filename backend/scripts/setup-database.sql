-- =====================================================
-- BALANCED NEWS DATABASE SETUP
-- =====================================================
-- Run this script as PostgreSQL superuser (postgres)

-- Create database (if not exists)
SELECT 'CREATE DATABASE balancednews'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'balancednews')\gexec

-- Connect to the database
\c balancednews

-- Create user (if not exists)
DO
$do$
BEGIN
   IF NOT EXISTS (
      SELECT FROM pg_catalog.pg_roles
      WHERE  rolname = 'user') THEN

      CREATE ROLE "user" LOGIN PASSWORD 'password';
   END IF;
END
$do$;

-- Grant privileges
GRANT ALL PRIVILEGES ON DATABASE balancednews TO "user";
GRANT ALL ON SCHEMA public TO "user";
GRANT CREATE ON SCHEMA public TO "user";

-- =====================================================
-- CREATE TABLES
-- =====================================================

-- Reactions table
CREATE TABLE IF NOT EXISTS reactions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    article_id TEXT NOT NULL,
    emoji VARCHAR(20) NOT NULL CHECK (emoji IN ('like', 'meh', 'dislike')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB DEFAULT '{}',
    CONSTRAINT unique_user_article UNIQUE (user_id, article_id)
);

-- User sessions table (for analytics)
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
);

-- Feed requests log (for analytics and debugging)
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
);

-- Article parsing cache (optional, for expensive operations)
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
);

-- =====================================================
-- CREATE INDEXES
-- =====================================================

-- Reactions indexes
CREATE INDEX IF NOT EXISTS idx_reactions_user_id ON reactions (user_id);
CREATE INDEX IF NOT EXISTS idx_reactions_article_id ON reactions (article_id);
CREATE INDEX IF NOT EXISTS idx_reactions_created_at ON reactions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reactions_emoji ON reactions (emoji);

-- User sessions indexes
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_created_at ON user_sessions (created_at DESC);

-- Feed requests indexes
CREATE INDEX IF NOT EXISTS idx_feed_requests_user_id ON feed_requests (user_id);
CREATE INDEX IF NOT EXISTS idx_feed_requests_created_at ON feed_requests (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feed_requests_bias ON feed_requests (bias_x, bias_y);

-- Article cache indexes
CREATE INDEX IF NOT EXISTS idx_article_cache_url ON article_cache (url);
CREATE INDEX IF NOT EXISTS idx_article_cache_expires_at ON article_cache (expires_at);

-- =====================================================
-- GRANT PERMISSIONS ON TABLES
-- =====================================================

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "user";
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "user";

-- Grant permissions for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "user";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "user";

-- =====================================================
-- INSERT SAMPLE DATA (OPTIONAL)
-- =====================================================

-- Insert a sample reaction for testing
INSERT INTO reactions (user_id, article_id, emoji, metadata) 
VALUES (
    'sample_user_123', 
    'https://example.com/article', 
    'like',
    '{"source": "setup_script", "test": true}'
) ON CONFLICT (user_id, article_id) DO NOTHING;

-- =====================================================
-- VERIFICATION QUERIES
-- =====================================================

-- Show created tables
\dt

-- Show table sizes
SELECT 
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size
FROM pg_tables 
WHERE schemaname = 'public';

-- Test sample data
SELECT COUNT(*) as reaction_count FROM reactions;

-- Show database info
SELECT 
    current_database() as database_name,
    current_user as current_user,
    version() as postgresql_version;

-- =====================================================
-- SUCCESS MESSAGE
-- =====================================================

SELECT 'Database setup completed successfully! 🎉' as message;