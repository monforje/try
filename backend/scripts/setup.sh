#!/bin/bash

# =====================================================
# BALANCED NEWS BACKEND SETUP SCRIPT
# =====================================================

set -e  # Exit on any error

echo "🚀 Setting up Balanced News Backend..."
echo "======================================"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if Node.js is installed
print_status "Checking Node.js installation..."
if command -v node >/dev/null 2>&1; then
    NODE_VERSION=$(node -v)
    print_success "Node.js is installed: $NODE_VERSION"
else
    print_error "Node.js is not installed. Please install Node.js 18+ first."
    exit 1
fi

# Check if npm is installed
if command -v npm >/dev/null 2>&1; then
    NPM_VERSION=$(npm -v)
    print_success "npm is installed: $NPM_VERSION"
else
    print_error "npm is not installed. Please install npm first."
    exit 1
fi

# Check if we're in the backend directory
if [ ! -f "package.json" ]; then
    print_error "Please run this script from the backend directory."
    exit 1
fi

# Install dependencies
print_status "Installing npm dependencies..."
npm install
print_success "Dependencies installed successfully!"

# Check if .env file exists in parent directory
if [ -f "../.env" ]; then
    print_success ".env file found in parent directory"
else
    print_warning ".env file not found. Please create it in the project root."
    echo "Example .env content:"
    echo "NODE_ENV=development"
    echo "PORT=3001"
    echo "API_BASE_URL=https://fbwrz5-2a01-620-1c4b-a400-2c-e180-9897-8f1d.ru.tuna.am"
    echo "NEWSAPI_KEY=3e2ce6956e1c4a44bbe2097dda9c4d53"
    echo "REDIS_URL=redis://localhost:6379"
    echo "PG_CONNECTION_STRING=postgres://user:password@localhost:5432/balancednews"
fi

# Check PostgreSQL connection
print_status "Checking PostgreSQL connection..."
if command -v psql >/dev/null 2>&1; then
    print_success "PostgreSQL client (psql) is available"
    
    # Try to connect to database
    if psql "postgres://user:password@localhost:5432/balancednews" -c "SELECT 1;" >/dev/null 2>&1; then
        print_success "PostgreSQL connection successful!"
    else
        print_warning "Cannot connect to PostgreSQL database."
        print_status "To set up database, run:"
        echo "  psql -U postgres -f scripts/setup-database.sql"
    fi
else
    print_warning "PostgreSQL client (psql) not found. Please install PostgreSQL."
fi

# Check Redis connection
print_status "Checking Redis connection..."
if command -v redis-cli >/dev/null 2>&1; then
    if redis-cli ping >/dev/null 2>&1; then
        print_success "Redis is running and accessible!"
    else
        print_warning "Redis is not running. Starting without Redis (will use memory cache)."
    fi
else
    print_warning "Redis not found. Will use memory cache only."
fi

# Create logs directory
print_status "Creating logs directory..."
mkdir -p logs
print_success "Logs directory created!"

# Run database setup if PostgreSQL is available
if command -v psql >/dev/null 2>&1; then
    print_status "Setting up database schema..."
    if [ -f "scripts/setup-database.sql" ]; then
        if psql -U postgres -f scripts/setup-database.sql >/dev/null 2>&1; then
            print_success "Database setup completed!"
        else
            print_warning "Database setup failed. You may need to run it manually:"
            echo "  psql -U postgres -f scripts/setup-database.sql"
        fi
    else
        print_warning "Database setup script not found."
    fi
fi

# Test the application
print_status "Testing application startup..."
timeout 10s npm run dev >/dev/null 2>&1 &
SERVER_PID=$!
sleep 5

# Check if server is responding
if curl -s http://localhost:3001/health >/dev/null 2>&1; then
    print_success "Server is responding to health checks!"
    kill $SERVER_PID 2>/dev/null || true
else
    print_warning "Server health check failed. Check the logs for errors."
    kill $SERVER_PID 2>/dev/null || true
fi

echo ""
echo "======================================"
print_success "Setup completed! 🎉"
echo ""
echo "Next steps:"
echo "1. Start the server: npm run dev"
echo "2. Check health: curl http://localhost:3001/health"
echo "3. View metrics: curl http://localhost:3001/metrics"
echo "4. Test feed API: curl 'http://localhost:3001/feed?x=0.1&y=0.2'"
echo ""
echo "Logs will be available in the ./logs/ directory"
echo "======================================"