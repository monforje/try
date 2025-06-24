import 'dotenv/config';

const IS_DEV = process.env.NODE_ENV === 'development';
const IS_PREVIEW = process.env.NODE_ENV === 'preview';

export default {
  expo: {
    name: 'Balanced News',
    slug: 'balanced-news-app',
    version: '1.0.0',
    orientation: 'portrait',
    userInterfaceStyle: 'automatic',
    splash: {
      resizeMode: 'contain',
      backgroundColor: '#ffffff'
    },
    assetBundlePatterns: [
      '**/*'
    ],
    ios: {
      supportsTablet: false,
      bundleIdentifier: IS_DEV ? 'com.balancednews.app.dev' : 'com.balancednews.app',
      buildNumber: '1',
      infoPlist: {
        NSAppTransportSecurity: {
          NSAllowsArbitraryLoads: IS_DEV,
          NSExceptionDomains: IS_DEV ? {
            'localhost': {
              NSExceptionAllowsInsecureHTTPLoads: true,
              NSExceptionMinimumTLSVersion: '1.0',
              NSIncludesSubdomains: true
            }
          } : {}
        }
      }
    },
    android: {
      adaptiveIcon: {
        backgroundColor: '#FFFFFF'
      },
      package: IS_DEV ? 'com.balancednews.app.dev' : 'com.balancednews.app',
      versionCode: 1,
      permissions: [
        'android.permission.INTERNET',
        'android.permission.ACCESS_NETWORK_STATE'
      ],
      usesCleartextTraffic: IS_DEV
    },
    web: {
      favicon: './assets/favicon.png',
      bundler: 'metro'
    },
    plugins: [
      'expo-font'
    ],
    extra: {
      // API Configuration
      API_BASE_URL: process.env.API_BASE_URL || 'https://jjtau3-185-247-185-62.ru.tuna.am',
      
      // Environment flags
      IS_DEV: IS_DEV,
      IS_PREVIEW: IS_PREVIEW,
      
      // Feature flags
      ENABLE_DEBUG_LOGS: IS_DEV || process.env.ENABLE_DEBUG_LOGS === 'true',
      ENABLE_ERROR_REPORTING: !IS_DEV,
      ENABLE_ANALYTICS: !IS_DEV,
      
      // App configuration
      DEFAULT_TIMEOUT: parseInt(process.env.DEFAULT_TIMEOUT) || 15000,
      MAX_RETRY_ATTEMPTS: parseInt(process.env.MAX_RETRY_ATTEMPTS) || 3,
      CACHE_TTL_FEED: parseInt(process.env.CACHE_TTL_FEED) || 1800, // 30 min
      CACHE_TTL_ARTICLE: parseInt(process.env.CACHE_TTL_ARTICLE) || 86400, // 24h
      
      // App metadata
      APP_VERSION: '1.0.0',
      BUILD_DATE: new Date().toISOString(),
      COMMIT_HASH: process.env.COMMIT_HASH || 'unknown',
      
      // EAS Build specific
      eas: {
        projectId: process.env.EAS_PROJECT_ID || 'your-project-id'
      }
    },
    owner: process.env.EXPO_OWNER,
    runtimeVersion: {
      policy: 'sdkVersion'
    },
    updates: {
      url: process.env.EXPO_UPDATES_URL,
      fallbackToCacheTimeout: 0,
      checkAutomatically: 'ON_LOAD',
      codeSigningCertificate: process.env.EXPO_CODE_SIGNING_CERTIFICATE,
      codeSigningMetadata: {
        keyid: process.env.EXPO_CODE_SIGNING_KEY_ID,
        alg: 'rsa-v1_5-sha256'
      }
    }
  }
};