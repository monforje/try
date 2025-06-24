import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { 
  View, 
  Text, 
  FlatList, 
  RefreshControl, 
  TouchableOpacity, 
  StyleSheet, 
  SafeAreaView,
  Image,
  Alert,
  Platform,
  ActivityIndicator
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';
import Constants from 'expo-constants';

// Базовый URL API из конфигурации Expo (.env)
const API_BASE_URL =
  Constants.expoConfig?.extra?.API_BASE_URL || 'http://localhost:3001';

// Константы
const FETCH_TIMEOUT = 15000;
const HEALTH_CHECK_TIMEOUT = 5000;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY = 1000;

export default function FeedScreen({ navigation }) {
  const [cards, setCards] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [userBias, setUserBias] = useState(null);

  // Мемоизированная конфигурация axios
  const axiosConfig = useMemo(() => ({
    timeout: FETCH_TIMEOUT,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  }), []);

  // Функция для повторных попыток
  const retryWithBackoff = useCallback(async (fn, attempt = 1) => {
    try {
      return await fn();
    } catch (error) {
      if (attempt < MAX_RETRY_ATTEMPTS && !error.response?.status) {
        console.log(`Feed attempt ${attempt} failed, retrying in ${RETRY_DELAY * attempt}ms...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * attempt));
        return retryWithBackoff(fn, attempt + 1);
      }
      throw error;
    }
  }, []);

  // Улучшенная обработка ошибок
  const getErrorMessage = useCallback((err) => {
    if (err.code === 'NETWORK_ERROR' || err.message.includes('Network Error')) {
      return 'Не удается подключиться к серверу.\nПроверьте подключение к интернету.';
    }
    
    if (err.code === 'ECONNABORTED' || err.message.includes('timeout')) {
      return 'Превышено время ожидания.\nПопробуйте еще раз.';
    }
    
    if (err.response) {
      const status = err.response.status;
      const message = err.response.data?.error || err.response.statusText;
      
      switch (status) {
        case 400:
          return 'Некорректные параметры запроса.\nПопробуйте пройти квиз заново.';
        case 429:
          return 'Слишком много запросов.\nПопробуйте через несколько минут.';
        case 500:
        case 502:
        case 503:
          return 'Ошибка сервера.\nПопробуйте позже.';
        default:
          return `Ошибка сервера: ${status}\n${message}`;
      }
    }
    
    return err.message || 'Неизвестная ошибка при загрузке новостей';
  }, []);

  // Проверка доступности сервера
  const checkServerHealth = useCallback(async () => {
    const healthUrl = `${API_BASE_URL}/health`;
    console.log('Checking server health at:', healthUrl);
    
    try {
      const healthResponse = await axios.get(healthUrl, { 
        ...axiosConfig, 
        timeout: HEALTH_CHECK_TIMEOUT 
      });
      console.log('Server is healthy:', healthResponse.data);
      return true;
    } catch (healthError) {
      console.error('Health check failed:', healthError.message);
      throw new Error(`Сервер недоступен по адресу ${API_BASE_URL}`);
    }
  }, [axiosConfig]);

  // Основная функция загрузки ленты
  const fetchFeed = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) {
        setRefreshing(true);
      } else {
        setIsLoading(true);
      }
      setError(null);
      
      console.log('Platform:', Platform.OS);
      console.log('Fetching feed from:', API_BASE_URL);
      
      // Получаем bias из AsyncStorage
      const biasString = await AsyncStorage.getItem('bias');
      if (!biasString) {
        Alert.alert('Ошибка', 'Необходимо пройти квиз заново', [
          { text: 'OK', onPress: () => navigation.replace('Quiz') }
        ]);
        return;
      }
      
      const bias = JSON.parse(biasString);
      setUserBias(bias);
      console.log('Using bias for feed:', bias);
      
      // Проверяем здоровье сервера с retry
      await retryWithBackoff(checkServerHealth);
      
      // Загружаем ленту с retry
      const response = await retryWithBackoff(async () => {
        const feedUrl = `${API_BASE_URL}/feed`;
        console.log('Fetching feed from:', feedUrl);
        
        return await axios.get(feedUrl, { 
          ...axiosConfig,
          params: { 
            x: bias.x, 
            y: bias.y, 
            client_ts: Date.now() 
          }
        });
      });
      
      console.log('Feed response status:', response.status);
      console.log('Feed response data length:', response.data?.length || 0);
      
      // Валидация ответа
      if (!response.data || !Array.isArray(response.data)) {
        console.warn('Unexpected response format:', response.data);
        throw new Error('Получен некорректный формат данных от сервера');
      }
      
      // Валидация карточек
      const validCards = response.data.filter(card => {
        const isValid = card && card.title && card.url && card.sourceName;
        if (!isValid) {
          console.warn('Invalid card data:', card);
        }
        return isValid;
      });
      
      setCards(validCards);
      
      if (validCards.length === 0 && response.data.length > 0) {
        throw new Error('Получены некорректные данные статей');
      }
      
    } catch (err) {
      console.error('Error fetching feed:', err);
      setError(getErrorMessage(err));
      
      // Если это не первая загрузка, показываем уведомление
      if (isRefresh && cards.length > 0) {
        Alert.alert('Ошибка обновления', getErrorMessage(err));
      }
    } finally {
      setRefreshing(false);
      setIsLoading(false);
    }
  }, [navigation, axiosConfig, retryWithBackoff, checkServerHealth, getErrorMessage, cards.length]);

  // Сброс квиза с подтверждением
  const resetQuiz = useCallback(async () => {
    Alert.alert(
      'Сбросить квиз?',
      'Вы пройдете квиз заново и получите новые координаты.',
      [
        { text: 'Отмена', style: 'cancel' },
        { 
          text: 'Сбросить', 
          onPress: async () => {
            try {
              await AsyncStorage.removeItem('bias');
              navigation.replace('Quiz');
            } catch (error) {
              console.error('Error removing bias:', error);
              Alert.alert('Ошибка', 'Не удалось сбросить данные квиза');
            }
          }
        }
      ]
    );
  }, [navigation]);

  // Обработка pull-to-refresh
  const onRefresh = useCallback(() => {
    fetchFeed(true);
  }, [fetchFeed]);

  // Загрузка при монтировании
  useEffect(() => {
    fetchFeed();
  }, [fetchFeed]);

  // Форматирование времени
  const formatTimeAgo = useCallback((dateString) => {
    try {
      if (!dateString) return 'Недавно';
      
      const now = new Date();
      const published = new Date(dateString);
      
      // Проверка валидности даты
      if (isNaN(published.getTime())) return 'Недавно';
      
      const diffInMinutes = Math.floor((now - published) / (1000 * 60));
      const diffInHours = Math.floor(diffInMinutes / 60);
      const diffInDays = Math.floor(diffInHours / 24);
      
      if (diffInMinutes < 1) return 'Только что';
      if (diffInMinutes < 60) return `${diffInMinutes} мин назад`;
      if (diffInHours < 1) return '1 час назад';
      if (diffInHours === 1) return '1 час назад';
      if (diffInHours < 24) return `${diffInHours} ч назад`;
      if (diffInDays === 1) return '1 день назад';
      if (diffInDays < 7) return `${diffInDays} дн назад`;
      
      return published.toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'short'
      });
    } catch (e) {
      console.warn('Date formatting error:', e);
      return 'Недавно';
    }
  }, []);

  // Стили для бейджа стороны
  const getSideBadgeStyle = useCallback((side) => {
    return side === 'friendly' 
      ? [styles.sideBadge, styles.friendlyBadge]
      : [styles.sideBadge, styles.opposingBadge];
  }, []);

  // Текст для бейджа стороны
  const getSideText = useCallback((side) => {
    return side === 'friendly' ? 'Близкие взгляды' : 'Другая точка зрения';
  }, []);

  // Навигация к статье
  const navigateToArticle = useCallback((url) => {
    if (!url) {
      Alert.alert('Ошибка', 'Некорректная ссылка на статью');
      return;
    }
    navigation.navigate('Article', { url });
  }, [navigation]);

  // Рендер карточки новости
  const renderCard = useCallback(({ item }) => (
    <TouchableOpacity
      style={styles.card}
      onPress={() => navigateToArticle(item.url)}
      activeOpacity={0.7}
    >
      {item.imageUrl ? (
        <Image 
          source={{ uri: item.imageUrl }} 
          style={styles.cardImage}
          resizeMode="cover"
          onError={(e) => console.log('Image load error:', e.nativeEvent.error)}
          defaultSource={require('../assets/placeholder-image.png')} // если есть placeholder
        />
      ) : (
        <View style={styles.cardImagePlaceholder}>
          <Text style={styles.cardImagePlaceholderText}>📰</Text>
        </View>
      )}
      
      <View style={styles.cardContent}>
        <View style={styles.cardHeader}>
          <Text style={styles.sourceName} numberOfLines={1}>
            {item.sourceName || 'Неизвестный источник'}
          </Text>
          <View style={getSideBadgeStyle(item.side)}>
            <Text style={styles.sideText}>
              {getSideText(item.side)}
            </Text>
          </View>
        </View>
        
        <Text style={styles.cardTitle} numberOfLines={3}>
          {item.title || 'Заголовок недоступен'}
        </Text>
        
        <Text style={styles.timeAgo}>
          {formatTimeAgo(item.publishedAt)}
        </Text>
      </View>
    </TouchableOpacity>
  ), [navigateToArticle, getSideBadgeStyle, getSideText, formatTimeAgo]);

  // Рендер пустого состояния
  const renderEmptyState = useCallback(() => (
    <View style={styles.emptyState}>
      <Text style={styles.emptyStateTitle}>
        {error ? '😔 Ошибка загрузки' : '📰 Новостей пока нет'}
      </Text>
      <Text style={styles.emptyStateText}>
        {error || 'Потяните вниз, чтобы обновить ленту'}
      </Text>
      {error && (
        <View style={styles.emptyStateButtons}>
          <TouchableOpacity style={styles.retryButton} onPress={() => fetchFeed()}>
            <Text style={styles.retryButtonText}>Попробовать снова</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.resetQuizButton} onPress={resetQuiz}>
            <Text style={styles.resetQuizButtonText}>Пройти квиз заново</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  ), [error, fetchFeed, resetQuiz]);

  // Рендер состояния загрузки
  const renderLoadingState = () => (
    <View style={styles.loadingContainer}>
      <ActivityIndicator size="large" color="#007AFF" />
      <Text style={styles.loadingText}>Загружаем новости...</Text>
      <Text style={styles.loadingSubtext}>
        Подбираем статьи под ваши предпочтения
      </Text>
    </View>
  );

  // Основной рендер
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <View style={styles.headerLeft}>
            <Text style={styles.headerTitle}>Balanced News</Text>
            <Text style={styles.headerSubtitle}>
              Сбалансированный взгляд на новости
            </Text>
          </View>
          <TouchableOpacity onPress={resetQuiz} style={styles.resetButton}>
            <Text style={styles.resetButtonText}>Новый квиз</Text>
          </TouchableOpacity>
        </View>
        
        {userBias && (
          <Text style={styles.biasText}>
            Ваши координаты: ({userBias.x.toFixed(2)}, {userBias.y.toFixed(2)})
          </Text>
        )}
        
        {cards.length > 0 && (
          <Text style={styles.cardsCountText}>
            Показано {cards.length} статей
          </Text>
        )}
        
        {__DEV__ && (
          <Text style={styles.debugText}>
            {Platform.OS}: {API_BASE_URL}
          </Text>
        )}
      </View>
      
      {isLoading && cards.length === 0 ? renderLoadingState() : (
        <FlatList
          data={cards}
          keyExtractor={(item, index) => item.articleId || item.url || `item_${index}`}
          renderItem={renderCard}
          refreshControl={
            <RefreshControl 
              refreshing={refreshing} 
              onRefresh={onRefresh}
              tintColor="#007AFF"
              title="Обновление..."
              titleColor="#666"
            />
          }
          ListEmptyComponent={!isLoading ? renderEmptyState : null}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={cards.length === 0 ? styles.emptyContainer : styles.listContainer}
          initialNumToRender={4}
          maxToRenderPerBatch={4}
          windowSize={10}
          removeClippedSubviews={true}
          getItemLayout={(data, index) => ({
            length: 280, // примерная высота карточки
            offset: 280 * index,
            index,
          })}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  header: {
    backgroundColor: '#fff',
    paddingHorizontal: 20,
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  headerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  headerLeft: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#333',
  },
  headerSubtitle: {
    fontSize: 14,
    color: '#666',
    marginTop: 2,
  },
  resetButton: {
    backgroundColor: '#f0f0f0',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  resetButtonText: {
    fontSize: 12,
    color: '#007AFF',
    fontWeight: '600',
  },
  biasText: {
    fontSize: 12,
    color: '#999',
    marginTop: 8,
  },
  cardsCountText: {
    fontSize: 12,
    color: '#666',
    marginTop: 4,
  },
  debugText: {
    fontSize: 10,
    color: '#999',
    marginTop: 4,
  },
  listContainer: {
    paddingBottom: 20,
  },
  card: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginVertical: 8,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
    overflow: 'hidden',
  },
  cardImage: {
    width: '100%',
    height: 200,
  },
  cardImagePlaceholder: {
    width: '100%',
    height: 200,
    backgroundColor: '#f0f0f0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  cardImagePlaceholderText: {
    fontSize: 48,
    opacity: 0.3,
  },
  cardContent: {
    padding: 16,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  sourceName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#007AFF',
    flex: 1,
  },
  sideBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    marginLeft: 8,
  },
  friendlyBadge: {
    backgroundColor: '#E8F5E8',
  },
  opposingBadge: {
    backgroundColor: '#FFF2E8',
  },
  sideText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#666',
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    lineHeight: 22,
    marginBottom: 8,
  },
  timeAgo: {
    fontSize: 12,
    color: '#999',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  loadingText: {
    fontSize: 16,
    color: '#666',
    marginTop: 12,
    textAlign: 'center',
  },
  loadingSubtext: {
    fontSize: 14,
    color: '#999',
    marginTop: 4,
    textAlign: 'center',
  },
  emptyContainer: {
    flex: 1,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  emptyStateTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 8,
    textAlign: 'center',
  },
  emptyStateText: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 20,
  },
  emptyStateButtons: {
    width: '100%',
    alignItems: 'center',
  },
  retryButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    marginBottom: 10,
    width: 200,
  },
  retryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  resetQuizButton: {
    borderWidth: 1,
    borderColor: '#007AFF',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    width: 200,
  },
  resetQuizButtonText: {
    color: '#007AFF',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
});