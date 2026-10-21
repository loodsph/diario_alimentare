// Test delle regole Firestore. Richiedono l'emulatore: `npm run test:rules`.
import test, { before, after, beforeEach } from 'node:test';
import fs from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, setLogLevel } from 'firebase/firestore';

// I rifiuti attesi (assertFails) altrimenti riempiono il log di PERMISSION_DENIED.
setLogLevel('silent');

let env;

const food = (name = 'Pane integrale') => ({
    name, name_lowercase: name.toLowerCase(), search_tokens: name.toLowerCase().split(' '),
    calories: 250, proteins: 9, carbs: 45, fats: 3, fibers: 6
});

before(async () => {
    env = await initializeTestEnvironment({
        projectId: 'demo-nutritrack',
        firestore: { rules: fs.readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') }
    });
});

after(() => env.cleanup());

beforeEach(async () => {
    await env.clearFirestore();
    // Dati di partenza scritti ignorando le regole (come un import con l'Admin SDK).
    await env.withSecurityRulesDisabled(async context => {
        const db = context.firestore();
        await setDoc(doc(db, 'users/alice/meals/m1'), { name: 'Yogurt', quantity: 125 });
        await setDoc(doc(db, 'foods/crea1'), { ...food('Mela'), original_id: 'CREA-001', acqua_g: 85 });
    });
});

const as = uid => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();

test('i dati personali sono accessibili solo al proprietario', async () => {
    await assertSucceeds(getDoc(doc(as('alice'), 'users/alice/meals/m1')));
    await assertSucceeds(setDoc(doc(as('alice'), 'users/alice/goals/nutrition'), { calories: 2000 }));
    await assertSucceeds(deleteDoc(doc(as('alice'), 'users/alice/meals/m1')));
    await assertFails(getDoc(doc(as('bob'), 'users/alice/meals/m1')));
    await assertFails(setDoc(doc(as('bob'), 'users/alice/meals/m2'), { name: 'Intruso' }));
    await assertFails(getDoc(doc(as(null), 'users/alice/meals/m1')));
});

test('gli alimenti condivisi si leggono solo da autenticati', async () => {
    await assertSucceeds(getDoc(doc(as('bob'), 'foods/crea1')));
    await assertFails(getDoc(doc(as(null), 'foods/crea1')));
});

test('aggiungere un alimento richiede solo i campi previsti e valori validi', async () => {
    const db = as('bob');
    await assertSucceeds(addDoc(collection(db, 'foods'), food()));
    const { fibers, ...withoutFibers } = food('Riso');
    await assertSucceeds(addDoc(collection(db, 'foods'), withoutFibers));
    await assertFails(addDoc(collection(as(null), 'foods'), food()));
    await assertFails(addDoc(collection(db, 'foods'), { ...food(), owner: 'bob' }));
    await assertFails(addDoc(collection(db, 'foods'), { ...food(), calories: -1 }));
    await assertFails(addDoc(collection(db, 'foods'), { ...food(), proteins: '9' }));
    await assertFails(addDoc(collection(db, 'foods'), { ...food(), name_lowercase: 'altro' }));
    await assertFails(addDoc(collection(db, 'foods'), { ...food(), name: '' , name_lowercase: '' }));
});

test('modificare un alimento CREA conserva i campi extra ma non permette di aggiungerne', async () => {
    const db = as('bob');
    await assertSucceeds(updateDoc(doc(db, 'foods/crea1'), { ...food('Mela rossa'), calories: 55 }));
    await assertFails(updateDoc(doc(db, 'foods/crea1'), { acqua_g: 0 }));
    await assertFails(updateDoc(doc(db, 'foods/crea1'), { fats: -2 }));
});

test('gli alimenti non si cancellano dal client', async () => {
    await assertFails(deleteDoc(doc(as('bob'), 'foods/crea1')));
});

test('le collezioni non previste sono chiuse', async () => {
    await assertFails(setDoc(doc(as('bob'), 'altro/x'), { a: 1 }));
    await assertFails(getDoc(doc(as('bob'), 'users/alice')));
});
