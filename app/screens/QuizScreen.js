import React, { useState, useCallback, useMemo } from 'react';
import { 
  View, 
  Text, 
  TouchableOpacity, 
  StyleSheet, 
  SafeAreaView, 
  Alert,
  ActivityIndicator,
  Animated,
  Dimensions
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Slider from '@react-native-community/slider';

const QUESTIONS = [
  {
    id: 1,
    text: 'Государство должно активно регулировать экономику',
    axis: 'x', // economic left-right
    category: 'Экономика'
  },
  {
    id: 2,
    text: 'Свободный рынок лучше всего решает экономические проблемы',
    axis: 'x',
    category: 'Экономика'
  },
  {
    id: 3,
    text: 'Налоги на богатых должны быть выше',
    axis: 'x',
    category: 'Экономика'
  },
  {
    id: 4,
    text: 'Традиционные ценности важнее прогрессивных изменений',
    axis: 'y', // social conservative-liberal
    category: 'Общество'
  },
  {
    id: 5,
    text: 'Иммиграция приносит больше пользы, чем вреда',
    axis: 'y',
    category: 'Общество'
  },
  {
    id: 6,
    text: 'Правительство должно защищать права меньшинств',
    axis: 'y',
    category: 'Общество'
  },
];

const { width } = Dimensions.get('window');

export default function QuizScreen({ navigation }) {
  const [answers, setAnswers] = useState(Array(QUESTIONS.length).fill(0));
  const [step, setStep] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [slideAnim] = useState(new Animated.Value(0));

  // Текущий вопрос
  const currentQuestion = useMemo(() => QUESTIONS[step], [step]);
  
  // Прогресс в процентах
  const progressPercentage = useMemo(() => 
    ((step + 1) / QUESTIONS.length) * 100, [step]
  );

  // Проверка, можно ли продолжить
  const canProceed = useMemo(() => 
    answers[step] !== 0 || step === 0, [answers, step]
  );

  // Анимация перехода к следующему вопросу
  const animateToNext = useCallback(() => {
    Animated.sequence([
      Animated.timing(slideAnim, {
        toValue: -width,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start();
  }, [slideAnim]);

  // Вычисление координат bias
  const calculateBias = useCallback(() => {
    try {
      const xQuestions = QUESTIONS.filter(q => q.axis === 'x');
      const yQuestions = QUESTIONS.filter(q => q.axis === 'y');
      
      const xAnswers = xQuestions.map((q) => {
        const questionIndex = QUESTIONS.indexOf(q);
        return answers[questionIndex];
      });
      
      const yAnswers = yQuestions.map((q) => {
        const questionIndex = QUESTIONS.indexOf(q);
        return answers[questionIndex];
      });
      
      // Для второго вопроса инвертируем (свободный рынок vs регулирование)
      const adjustedXAnswers = xAnswers.map((answer, i) => {
        return i === 1 ? -answer : answer;
      });
      
      const x = adjustedXAnswers.reduce((a, b) => a + b, 0) / adjustedXAnswers.length;
      const y = yAnswers.reduce((a, b) => a + b, 0) / yAnswers.length;
      
      // Ограничиваем значения в диапазоне [-1, 1]
      const clampedX = Math.max(-1, Math.min(1, x));
      const clampedY = Math.max(-1, Math.min(1, y));
      
      console.log('Calculated bias:', { x: clampedX, y: clampedY });
      console.log('Raw answers:', { xAnswers, yAnswers, adjustedXAnswers });
      
      return { x: clampedX, y: clampedY };
    } catch (error) {
      console.error('Error calculating bias:', error);
      throw new Error('Ошибка при вычислении координат');
    }
  }, [answers]);

  // Сохранение результатов и переход к ленте
  const saveBiasAndNavigate = useCallback(async () => {
    try {
      setIsLoading(true);
      
      const bias = calculateBias();
      
      // Сохраняем bias
      await AsyncStorage.setItem('bias', JSON.stringify(bias));
      
      // Сохраняем также результаты квиза для аналитики
      const quizResults = {
        answers,
        bias,
        timestamp: Date.now(),
        version: '1.0'
      };
      
      await AsyncStorage.setItem('quizResults', JSON.stringify(quizResults));
      
      console.log('Quiz completed successfully:', quizResults);
      
      // Короткая задержка для UX
      setTimeout(() => {
        navigation.replace('Feed');
      }, 500);
      
    } catch (error) {
      console.error('Error saving bias:', error);
      setIsLoading(false);
      
      Alert.alert(
        'Ошибка',
        'Не удалось сохранить результаты квиза. Попробуйте еще раз.',
        [
          { text: 'OK' },
          { text: 'Повторить', onPress: saveBiasAndNavigate }
        ]
      );
    }
  }, [answers, calculateBias, navigation]);

  // Обработка нажатия "Далее/Завершить"
  const handleNext = useCallback(async () => {
    if (!canProceed) {
      Alert.alert('Внимание', 'Пожалуйста, выберите ответ для продолжения');
      return;
    }

    if (step < QUESTIONS.length - 1) {
      animateToNext();
      setStep(step + 1);
    } else {
      await saveBiasAndNavigate();
    }
  }, [step, canProceed, animateToNext, saveBiasAndNavigate]);

  // Обработка нажатия "Назад"
  const handlePrevious = useCallback(() => {
    if (step > 0) {
      animateToNext();
      setStep(step - 1);
    }
  }, [step, animateToNext]);

  // Изменение ответа
  const setAnswer = useCallback((value) => {
    const newAnswers = [...answers];
    newAnswers[step] = value;
    setAnswers(newAnswers);
  }, [answers, step]);

  // Получение текстового описания значения слайдера
  const getSliderValueText = useCallback((value) => {
    const absValue = Math.abs(value);
    
    if (absValue < 0.2) return 'Нейтрально';
    if (absValue < 0.5) return value > 0 ? 'Скорее согласен' : 'Скорее не согласен';
    if (absValue < 0.8) return value > 0 ? 'Согласен' : 'Не согласен';
    return value > 0 ? 'Полностью согласен' : 'Полностью не согласен';
  }, []);

  // Сброс квиза с подтверждением
  const resetQuiz = useCallback(() => {
    Alert.alert(
      'Начать заново?',
      'Все ответы будут потеряны',
      [
        { text: 'Отмена', style: 'cancel' },
        { 
          text: 'Сбросить', 
          onPress: () => {
            setAnswers(Array(QUESTIONS.length).fill(0));
            setStep(0);
            slideAnim.setValue(0);
          }
        }
      ]
    );
  }, [slideAnim]);

  // Получение цвета для текущего ответа
  const getAnswerColor = useCallback((value) => {
    const absValue = Math.abs(value);
    if (absValue < 0.2) return '#666';
    if (absValue < 0.5) return '#007AFF';
    if (absValue < 0.8) return '#5856D6';
    return '#AF52DE';
  }, []);

  // Рендер индикаторов прогресса
  const renderProgressDots = useCallback(() => {
    return (
      <View style={styles.progressDots}>
        {QUESTIONS.map((_, index) => (
          <View
            key={index}
            style={[
              styles.progressDot,
              index === step && styles.progressDotActive,
              index < step && styles.progressDotCompleted
            ]}
          />
        ))}
      </View>
    );
  }, [step]);

  // Основной рендер
  return (
    <SafeAreaView style={styles.container}>
      {/* Header с прогрессом */}
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <TouchableOpacity 
            onPress={resetQuiz} 
            style={styles.resetButton}
            disabled={isLoading}
          >
            <Text style={styles.resetButtonText}>Начать заново</Text>
          </TouchableOpacity>
          
          <Text style={styles.progress}>
            {step + 1} из {QUESTIONS.length}
          </Text>
        </View>
        
        {/* Прогресс-бар */}
        <View style={styles.progressBar}>
          <Animated.View 
            style={[
              styles.progressFill, 
              { width: `${progressPercentage}%` }
            ]} 
          />
        </View>
        
        {/* Индикаторы точек */}
        {renderProgressDots()}
        
        {/* Категория вопроса */}
        <Text style={styles.category}>
          {currentQuestion.category}
        </Text>
      </View>

      {/* Основной контент */}
      <Animated.View 
        style={[
          styles.questionContainer,
          { transform: [{ translateX: slideAnim }] }
        ]}
      >
        <Text style={styles.questionText}>
          {currentQuestion.text}
        </Text>
        
        <View style={styles.sliderContainer}>
          <Slider
            style={styles.slider}
            minimumValue={-1}
            maximumValue={1}
            step={0.1}
            value={answers[step]}
            onValueChange={setAnswer}
            minimumTrackTintColor={getAnswerColor(answers[step])}
            maximumTrackTintColor="#E0E0E0"
            thumbStyle={[
              styles.thumb,
              { backgroundColor: getAnswerColor(answers[step]) }
            ]}
            disabled={isLoading}
          />
          
          <Text style={[
            styles.valueText,
            { color: getAnswerColor(answers[step]) }
          ]}>
            {getSliderValueText(answers[step])}
          </Text>
        </View>

        {/* Подписи к слайдеру */}
        <View style={styles.scaleLabels}>
          <Text style={styles.scaleLabel}>Полностью не согласен</Text>
          <Text style={styles.scaleLabel}>Полностью согласен</Text>
        </View>
        
        {/* Индикатор силы ответа */}
        <View style={styles.strengthIndicator}>
          <Text style={styles.strengthLabel}>Сила убеждения:</Text>
          <View style={styles.strengthBar}>
            <View 
              style={[
                styles.strengthFill,
                { 
                  width: `${Math.abs(answers[step]) * 100}%`,
                  backgroundColor: getAnswerColor(answers[step])
                }
              ]}
            />
          </View>
        </View>
      </Animated.View>

      {/* Кнопки навигации */}
      <View style={styles.navigationContainer}>
        <TouchableOpacity 
          style={[
            styles.navigationButton,
            styles.previousButton,
            step === 0 && styles.disabledButton
          ]}
          onPress={handlePrevious}
          disabled={step === 0 || isLoading}
        >
          <Text style={[
            styles.navigationButtonText,
            step === 0 && styles.disabledButtonText
          ]}>
            Назад
          </Text>
        </TouchableOpacity>
        
        <TouchableOpacity 
          style={[
            styles.navigationButton,
            styles.nextButton,
            !canProceed && styles.disabledButton
          ]}
          onPress={handleNext}
          disabled={!canProceed || isLoading}
        >
          {isLoading ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.nextButtonText}>
              {step < QUESTIONS.length - 1 ? 'Далее' : 'Завершить'}
            </Text>
          )}
        </TouchableOpacity>
      </View>
      
      {/* Подсказка */}
      {step === 0 && (
        <Text style={styles.hint}>
          Перемещайте ползунок, чтобы выразить степень согласия с утверждением
        </Text>
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
    alignItems: 'center',
    marginBottom: 15,
  },
  resetButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: '#f0f0f0',
  },
  resetButtonText: {
    fontSize: 12,
    color: '#666',
    fontWeight: '500',
  },
  progress: {
    fontSize: 16,
    color: '#666',
    fontWeight: '600',
  },
  progressBar: {
    height: 4,
    backgroundColor: '#E0E0E0',
    borderRadius: 2,
    marginBottom: 15,
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#007AFF',
    borderRadius: 2,
  },
  progressDots: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginBottom: 10,
  },
  progressDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#E0E0E0',
    marginHorizontal: 4,
  },
  progressDotActive: {
    backgroundColor: '#007AFF',
    transform: [{ scale: 1.2 }],
  },
  progressDotCompleted: {
    backgroundColor: '#34C759',
  },
  category: {
    fontSize: 14,
    color: '#007AFF',
    fontWeight: '600',
    textAlign: 'center',
  },
  questionContainer: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  questionText: {
    fontSize: 22,
    textAlign: 'center',
    marginBottom: 50,
    color: '#333',
    lineHeight: 32,
    fontWeight: '500',
  },
  sliderContainer: {
    alignItems: 'center',
    marginBottom: 30,
  },
  slider: {
    width: '100%',
    height: 50,
  },
  thumb: {
    width: 24,
    height: 24,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
    elevation: 4,
  },
  valueText: {
    fontSize: 18,
    fontWeight: '600',
    marginTop: 15,
    minHeight: 24,
  },
  scaleLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    marginBottom: 30,
  },
  scaleLabel: {
    fontSize: 12,
    color: '#999',
    flex: 1,
    textAlign: 'center',
  },
  strengthIndicator: {
    alignItems: 'center',
    marginBottom: 20,
  },
  strengthLabel: {
    fontSize: 14,
    color: '#666',
    marginBottom: 8,
  },
  strengthBar: {
    width: 200,
    height: 6,
    backgroundColor: '#E0E0E0',
    borderRadius: 3,
    overflow: 'hidden',
  },
  strengthFill: {
    height: '100%',
    borderRadius: 3,
  },
  navigationContainer: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingVertical: 20,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
  },
  navigationButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 8,
  },
  previousButton: {
    backgroundColor: '#f0f0f0',
  },
  nextButton: {
    backgroundColor: '#007AFF',
  },
  disabledButton: {
    backgroundColor: '#e0e0e0',
    opacity: 0.6,
  },
  navigationButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#666',
  },
  nextButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
  disabledButtonText: {
    color: '#999',
  },
  hint: {
    fontSize: 12,
    color: '#999',
    textAlign: 'center',
    paddingHorizontal: 20,
    paddingBottom: 10,
    fontStyle: 'italic',
  },
});