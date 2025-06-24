import React, { useEffect, useState, useCallback } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { 
  View, 
  Text, 
  TouchableOpacity, 
  StyleSheet, 
  SafeAreaView,
  ActivityIndicator,
  Alert,
  StatusBar,
  Platform,
  Linking,
  AppState
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Font from 'expo-font';

// Screens
import QuizScreen from './screens/QuizScreen';
import FeedScreen from './screens/FeedScreen';
import ArticleScreen from './screens/ArticleScreen';

// Constants from config
const { extra } = Constants.expoConfig;
const IS_DEV = extra?.IS_DEV || false;
const ENABLE_DEBUG_LOGS = extra?.ENABLE_DEBUG_LOGS || false;

// Enhanced logging
const log = (message, ...args) => {
  if (ENABLE_DEBUG_LOGS) {
    console.log(`[App] ${message}`, ...args);
  }
};

const logError = (message, error) => {
  console.error(`[App Error] ${message}`, error);
  // Here you could integrate with crash reporting service
  // Crashlytics.recordError(error);
};

// Enhanced Splash Screen Component
function SplashScreen({ navigation }) {
  const [isLoading, setIsLoading] = useState(true);
  const [loadingMessage, setLoadingMessage] = useState('Инициализация...');
  const [error, setError] = useState(null);

  // App initialization
  const initializeApp = useCallback(async () => {
    try {
      setLoadingMessage('Загрузка шрифтов...');
      
      // Load custom fonts if any
      try {
        await Font.loadAsync({
          // Add custom fonts here if needed
          // 'CustomFont': require('./assets/fonts/CustomFont.ttf'),
        });
      } catch (fontError) {
        log('Font loading failed, continuing with system fonts', fontError);
      }

      setLoadingMessage('Проверка данных пользователя...');
      
      // Check for existing user data
      const bias = await AsyncStorage.getItem('bias');
      log('Existing bias found:', !!bias);
      
      if (bias) {
        // Validate bias data
        try {
          const parsedBias = JSON.parse(bias);
          if (parsedBias && typeof parsedBias.x === 'number' && typeof parsedBias.y === 'number') {
            log('Valid bias found, navigating to Feed');
            navigation.replace('Feed');
            return;
          } else {
            log('Invalid bias data found, removing');
            await AsyncStorage.removeItem('bias');
          }
        } catch (parseError) {
          log('Error parsing bias data, removing', parseError);
          await AsyncStorage.removeItem('bias');
        }
      }

      setLoadingMessage('Проверка подключения...');
      
      // Optional: Check API connectivity
      if (extra?.API_BASE_URL) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);
          
          const response = await fetch(`${extra.API_BASE_URL}/health`, {
            signal: controller.signal,
            method: 'GET',
            headers: { 'Accept': 'application/json' }
          });
          
          clearTimeout(timeoutId);
          
          if (!response.ok) {
            log('API health check failed:', response.status);
          } else {
            log('API health check passed');
          }
        } catch (apiError) {
          log('API connectivity check failed:', apiError.message);
          // Don't block app startup for API issues
        }
      }

      // App is ready, show splash content
      setLoadingMessage('');
      
    } catch (error) {
      logError('App initialization failed', error);
      setError('Ошибка инициализации приложения');
    } finally {
      setIsLoading(false);
    }
  }, [navigation]);

  // Handle app state changes
  useEffect(() => {
    const handleAppStateChange = (nextAppState) => {
      log('App state changed to:', nextAppState);
      // Handle app state changes if needed
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription?.remove();
  }, []);

  // Initialize app on mount
  useEffect(() => {
    initializeApp();
  }, [initializeApp]);

  // Retry initialization
  const retryInitialization = useCallback(() => {
    setError(null);
    setIsLoading(true);
    initializeApp();
  }, [initializeApp]);

  // Handle deep links
  const handleDeepLink = useCallback((url) => {
    log('Deep link received:', url);
    // Handle deep linking logic here
    // For example: navigate to specific article
  }, []);

  useEffect(() => {
    // Get initial URL
    Linking.getInitialURL().then((url) => {
      if (url) {
        handleDeepLink(url);
      }
    });

    // Listen for incoming links
    const subscription = Linking.addEventListener('url', ({ url }) => {
      handleDeepLink(url);
    });

    return () => subscription?.remove();
  }, [handleDeepLink]);

  // Error state
  if (error) {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="dark-content" backgroundColor="#f5f5f5" />
        <View style={styles.errorContainer}>
          <Text style={styles.errorTitle}>😔 Ошибка</Text>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={retryInitialization}>
            <Text style={styles.retryButtonText}>Попробовать снова</Text>
          </TouchableOpacity>
          {IS_DEV && (
            <Text style={styles.debugText}>
              Режим разработки активен
            </Text>
          )}
        </View>
      </SafeAreaView>
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="dark-content" backgroundColor="#f5f5f5" />
        <View style={styles.loadingContainer}>
          <Text style={styles.appName}>Balanced News</Text>
          <ActivityIndicator 
            size="large" 
            color="#007AFF" 
            style={styles.loadingSpinner}
          />
          <Text style={styles.loadingText}>
            {loadingMessage || 'Загрузка...'}
          </Text>
          {IS_DEV && (
            <Text style={styles.versionText}>
              v{extra?.APP_VERSION} (dev)
            </Text>
          )}
        </View>
      </SafeAreaView>
    );
  }

  // Main splash content
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#f5f5f5" />
      <View style={styles.splashContent}>
        <View style={styles.brandingContainer}>
          <Text style={styles.title}>Balanced News</Text>
          <Text style={styles.tagline}>Выходите из информационного пузыря</Text>
          <Text style={styles.subtitle}>
            Читайте новости с разных точек зрения{'\n'}
            Формируйте сбалансированное мнение
          </Text>
        </View>
        
        <View style={styles.featuresContainer}>
          <View style={styles.feature}>
            <Text style={styles.featureIcon}>🎯</Text>
            <Text style={styles.featureText}>Персонализированная лента</Text>
          </View>
          <View style={styles.feature}>
            <Text style={styles.featureIcon}>⚖️</Text>
            <Text style={styles.featureText}>Разные точки зрения</Text>
          </View>
          <View style={styles.feature}>
            <Text style={styles.featureIcon}>📊</Text>
            <Text style={styles.featureText}>Анализ предпочтений</Text>
          </View>
        </View>
        
        <View style={styles.actionContainer}>
          <TouchableOpacity 
            style={styles.startButton} 
            onPress={() => navigation.replace('Quiz')}
            activeOpacity={0.8}
          >
            <Text style={styles.startButtonText}>Начать</Text>
          </TouchableOpacity>
          
          <Text style={styles.disclaimerText}>
            Анонимно и безопасно
          </Text>
        </View>
        
        {IS_DEV && (
          <View style={styles.devInfo}>
            <Text style={styles.devText}>
              Режим разработки{'\n'}
              API: {extra?.API_BASE_URL}
            </Text>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

// Stack Navigator
const Stack = createStackNavigator();

// Main App Component
export default function App() {
  const [isReady, setIsReady] = useState(false);

  // App-level error boundary simulation
  useEffect(() => {
    const handleError = (error, isFatal) => {
      logError('Unhandled error', { error, isFatal });
      
      if (isFatal) {
        Alert.alert(
          'Критическая ошибка',
          'Приложение будет перезапущено',
          [{ text: 'OK', onPress: () => {
            // In a real app, you might want to restart or show a recovery screen
          }}]
        );
      }
    };

    // This would be replaced with actual error boundary in production
    if (IS_DEV) {
      log('Error handling initialized');
    }

    setIsReady(true);
  }, []);

  if (!isReady) {
    return null; // Or a minimal loading screen
  }

  return (
    <NavigationContainer>
      <StatusBar barStyle="dark-content" />
      <Stack.Navigator 
        initialRouteName="Splash"
        screenOptions={{ 
          headerShown: false,
          gestureEnabled: true,
          cardStyleInterpolator: ({ current, layouts }) => {
            return {
              cardStyle: {
                transform: [
                  {
                    translateX: current.progress.interpolate({
                      inputRange: [0, 1],
                      outputRange: [layouts.screen.width, 0],
                    }),
                  },
                ],
              },
            };
          },
        }}
      >
        <Stack.Screen 
          name="Splash" 
          component={SplashScreen}
          options={{ gestureEnabled: false }}
        />
        <Stack.Screen 
          name="Quiz" 
          component={QuizScreen}
          options={{ gestureEnabled: false }}
        />
        <Stack.Screen 
          name="Feed" 
          component={FeedScreen}
          options={{ gestureEnabled: false }}
        />
        <Stack.Screen 
          name="Article" 
          component={ArticleScreen}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  appName: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 40,
  },
  loadingSpinner: {
    marginBottom: 20,
  },
  loadingText: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
  },
  versionText: {
    fontSize: 12,
    color: '#999',
    marginTop: 20,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  errorTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 12,
  },
  errorText: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 30,
  },
  retryButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 30,
    paddingVertical: 12,
    borderRadius: 8,
  },
  retryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  debugText: {
    fontSize: 12,
    color: '#FF3B30',
    marginTop: 20,
    textAlign: 'center',
  },
  splashContent: {
    flex: 1,
    paddingHorizontal: 20,
    justifyContent: 'space-between',
    paddingVertical: 40,
  },
  brandingContainer: {
    alignItems: 'center',
    marginTop: 60,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 10,
  },
  tagline: {
    fontSize: 18,
    fontWeight: '600',
    color: '#007AFF',
    marginBottom: 20,
  },
  subtitle: {
    fontSize: 16,
    textAlign: 'center',
    color: '#666',
    lineHeight: 24,
  },
  featuresContainer: {
    flex: 1,
    justifyContent: 'center',
    paddingVertical: 40,
  },
  feature: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 15,
    paddingHorizontal: 20,
    backgroundColor: '#fff',
    marginVertical: 8,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  featureIcon: {
    fontSize: 24,
    marginRight: 15,
  },
  featureText: {
    fontSize: 16,
    color: '#333',
    fontWeight: '500',
  },
  actionContainer: {
    alignItems: 'center',
  },
  startButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 60,
    paddingVertical: 16,
    borderRadius: 12,
    shadowColor: '#007AFF',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  startButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  disclaimerText: {
    fontSize: 12,
    color: '#999',
    marginTop: 15,
    textAlign: 'center',
  },
  devInfo: {
    position: 'absolute',
    bottom: 10,
    left: 10,
    right: 10,
    alignItems: 'center',
  },
  devText: {
    fontSize: 10,
    color: '#FF3B30',
    textAlign: 'center',
  },
});