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

I pasti precedenti rimangono leggibili senza migrazioni. I nuovi pasti conservano i valori per 100 g e il peso equivalente, più metadati facoltativi della porzione. La modifica di un pasto mantiene la misura originale (fette, vasetti o frazioni di ricetta); passando ai grammi conserva la quantità equivalente.

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

## Registrazione rapida e sincronizzazione

- Ogni categoria del diario offre **Ripeti da ieri**, con scelta degli alimenti e quantità modificabili, e **Salva come abituale**. I pasti abituali sono privati, salvati su Firebase e disponibili in **La tua raccolta**. Le copie conservano valori nutrizionali e indicazione delle stime, con nuovi identificativi.
- **Salva e aggiungi altro** registra l’alimento e riapre la ricerca, mantenendo data e tipo di pasto. **Aggiungi** nella categoria apre direttamente il flusso per quel pasto.
- L’eliminazione offre **Annulla** per 10 secondi; il ripristino riutilizza lo stesso documento, anche offline.
- Pasti, modifiche, eliminazioni, ripristini, pasti abituali e acqua usano la coda persistente di Firestore. Il modulo si libera senza attendere la conferma del server. Lo stato distingue modifiche da sincronizzare ed errori, con **Riprova salvataggi** durante la sessione. Le operazioni rifiutate dal server richiedono un nuovo tentativo; non sono considerate sincronizzate. Le porzioni recenti vengono aggiornate alla conferma del server.
- Per l’uso offline occorre aver aperto e autenticato l’app sul dispositivo. Sono disponibili i dati già in cache; ricerca remota, scansione con recupero prodotto e analisi AI richiedono rete. La libreria scanner e i grafici vengono scaricati al primo utilizzo.
- Lo storico carica la settimana che termina nella data selezionata, anche oltre 30 giorni. Caricamento, errore e cache potenzialmente incompleta sono segnalati separatamente dai giorni vuoti. Il grafico segue lo stesso periodo e lascia interruzioni per i giorni senza registrazioni.
- La ricerca presenta subito cache, recenti e preferiti, poi integra i risultati remoti; gli errori di rete non vengono presentati come assenza di risultati. I cambiamenti ai pasti ricalcolano i soli giorni interessati e conservano le liste invariate.
- Prima dell’analisi, le foto vengono ridimensionate a un lato massimo di 1600 px e convertite in JPEG (qualità 0,82), senza ingrandire immagini piccole. Limite del file in ingresso: 25 MB.

L’anteprima locale permette anche copia da ieri, pasti abituali, modifica, eliminazione con annullamento e una **simulazione** offline. Tutte le scritture restano nella memoria della pagina; un refresh azzera i dati fittizi. Il salvataggio e la sincronizzazione reali si verificano con `npm run test:rules`, che include prove contro l’emulatore Firebase, senza toccare il progetto di produzione.

Il comando dei test sull’emulatore usa `--test-force-exit` (Node 22): chiude il runner **dopo** il completamento di test e hook, evitando che i trasporti Firebase mantengano attivo il processo.

## Grigliata e sushi, senza bilancia

In **Aggiungi qualcosa → Grigliata o sushi?** scegli gli alimenti e conta i pezzi che hai mangiato, anche frazionari. Puoi aggiungere pane, contorni, salse e bevande. Ogni voce offre dimensione piccola/media/grande e correzione del peso e dei nutrienti per 100 g. La carne è espressa come peso **cotto edibile**, senza ossa e parti scartate; per il sushi si contano i singoli bocconi, non i roll interi. I roll fritti/con maionese includono già frittura e salsa: aggiungere solo gli extra effettivi.

La funzione è locale e non richiede AI o rete. **Usa questa stima** porta al riepilogo, dove scegli data/tipo di pasto con il flusso consueto e confermi l’inserimento. Il diario conserva una voce aggregata **Stima in pezzi**, il dettaglio degli ingredienti e l’intervallo calorico. **Modifica pasto → Modifica pezzi e ingredienti** permette di correggere anche un pasto già salvato; la modifica resta una bozza fino a **Salva Modifiche**. Preferiti, copie, pasti abituali e annullamento dell’eliminazione mantengono la provenienza della stima.

Il catalogo in `public/modules/mealEstimate.js` contiene ipotesi iniziali esplicite, non porzioni standard né dati specifici del ristorante. I riferimenti per 100 g sono [CREA salsiccia cotta](https://www.alimentinutrizione.it/tabelle-nutrizionali/110716), [CREA petto di pollo cotto](https://www.alimentinutrizione.it/tabelle-nutrizionali/106506), [Sushi Gourmet nigiri al salmone](https://sushigourmet.eu/en/produit/salmon-nigiri-sushi/) e [Sushi Gourmet sashimi misto](https://sushigourmet.eu/en/produit/tuna-salmon-sashimi/), consultati il 24 ottobre 2026. I restanti valori e tutti i pesi per pezzo sono **modelli indicativi NutriTrack**, correggibili; le fibre non disponibili sono approssimate a zero. Per le bevande il catalogo dichiara la massa approssimata associata al volume, senza introdurre conversioni generiche ml→g nel selettore delle porzioni. Le calorie delle bevande alcoliche includono l’alcol.

L’intervallo usa un margine **convenzionale**, ±30% per la grigliata e ±35% per il sushi: non è un intervallo statistico né garantisce di contenere il valore reale. I totali del diario usano la stima centrale. Il documento conserva metodo/versione, composizione e limiti per 100 g: cambiando la porzione si ridimensionano coerentemente nutrienti, intervallo e quantità dei singoli ingredienti. I vecchi pasti da foto restano etichettati **Stima da foto**.

Il service worker v4 precarica anche i moduli delle stime, rinnova la cache all’installazione e rivalida i file dell’app con il server; Firebase Hosting invia `no-cache` per HTML, CSS e JavaScript. I riferimenti ai componenti modificati hanno una versione per evitare riuso di risposte del deploy precedente.

## Stima di un piatto da descrizione

In **Aggiungi qualcosa → Descrivi un piatto**, inserisci il nome e i dettagli che conosci: provenienza, stato crudo/cotto, ingredienti con quantità e unità, metodo di cottura, panatura, grassi aggiunti e trattenuti, salsa, peso finale edibile e note. Le quantità si riferiscono all’intera preparazione; la porzione da registrare si sceglie dopo. I dati sconosciuti restano espliciti e le dosi sono facoltative.

Il form usa [`gemini-3.8-flash`](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash), con risposta JSON strutturata, senza ricerca web e senza tentativi automatici. Riutilizza la chiave delle foto oppure ne accetta una per la singola sessione del form; “Ricorda la chiave” la conserva nel localStorage del dispositivo. Quota esaurita, errori e timeout vengono mostrati senza perdere la compilazione. Chiudere il form interrompe la richiesta.

Prima dell’importazione mostra kcal, proteine, carboidrati, grassi e fibre **per 100 g**, modificabili, più le ipotesi della ricetta. I valori ricevuti sono validati, ma restano stime AI. Il diario conserva **Stima da descrizione**, input, ipotesi e correzioni manuali anche in preferiti, copie e pasti abituali. Il salvataggio avviene solo dopo la scelta della porzione e la conferma nel flusso consueto. Il service worker v5 include i nuovi moduli.

Per verificare il flusso senza consumare quota o usare credenziali reali:

```sh
python3 tests/ui-preview.py --serve --mock-dish-ai
```

In questa anteprima inserisci una chiave fittizia: il modulo copiato nella cartella temporanea restituisce dati sintetici, chiaramente indicati nel risultato, senza richieste a Gemini. I file pubblici di produzione non vengono modificati. `npm test` verifica prompt, dati mancanti, validazione, errori API e conservazione della provenienza.
