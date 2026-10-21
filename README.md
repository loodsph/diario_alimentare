# NutriTrack

Diario alimentare in italiano, con interfaccia JavaScript e salvataggio su Firebase.

## Inserire una porzione

- Cerca un alimento o scansiona un prodotto. Scegli la misura e la quantità; non viene più proposto automaticamente un peso di 100 g.
- Per i prodotti, confezioni e porzioni sono disponibili quando i dati riportano esplicitamente un peso in grammi. I volumi non vengono convertiti in massa senza una densità.
- In “Non so il peso / usa fette, pezzi o vasetti” puoi definire il peso di una tua misura per quell’alimento. Usa l’etichetta o una pesata di riferimento.
- Le quantità usate e le misure personali vengono ricordate dopo il salvataggio, sul dispositivo e separatamente per ciascun account. I sei alimenti più recenti sono accessibili sopra la ricerca. Il mancato accesso alla memoria locale non impedisce il salvataggio del pasto.
- “Salva porzione preferita” salva anche quantità e misura su Firebase; “Aggiorna preferito” permette di modificarle.
- Le ricette possono essere inserite in porzioni o frazioni dell’intera preparazione. Il peso finale è facoltativo: se non c’è, i grammi interni al calcolo rappresentano gli ingredienti e non il piatto cotto. I nutrienti vengono sempre ripartiti secondo la frazione selezionata.
- La foto AI mostra i nutrienti della porzione, permette di correggere il peso e conserva nel diario l’indicazione “Stima da foto”.

I pasti precedenti rimangono leggibili senza migrazioni. I nuovi pasti conservano i valori per 100 g e il peso equivalente, più metadati facoltativi della porzione. Per correggere un pasto già registrato si usano i grammi; se cambia il peso, la vecchia descrizione della porzione viene sostituita.

## Sviluppo e verifiche

È necessario il file locale `public/firebase-config.js`, escluso da Git, e l’accesso al progetto Firebase configurato. Non includere credenziali in file pubblicati.

```sh
npm ci
npm run build
npm test
```

I test usano il test runner di Node (verificati con Node 22), senza scritture sui servizi reali. Coprono conversioni, ricette con e senza peso cotto, preferiti, validazione, memoria per account e risposte AI.

`tests/portion-preview.html` carica il componente reale da `public/index.html` con esempi sintetici di yogurt, ricetta e pane. Va aperto attraverso un server locale che esponga **solo** i file pubblici necessari e la pagina di prova; non esporre l’intera cartella del progetto. Non autentica utenti e non scrive su Firebase. Non viene distribuito da Firebase Hosting.

Il modello foto è `gemini-3.5-flash-lite`, con output JSON e validazione prima dell’importazione. Riferimento: [documentazione Google del modello](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite). L’uso richiede una chiave Google AI Studio e disponibilità della relativa quota.

La compilazione produce `public/style.css`. La pubblicazione su Firebase è un’operazione separata.

### Interfaccia Diario essenziale

Il diario mostra pasti, riepilogo e acqua. **Andamento** raccoglie obiettivi e grafici;
**La tua raccolta** contiene ricette, storico e database degli alimenti.
**Aggiungi qualcosa** apre due passaggi: alimento e porzione. Tornare al diario conserva
la bozza; il salvataggio riuscito la azzera. Le ricette, i preferiti, lo scanner e le foto
portano allo stesso selettore delle porzioni. Il tema segue la preferenza chiaro/scuro del dispositivo.

Per provare l’interfaccia senza accedere a Firebase:

```sh
python3 tests/ui-preview.py --serve
```

Aprire `http://127.0.0.1:8765`. Il comando serve una copia temporanea dei soli file pubblici,
con pasti fittizi e salvataggi in memoria. Non espone configurazioni o credenziali.
`/light.html` forza i colori chiari per il controllo visivo. Account, salvataggio ricette,
scanner e analisi AI richiedono invece l’app configurata: l’anteprima serve a verificare
navigazione, ricerca degli esempi, porzioni e inserimento nel diario. Arrestare con Ctrl+C.
