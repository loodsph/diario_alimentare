// Global application state management
import { getTodayUTC } from './utils.js';

// Firebase instances
export let app = null;
export let auth = null;
export let db = null;

// User state
export let userId = null;
export let isAppInitialized = false;

// Date and selection state
export let selectedDate = getTodayUTC();
export let selectedFood = null;

// Data caches
export let allMeals = [];
export let dailyMealsCache = {}; // Cache per i pasti giornalieri raggruppati e ordinati
export let dailyTotalsCache = {}; // Cache per i totali nutrizionali giornalieri
export let foods = []; // Cache per tutti gli alimenti del database
export let recipes = [];

// UI state
export let isCustomMealMode = false;
export let isOnline = navigator.onLine;

// Modal and editing state
export let mealToEditId = null; // ID del pasto attualmente in modifica
export let foodToEditId = null; // ID dell'alimento attualmente in modifica
export let recipeToEditId = null; // ID della ricetta in modifica
export let onConfirmAction = null; // Callback per il modale di conferma

// Scanner state
export let onDecodeCallback = null;
export let html5QrCode = null;
export let availableCameras = [];
export let currentCameraIndex = 0;

// Recipe state
export let currentRecipeIngredientResults = [];
export let ingredientCounter = 0;

// Water tracking state
export let waterCount = 0;
export let waterUnsubscribe = null;
export let waterHistory = {}; // e.g., { '2024-05-24': 8, '2024-05-23': 6 }
export let waterHistoryUnsubscribe = null;

// Nutrition goals
export let nutritionGoals = {
    calories: 2000,
    proteins: 150,
    carbs: 250,
    fats: 70,
    fibers: 30,
    water: 8 // Obiettivo di bicchieri d'acqua
};

// State setters for controlled access
export function setFirebaseInstances(appInstance, authInstance, dbInstance) {
    app = appInstance;
    auth = authInstance;
    db = dbInstance;
}

export function setUserId(id) {
    userId = id;
}

export function setAppInitialized(status) {
    isAppInitialized = status;
}

export function setSelectedDate(date) {
    selectedDate = date;
}

export function setSelectedFood(food) {
    selectedFood = food;
}

export function setAllMeals(meals) {
    allMeals = meals;
}

export function setFoods(foodsArray) {
    foods = foodsArray;
}

export function setRecipes(recipesArray) {
    recipes = recipesArray;
}

export function setIsCustomMealMode(mode) {
    isCustomMealMode = mode;
}

export function setOnlineStatus(status) {
    isOnline = status;
}

export function setMealToEditId(id) {
    mealToEditId = id;
}

export function setFoodToEditId(id) {
    foodToEditId = id;
}

export function setRecipeToEditId(id) {
    recipeToEditId = id;
}

export function setOnConfirmAction(callback) {
    onConfirmAction = callback;
}

export function setScannerState(callback, qrCode, cameras, index) {
    onDecodeCallback = callback;
    html5QrCode = qrCode;
    availableCameras = cameras;
    currentCameraIndex = index;
}

export function setWaterState(count, unsubscribe, history, historyUnsubscribe) {
    waterCount = count;
    waterUnsubscribe = unsubscribe;
    waterHistory = history;
    waterHistoryUnsubscribe = historyUnsubscribe;
}

export function setNutritionGoals(goals) {
    nutritionGoals = { ...nutritionGoals, ...goals };
}

export function incrementIngredientCounter() {
    return ingredientCounter++;
}

export function clearDailyCache() {
    dailyMealsCache = {};
    dailyTotalsCache = {};
}

export function resetAppData() {
    selectedFood = null;
    selectedDate = getTodayUTC();
    allMeals = [];
    clearDailyCache();
    foods = [];
    recipes = [];
    mealToEditId = null;
    foodToEditId = null;
    recipeToEditId = null;
    onConfirmAction = null;
    waterCount = 0;
    waterHistory = {};
    nutritionGoals = {
        calories: 2000,
        proteins: 150,
        carbs: 250,
        fats: 70,
        fibers: 30,
        water: 8
    };
}