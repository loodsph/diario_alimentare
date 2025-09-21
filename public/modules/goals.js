// Nutrition goals management module
import { doc, setDoc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { showToast } from './uiHelpers.js';
import { db, userId, nutritionGoals, setNutritionGoals } from './state.js';

export async function loadNutritionGoals() {
    if (!userId) return;

    try {
        const goalsDoc = await getDoc(doc(db, `users/${userId}/goals/nutrition`));
        if (goalsDoc.exists()) {
            const savedGoals = goalsDoc.data();
            setNutritionGoals(savedGoals);
        }
    } catch (error) {
        console.error("Errore caricamento obiettivi:", error);
        showToast("Errore caricamento obiettivi nutrizionali.", true);
    }
}

export async function saveNutritionGoals() {
    if (!userId) return;

    try {
        await setDoc(doc(db, `users/${userId}/goals/nutrition`), nutritionGoals);
    } catch (error) {
        console.error("Errore salvataggio obiettivi:", error);
        showToast("Errore salvataggio obiettivi nutrizionali.", true);
    }
}

export function openGoalsModal() {
    updateGoalsInputs();
    updateGoalsModalMacroDistributionBar(nutritionGoals.proteins, nutritionGoals.carbs, nutritionGoals.fats);
    document.getElementById('goals-modal').classList.remove('hidden');
}

export function closeGoalsModal() {
    document.getElementById('goals-modal').classList.add('hidden');
}

export function updateGoalsInputs() {
    document.getElementById('goal-calories').value = nutritionGoals.calories;
    document.getElementById('goal-proteins').value = nutritionGoals.proteins;
    document.getElementById('goal-carbs').value = nutritionGoals.carbs;
    document.getElementById('goal-fats').value = nutritionGoals.fats;
    document.getElementById('goal-fibers').value = nutritionGoals.fibers;
    document.getElementById('goal-water').value = nutritionGoals.water;
}

export function updateGoalsModalMacroDistributionBar(proteins, carbs, fats) {
    const proteinCalories = proteins * 4;
    const carbCalories = carbs * 4;
    const fatCalories = fats * 9;
    const totalCalories = proteinCalories + carbCalories + fatCalories;

    if (totalCalories === 0) return;

    const proteinPerc = (proteinCalories / totalCalories) * 100;
    const carbPerc = (carbCalories / totalCalories) * 100;
    const fatPerc = (fatCalories / totalCalories) * 100;

    document.getElementById('modal-macro-dist-proteins').style.width = `${proteinPerc}%`;
    document.getElementById('modal-macro-dist-carbs').style.width = `${carbPerc}%`;
    document.getElementById('modal-macro-dist-fats').style.width = `${fatPerc}%`;

    document.getElementById('modal-macro-dist-proteins-perc').textContent = `${proteinPerc.toFixed(0)}%`;
    document.getElementById('modal-macro-dist-carbs-perc').textContent = `${carbPerc.toFixed(0)}%`;
    document.getElementById('modal-macro-dist-fats-perc').textContent = `${fatPerc.toFixed(0)}%`;
}

export function updateCalculatedCalories() {
    const proteins = parseInt(document.getElementById('goal-proteins').value) || 0;
    const carbs = parseInt(document.getElementById('goal-carbs').value) || 0;
    const fats = parseInt(document.getElementById('goal-fats').value) || 0;

    const calculatedCalories = (proteins * 4) + (carbs * 4) + (fats * 9);
    document.getElementById('goal-calories').value = calculatedCalories;

    updateGoalsModalMacroDistributionBar(proteins, carbs, fats);
}

export async function saveAndCloseGoalsModal() {
    const newGoals = {
        calories: parseInt(document.getElementById('goal-calories').value) || 2000,
        proteins: parseInt(document.getElementById('goal-proteins').value) || 150,
        carbs: parseInt(document.getElementById('goal-carbs').value) || 250,
        fats: parseInt(document.getElementById('goal-fats').value) || 70,
        fibers: parseInt(document.getElementById('goal-fibers').value) || 30,
        water: parseInt(document.getElementById('goal-water').value) || 8
    };

    setNutritionGoals(newGoals);
    await saveNutritionGoals();
    closeGoalsModal();
    showToast('Obiettivi aggiornati!');

    // Update UI immediately
    if (window.updateNutritionProgress) {
        window.updateNutritionProgress();
    }
    if (window.updateMacroDistributionBar) {
        window.updateMacroDistributionBar();
    }
}