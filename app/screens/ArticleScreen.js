import React, { useEffect, useState, useCallback } from 'react';
import { 
  View, 
  Text, 
  ScrollView, 
  TouchableOpacity, 
  StyleSheet, 
  SafeAreaView,
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  RefreshControl
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';
import Constants from 'expo-constants';

// Базовый URL API из конфигурации Expo (.env)
const API_BASE_URL =
  Constants.expoConfig?.extra?.API_BASE_URL || 'http://localhost:3001';

// Константы для таймаутов и retry
const FETCH_TIMEOUT = 20000;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY = 1000;

export default function ArticleScreen({ route, navigation }) {
  const { url } = route.params;
  const [article, setArticle] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [selectedReaction, setSelectedReaction] = useState(null);
  const [reactionStatus, setReactionStatus] = useState('');
  const [reactionLoading, setReactionLoading] = useState(false);

  // Мемоизированная конфигурация axios
  const axiosConfig = React.useMemo(() => ({
    timeout: FETCH_TIMEOUT,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  }), []);

  // Генерация или получение device ID с кешированием
  const getDeviceId = useCallback(async () => {
    try {
      let deviceId = await AsyncStorage.getItem('deviceId');
      if (!deviceId) {
        deviceId = `device_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        await AsyncStorage.setItem('deviceId', deviceId);
      }
      return deviceId;
    } catch (error) {
      console.error('Error getting device ID:', error);
      // Fallback device ID если AsyncStorage недоступен
      return `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
  }, []);

  // Функция для повторных попыток с экспоненциальной задержкой
  const retryWithBackoff = useCallback(async (fn, attempt = 1) => {
    try {
      return await fn();
    } catch (error) {
      if (attempt < MAX_RETRY_ATTEMPTS && !error.response?.status) {
        console.log(`Attempt ${attempt} failed, retrying in ${RETRY_DELAY * attempt}ms...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * attempt));
        return retryWithBackoff(fn, attempt + 1);
      }
      throw error;
    }
  }, []);

  // Основная функция загрузки статьи
  const fetchArticle = useCallback(async (forceRefresh = false) => {
    try {
      if (forceRefresh) {
        setIsRefreshing(true);
      } else {
        setIsLoading(true);
      }
      setError(null);
      
      console.log('Fetching article from:', `${API_BASE_URL}/article`);
      console.log('Article URL:', url);
      
      const response = await retryWithBackoff(async () => {
        return await axios.get(`${API_BASE_URL}/article`, { 
          ...axiosConfig,
          params: { url }
        });
      });
      
      console.log('Article response received:', !!response.data);
      
      // Валидация ответа
      if (!response.data || typeof response.data !== 'object') {
        throw new Error('Получен некорректный ответ от сервера');
      }

      setArticle(response.data);
      
    } catch (err) {
      console.error('Error fetching article:', err);
      setError(getErrorMessage(err));
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [url, axiosConfig, retryWithBackoff]);

  // Улучшенная обработка ошибок
  const getErrorMessage = useCallback((err) => {
    if (err.code === 'NETWORK_ERROR' || err.message.includes('Network Error')) {
      return `Не удается подключиться к серверу.\nПроверьте подключение к интернету.\nСервер: ${API_BASE_URL}`;
    }
    
    if (err.code === 'ECONNABORTED' || err.message.includes('timeout')) {
      return 'Превышено время ожидания загрузки.\nПопробуйте еще раз.';
    }
    
    if (err.response) {
      const status = err.response.status;
      const message = err.response.data?.error || err.response.statusText;
      
      switch (status) {
        case 400:
          return 'Некорректный URL статьи';
        case 404:
          return 'Статья не найдена';
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
    
    if (err.request) {
      return 'Запрос не дошел до сервера.\nПроверьте подключение к интернету.';
    }
    
    return err.message || 'Неизвестная ошибка при загрузке статьи';
  }, []);

  // Отправка реакции с улучшенной обработкой ошибок
  const sendReaction = useCallback(async (emoji) => {
    if (reactionLoading) return;
    
    try {
      setReactionLoading(true);
      
      const deviceId = await getDeviceId();
      
      console.log('Sending reaction:', { emoji, deviceId, url: url.substring(0, 50) + '...' });

      await retryWithBackoff(async () => {
        return await axios.post(`${API_BASE_URL}/reaction`, {
          userId: deviceId,
          articleId: url,
          emoji,
          ts: Date.now()
        }, axiosConfig);
      });

      console.log('Reaction sent successfully');

      setSelectedReaction(emoji);
      setReactionStatus('Спасибо за вашу реакцию!');
      
      // Убираем статус через 3 секунды
      setTimeout(() => setReactionStatus(''), 3000);
      
    } catch (err) {
      console.error('Error sending reaction:', err);
      
      let errorMessage = 'Не удалось отправить реакцию';
      
      if (err.code === 'NETWORK_ERROR' || err.message.includes('Network Error')) {
        errorMessage = 'Проблема с сетью. Реакция не отправлена.';
      } else if (err.code === 'ECONNABORTED' || err.message.includes('timeout')) {
        errorMessage = 'Превышено время ожидания. Попробуйте еще раз.';
      } else if (err.response?.status === 429) {
        errorMessage = 'Слишком много запросов. Попробуйте позже.';
      }
      
      Alert.alert('Ошибка', errorMessage, [
        { text: 'OK' },
        { text: 'Повторить', onPress: () => sendReaction(emoji) }
      ]);
    } finally {
      setReactionLoading(false);
    }
  }, [url, axiosConfig, getDeviceId, retryWithBackoff, reactionLoading]);

  // Открытие оригинальной статьи
  const openOriginalArticle = useCallback(() => {
    Linking.openURL(url).catch((error) => {
      console.error('Failed to open URL:', error);
      Alert.alert('Ошибка', 'Не удалось открыть ссылку в браузере');
    });
  }, [url]);

  // Форматирование даты
  const formatDate = useCallback((dateString) => {
    if (!dateString) return '';
    try {
      const date = new Date(dateString);
      // Проверяем валидность даты
      if (isNaN(date.getTime())) return dateString;
      
      return date.toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (e) {
      console.warn('Date formatting error:', e);
      return dateString;
    }
  }, []);

  // Рендер кнопки реакции
  const getReactionButton = useCallback((emoji, label) => {
    const isSelected = selectedReaction === emoji;
    const isDisabled = reactionLoading;
    
    return (
      <TouchableOpacity
        style={[
          styles.reactionButton,
          isSelected && styles.selectedReactionButton,
          isDisabled && styles.disabledReactionButton
        ]}
        onPress={() => sendReaction(emoji)}
        disabled={isDisabled}
        activeOpacity={0.7}
      >
        <Text style={[
          styles.reactionEmoji,
          isSelected && styles.selectedReactionEmoji
        ]}>
          {getEmojiIcon(emoji)}
        </Text>
        <Text style={[
          styles.reactionLabel,
          isSelected && styles.selectedReactionLabel,
          isDisabled && styles.disabledReactionLabel
        ]}>
          {label}
        </Text>
      </TouchableOpacity>
    );
  }, [selectedReaction, reactionLoading, sendReaction]);

  // Получение эмодзи по типу
  const getEmojiIcon = useCallback((emoji) => {
    const emojiMap = {
      'like': '👍',
      'meh': '😐',
      'dislike': '👎'
    };
    return emojiMap[emoji] || '';
  }, []);

  // Обработка pull-to-refresh
  const onRefresh = useCallback(() => {
    fetchArticle(true);
  }, [fetchArticle]);

  // Загрузка статьи при монтировании компонента
  useEffect(() => {
    fetchArticle();
  }, [fetchArticle]);

  // Экран загрузки
  if (isLoading && !article) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <Text style={styles.backButton}>← Назад</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={styles.loadingText}>Загрузка статьи...</Text>
          <Text style={styles.loadingSubtext}>
            Извлекаем и обрабатываем контент
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  // Экран ошибки
  if (error && !article) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <Text style={styles.backButton}>← Назад</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.errorContainer}>
          <Text style={styles.errorTitle}>😔 Ошибка</Text>
          <Text style={styles.errorText}>{error}</Text>
          <View style={styles.errorButtons}>
            <TouchableOpacity style={styles.retryButton} onPress={() => fetchArticle()}>
              <Text style={styles.retryButtonText}>Попробовать снова</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.originalButton} onPress={openOriginalArticle}>
              <Text style={styles.originalButtonText}>Открыть оригинал</Text>
            </TouchableOpacity>
          </View>
          {__DEV__ && (
            <Text style={styles.debugInfo}>
              API: {API_BASE_URL}
            </Text>
          )}
        </View>
      </SafeAreaView>
    );
  }

  // Основной экран статьи
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.backButton}>← Назад</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={openOriginalArticle}>
          <Text style={styles.originalLink}>Оригинал</Text>
        </TouchableOpacity>
      </View>

      <ScrollView 
        style={styles.content} 
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl 
            refreshing={isRefreshing} 
            onRefresh={onRefresh}
            tintColor="#007AFF"
          />
        }
      >
        {article?.title && (
          <Text style={styles.title}>{article.title}</Text>
        )}
        
        {article?.author && (
          <Text style={styles.author}>Автор: {article.author}</Text>
        )}
        
        {article?.publishedAt && (
          <Text style={styles.publishedAt}>
            {formatDate(article.publishedAt)}
          </Text>
        )}

        <View style={styles.contentContainer}>
          <Text style={styles.articleContent}>
            {article?.htmlContent?.replace(/<[^>]*>/g, '') || 'Содержимое статьи недоступно'}
          </Text>
        </View>

        {article?.readingTimeSec && (
          <Text style={styles.readingTime}>
            Время чтения: ~{Math.ceil(article.readingTimeSec / 60)} мин
          </Text>
        )}
        
        {/* Отступ для панели реакций */}
        <View style={styles.bottomSpacer} />
      </ScrollView>

      <View style={styles.reactionsContainer}>
        <Text style={styles.reactionsTitle}>Ваше мнение о статье:</Text>
        
        <View style={styles.reactionsRow}>
          {getReactionButton('like', 'Нравится')}
          {getReactionButton('meh', 'Нейтрально')}
          {getReactionButton('dislike', 'Не нравится')}
        </View>

        {reactionStatus ? (
          <Text style={styles.reactionStatus}>{reactionStatus}</Text>
        ) : null}
        
        {reactionLoading && (
          <View style={styles.reactionLoadingContainer}>
            <ActivityIndicator size="small" color="#007AFF" />
            <Text style={styles.reactionLoadingText}>Отправляем...</Text>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
    backgroundColor: '#fff',
  },
  backButton: {
    fontSize: 16,
    color: '#007AFF',
    fontWeight: '600',
  },
  originalLink: {
    fontSize: 16,
    color: '#007AFF',
  },
  content: {
    flex: 1,
    paddingHorizontal: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#333',
    lineHeight: 30,
    marginTop: 16,
    marginBottom: 12,
  },
  author: {
    fontSize: 14,
    color: '#666',
    marginBottom: 4,
  },
  publishedAt: {
    fontSize: 14,
    color: '#999',
    marginBottom: 20,
  },
  contentContainer: {
    marginBottom: 20,
  },
  articleContent: {
    fontSize: 16,
    lineHeight: 24,
    color: '#333',
    textAlign: 'justify',
  },
  readingTime: {
    fontSize: 12,
    color: '#999',
    fontStyle: 'italic',
    marginBottom: 20,
  },
  bottomSpacer: {
    height: 40,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    fontSize: 16,
    color: '#666',
    marginTop: 12,
  },
  loadingSubtext: {
    fontSize: 14,
    color: '#999',
    marginTop: 4,
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
    marginBottom: 20,
  },
  errorButtons: {
    width: '100%',
    alignItems: 'center',
  },
  retryButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    marginBottom: 12,
    width: 200,
  },
  retryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  originalButton: {
    borderWidth: 1,
    borderColor: '#007AFF',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    marginBottom: 12,
    width: 200,
  },
  originalButtonText: {
    color: '#007AFF',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  debugInfo: {
    fontSize: 12,
    color: '#999',
    textAlign: 'center',
    marginTop: 10,
  },
  reactionsContainer: {
    backgroundColor: '#f8f9fa',
    paddingHorizontal: 16,
    paddingVertical: 20,
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
  },
  reactionsTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    marginBottom: 12,
    textAlign: 'center',
  },
  reactionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: 12,
  },
  reactionButton: {
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e0e0e0',
    minWidth: 80,
  },
  selectedReactionButton: {
    backgroundColor: '#007AFF',
    borderColor: '#007AFF',
  },
  disabledReactionButton: {
    opacity: 0.6,
  },
  reactionEmoji: {
    fontSize: 24,
    marginBottom: 4,
  },
  selectedReactionEmoji: {
    // эмодзи не меняется при выборе
  },
  reactionLabel: {
    fontSize: 12,
    color: '#666',
    fontWeight: '600',
  },
  selectedReactionLabel: {
    color: '#fff',
  },
  disabledReactionLabel: {
    color: '#999',
  },
  reactionStatus: {
    fontSize: 14,
    color: '#28a745',
    textAlign: 'center',
    fontWeight: '600',
  },
  reactionLoadingContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
  },
  reactionLoadingText: {
    fontSize: 12,
    color: '#666',
    marginLeft: 8,
  },
});